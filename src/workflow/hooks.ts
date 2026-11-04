/**
 * Cursor hooks: `.cursor/hooks.json` and `~/.cursor/hooks.json` run unchanged. Command hooks exchange
 * JSON over stdin/stdout; exit code 2 blocks; other failures fail open unless `failClosed` is set.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readJson, type Runtime } from "../core/runtime.ts";
import { oneLine } from "../core/text.ts";
import type { TaskSnapshot } from "../subagents/manager.ts";
import type { ToolVerdict } from "./approvals.ts";

export interface HookDef {
	event: string;
	type: "command" | "prompt";
	command?: string;
	prompt?: string;
	timeout?: number;
	matcher?: string;
	failClosed?: boolean;
	loopLimit?: number;
	cwd: string;
	source: string;
}

export interface HookOutput {
	permission?: "allow" | "deny" | "ask";
	user_message?: string;
	agent_message?: string;
	updated_input?: Record<string, unknown>;
	additional_context?: string;
	followup_message?: string;
	continue?: boolean;
	updated_mcp_tool_output?: unknown;
}

const DEFAULT_TIMEOUT_SECONDS = 60;
const LOG_LIMIT = 200;

/** Cursor's name for a Pi tool, used by matchers and in hook input. */
export function cursorToolName(name: string): string {
	const known: Record<string, string> = { bash: "Shell", background_shell: "Shell", read: "Read", edit: "Write", write: "Write", grep: "Grep", find: "Glob", ls: "LS", task: "Task", task_group: "Task", web_fetch: "WebFetch", web_search: "WebSearch", todo_write: "TodoWrite", ask_question: "AskQuestion" };
	if (name.startsWith("mcp__")) return `MCP: ${name}`;
	return known[name] ?? name;
}

export function loadHookFile(file: string, cwd: string, source: string): HookDef[] {
	const config = readJson<{ hooks?: Record<string, Array<Record<string, unknown>>> }>(file);
	if (!config?.hooks) return [];
	const hooks: HookDef[] = [];
	for (const [event, list] of Object.entries(config.hooks)) {
		if (!Array.isArray(list)) continue;
		for (const entry of list) {
			const type = entry.type === "prompt" ? "prompt" : "command";
			if (type === "command" && typeof entry.command !== "string") continue;
			if (type === "prompt" && typeof entry.prompt !== "string") continue;
			hooks.push({
				event,
				type,
				command: entry.command as string | undefined,
				prompt: entry.prompt as string | undefined,
				timeout: typeof entry.timeout === "number" ? entry.timeout : undefined,
				matcher: typeof entry.matcher === "string" ? entry.matcher : undefined,
				failClosed: entry.failClosed === true,
				loopLimit: typeof entry.loop_limit === "number" ? entry.loop_limit : undefined,
				cwd,
				source,
			});
		}
	}
	return hooks;
}

