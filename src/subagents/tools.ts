/** The tools the model uses to delegate work: `task`, `task_group` and `task_control`. */

import * as path from "node:path";
import { DEFAULT_MAX_BYTES, truncateHead, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverAgents, findAgent, resolveModel, type AgentDef } from "../agents/agents.ts";
import { canonicalPath, isInside, type Runtime } from "../core/runtime.ts";
import { stringEnum } from "../core/schema.ts";
import { getTaskManager, isActive, type SpawnRequest, type TaskListener, type TaskSnapshot, type UiRequest, type UiResponse } from "./manager.ts";
import { renderGroupCall, renderTaskCall, renderTaskResult, type TaskToolDetails } from "./render.ts";
import { applyWorktree, fullDiff, removeWorktree } from "./worktree.ts";

const MAX_DETAIL_TEXT = 24 * 1024;

export interface ChildEnvProvider {
	(ctx: ExtensionContext | undefined): Record<string, string>;
}

export interface SubagentGate {
	/** Lets hooks refuse a sub-agent. Returns the reason when refused. */
	beforeSpawn(agent: string, prompt: string): Promise<string | undefined>;
	/** Lets hooks react to a finished sub-agent. May return a follow-up for it. */
	afterFinish(task: TaskSnapshot): Promise<string | undefined>;
}

export interface SubagentsApi {
	agents(): AgentDef[];
	refreshAgents(): void;
	spawnFromCommand(options: { agent?: string; prompt: string; description?: string; background: boolean; isolation?: "worktree"; model?: string }, ctx: ExtensionContext): Promise<TaskSnapshot>;
	setGate(gate: SubagentGate): void;
	apply(id: string): Promise<string>;
	discard(id: string): Promise<string>;
	diff(id: string): Promise<string>;
	resume(id: string, prompt: string, background: boolean): TaskSnapshot;
	sessionId(): string;
}

function childSystemPrompt(agent: AgentDef, readonly: boolean, worktree: boolean): string {
	const lines = [
		`You are the "${agent.name}" sub-agent, working on one delegated task for a parent agent. You have your own context and do not see the parent's conversation.`,
		"Your final message is the only thing the parent receives, and the user does not see your intermediate steps. Make that final message complete and self-contained, and report what you actually verified.",
		"Do not ask for confirmation of the plan; work autonomously. Use ask_question only when you are truly blocked on a decision only the user can make.",
	];
	if (readonly) lines.push("You are read-only: file edits are disabled and shell access is limited to read-only commands.");
	if (worktree) lines.push("You are working in an isolated git worktree. Your changes reach the main checkout only if they are applied afterwards. Leave them uncommitted unless the task asks you to commit.");
	if (agent.prompt) lines.push("", agent.prompt);
	return lines.join("\n");
}

function slim(task: TaskSnapshot): TaskSnapshot {
	return {
		...task,
		prompt: task.prompt.slice(0, 2000),
		finalText: task.finalText && task.finalText.length > MAX_DETAIL_TEXT ? `${task.finalText.slice(0, MAX_DETAIL_TEXT)}\n…` : task.finalText,
		activity: task.activity.slice(-30),
	};
}

export function formatForModel(task: TaskSnapshot): string {
	const elapsed = task.startedAt ? `${Math.round(((task.endedAt ?? Date.now()) - task.startedAt) / 1000)}s` : "not started";
	const lines = [`[task ${task.id} · ${task.agent} · ${task.status} · ${elapsed} · ${task.toolCount} tools]`];
	if (task.note) lines.push(task.note);
	if (task.status !== "completed" && task.error) lines.push(`Error: ${task.error}`);
	if (task.finalText) {
		const truncated = truncateHead(task.finalText, { maxBytes: DEFAULT_MAX_BYTES, maxLines: 2000 });
		lines.push(truncated.content);
		if (truncated.truncated) lines.push(`[Output truncated. Full output: ${path.join(task.dir, "output.md")}]`);
	} else if (task.status === "completed") {
		lines.push("(The sub-agent finished without a final message.)");
	}
	const worktree = task.worktree;
	if (worktree?.state === "active" && worktree.diff) {
		const changed = worktree.diff.files.map((file) => `  ${file.path} +${file.added} -${file.removed}`).join("\n");
		lines.push(
			worktree.diff.files.length > 0
				? `Changes are isolated in worktree ${worktree.path} (branch ${worktree.branch}), not yet in the main checkout:\n${changed}\nUse task_control with action "apply" to bring them over, or "discard" to throw them away.`
				: "It made no file changes in its worktree.",
		);
	}
	if (task.status === "failed" || task.status === "stopped" || task.status === "interrupted") lines.push(`Resume with task resume: "${task.id}".`);
	return lines.join("\n");
}

