/**
 * Runs sub-agents as `pi --mode rpc` child processes. Each child gets its own context window and a
 * persistent session file, so it can be steered while running and resumed after it finishes.
 *
 * The manager lives on globalThis: a `/reload`, `/new` or `/resume` replaces the extension runtime
 * but must not lose track of background agents that are still working.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { readJson, stateDir, writeJson } from "../core/runtime.ts";
import { oneLine } from "../core/text.ts";
import { createWorktree, diffWorktree, type WorktreeInfo } from "./worktree.ts";

export type TaskStatus = "queued" | "starting" | "running" | "completed" | "failed" | "stopped" | "interrupted";

export interface Activity {
	kind: "tool" | "text";
	text: string;
	error?: boolean;
}

export interface TaskUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
}

export interface TaskSnapshot {
	id: string;
	agent: string;
	description: string;
	prompt: string;
	status: TaskStatus;
	background: boolean;
	readonly: boolean;
	model?: string;
	thinking?: string;
	cwd: string;
	createdAt: number;
	startedAt?: number;
	endedAt?: number;
	activity: Activity[];
	toolCount: number;
	turns: number;
	usage: TaskUsage;
	finalText?: string;
	error?: string;
	note?: string;
	worktree?: WorktreeInfo;
	wantsWorktree: boolean;
	/** Read-only by its own definition, whatever the current run was limited to. */
	baseReadonly: boolean;
	tools?: string[];
	parentSessionId: string;
	groupId?: string;
	dir: string;
	/** Its result has reached the parent agent, so it must not be announced again. */
	reported?: boolean;
}

export interface SpawnRequest {
	agent: string;
	description: string;
	prompt: string;
	systemPrompt: string;
	background: boolean;
	readonly: boolean;
	model?: string;
	thinking?: string;
	tools?: string[];
	cwd: string;
	isolation?: "worktree";
	runWorktreeSetup: boolean;
	maxTurns?: number;
	timeoutSeconds?: number;
	parentSessionId: string;
	groupId?: string;
	note?: string;
	depth: number;
	/** "approve" and "deny" decide project trust for the child; "resolve" leaves it to Pi's own rules. */
	trust: "approve" | "deny" | "resolve";
	env?: Record<string, string>;
}

export interface UiRequest {
	id: string;
	method: "select" | "confirm" | "input" | "editor";
	title?: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
	timeout?: number;
}

export type UiResponse = { value: string } | { confirmed: boolean } | { cancelled: true };
export type UiBridge = (task: TaskSnapshot, request: UiRequest) => Promise<UiResponse>;
export type TaskListener = (task: TaskSnapshot, event: "update" | "done") => void;

const MAX_ACTIVITY = 60;
const MAX_FINAL_TEXT = 256 * 1024;
const UPDATE_THROTTLE_MS = 120;
const ACTIVE: TaskStatus[] = ["queued", "starting", "running"];

export function isActive(task: TaskSnapshot): boolean {
	return ACTIVE.includes(task.status);
}

export function emptyUsage(): TaskUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 };
}

/** Compact one-line description of a tool call, for activity feeds. */
export function describeToolCall(name: string, args: Record<string, unknown>): string {
	const arg = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : "");
	switch (name) {
		case "bash":
			return `$ ${oneLine(arg("command"), 80)}`;
		case "read":
			return `read ${arg("path")}`;
		case "edit":
			return `edit ${arg("path")}`;
		case "write":
			return `write ${arg("path")}`;
		case "grep":
			return `grep ${oneLine(arg("pattern"), 50)}${arg("path") ? ` in ${arg("path")}` : ""}`;
		case "find":
			return `find ${oneLine(arg("pattern"), 50)}${arg("path") ? ` in ${arg("path")}` : ""}`;
		case "ls":
			return `ls ${arg("path") || "."}`;
		case "task":
			return `task ${oneLine(arg("description"), 60)}`;
		default:
			return oneLine(`${name} ${JSON.stringify(args)}`, 90);
	}
}