export function runCommandHook(hook: HookDef, payload: unknown, env: NodeJS.ProcessEnv): Promise<HookOutput & { failed?: string }> {
	return new Promise((resolve) => {
		const child = spawn(process.env.SHELL || "sh", ["-c", hook.command as string], { cwd: hook.cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (output: HookOutput & { failed?: string }) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(output);
		};
		const failed = (reason: string) => finish(hook.failClosed ? { permission: "deny", agent_message: `Hook failed: ${reason}`, continue: false, failed: reason } : { failed: reason });
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			failed(`timed out after ${hook.timeout ?? DEFAULT_TIMEOUT_SECONDS}s`);
		}, (hook.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000);
		child.stdout.on("data", (data: Buffer) => {
			stdout += data.toString();
		});
		child.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});
		child.on("error", (error) => failed(error.message));
		child.stdin.on("error", () => {});
		child.on("close", (code) => {
			if (code === 2) {
				const message = stderr.trim() || stdout.trim() || "Blocked by a hook.";
				finish({ permission: "deny", agent_message: message, user_message: message, continue: false });
				return;
			}
			if (code !== 0) {
				failed(`exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
				return;
			}
			if (!stdout.trim()) {
				finish({});
				return;
			}
			try {
				finish(JSON.parse(stdout) as HookOutput);
			} catch {
				failed("returned invalid JSON");
			}
		});
		child.stdin.end(JSON.stringify(payload));
	});
}

export interface HooksApi {
	list(): HookDef[];
	log(): string[];
	beforeTool(toolName: string, toolCallId: string, input: Record<string, unknown>, ctx: ExtensionContext): Promise<ToolVerdict>;
	beforeSubagent(agent: string, prompt: string): Promise<string | undefined>;
	afterSubagent(task: TaskSnapshot): Promise<string | undefined>;
}

export function setupHooks(rt: Runtime): HooksApi {
	const { pi } = rt;
	let hooks: HookDef[] = [];
	const logLines: string[] = [];
	let generationId = randomUUID();
	let stopLoops = 0;
	let extraContext: string | undefined;

	const addLog = (line: string) => {
		logLines.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
		if (logLines.length > LOG_LIMIT) logLines.shift();
	};

	const load = () => {
		hooks = [];
		if (!rt.config.hooks) return;
		const home = os.homedir();
		if (rt.config.compat.cursor) hooks.push(...loadHookFile(path.join(home, ".cursor", "hooks.json"), path.join(home, ".cursor"), "user"));
		hooks.push(...loadHookFile(path.join(getAgentDir(), "hooks.json"), getAgentDir(), "user"));
		if (rt.execTrusted) {
			if (rt.config.compat.cursor) hooks.push(...loadHookFile(path.join(rt.root, ".cursor", "hooks.json"), rt.root, "project"));
			hooks.push(...loadHookFile(path.join(rt.root, ".pi", "hooks.json"), rt.root, "project"));
		}
	};

	const runPromptHook = async (hook: HookDef, payload: unknown, ctx: ExtensionContext | undefined): Promise<HookOutput & { failed?: string }> => {
		const model = ctx?.model;
		if (!ctx || !model) return { failed: "no model available" };
		const text = (hook.prompt as string).replace("$ARGUMENTS", JSON.stringify(payload));
		const response = await ctx.modelRegistry.complete(
			model,
			{
				systemPrompt: 'You evaluate a policy for a coding agent. Reply with only JSON: {"ok": true} to allow, or {"ok": false, "reason": "..."} to block.',
				messages: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }],
			},
			{ signal: AbortSignal.timeout((hook.timeout ?? 30) * 1000) },
		);
		const reply = response.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("");
		const json = /\{[\s\S]*\}/.exec(reply)?.[0];
		try {
			const parsed = JSON.parse(json ?? "") as { ok?: boolean; reason?: string };
			if (parsed.ok === false) return { permission: "deny", agent_message: parsed.reason, user_message: parsed.reason, continue: false, followup_message: parsed.reason };
			// Having no objection is not the same as approving: approvals still get their say.
			return {};
		} catch {
			return hook.failClosed ? { permission: "deny", agent_message: "Prompt hook gave no usable answer." } : { failed: "prompt hook gave no usable answer" };
		}
	};

	const run = async (event: string, input: Record<string, unknown>, matchValue?: string): Promise<HookOutput[]> => {
		const selected = hooks.filter((hook) => {
			if (hook.event !== event) return false;
			if (!hook.matcher || matchValue === undefined) return true;
			try {
				return new RegExp(hook.matcher).test(matchValue);
			} catch {
				addLog(`invalid matcher on ${event}: ${hook.matcher}`);
				return false;
			}
		});
		if (selected.length === 0) return [];
		const ctx = rt.ctx;
		const payload = {
			conversation_id: ctx?.sessionManager.getSessionId(),
			generation_id: generationId,
			model: ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			hook_event_name: event,
			cursor_version: "pi-cursor",
			workspace_roots: [rt.root],
			transcript_path: ctx?.sessionManager.getSessionFile() ?? null,
			...input,
		};
		const env = { CURSOR_PROJECT_DIR: rt.root, CLAUDE_PROJECT_DIR: rt.root, CURSOR_TRANSCRIPT_PATH: ctx?.sessionManager.getSessionFile() ?? "" };
		const results = await Promise.all(
			selected.map(async (hook) => {
				const output: HookOutput & { failed?: string } = hook.type === "prompt" ? await runPromptHook(hook, payload, ctx).catch((error: unknown) => ({ failed: String(error) })) : await runCommandHook(hook, payload, env);
				const summary = oneLine(hook.command ?? hook.prompt ?? "", 60);
				const failure = output.failed;
				addLog(`${event} ${summary}: ${failure ? `FAILED ${failure}` : JSON.stringify(output).slice(0, 120)}`);
				if (failure && ctx?.hasUI && !rt.role.subagent) ctx.ui.notify(`Hook ${event} failed: ${failure}`, "warning");
				return output;
			}),
		);
		return results;
	};

	const anyHook = (...events: string[]) => hooks.some((hook) => events.includes(hook.event));

	const mergeVerdict = (outputs: HookOutput[]): ToolVerdict & { updatedInput?: Record<string, unknown> } => {
		const verdict: ToolVerdict & { updatedInput?: Record<string, unknown> } = {};
		for (const output of outputs) {
			if (output.updated_input) verdict.updatedInput = { ...verdict.updatedInput, ...output.updated_input };
			const rank = { allow: 1, ask: 2, deny: 3 } as const;
			if (output.permission && rank[output.permission] > (verdict.permission ? rank[verdict.permission] : 0)) {
				verdict.permission = output.permission;
				verdict.message = output.agent_message ?? output.user_message;
			}
		}
		return verdict;
	};

	pi.on("session_start", async (_event, ctx) => {
		load();
		if (anyHook("sessionStart")) {
			const outputs = await run("sessionStart", { session_id: ctx.sessionManager.getSessionId(), is_background_agent: rt.role.subagent });
			extraContext = outputs.map((output) => output.additional_context).filter(Boolean).join("\n\n") || undefined;
		}
	});

	pi.on("session_shutdown", async (event) => {
		if (anyHook("sessionEnd")) await run("sessionEnd", { reason: event.reason });
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension" || !anyHook("beforeSubmitPrompt")) return { action: "continue" };
		const outputs = await run("beforeSubmitPrompt", { prompt: event.text, attachments: [] }, "UserPromptSubmit");
		const blocked = outputs.find((output) => output.continue === false || output.permission === "deny");
		if (blocked) {
			ctx.ui.notify(blocked.user_message ?? "A hook blocked this prompt.", "warning");
			return { action: "handled" };
		}
		return { action: "continue" };
	});

	pi.on("before_agent_start", (event) => {
		if (event.messageType === "user") {
			generationId = randomUUID();
			stopLoops = 0;
		}
		if (extraContext) event.systemPromptOptions.sections.hook_context = extraContext;
	});

	pi.on("tool_result", async (event) => {
		const toolType = cursorToolName(event.toolName);
		const input = event.input as Record<string, unknown>;
		const output = event.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		const additions: string[] = [];
		if (anyHook("postToolUse", "postToolUseFailure")) {
			const name = event.isError ? "postToolUseFailure" : "postToolUse";
			const outputs = await run(name, { tool_name: toolType, tool_input: input, tool_use_id: event.toolCallId, cwd: rt.cwd, ...(event.isError ? { error_message: output } : { tool_output: output }) }, toolType);
			for (const item of outputs) if (item.additional_context) additions.push(item.additional_context);
		}
		if (event.toolName === "bash" && anyHook("afterShellExecution")) {
			await run("afterShellExecution", { command: input.command, output, cwd: rt.cwd }, String(input.command));
		}
		if (event.toolName.startsWith("mcp__") && anyHook("afterMCPExecution")) {
			await run("afterMCPExecution", { tool_name: event.toolName, tool_input: JSON.stringify(input), result_json: output }, event.toolName);
		}
		if ((event.toolName === "edit" || event.toolName === "write") && !event.isError && anyHook("afterFileEdit")) {
			const edits = event.toolName === "write" ? [{ old_string: "", new_string: input.content }] : ((input.edits as Array<{ oldText: string; newText: string }> | undefined) ?? []).map((edit) => ({ old_string: edit.oldText, new_string: edit.newText }));
			await run("afterFileEdit", { file_path: path.resolve(rt.cwd, String(input.path ?? "")), edits }, "Write");
		}
		if (additions.length > 0) return { content: [...event.content, { type: "text" as const, text: `\n\n${additions.join("\n\n")}` }] };
		return undefined;
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant" || !anyHook("afterAgentResponse", "afterAgentThought")) return;
		const content = event.message.content;
		const text = content.filter((part) => part.type === "text").map((part) => (part as { text: string }).text).join("\n");
		const thinking = content.filter((part) => part.type === "thinking").map((part) => (part as { thinking: string }).thinking).join("\n");
		if (text) void run("afterAgentResponse", { text });
		if (thinking) void run("afterAgentThought", { text: thinking });
	});

	pi.on("session_before_compact", async (event) => {
		if (anyHook("preCompact")) await run("preCompact", { trigger: event.reason === "manual" ? "manual" : "auto", custom_instructions: event.customInstructions ?? "" });
	});

	pi.on("agent_before_settle", async (event) => {
		if (!anyHook("stop")) return;
		const limit = Math.min(...hooks.filter((hook) => hook.event === "stop").map((hook) => hook.loopLimit ?? 5));
		const outputs = await run("stop", { status: "completed", loop_count: stopLoops });
		const followup = outputs.find((output) => output.followup_message)?.followup_message;
		if (!followup || stopLoops >= limit) return;
		stopLoops++;
		return {
			entries: [...event.entries, { type: "custom_message" as const, customType: "pi-cursor.hook", content: followup, display: true }],
			continue: true,
		};
	});

	pi.on("agent_settled", async (event) => {
		if (event.aborted && anyHook("stop")) await run("stop", { status: "aborted", loop_count: stopLoops });
	});

	return {
		list: () => hooks,
		log: () => logLines,
		async beforeTool(toolName, toolCallId, input, ctx) {
			if (hooks.length === 0) return {};
			const toolType = cursorToolName(toolName);
			const outputs: HookOutput[] = [];
			if (anyHook("preToolUse")) outputs.push(...(await run("preToolUse", { tool_name: toolType, tool_input: input, tool_use_id: toolCallId, cwd: rt.cwd }, toolType)));
			const shellCommand = toolName === "bash" || (toolName === "background_shell" && input.action === "start") ? input.command : undefined;
			if (shellCommand !== undefined && anyHook("beforeShellExecution")) outputs.push(...(await run("beforeShellExecution", { command: shellCommand, cwd: rt.cwd }, String(shellCommand))));
			if (toolName.startsWith("mcp__") && anyHook("beforeMCPExecution")) outputs.push(...(await run("beforeMCPExecution", { tool_name: toolName, tool_input: JSON.stringify(input) }, toolName)));
			if (toolName === "read" && anyHook("beforeReadFile")) {
				const file = path.resolve(rt.cwd, String(input.path ?? ""));
				let content = "";
				try {
					content = fs.readFileSync(file, "utf8");
				} catch {
					// The read tool reports missing files itself.
				}
				outputs.push(...(await run("beforeReadFile", { file_path: file, content, attachments: [] }, "Read")));
			}
			const verdict = mergeVerdict(outputs);
			if (verdict.updatedInput) Object.assign(input, verdict.updatedInput);
			if (verdict.permission === "deny" && ctx.hasUI && !rt.role.subagent) {
				const notice = outputs.find((output) => output.permission === "deny")?.user_message;
				if (notice) ctx.ui.notify(notice, "warning");
			}
			return verdict;
		},
		async beforeSubagent(agent, prompt) {
			if (!anyHook("subagentStart")) return undefined;
			const outputs = await run("subagentStart", { subagent_type: agent, task: prompt }, agent);
			const denied = outputs.find((output) => output.permission === "deny");
			return denied ? (denied.user_message ?? denied.agent_message ?? "denied") : undefined;
		},
		async afterSubagent(task) {
			if (!anyHook("subagentStop")) return undefined;
			const outputs = await run("subagentStop", { subagent_type: task.agent, status: task.status, task: task.prompt, result: task.finalText ?? "", duration_ms: (task.endedAt ?? 0) - (task.startedAt ?? 0) }, task.agent);
			return outputs.find((output) => output.followup_message)?.followup_message;
		},
	};
}
