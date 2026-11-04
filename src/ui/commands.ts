/** Slash commands, keyboard shortcuts and `@` completion. */

import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { configPaths, relativeToCwd, type ApprovalMode, type Runtime } from "../core/runtime.ts";
import { oneLine } from "../core/text.ts";
import type { ModesApi } from "../modes/modes.ts";
import { listPlans, type PlanApi } from "../modes/plan.ts";
import { describeRule, type RulesApi } from "../rules/rules.ts";
import { getTaskManager, isActive } from "../subagents/manager.ts";
import type { PanelApi } from "../subagents/panel.ts";
import type { SubagentsApi } from "../subagents/tools.ts";
import type { TodosApi } from "../tools/todo.ts";
import type { ApprovalsApi } from "../workflow/approvals.ts";
import type { CheckpointsApi } from "../workflow/checkpoints.ts";
import type { GoalApi } from "../workflow/goal.ts";
import type { HooksApi } from "../workflow/hooks.ts";
import type { LoopApi } from "../workflow/loop.ts";
import type { McpApi } from "../workflow/mcp.ts";
import { colorizeDiff, showViewer } from "./viewer.ts";

export interface CommandDeps {
	modes: ModesApi;
	rules: RulesApi;
	subagents: SubagentsApi;
	panel: PanelApi;
	plan: PlanApi;
	todos: TodosApi;
	approvals: ApprovalsApi;
	checkpoints: CheckpointsApi;
	compaction: { lastOutcome(): string | undefined };
	goal: GoalApi;
	hooks: HooksApi;
	loop: LoopApi;
	mcp: McpApi;
}

/** Built-in Pi commands an agent's `/name` command must not shadow. */
const RESERVED = new Set(["settings", "model", "thinking", "scoped-models", "login", "logout", "llama", "new", "resume", "name", "session", "tree", "fork", "clone", "compact", "import", "copy", "export", "share", "bug", "trust", "mcp", "reload", "hotkeys", "changelog", "quit"]);

/** Sends a prompt from a command. Without a UI the process exits once the command returns, so it waits for the run. */
async function send(pi: ExtensionAPI, ctx: ExtensionCommandContext, text: string): Promise<void> {
	if (ctx.isIdle()) pi.sendUserMessage(text);
	else pi.sendUserMessage(text, { deliverAs: "followUp" });
	if (ctx.mode === "print" || ctx.mode === "json") {
		await new Promise((resolve) => setImmediate(resolve));
		await ctx.waitForIdle();
	}
}