/** How to re-run this same Pi, whichever way it was launched. */
function piInvocation(): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/") && fs.existsSync(script)) return { command: process.execPath, args: [script] };
	const exec = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(exec)) return { command: process.execPath, args: [] };
	return { command: "pi", args: [] };
}

/** Flags on our own command line that a child needs in order to see the same extensions and resources. */
export function inheritedFlags(argv: string[], cwd: string): string[] {
	const out: string[] = [];
	const passAlone = new Set(["--no-extensions", "-ne", "--no-mcp", "--no-skills", "-ns", "--no-prompt-templates", "-np", "--no-context-files", "-nc", "--offline"]);
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (passAlone.has(arg)) out.push(arg);
		else if (arg === "-e" || arg === "--extension" || arg === "--skill") {
			const value = argv[++i];
			if (value === undefined) continue;
			const keepRaw = /^(npm:|git:|builtin:|https?:)/.test(value);
			out.push(arg, keepRaw ? value : path.resolve(cwd, value));
		} else if (arg === "--") break;
	}
	return out;
}

interface RunningTask {
	snapshot: TaskSnapshot;
	request?: SpawnRequest;
	nextPrompt?: string;
	proc?: ChildProcessWithoutNullStreams;
	buffer: string;
	stderr: string;
	streamText: string;
	settled: boolean;
	stopRequested: boolean;
	waiters: Array<(snapshot: TaskSnapshot) => void>;
	timer?: NodeJS.Timeout;
	lastEmit: number;
	emitPending?: NodeJS.Timeout;
	turnsThisRun: number;
	lastStopReason?: string;
	lastError?: string;
	detach?: () => void;
}

export class TaskManager {
	readonly tasks = new Map<string, RunningTask>();
	readonly listeners = new Set<TaskListener>();
	maxConcurrent = 6;
	bridge?: UiBridge;
	private running = 0;

	private root(sessionId: string): string {
		return path.join(stateDir(), "tasks", sessionId);
	}

	list(sessionId?: string): TaskSnapshot[] {
		const all = [...this.tasks.values()].map((task) => task.snapshot);
		return (sessionId ? all.filter((task) => task.parentSessionId === sessionId) : all).sort((a, b) => a.createdAt - b.createdAt);
	}

	get(id: string): TaskSnapshot | undefined {
		return this.tasks.get(id)?.snapshot;
	}

	/** Loads tasks that a previous process ran for this session, so they can be listed and resumed. */
	loadPersisted(sessionId: string): void {
		const root = this.root(sessionId);
		let ids: string[];
		try {
			ids = fs.readdirSync(root);
		} catch {
			return;
		}
		for (const id of ids) {
			if (this.tasks.has(id)) continue;
			const snapshot = readJson<TaskSnapshot>(path.join(root, id, "meta.json"));
			if (!snapshot) continue;
			if (isActive(snapshot)) {
				snapshot.status = "interrupted";
				snapshot.endedAt = snapshot.endedAt ?? Date.now();
			}
			this.tasks.set(id, this.record(snapshot));
		}
	}

	private record(snapshot: TaskSnapshot): RunningTask {
		return { snapshot, buffer: "", stderr: "", streamText: "", settled: true, stopRequested: false, waiters: [], lastEmit: 0, turnsThisRun: 0 };
	}