function usageOf(tasks: TaskSnapshot[]) {
	const sum = (pick: (task: TaskSnapshot) => number) => tasks.reduce((total, task) => total + pick(task), 0);
	const input = sum((t) => t.usage.input);
	const output = sum((t) => t.usage.output);
	const cacheRead = sum((t) => t.usage.cacheRead);
	const cacheWrite = sum((t) => t.usage.cacheWrite);
	const total = sum((t) => t.usage.cost);
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
	};
}

const TaskFields = {
	description: Type.String({ description: "Short label for the task, 3-5 words" }),
	prompt: Type.String({ description: "Complete instructions. The sub-agent cannot see this conversation, so include every file path, constraint and piece of context it needs, and say what to report back." }),
	subagent_type: Type.Optional(Type.String({ description: "Name of the agent to use. Defaults to general-purpose." })),
	model: Type.Optional(Type.String({ description: 'Model override: "inherit", "fast", or a model name. Defaults to what the agent specifies.' })),
	readonly: Type.Optional(Type.Boolean({ description: "Forbid the sub-agent from changing anything." })),
	isolation: Type.Optional(stringEnum(["worktree"] as const, { description: "Run in an isolated git worktree. Changes stay there until applied with task_control." })),
	cwd: Type.Optional(Type.String({ description: "Working directory, if it should differ from the current one." })),
	max_turns: Type.Optional(Type.Number({ description: "Stop after this many model turns." })),
	timeout_seconds: Type.Optional(Type.Number({ description: "Stop after this many seconds." })),
};

const TaskParams = Type.Object({
	...TaskFields,
	run_in_background: Type.Optional(Type.Boolean({ description: "Return immediately and keep working. You are notified when it finishes. Do not poll." })),
	resume: Type.Optional(Type.String({ description: "ID of an earlier task to continue with all of its context. prompt is the follow-up instruction." })),
});

const GroupParams = Type.Object({
	mode: stringEnum(["parallel", "chain", "best_of_n"] as const, {
		description: "parallel: run tasks at once. chain: run tasks in order, with {previous} in a prompt replaced by the prior task's output; stops at the first failure. best_of_n: run one prompt several times, each in its own worktree, then compare and apply the best.",
	}),
	tasks: Type.Optional(Type.Array(Type.Object(TaskFields), { description: "Tasks, for parallel and chain." })),
	prompt: Type.Optional(Type.String({ description: "The prompt, for best_of_n." })),
	description: Type.Optional(Type.String({ description: "Short label, for best_of_n." })),
	subagent_type: Type.Optional(Type.String({ description: "Agent, for best_of_n." })),
	models: Type.Optional(Type.Array(Type.String(), { description: "One attempt per model, for best_of_n." })),
	n: Type.Optional(Type.Number({ description: "Number of attempts when models is not given, for best_of_n." })),
	readonly: Type.Optional(Type.Boolean({ description: "Forbid every task from changing anything." })),
	run_in_background: Type.Optional(Type.Boolean({ description: "Return immediately. You are notified when the whole group finishes." })),
});

const ControlParams = Type.Object({
	action: stringEnum(["list", "status", "wait", "send", "stop", "apply", "discard", "diff"] as const, {
		description: 'list: all tasks. status: details of one task. wait: block until tasks finish. send: message a running task. stop: cancel. apply: bring a worktree task\'s changes into the main checkout. discard: delete its worktree. diff: show its changes.',
	}),
	id: Type.Optional(Type.String({ description: "Task ID." })),
	ids: Type.Optional(Type.Array(Type.String(), { description: "Task IDs, for wait." })),
	message: Type.Optional(Type.String({ description: "Message, for send." })),
	behavior: Type.Optional(stringEnum(["steer", "follow_up"] as const, { description: "For send. steer: deliver after its current tool calls (default). follow_up: deliver when it finishes its work." })),
	timeout_seconds: Type.Optional(Type.Number({ description: "For wait: stop waiting after this long." })),
});