export function registerCommands(rt: Runtime, deps: CommandDeps): void {
	const { pi } = rt;
	const { modes, rules, subagents, panel, plan, todos, approvals, checkpoints, compaction, goal, hooks, loop, mcp } = deps;

	const modeCommand = (name: string, target: string, description: string) => {
		pi.registerCommand(name, {
			description,
			handler: async (args, ctx) => {
				await modes.set(target, ctx);
				if (args.trim()) await send(pi, ctx, args.trim());
				else ctx.ui.notify(`${modes.current().label} mode: ${modes.current().description}`, "info");
			},
		});
	};
	modeCommand("implement", "implement", "Switch to Implement mode; add text to send it as a prompt");
	modeCommand("agent", "implement", "Alias for /implement");
	modeCommand("plan", "plan", "Switch to Plan mode; add text to start planning it");
	modeCommand("ask", "ask", "Switch to read-only Ask mode; add text to ask it");
	modeCommand("debug", "debug", "Switch to Debug mode; add text to start debugging it");

	const pickMode = async (ctx: ExtensionContext) => {
		const all = modes.all();
		const labels = all.map((mode) => `${mode.icon} ${mode.label}  ${mode.description}${mode.id === modes.current().id ? "  (current)" : ""}`);
		const choice = await ctx.ui.select("Mode", labels);
		if (choice !== undefined) await modes.set((all[labels.indexOf(choice)] as (typeof all)[number]).id, ctx);
	};

	pi.registerCommand("mode", {
		description: "Pick a mode, or switch directly with /mode <name>",
		getArgumentCompletions: (prefix) => {
			const items = modes.all().filter((mode) => mode.id.startsWith(prefix)).map((mode) => ({ value: mode.id, label: mode.id, description: mode.description }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!name) return pickMode(ctx);
			if (!(await modes.set(name, ctx))) ctx.ui.notify(`No mode named ${name}. Available: ${modes.all().map((mode) => mode.id).join(", ")}`, "warning");
		},
	});

	pi.registerShortcut("alt+m", { description: "Pick a mode", handler: async (ctx) => pickMode(ctx) });
	pi.registerShortcut("alt+a", { description: "Open the agents panel", handler: async (ctx) => panel.open(ctx) });

	pi.registerCommand("rules", {
		description: "Show rules; attach, disable or view them. /rules new creates one",
		handler: async (args, ctx) => {
			if (args.trim().startsWith("new")) {
				pi.sendUserMessage(`/skill:create-rule ${args.trim().slice(3).trim()}`.trim(), { expandPromptTemplates: true });
				return;
			}
			const all = rules.rules();
			if (all.length === 0) {
				const skipped = rules.skipped().length ? ` ${rules.skipped().length} skipped; see /pi-cursor.` : "";
				ctx.ui.notify(`No rules apply. Add .mdc files to .cursor/rules or ~/.cursor/rules, or run /rules new.${skipped}`, "info");
				return;
			}
			const stateOf = (rule: (typeof all)[number]) => (rules.disabled().has(rule.id) ? "off" : rule.type === "always" || rules.attached().has(rule.id) ? "active" : "ready");
			const labels = all.map((rule) => `[${stateOf(rule)}] ${rule.name}  ${describeRule(rule)}`);
			const choice = await ctx.ui.select("Rules", labels);
			if (choice === undefined) return;
			const rule = all[labels.indexOf(choice)] as (typeof all)[number];
			const off = rules.disabled().has(rule.id);
			const action = await ctx.ui.select(rule.name, ["View", "Attach to this conversation", off ? "Enable" : "Disable for this conversation"]);
			if (action === "View") await showViewer(ctx, relativeToCwd(rt, rule.path), rule.body);
			else if (action === "Attach to this conversation") rules.attach(rule);
			else if (action === "Enable") rules.setDisabled(rule, false);
			else if (action) rules.setDisabled(rule, true);
		},
	});

	pi.registerCommand("agents", {
		description: "Show custom agents and start one. /agents new creates one",
		handler: async (args, ctx) => {
			if (args.trim().startsWith("new")) {
				pi.sendUserMessage(`/skill:create-subagent ${args.trim().slice(3).trim()}`.trim(), { expandPromptTemplates: true });
				return;
			}
			subagents.refreshAgents();
			const all = subagents.agents();
			const labels = all.map((agent) => `${agent.name}  [${agent.scope}${agent.readonly ? ", read-only" : ""}]  ${oneLine(agent.description, 70)}`);
			const choice = await ctx.ui.select("Agents", labels);
			if (choice === undefined) return;
			const agent = all[labels.indexOf(choice)] as (typeof all)[number];
			const action = await ctx.ui.select(agent.name, ["Run in the background…", "View"]);
			if (action === "View") await showViewer(ctx, agent.path ? relativeToCwd(rt, agent.path) : agent.name, `${agent.description}\n\n${agent.prompt}`);
			else if (action) {
				const prompt = await ctx.ui.input(`Task for ${agent.name}`);
				if (prompt?.trim()) await subagents.spawnFromCommand({ agent: agent.name, prompt: prompt.trim(), background: true }, ctx);
			}
		},
	});

	pi.registerCommand("tasks", {
		description: "Open the agents panel: watch, steer, stop, resume, apply",
		handler: async (_args, ctx) => panel.open(ctx),
	});

	pi.registerCommand("bg", {
		description: "Run a prompt in a background agent: /bg [--agent name] [--worktree] [--model m] <prompt>",
		handler: async (args, ctx) => {
			let rest = args.trim();
			let agent: string | undefined;
			let model: string | undefined;
			let isolation: "worktree" | undefined;
			for (;;) {
				const flag = /^--(worktree|agent|model)(?:\s+|$)/.exec(rest);
				if (!flag) break;
				rest = rest.slice(flag[0].length);
				if (flag[1] === "worktree") {
					isolation = "worktree";
					continue;
				}
				const value = /^\S+/.exec(rest)?.[0];
				rest = rest.slice(value?.length ?? 0).trimStart();
				if (flag[1] === "agent") agent = value;
				else model = value;
			}
			if (!rest) {
				ctx.ui.notify("Usage: /bg [--agent name] [--worktree] [--model m] <prompt>", "warning");
				return;
			}
			try {
				const task = await subagents.spawnFromCommand({ agent, prompt: rest, background: true, isolation, model }, ctx);
				ctx.ui.notify(`Started ${task.agent} in the background (${task.id}). alt+a to watch it.`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("bestof", {
		description: "Run competing attempts in worktrees and pick the best: /bestof <n or model,model> <prompt>",
		handler: async (args, ctx) => {
			const match = /^(\S+)\s+([\s\S]+)$/.exec(args.trim());
			if (!match) {
				ctx.ui.notify("Usage: /bestof <n or model,model> <prompt>", "warning");
				return;
			}
			const spec = match[1] as string;
			const models = /^\d+$/.test(spec) ? "" : `models ${JSON.stringify(spec.split(","))}`;
			const count = /^\d+$/.test(spec) ? `n ${spec}` : "";
			await send(pi, ctx, `Use task_group with mode best_of_n and ${models || count} for the task below. When the attempts finish, compare their diffs, recommend one, and use ask_question to let me pick which to apply. Apply the choice with task_control and discard the rest.\n\nTask:\n${match[2]}`);
		},
	});

	pi.registerCommand("plans", {
		description: "List saved plans; view or build one",
		handler: async (_args, ctx) => {
			const plans = listPlans(rt.root);
			if (plans.length === 0) {
				ctx.ui.notify("No plans yet. Switch to Plan mode with /plan.", "info");
				return;
			}
			const labels = plans.map((item) => `${item.title}  ${oneLine(item.overview, 60)}`);
			const choice = await ctx.ui.select("Plans", labels);
			if (choice === undefined) return;
			const picked = plans[labels.indexOf(choice)] as (typeof plans)[number];
			const action = await ctx.ui.select(picked.title, ["Build it", "View"]);
			if (action === "Build it") await plan.build(picked, ctx);
			else if (action === "View") await showViewer(ctx, path.basename(picked.path), picked.body);
		},
	});

	pi.registerCommand("build", {
		description: "Build the most recent plan in Implement mode",
		handler: async (_args, ctx) => {
			const latest = listPlans(rt.root)[0];
			if (!latest) ctx.ui.notify("No plans yet. Switch to Plan mode with /plan.", "info");
			else await plan.build(latest, ctx);
		},
	});

	pi.registerCommand("todos", {
		description: "Show the checklist. /todos clear empties it",
		handler: async (args, ctx) => {
			if (args.trim() === "clear") {
				todos.clear(ctx);
				return;
			}
			const list = todos.list();
			ctx.ui.notify(list.length ? list.map((todo) => `${todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "◐" : "○"} ${todo.content}`).join("\n") : "The checklist is empty.", "info");
		},
	});

	pi.registerCommand("goal", {
		description: "Keep working until an objective is done: /goal <objective>, /goal clear",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (text === "clear") {
				goal.set(undefined, ctx);
				ctx.ui.notify("Goal cleared.", "info");
			} else if (!text) {
				ctx.ui.notify(goal.current() ? `Goal: ${goal.current()}` : "Usage: /goal <objective>", "info");
			} else {
				goal.set(text, ctx);
				await send(pi, ctx, `New goal: ${text}\n\nRestate the objective with the deliverables you will verify against, then start on the first concrete step now.`);
			}
		},
	});

	pi.registerCommand("loop", {
		description: "Repeat a prompt on an interval: /loop 5m <prompt>, /loop stop",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) ctx.ui.notify(loop.describe() ? `Loop: ${loop.describe()}` : "Usage: /loop [interval] <prompt>", "info");
			else if (text === "stop") ctx.ui.notify(loop.stop(ctx) ? "Loop stopped." : "No loop is running.", "info");
			else loop.start(text, ctx);
		},
	});

	const restore = async (_args: string, ctx: ExtensionCommandContext) => checkpoints.restoreCommand(ctx);
	pi.registerCommand("restore", { description: "Roll files and/or conversation back to before an earlier prompt", handler: restore });
	pi.registerCommand("rewind", { description: "Alias for /restore", handler: restore });

	pi.registerCommand("changes", {
		description: "Review everything changed since the session's first checkpoint; revert files",
		handler: async (_args, ctx) => {
			const repo = checkpoints.repo();
			const baseline = checkpoints.baseline(ctx);
			if (!repo || !baseline) {
				ctx.ui.notify("No checkpoint yet, so there is nothing to compare against.", "info");
				return;
			}
			for (;;) {
				const current = await repo.snapshot();
				const changes = await repo.changedFiles(baseline.tree, current);
				if (changes.length === 0) {
					ctx.ui.notify("No changes since the first checkpoint.", "info");
					return;
				}
				const labels = changes.map((change) => `${change.status}  ${change.path}`);
				const everything = `Show the whole diff (${changes.length} files)`;
				const choice = await ctx.ui.select("Changes since the first checkpoint", [everything, ...labels]);
				if (choice === undefined) return;
				if (choice === everything) {
					const diff = await repo.diff(baseline.tree, current);
					await showViewer(ctx, "All changes", (theme) => colorizeDiff(diff, theme));
					continue;
				}
				const change = changes[labels.indexOf(choice)] as (typeof changes)[number];
				const action = await ctx.ui.select(change.path, ["View diff", "Revert this file", "Back"]);
				if (action === "View diff") {
					const diff = await repo.diff(baseline.tree, current, change.path);
					await showViewer(ctx, change.path, (theme) => colorizeDiff(diff, theme));
				} else if (action === "Revert this file") {
					await repo.revertFile(baseline.tree, change.path);
					ctx.ui.notify(`Reverted ${change.path}.`, "info");
				}
			}
		},
	});

	pi.registerCommand("approvals", {
		description: "How much runs without asking: /approvals auto|allowlist|ask",
		getArgumentCompletions: (prefix) => {
			const items = ["auto", "allowlist", "ask"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			let value = args.trim();
			if (!value) {
				const options = ["auto: run everything", "allowlist: ask for commands not known to be safe", "ask: also ask before edits"];
				const choice = await ctx.ui.select(`Approvals (now ${approvals.mode()})`, options);
				if (choice === undefined) return;
				value = choice.split(":")[0] as string;
			}
			if (!["auto", "allowlist", "ask"].includes(value)) {
				ctx.ui.notify("Choose auto, allowlist or ask.", "warning");
				return;
			}
			approvals.setMode(value as ApprovalMode);
			ctx.ui.notify(`Approvals: ${value}. To keep this for new sessions, set "approvals" in ${configPaths(rt.root).user}.`, "info");
		},
	});

	pi.registerCommand("hooks", {
		description: "Show loaded hooks and their recent runs",
		handler: async (_args, ctx) => {
			const list = hooks.list();
			const body = [
				list.length ? list.map((hook) => `${hook.event}  [${hook.source}]  ${hook.matcher ? `/${hook.matcher}/ ` : ""}${oneLine(hook.command ?? hook.prompt ?? "", 80)}`).join("\n") : "No hooks loaded. Add .cursor/hooks.json or ~/.cursor/hooks.json.",
				"",
				"Recent runs:",
				hooks.log().slice(-40).join("\n") || "(none)",
			].join("\n");
			await showViewer(ctx, "Hooks", body);
		},
	});

	pi.registerCommand("pi-cursor", {
		description: "Show what pi-cursor loaded for this workspace",
		handler: async (_args, ctx) => {
			const stats = rules.stats();
			const skills = pi.getCommands().filter((command) => command.source === "skill").length;
			const tasks = getTaskManager().list(subagents.sessionId());
			const trust = rt.projectTrusted ? (rt.execTrusted ? "trusted" : "instructions only (hooks, MCP and worktree setup need approval)") : "not trusted: workspace config ignored";
			const body = [
				`Workspace: ${rt.root}`,
				`Trust: ${trust}`,
				`Mode: ${modes.current().label} (${modes.all().map((mode) => mode.id).join(", ")})`,
				`Approvals: ${approvals.mode()}`,
				`Rules: ${stats.always} always, ${stats.auto} glob, ${stats.agent} on request, ${stats.manual} manual`,
				...rules.skipped().map((rule) => `  skipped ${rule.name}: ${rule.reason}`),
				`Skills: ${skills}`,
				`Agents: ${subagents.agents().map((agent) => agent.name).join(", ")}`,
				`Hooks: ${hooks.list().length}`,
				`MCP servers from Cursor config: ${mcp.imported().join(", ") || "none"}${mcp.errors().length ? `\nMCP errors:\n${mcp.errors().join("\n")}` : ""}`,
				`Agents this session: ${tasks.filter(isActive).length} running, ${tasks.length} total`,
				`Checkpoints: ${checkpoints.repo() ? `on (${checkpoints.list(ctx).length} on this branch)` : "off"}`,
				`Compaction: ${rt.config.compaction.sharedCache ? "from the prompt cache when possible" : "separate request"}${compaction.lastOutcome() ? `\n  last: ${compaction.lastOutcome()}` : ""}`,
				`Config: ${configPaths(rt.root).user}`,
			].join("\n");
			await showViewer(ctx, "pi-cursor", body);
		},
	});

	// `/explore find the auth code` and so on, as Cursor offers for each custom agent.
	const registered = new Set<string>();
	pi.on("session_start", (_event, ctx) => {
		const taken = new Set(pi.getCommands().map((command) => command.name));
		for (const agent of subagents.agents()) {
			if (RESERVED.has(agent.name) || registered.has(agent.name) || taken.has(agent.name) || !/^[a-z0-9][a-z0-9-]*$/.test(agent.name)) continue;
			registered.add(agent.name);
			pi.registerCommand(agent.name, {
				description: `Agent: ${oneLine(agent.description, 80)}`,
				handler: async (args, commandCtx) => {
					if (!args.trim()) {
						commandCtx.ui.notify(`Usage: /${agent.name} <task>`, "warning");
						return;
					}
					await send(pi, commandCtx, `Use the task tool with subagent_type "${agent.name}" for this. Pass along everything it needs from this conversation.\n\n${args.trim()}`);
				},
			});
		}
		if (ctx.mode !== "tui") return;
		// Adds rules and agents to the `@` menu, alongside file completion.
		ctx.ui.addAutocompleteProvider((current) => ({
			triggerCharacters: current.triggerCharacters,
			async getSuggestions(lines, line, col, options) {
				const before = (lines[line] ?? "").slice(0, col);
				const match = /(?:^|\s)@([\w.-]*)$/.exec(before);
				const base = await current.getSuggestions(lines, line, col, options);
				if (!match) return base;
				const query = (match[1] as string).toLowerCase();
				const extra = [
					...rules.rules().filter((rule) => rule.name.toLowerCase().includes(query)).map((rule) => ({ value: `@${rule.name}`, label: `@${rule.name}`, description: `rule · ${describeRule(rule)}` })),
				].slice(0, 8);
				if (extra.length === 0) return base;
				return { prefix: `@${match[1]}`, items: [...extra, ...(base?.items ?? [])] };
			},
			applyCompletion: (lines, line, col, item, prefix) => current.applyCompletion(lines, line, col, item, prefix),
			shouldTriggerFileCompletion: (lines, line, col) => current.shouldTriggerFileCompletion?.(lines, line, col) ?? true,
		}));
	});

}