	spawn(request: SpawnRequest): TaskSnapshot {
		const id = `t${randomBytes(3).toString("hex")}`;
		const dir = path.join(this.root(request.parentSessionId), id);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "system-prompt.md"), request.systemPrompt, { mode: 0o600 });
		const snapshot: TaskSnapshot = {
			id,
			agent: request.agent,
			description: request.description,
			prompt: request.prompt,
			status: "queued",
			background: request.background,
			readonly: request.readonly,
			model: request.model,
			thinking: request.thinking,
			cwd: request.cwd,
			createdAt: Date.now(),
			activity: [],
			toolCount: 0,
			turns: 0,
			usage: emptyUsage(),
			note: request.note,
			wantsWorktree: request.isolation === "worktree",
			baseReadonly: request.readonly,
			tools: request.tools,
			parentSessionId: request.parentSessionId,
			groupId: request.groupId,
			dir,
		};
		const task = this.record(snapshot);
		task.request = request;
		task.nextPrompt = request.prompt;
		task.settled = false;
		this.tasks.set(id, task);
		this.persist(task);
		this.emit(task, "update", true);
		this.pump();
		return snapshot;
	}

	/** Continues a finished task in its existing session, keeping all of its context. */
	resume(id: string, prompt: string, background: boolean, request: Pick<SpawnRequest, "depth" | "trust" | "runWorktreeSetup" | "env" | "readonly">): TaskSnapshot {
		const task = this.tasks.get(id);
		if (!task) throw new Error(`No task with id ${id}`);
		if (isActive(task.snapshot)) throw new Error(`Task ${id} is still running. Use task_control with action "send" to steer it.`);
		const snapshot = task.snapshot;
		if (snapshot.worktree && snapshot.worktree.state !== "active") throw new Error(`Task ${id}'s worktree was already ${snapshot.worktree.state}, so it cannot resume. Start a new task.`);
		snapshot.status = "queued";
		snapshot.background = background;
		snapshot.readonly = snapshot.baseReadonly || request.readonly;
		snapshot.endedAt = undefined;
		snapshot.finalText = undefined;
		snapshot.error = undefined;
		snapshot.reported = false;
		snapshot.activity.push({ kind: "text", text: `Resumed: ${oneLine(prompt, 80)}` });
		task.nextPrompt = prompt;
		task.settled = false;
		task.stopRequested = false;
		task.stderr = "";
		task.buffer = "";
		task.lastError = undefined;
		task.lastStopReason = undefined;
		task.turnsThisRun = 0;
		task.request = {
			agent: snapshot.agent,
			description: snapshot.description,
			prompt,
			systemPrompt: "",
			background,
			readonly: snapshot.readonly,
			model: snapshot.model,
			thinking: snapshot.thinking,
			tools: snapshot.tools,
			cwd: snapshot.cwd,
			// Its worktree may never have been created. It must not fall back to the main checkout.
			isolation: snapshot.wantsWorktree ? "worktree" : undefined,
			runWorktreeSetup: request.runWorktreeSetup,
			parentSessionId: snapshot.parentSessionId,
			depth: request.depth,
			trust: request.trust,
			env: request.env,
		};
		this.persist(task);
		this.emit(task, "update", true);
		this.pump();
		return snapshot;
	}

	waitFor(id: string): Promise<TaskSnapshot> {
		const task = this.tasks.get(id);
		if (!task) return Promise.reject(new Error(`No task with id ${id}`));
		if (!isActive(task.snapshot)) return Promise.resolve(task.snapshot);
		return new Promise((resolve) => task.waiters.push(resolve));
	}

	/** Lets a foreground wait return early; the task carries on as a background task. */
	onDetach(id: string, callback: () => void): void {
		const task = this.tasks.get(id);
		if (task) task.detach = callback;
	}

	detachForeground(sessionId: string): number {
		let count = 0;
		for (const task of this.tasks.values()) {
			if (task.snapshot.parentSessionId === sessionId && !task.snapshot.background && isActive(task.snapshot) && task.detach) {
				task.snapshot.background = true;
				task.detach();
				task.detach = undefined;
				count++;
				this.emit(task, "update", true);
			}
		}
		return count;
	}

	/** Delivers a message to a running or queued agent. `steer` lands after its current tool calls. */
	send(id: string, message: string, behavior: "steer" | "follow_up"): boolean {
		const task = this.tasks.get(id);
		if (!task || !isActive(task.snapshot)) return false;
		if (task.proc && task.snapshot.status === "running") {
			this.write(task, { type: behavior, message });
		} else {
			task.nextPrompt = `${task.nextPrompt ?? ""}\n\n${message}`;
		}
		task.snapshot.activity.push({ kind: "text", text: `You: ${oneLine(message, 80)}` });
		this.emit(task, "update", true);
		return true;
	}

	stop(id: string): boolean {
		const task = this.tasks.get(id);
		if (!task || !isActive(task.snapshot)) return false;
		task.stopRequested = true;
		if (!task.proc) {
			this.finish(task, "stopped");
			return true;
		}
		this.write(task, { type: "abort" });
		const proc = task.proc;
		setTimeout(() => {
			if (proc.exitCode === null) proc.kill("SIGTERM");
		}, 1500).unref();
		setTimeout(() => {
			if (proc.exitCode === null) proc.kill("SIGKILL");
		}, 5000).unref();
		return true;
	}

	/** Called when the Pi process is quitting. */
	shutdown(): void {
		for (const task of this.tasks.values()) {
			if (!isActive(task.snapshot)) continue;
			task.stopRequested = true;
			task.snapshot.status = "interrupted";
			task.snapshot.endedAt = Date.now();
			this.persist(task);
			task.proc?.kill("SIGTERM");
		}
	}

	updateWorktree(id: string, state: WorktreeInfo["state"]): void {
		const task = this.tasks.get(id);
		if (task?.snapshot.worktree) {
			task.snapshot.worktree.state = state;
			this.persist(task);
			this.emit(task, "update", true);
		}
	}

	markReported(id: string): void {
		const task = this.tasks.get(id);
		if (task && !task.snapshot.reported) {
			task.snapshot.reported = true;
			this.persist(task);
		}
	}

	private pump(): void {
		for (const task of this.tasks.values()) {
			if (this.running >= this.maxConcurrent) return;
			if (task.snapshot.status === "queued" && task.request && !task.proc) {
				this.running++;
				task.snapshot.status = "starting";
				this.emit(task, "update", true);
				void this.start(task).catch((error: unknown) => {
					task.lastError = error instanceof Error ? error.message : String(error);
					this.finish(task, "failed");
				});
			}
		}
	}

	private async start(task: RunningTask): Promise<void> {
		const request = task.request as SpawnRequest;
		const snapshot = task.snapshot;
		if (request.isolation === "worktree" && !snapshot.worktree) {
			snapshot.worktree = await createWorktree(request.cwd, snapshot.id, request.runWorktreeSetup);
			snapshot.cwd = snapshot.worktree.path;
			if (snapshot.worktree.setupWarning) snapshot.activity.push({ kind: "text", text: snapshot.worktree.setupWarning, error: true });
		}
		if (task.stopRequested) {
			this.finish(task, "stopped");
			return;
		}
		const invocation = piInvocation();
		const args = [...invocation.args, "--mode", "rpc", "--session-dir", snapshot.dir, "--session-id", snapshot.id];
		const promptFile = path.join(snapshot.dir, "system-prompt.md");
		if (fs.existsSync(promptFile)) args.push("--append-system-prompt", promptFile);
		if (snapshot.model) args.push("--model", snapshot.model);
		if (snapshot.thinking) args.push("--thinking", snapshot.thinking);
		if (request.tools?.length) args.push("--tools", request.tools.join(","));
		if (request.trust !== "resolve") args.push(request.trust === "approve" ? "--approve" : "--no-approve");
		args.push(...inheritedFlags(process.argv.slice(2), process.cwd()));
		const proc = spawn(invocation.command, args, {
			cwd: snapshot.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				...request.env,
				PI_CURSOR_TASK_ID: snapshot.id,
				PI_CURSOR_DEPTH: String(request.depth + 1),
				PI_CURSOR_READONLY: snapshot.readonly ? "1" : "0",
				PI_CURSOR_AGENT: snapshot.agent,
				PI_SKIP_VERSION_CHECK: "1",
			},
		});
		task.proc = proc;
		snapshot.status = "running";
		snapshot.startedAt = snapshot.startedAt ?? Date.now();
		this.persist(task);
		this.emit(task, "update", true);
		if (request.timeoutSeconds) {
			task.timer = setTimeout(() => {
				task.lastError = `Timed out after ${request.timeoutSeconds}s`;
				this.stop(snapshot.id);
			}, request.timeoutSeconds * 1000);
			task.timer.unref();
		}
		proc.stdout.setEncoding("utf8");
		// A finished run detaches its process, so a late close cannot touch a resumed run of the task.
		proc.stdout.on("data", (chunk: string) => {
			if (task.proc === proc) this.onStdout(task, chunk);
		});
		proc.stderr.on("data", (chunk: Buffer) => {
			if (task.proc === proc) task.stderr = (task.stderr + chunk.toString()).slice(-4000);
		});
		proc.stdin.on("error", () => {});
		proc.on("error", (error) => {
			if (task.proc !== proc) return;
			task.lastError = `Could not start pi: ${error.message}`;
			this.finish(task, "failed");
		});
		proc.on("close", (code) => {
			if (task.proc !== proc) return;
			const status = task.stopRequested ? "stopped" : "failed";
			if (status === "failed") task.lastError = task.lastError ?? `Sub-agent exited with code ${code}.\n${task.stderr.trim()}`;
			this.finish(task, status);
		});
		this.write(task, { id: "prompt", type: "prompt", message: task.nextPrompt ?? request.prompt });
		task.nextPrompt = undefined;
	}

	private write(task: RunningTask, command: Record<string, unknown>): void {
		if (task.proc?.stdin.writable) task.proc.stdin.write(`${JSON.stringify(command)}\n`);
	}

	private onStdout(task: RunningTask, chunk: string): void {
		task.buffer += chunk;
		let index = task.buffer.indexOf("\n");
		while (index >= 0) {
			const line = task.buffer.slice(0, index).replace(/\r$/, "");
			task.buffer = task.buffer.slice(index + 1);
			if (line.trim()) {
				try {
					this.onRecord(task, JSON.parse(line) as Record<string, any>);
				} catch {
					// A non-JSON line on stdout comes from a misbehaving tool; the protocol carries on.
				}
			}
			index = task.buffer.indexOf("\n");
		}
	}

	private onRecord(task: RunningTask, record: Record<string, any>): void {
		const snapshot = task.snapshot;
		switch (record.type) {
			case "response":
				if (record.id === "prompt") {
					if (!record.success) {
						task.lastError = String(record.error ?? "The sub-agent rejected its prompt.");
						this.finish(task, "failed");
					} else if (record.data?.disposition === "handled") {
						this.finish(task, "completed");
					}
				}
				break;
			case "message_update": {
				const event = record.assistantMessageEvent;
				if (event?.type === "text_delta" && typeof event.delta === "string") {
					task.streamText = (task.streamText + event.delta).slice(-2000);
					this.emit(task, "update");
				}
				break;
			}
			case "tool_execution_start":
				snapshot.toolCount++;
				this.pushActivity(snapshot, { kind: "tool", text: describeToolCall(record.toolName, record.args ?? {}) });
				this.emit(task, "update");
				break;
			case "tool_execution_end":
				if (record.isError) {
					const last = [...snapshot.activity].reverse().find((item) => item.kind === "tool");
					if (last) last.error = true;
					this.emit(task, "update");
				}
				break;
			case "message_end": {
				const message = record.message;
				if (message?.role !== "assistant") break;
				snapshot.turns++;
				task.turnsThisRun++;
				const usage = message.usage;
				if (usage) {
					snapshot.usage.input += usage.input ?? 0;
					snapshot.usage.output += usage.output ?? 0;
					snapshot.usage.cacheRead += usage.cacheRead ?? 0;
					snapshot.usage.cacheWrite += usage.cacheWrite ?? 0;
					snapshot.usage.cost += usage.cost?.total ?? 0;
					snapshot.usage.contextTokens = usage.totalTokens ?? snapshot.usage.contextTokens;
				}
				task.lastStopReason = message.stopReason;
				task.lastError = message.errorMessage ?? task.lastError;
				const text = (message.content ?? [])
					.filter((part: { type: string }) => part.type === "text")
					.map((part: { text: string }) => part.text)
					.join("\n")
					.trim();
				if (text) {
					snapshot.finalText = text.slice(-MAX_FINAL_TEXT);
					this.pushActivity(snapshot, { kind: "text", text: oneLine(text, 200) });
				}
				task.streamText = "";
				const maxTurns = task.request?.maxTurns;
				if (maxTurns && task.turnsThisRun >= maxTurns && message.stopReason === "toolUse") {
					task.lastError = `Stopped after reaching the limit of ${maxTurns} turns.`;
					this.stop(snapshot.id);
				}
				this.persist(task);
				this.emit(task, "update", true);
				break;
			}
			case "agent_settled":
				if (task.stopRequested || record.aborted) this.finish(task, "stopped");
				else if (task.lastStopReason === "error") this.finish(task, "failed");
				else this.finish(task, "completed");
				break;
			case "extension_ui_request":
				void this.onUiRequest(task, record);
				break;
			default:
				break;
		}
	}

	private async onUiRequest(task: RunningTask, record: Record<string, any>): Promise<void> {
		if (!["select", "confirm", "input", "editor"].includes(record.method)) return;
		const respond = (response: UiResponse) => this.write(task, { type: "extension_ui_response", id: record.id, ...response });
		if (!this.bridge) {
			respond({ cancelled: true });
			return;
		}
		try {
			respond(await this.bridge(task.snapshot, record as unknown as UiRequest));
		} catch {
			respond({ cancelled: true });
		}
	}

	private pushActivity(snapshot: TaskSnapshot, item: Activity): void {
		snapshot.activity.push(item);
		if (snapshot.activity.length > MAX_ACTIVITY) snapshot.activity.splice(0, snapshot.activity.length - MAX_ACTIVITY);
	}

	private finish(task: RunningTask, status: TaskStatus): void {
		if (task.settled) return;
		task.settled = true;
		const snapshot = task.snapshot;
		const wasRunning = snapshot.status === "running" || snapshot.status === "starting";
		snapshot.status = status;
		snapshot.endedAt = Date.now();
		if (status !== "completed") {
			snapshot.error = task.lastError ?? (status === "stopped" ? "Stopped." : task.stderr.trim() || "The sub-agent failed.");
		}
		if (task.timer) clearTimeout(task.timer);
		if (task.emitPending) clearTimeout(task.emitPending);
		const proc = task.proc;
		task.proc = undefined;
		if (proc) {
			proc.stdin.end();
			setTimeout(() => {
				if (proc.exitCode === null) proc.kill("SIGTERM");
			}, 1500).unref();
			setTimeout(() => {
				if (proc.exitCode === null) proc.kill("SIGKILL");
			}, 5000).unref();
		}
		if (wasRunning) this.running = Math.max(0, this.running - 1);
		const done = async () => {
			if (snapshot.worktree?.state === "active") {
				snapshot.worktree.diff = await diffWorktree(snapshot.worktree).catch(() => undefined);
			}
			this.persist(task);
			try {
				fs.writeFileSync(path.join(snapshot.dir, "output.md"), snapshot.finalText ?? snapshot.error ?? "");
			} catch {
				// The output file is a convenience; the snapshot already holds the result.
			}
			for (const waiter of task.waiters.splice(0)) waiter(snapshot);
			this.emit(task, "done", true);
			this.pump();
		};
		void done();
	}

	private persist(task: RunningTask): void {
		try {
			writeJson(path.join(task.snapshot.dir, "meta.json"), task.snapshot);
		} catch {
			// Losing metadata only affects resume after a restart.
		}
	}

	private emit(task: RunningTask, event: "update" | "done", force = false): void {
		const notify = () => {
			task.lastEmit = Date.now();
			task.emitPending = undefined;
			for (const listener of this.listeners) listener(task.snapshot, event);
		};
		if (force || event === "done") {
			if (task.emitPending) clearTimeout(task.emitPending);
			notify();
			return;
		}
		if (task.emitPending) return;
		const wait = UPDATE_THROTTLE_MS - (Date.now() - task.lastEmit);
		if (wait <= 0) notify();
		else task.emitPending = setTimeout(notify, wait);
	}

	streamingText(id: string): string {
		return this.tasks.get(id)?.streamText ?? "";
	}
}

const KEY = Symbol.for("pi-cursor.taskManager");

export function getTaskManager(): TaskManager {
	const store = globalThis as unknown as Record<symbol, TaskManager | undefined>;
	store[KEY] ??= new TaskManager();
	return store[KEY] as TaskManager;
}