export function setupSubagentTools(rt: Runtime, childEnv: ChildEnvProvider, inReadOnlyMode: () => boolean): SubagentsApi {
	const { pi } = rt;
	const manager = getTaskManager();
	let agents: AgentDef[] = [];
	let gate: SubagentGate | undefined;
	let listener: TaskListener | undefined;
	let settleWaiting = false;
	let alive = true;
	/** Chains still starting steps: finishing one step does not finish the group. */
	const openGroups = new Set<string>();
	const runningChains = new Set<Promise<void>>();
	/** Tasks someone is blocked on in `task_control wait`, who will get the result from that call. */
	const waitedOn = new Set<string>();
	let dialogChain: Promise<unknown> = Promise.resolve();

	const sessionId = () => rt.ctx?.sessionManager.getSessionId() ?? "unknown";

	/**
	 * The user's trust decision covers this working directory. A different directory may hold its own
	 * `.pi` config that nobody has looked at, so there Pi applies its normal rules.
	 */
	const trustFor = (cwd: string): SpawnRequest["trust"] => {
		if (!rt.projectTrusted) return "deny";
		return canonicalPath(cwd) === canonicalPath(rt.cwd) ? "approve" : "resolve";
	};

	const resumeOptions = (readonly: boolean | undefined) => ({
		depth: rt.role.depth,
		trust: trustFor(rt.cwd),
		runWorktreeSetup: rt.execTrusted,
		env: childEnv(rt.ctx),
		readonly: rt.role.readonly || inReadOnlyMode() || readonly === true,
	});

	const buildRequest = (input: { description: string; prompt: string; subagent_type?: string; model?: string; readonly?: boolean; isolation?: "worktree"; cwd?: string; max_turns?: number; timeout_seconds?: number }, ctx: ExtensionContext, background: boolean | undefined, groupId?: string): SpawnRequest => {
		const name = input.subagent_type ?? "general-purpose";
		const agent = findAgent(agents, name);
		if (!agent) throw new Error(`Unknown agent "${name}". Available agents: ${agents.map((a) => a.name).join(", ")}.`);
		const readonly = rt.role.readonly || inReadOnlyMode() || input.readonly === true || agent.readonly;
		const isolation = readonly ? undefined : (input.isolation ?? agent.isolation);
		const model = resolveModel(input.model ?? agent.model, ctx, rt.config, agent.thinking);
		const cwd = input.cwd ? path.resolve(rt.cwd, input.cwd) : rt.cwd;
		if (!isInside(canonicalPath(rt.root), canonicalPath(cwd))) throw new Error(`A sub-agent's cwd must be inside the workspace (${rt.root}), and ${cwd} is not.`);
		return {
			agent: agent.name,
			description: input.description,
			prompt: input.prompt,
			systemPrompt: childSystemPrompt(agent, readonly, isolation === "worktree"),
			background: background ?? agent.background,
			readonly,
			model: model.spec,
			thinking: model.thinking,
			tools: agent.tools,
			cwd,
			isolation,
			runWorktreeSetup: rt.execTrusted,
			maxTurns: input.max_turns ?? agent.maxTurns,
			timeoutSeconds: input.timeout_seconds,
			parentSessionId: sessionId(),
			groupId,
			note: model.note,
			depth: rt.role.depth,
			trust: trustFor(cwd),
			env: childEnv(ctx),
		};
	};

	const checkDepth = () => {
		if (rt.role.depth >= rt.config.subagents.maxDepth) throw new Error(`Sub-agents cannot nest deeper than ${rt.config.subagents.maxDepth} levels. Do the work directly.`);
	};

	const spawn = async (request: SpawnRequest): Promise<TaskSnapshot> => {
		const refused = await gate?.beforeSpawn(request.agent, request.prompt);
		if (refused) throw new Error(`A hook refused this sub-agent: ${refused}`);
		return manager.spawn(request);
	};

	/** Streams updates for `ids` to the tool row until they finish. */
	const follow = async (mode: TaskToolDetails["mode"], ids: () => string[], onUpdate: ((partial: any) => void) | undefined, wait: () => Promise<void>): Promise<TaskSnapshot[]> => {
		const snapshots = () => ids().map((id) => manager.get(id)).filter((task): task is TaskSnapshot => !!task);
		const push = () => onUpdate?.({ content: [{ type: "text", text: `${snapshots().filter(isActive).length} running` }], details: { mode, tasks: snapshots().map(slim) } });
		const update: TaskListener = (task) => {
			if (ids().includes(task.id)) push();
		};
		manager.listeners.add(update);
		const ticker = setInterval(push, 500);
		ticker.unref();
		try {
			await wait();
		} finally {
			clearInterval(ticker);
			manager.listeners.delete(update);
		}
		return snapshots();
	};

	const untilDetachedOrDone = (id: string): Promise<boolean> =>
		new Promise((resolve) => {
			manager.onDetach(id, () => resolve(true));
			void manager.waitFor(id).then(() => resolve(false));
		});

	const notifyDone = (tasks: TaskSnapshot[], wake = true) => {
		const finished = tasks.filter((task) => !task.reported);
		if (finished.length === 0) return;
		for (const task of finished) manager.markReported(task.id);
		const content = `${finished.length > 1 ? "Background tasks" : "A background task"} finished:\n\n${finished.map(formatForModel).join("\n\n")}`;
		pi.sendMessage(
			{ customType: "pi-cursor.task-done", content, display: true, details: { mode: "control", tasks: finished.map(slim) } satisfies TaskToolDetails },
			wake ? { triggerTurn: true, deliverAs: "followUp" } : { deliverAs: "nextTurn" },
		);
	};

	const announce = async (task: TaskSnapshot) => {
		const followUp = task.status === "completed" ? await gate?.afterFinish(task).catch(() => undefined) : undefined;
		if (!alive) return;
		if (followUp) task.note = `Hook follow-up: ${followUp}`;
		if (task.groupId) {
			if (openGroups.has(task.groupId)) return;
			const group = manager.list(task.parentSessionId).filter((other) => other.groupId === task.groupId);
			if (group.every((other) => !isActive(other))) notifyDone(group);
			return;
		}
		notifyDone([task]);
	};

	const onTaskEvent: TaskListener = (task, event) => {
		if (event !== "done" || !task.background || task.parentSessionId !== sessionId() || settleWaiting || waitedOn.has(task.id)) return;
		void announce(task);
	};

	const bridge = (task: TaskSnapshot, request: UiRequest): Promise<UiResponse> => {
		const run = async (): Promise<UiResponse> => {
			const ctx = rt.ctx;
			if (!ctx?.hasUI) return { cancelled: true };
			const label = `[${task.agent}] `;
			const options = request.timeout ? { timeout: request.timeout } : undefined;
			switch (request.method) {
				case "select": {
					const value = await ctx.ui.select(`${label}${request.title ?? ""}`, request.options ?? [], options);
					return value === undefined ? { cancelled: true } : { value };
				}
				case "confirm":
					return { confirmed: await ctx.ui.confirm(`${label}${request.title ?? ""}`, request.message ?? "", options) };
				case "input": {
					const value = await ctx.ui.input(`${label}${request.title ?? ""}`, request.placeholder, options);
					return value === undefined ? { cancelled: true } : { value };
				}
				case "editor": {
					const value = await ctx.ui.editor(`${label}${request.title ?? ""}`, request.prefill);
					return value === undefined ? { cancelled: true } : { value };
				}
			}
		};
		// Dialogs from parallel agents wait their turn rather than stacking on top of each other.
		const result = dialogChain.then(run, run);
		dialogChain = result.catch(() => undefined);
		return result;
	};

	pi.on("session_start", (_event, ctx) => {
		agents = discoverAgents(rt);
		manager.maxConcurrent = rt.config.subagents.maxConcurrent;
		manager.loadPersisted(ctx.sessionManager.getSessionId());
		manager.bridge = bridge;
		listener = onTaskEvent;
		manager.listeners.add(listener);
		// Background work that finished while another session was open is handed over with the next prompt.
		const missed = manager.list(ctx.sessionManager.getSessionId()).filter((task) => task.background && !isActive(task) && !task.reported);
		if (missed.length > 0) notifyDone(missed, false);
		if (rt.role.depth >= rt.config.subagents.maxDepth) {
			pi.setActiveTools(pi.getActiveTools().filter((name) => !name.startsWith("task")));
		}
	});

	pi.on("session_shutdown", (event) => {
		alive = false;
		if (listener) manager.listeners.delete(listener);
		listener = undefined;
		manager.bridge = undefined;
		if (event.reason === "quit") manager.shutdown();
	});

	pi.on("before_agent_start", (event) => {
		if (!pi.getActiveTools().includes("task")) {
			delete event.systemPromptOptions.sections.available_agents;
			return;
		}
		const lines = agents.map((agent) => {
			const flags = [agent.readonly ? "read-only" : "", agent.background ? "background" : "", agent.isolation === "worktree" ? "worktree" : ""].filter(Boolean);
			return `- ${agent.name}${flags.length ? ` (${flags.join(", ")})` : ""}: ${agent.description}`;
		});
		event.systemPromptOptions.sections.available_agents = `Agents available to the task tool:\n${lines.join("\n")}`;
	});

	// A process without a UI exits when the run settles, which would kill its background agents, so
	// it waits for them here and hands their results to the model in one more turn.
	pi.on("agent_before_settle", async (event, ctx) => {
		if (ctx.hasUI && !rt.role.subagent) return;
		const pending = () => manager.list(sessionId()).filter((task) => task.background && isActive(task));
		if (pending().length === 0 && runningChains.size === 0) return;
		settleWaiting = true;
		// A chain starts its next step only after the previous one ends, so this has to loop.
		while (pending().length > 0 || runningChains.size > 0) {
			await Promise.all([...pending().map((task) => manager.waitFor(task.id)), ...runningChains]);
		}
		settleWaiting = false;
		const finished = manager.list(sessionId()).filter((task) => task.background && !task.reported);
		if (finished.length === 0) return;
		for (const task of finished) manager.markReported(task.id);
		return {
			entries: [...event.entries, { type: "custom_message" as const, customType: "pi-cursor.task-done", content: `Background tasks finished:\n\n${finished.map(formatForModel).join("\n\n")}`, display: false }],
			continue: true,
		};
	});

	pi.registerMessageRenderer("pi-cursor.task-done", (message, { expanded }, theme) => {
		const details = message.details as TaskToolDetails | undefined;
		return renderTaskResult(details, expanded, theme, (_id, text) => theme.fg("dim", `ctrl+o ${text}`));
	});

	pi.registerTool({
		name: "task",
		label: "Task",
		description: "Delegate work to a sub-agent with its own context. Call it several times in one message to run sub-agents in parallel. Set run_in_background to keep working while it runs, resume to continue an earlier one, and isolation to give it its own git worktree.",
		promptSnippet: "Delegate work to a sub-agent with its own context, in parallel or in the background",
		promptGuidelines: [
			"Use task for broad research, independent parallel work, or noisy command output. Use read, grep and find directly when you already know where to look.",
			"Give task a complete prompt: the sub-agent cannot see this conversation.",
			"Use run_in_background for task when you can keep working without the result. You are told when it finishes, so do not poll it with task_control.",
		],
		parameters: TaskParams,
		// Once it is running, the result row shows the same agent and label with live status.
		renderCall: (args, theme, context) => (context.executionStarted && !context.isError ? new Container() : renderTaskCall(args, theme)),
		renderResult: (result, { expanded }, theme, context) => {
			const details = result.details as TaskToolDetails | undefined;
			if (details?.tasks.length) return renderTaskResult(details, expanded, theme, context.keyHint);
			const text = result.content.find((part) => part.type === "text");
			return new Text(text?.type === "text" ? theme.fg(context.isError ? "error" : "muted", text.text) : "", 0, 0);
		},
		async execute(_id, params, signal, onUpdate, ctx) {
			checkDepth();
			let snapshot: TaskSnapshot;
			if (params.resume) {
				const earlier = manager.get(params.resume);
				const refused = await gate?.beforeSpawn(earlier?.agent ?? "unknown", params.prompt);
				if (refused) throw new Error(`A hook refused this sub-agent: ${refused}`);
				snapshot = manager.resume(params.resume, params.prompt, params.run_in_background === true, resumeOptions(params.readonly));
			} else {
				snapshot = await spawn(buildRequest(params, ctx, params.run_in_background));
			}
			const id = snapshot.id;
			if (snapshot.background) {
				return {
					content: [{ type: "text", text: `Started background task ${id} (${snapshot.agent}). You will be notified when it finishes; do not poll it. Message it with task_control action "send" if needed.` }],
					details: { mode: "single", tasks: [slim(snapshot)] } satisfies TaskToolDetails,
				};
			}
			const abort = () => manager.stop(id);
			signal?.addEventListener("abort", abort, { once: true });
			let detached = false;
			const tasks = await follow("single", () => [id], onUpdate, async () => {
				detached = await untilDetachedOrDone(id);
			});
			signal?.removeEventListener("abort", abort);
			const task = tasks[0] as TaskSnapshot;
			if (detached) {
				return {
					content: [{ type: "text", text: `The user moved task ${id} to the background. You will be notified when it finishes.` }],
					details: { mode: "single", tasks: [slim(task)] } satisfies TaskToolDetails,
				};
			}
			const followUp = task.status === "completed" ? await gate?.afterFinish(task) : undefined;
			const text = formatForModel(task) + (followUp ? `\n\nHook follow-up: ${followUp}` : "");
			return {
				content: [{ type: "text", text }],
				details: { mode: "single", tasks: [slim(task)] } satisfies TaskToolDetails,
				usage: usageOf(tasks),
				isError: task.status !== "completed",
			};
		},
	});

	pi.registerTool({
		name: "task_group",
		label: "Task Group",
		description: "Run several sub-agents as one unit: all at once (parallel), in sequence with results passed along (chain), or as competing attempts in separate worktrees whose results you compare (best_of_n).",
		promptSnippet: "Run sub-agents in parallel, as a chain, or as competing best-of-n attempts",
		parameters: GroupParams,
		renderCall: (args, theme) => renderGroupCall(args, theme),
		renderResult: (result, { expanded }, theme, context) => renderTaskResult(result.details as TaskToolDetails, expanded, theme, context.keyHint),
		async execute(_id, params, signal, onUpdate, ctx) {
			checkDepth();
			const limit = rt.config.subagents.maxParallelTasks;
			const groupId = `g${Date.now().toString(36)}`;
			const background = params.run_in_background === true;
			const readonly = params.readonly;
			const ids: string[] = [];
			const finishResult = (tasks: TaskSnapshot[], header: string) => ({
				content: [{ type: "text" as const, text: `${header}\n\n${tasks.map(formatForModel).join("\n\n")}` }],
				details: { mode: params.mode, tasks: tasks.map(slim) } satisfies TaskToolDetails,
				usage: usageOf(tasks),
				isError: tasks.some((task) => task.status === "failed"),
			});
			const abort = () => {
				for (const id of ids) manager.stop(id);
			};
			signal?.addEventListener("abort", abort, { once: true });
			try {
				if (params.mode === "chain") {
					const steps = params.tasks ?? [];
					if (steps.length === 0) throw new Error("chain needs tasks");
					const run = async () => {
						let previous = "";
						for (const step of steps) {
							// A session switch replaces this runtime, so a chain ends with its current step.
							if (!alive || signal?.aborted) return;
							const prompt = step.prompt.replaceAll("{previous}", previous);
							const task = await spawn(buildRequest({ ...step, prompt, readonly: readonly || step.readonly }, ctx, background, groupId));
							ids.push(task.id);
							const done = await manager.waitFor(task.id);
							if (done.status !== "completed") return;
							previous = done.finalText ?? "";
						}
					};
					if (background) {
						openGroups.add(groupId);
						const chain: Promise<void> = run()
							.catch((error: unknown) => {
								if (alive) rt.ctx?.ui.notify(`Chain failed: ${error instanceof Error ? error.message : String(error)}`, "error");
							})
							.finally(() => {
								openGroups.delete(groupId);
								runningChains.delete(chain);
								if (alive && !settleWaiting) notifyDone(manager.list(sessionId()).filter((task) => task.groupId === groupId));
							});
						runningChains.add(chain);
						return {
							content: [{ type: "text", text: `Started a background chain of ${steps.length} tasks. You will be notified when it finishes.` }],
							details: { mode: "chain", tasks: [] } satisfies TaskToolDetails,
						};
					}
					const tasks = await follow("chain", () => ids, onUpdate, run);
					return finishResult(tasks, `Chain finished: ${tasks.filter((task) => task.status === "completed").length} of ${steps.length} steps completed.`);
				}
				let requests: SpawnRequest[];
				if (params.mode === "best_of_n") {
					if (!params.prompt) throw new Error("best_of_n needs a prompt");
					const models: Array<string | undefined> = params.models?.length ? params.models : Array.from({ length: Math.max(2, params.n ?? 2) });
					requests = models.map((model, index) =>
						buildRequest({ description: `${params.description ?? "Attempt"} #${index + 1}`, prompt: params.prompt as string, subagent_type: params.subagent_type, model, isolation: "worktree" }, ctx, background, groupId),
					);
					if (requests.some((request) => request.isolation !== "worktree")) throw new Error("best_of_n needs an agent that can change files; this one is read-only.");
				} else {
					const list = params.tasks ?? [];
					if (list.length === 0) throw new Error("parallel needs tasks");
					requests = list.map((task) => buildRequest({ ...task, readonly: readonly || task.readonly }, ctx, background, groupId));
				}
				if (requests.length > limit) throw new Error(`Too many tasks (${requests.length}); the limit is ${limit}.`);
				for (const request of requests) ids.push((await spawn(request)).id);
				if (background) {
					return {
						content: [{ type: "text", text: `Started ${ids.length} background tasks: ${ids.join(", ")}. You will be notified when all of them finish; do not poll.` }],
						details: { mode: params.mode, tasks: ids.map((id) => slim(manager.get(id) as TaskSnapshot)) } satisfies TaskToolDetails,
					};
				}
				const tasks = await follow(params.mode, () => ids, onUpdate, async () => {
					await Promise.all(ids.map((id) => manager.waitFor(id)));
				});
				const done = tasks.filter((task) => task.status === "completed").length;
				const header = params.mode === "best_of_n" ? `All ${tasks.length} attempts finished (${done} completed). Compare them, use task_control action "diff" to inspect, then "apply" the best and "discard" the rest. Ask the user with ask_question if the choice is not clear.` : `${done} of ${tasks.length} tasks completed.`;
				return finishResult(tasks, header);
			} finally {
				signal?.removeEventListener("abort", abort);
			}
		},
	});

	const apply = async (id: string): Promise<string> => {
		const task = manager.get(id);
		if (!task?.worktree) throw new Error(`Task ${id} has no worktree.`);
		if (task.worktree.state !== "active") throw new Error(`Task ${id}'s worktree was already ${task.worktree.state}.`);
		if (isActive(task)) throw new Error(`Task ${id} is still running.`);
		const result = await applyWorktree(task.worktree);
		if (!result.ok) throw new Error(result.message);
		await removeWorktree(task.worktree);
		manager.updateWorktree(id, "applied");
		return result.message;
	};

	const discard = async (id: string): Promise<string> => {
		const task = manager.get(id);
		if (!task?.worktree) throw new Error(`Task ${id} has no worktree.`);
		if (task.worktree.state !== "active") throw new Error(`Task ${id}'s worktree was already ${task.worktree.state}.`);
		if (isActive(task)) throw new Error(`Task ${id} is still running.`);
		await removeWorktree(task.worktree);
		manager.updateWorktree(id, "discarded");
		return "Discarded the worktree and its changes.";
	};

	const diff = async (id: string): Promise<string> => {
		const task = manager.get(id);
		if (!task?.worktree || task.worktree.state !== "active") throw new Error(`Task ${id} has no active worktree.`);
		return fullDiff(task.worktree);
	};

	pi.registerTool({
		name: "task_control",
		label: "Task Control",
		description: "Inspect and manage sub-agents: list them, check one, wait for some to finish, send a message to a running one, stop one, or apply, discard or view the changes in a task's worktree.",
		promptSnippet: "List, wait for, message, stop or apply the results of sub-agents",
		parameters: ControlParams,
		renderResult: (result, { expanded }, theme, context) => renderTaskResult(result.details as TaskToolDetails, expanded, theme, context.keyHint),
		async execute(_id, params, signal) {
			const single = (text: string, tasks: TaskSnapshot[] = []) => ({
				content: [{ type: "text" as const, text }],
				details: { mode: "control", tasks: tasks.map(slim) } satisfies TaskToolDetails,
			});
			const requireId = () => {
				if (!params.id) throw new Error(`action "${params.action}" needs an id`);
				return params.id;
			};
			switch (params.action) {
				case "list": {
					const tasks = manager.list(sessionId());
					if (tasks.length === 0) return single("No tasks in this session.");
					return single(tasks.map((task) => `${task.id} · ${task.agent} · ${task.status} · ${task.description}`).join("\n"), tasks);
				}
				case "status": {
					const task = manager.get(requireId());
					if (!task) throw new Error(`No task with id ${params.id}`);
					const recent = task.activity.slice(-10).map((item) => `  ${item.text}`).join("\n");
					return single(`${formatForModel(task)}${recent ? `\nRecent activity:\n${recent}` : ""}`, [task]);
				}
				case "wait": {
					const ids = params.ids ?? (params.id ? [params.id] : manager.list(sessionId()).filter(isActive).map((task) => task.id));
					for (const id of ids) waitedOn.add(id);
					const waits = Promise.all(ids.map((id) => manager.waitFor(id)));
					const racers: Array<Promise<unknown>> = [waits];
					if (params.timeout_seconds) racers.push(new Promise((resolve) => setTimeout(resolve, (params.timeout_seconds as number) * 1000).unref()));
					if (signal) racers.push(new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })));
					await Promise.race(racers);
					for (const id of ids) waitedOn.delete(id);
					const tasks = ids.map((id) => manager.get(id)).filter((task): task is TaskSnapshot => !!task);
					for (const task of tasks) if (!isActive(task)) manager.markReported(task.id);
					return single(tasks.map(formatForModel).join("\n\n") || "No tasks to wait for.", tasks);
				}
				case "send": {
					if (!params.message) throw new Error('action "send" needs a message');
					const sent = manager.send(requireId(), params.message, params.behavior ?? "steer");
					if (!sent) throw new Error(`Task ${params.id} is not running. Use the task tool with resume to continue it.`);
					return single(`Message sent to ${params.id}.`);
				}
				case "stop": {
					if (!manager.stop(requireId())) throw new Error(`Task ${params.id} is not running.`);
					return single(`Stopping ${params.id}.`);
				}
				case "apply":
					return single(await apply(requireId()));
				case "discard":
					return single(await discard(requireId()));
				case "diff": {
					const text = await diff(requireId());
					const truncated = truncateHead(text || "(no changes)", { maxBytes: DEFAULT_MAX_BYTES, maxLines: 2000 });
					return single(truncated.content);
				}
				default:
					throw new Error(`Unknown action ${params.action as string}`);
			}
		},
	});

	return {
		agents: () => agents,
		refreshAgents() {
			agents = discoverAgents(rt);
		},
		async spawnFromCommand(options, ctx) {
			checkDepth();
			return spawn(buildRequest({ description: options.description ?? options.prompt.slice(0, 60), prompt: options.prompt, subagent_type: options.agent, isolation: options.isolation, model: options.model }, ctx, options.background));
		},
		setGate(next) {
			gate = next;
		},
		apply,
		discard,
		diff,
		resume(id, prompt, background) {
			return manager.resume(id, prompt, background, resumeOptions(false));
		},
		sessionId,
	};
}
