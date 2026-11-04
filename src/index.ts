/**
 * pi-cursor: Cursor's agent workflows for Pi. Modes, rules, skills, custom agents, sub-agents, hooks,
 * approvals, checkpoints and a Cursor-like interface.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRuntime, type Runtime } from "./core/runtime.ts";
import { setupDebug } from "./modes/debug.ts";
import { setupModes } from "./modes/modes.ts";
import { setupPlan } from "./modes/plan.ts";
import { setupRules } from "./rules/rules.ts";
import { getTaskManager, isActive } from "./subagents/manager.ts";
import { setupTaskPanel } from "./subagents/panel.ts";
import { setupSubagentTools } from "./subagents/tools.ts";
import { setupAskQuestion } from "./tools/ask-question.ts";
import { setupBackgroundShell } from "./tools/background-shell.ts";
import { setupTodos } from "./tools/todo.ts";
import { setupWebTools } from "./tools/web.ts";
import { applyTheme, installChrome, workingMessageFor } from "./ui/chrome.ts";
import { registerCommands } from "./ui/commands.ts";
import { installToolRows } from "./ui/toolrows.ts";
import { setupApprovals } from "./workflow/approvals.ts";
import { setupCheckpoints } from "./workflow/checkpoints.ts";
import { setupCompaction } from "./workflow/compaction.ts";
import { setupGoal } from "./workflow/goal.ts";
import { setupHooks } from "./workflow/hooks.ts";
import { setupLoop } from "./workflow/loop.ts";
import { setupCursorMcp } from "./workflow/mcp.ts";
import { setupResources } from "./workflow/resources.ts";

export default function piCursor(pi: ExtensionAPI): void {
	const rt = createRuntime(pi);

	// Must run before every other session_start handler, since they all read the refreshed runtime.
	pi.on("session_start", async (_event, ctx) => {
		await rt.refresh(ctx);
	});

	const modes = setupModes(rt);
	const rules = setupRules(rt);
	const approvals = setupApprovals(rt);
	const hooks = setupHooks(rt);
	const mcp = setupCursorMcp(rt);
	setupResources(rt);
	const subagents = setupSubagentTools(
		rt,
		(ctx) => ({
			PI_CURSOR_HEADLESS: ctx?.hasUI && process.env.PI_CURSOR_HEADLESS !== "1" ? "0" : "1",
			PI_CURSOR_APPROVALS: approvals.mode(),
			PI_CURSOR_EXEC_HASH: rt.execTrusted ? rt.execHash : "",
		}),
		() => !rt.role.subagent && modes.current().readonly,
	);
	subagents.setGate({ beforeSpawn: hooks.beforeSubagent, afterFinish: hooks.afterSubagent });
	setupAskQuestion(rt);
	const todos = setupTodos(rt);
	setupWebTools(rt);
	setupBackgroundShell(rt);
	const checkpoints = setupCheckpoints(rt);
	// After the hooks, so a preCompact hook runs before the summary is requested.
	const compaction = setupCompaction(rt);

	// One gate, in a fixed order: mode policy, then hooks, then checkpoint, then approvals.
	pi.on("tool_call", async (event, ctx) => {
		const input = event.input as Record<string, unknown>;
		const denied = modes.check(event.toolName, input);
		if (denied) return { block: true, reason: denied };
		const verdict = await hooks.beforeTool(event.toolName, event.toolCallId, input, ctx);
		// A hook may have rewritten the input, which then has to satisfy the mode as well.
		const deniedAfterHooks = modes.check(event.toolName, input);
		if (deniedAfterHooks) return { block: true, reason: deniedAfterHooks };
		const reason = await approvals.check(event.toolName, input, ctx, verdict);
		if (reason) return { block: true, reason };
		await checkpoints.beforeTool(event.toolName, input, ctx);
		return undefined;
	});

	if (rt.role.subagent) return;
	setupInteractive(rt, { modes, rules, subagents, approvals, hooks, mcp, todos, checkpoints, compaction });
}

function setupInteractive(
	rt: Runtime,
	shared: Pick<Parameters<typeof registerCommands>[1], "modes" | "rules" | "subagents" | "approvals" | "hooks" | "mcp" | "todos" | "checkpoints" | "compaction">,
): void {
	const { pi } = rt;
	const { modes, rules, subagents, approvals, mcp } = shared;
	setupDebug(rt);
	const plan = setupPlan(rt, modes, shared.todos);
	const goal = setupGoal(rt);
	const loop = setupLoop(rt);
	const panel = setupTaskPanel(rt, subagents);
	registerCommands(rt, { ...shared, plan, goal, loop, panel });
	installToolRows(pi, () => rt.config.ui.toolRows);

	modes.onChange((mode) => {
		const ctx = rt.ctx;
		if (ctx?.mode === "tui") ctx.ui.setWorkingMessage(workingMessageFor(mode.id));
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		installChrome(rt, ctx, {
			modes,
			ctx: () => rt.ctx,
			thinking: () => pi.getThinkingLevel(),
			badge: () => panel.badge(ctx.ui.theme),
			detachForeground: () => {
				const moved = getTaskManager().detachForeground(subagents.sessionId());
				if (moved > 0) ctx.ui.notify(`Moved ${moved} agent${moved === 1 ? "" : "s"} to the background.`, "info");
				return moved > 0;
			},
			placeholder: () => (modes.current().id === "plan" ? "Describe what to plan, @ to mention, / for commands" : modes.current().id === "ask" ? "Ask about the code, @ to mention, / for commands" : modes.current().id === "debug" ? "Describe the bug, @ to mention, / for commands" : "Describe what to build, @ to mention, / for commands"),
			stats: () => {
				const counts = rules.stats();
				const total = counts.always + counts.auto + counts.agent + counts.manual;
				const skills = pi.getCommands().filter((command) => command.source === "skill").length;
				const servers = mcp.imported().length;
				return [`${total} rules`, `${skills} skills`, `${subagents.agents().length} agents`, servers ? `${servers} MCP` : ""].filter(Boolean).join(" · ");
			},
			approvals: () => (approvals.mode() === "auto" ? "auto-run" : approvals.mode()),
			extraCost: () =>
				getTaskManager()
					.list(subagents.sessionId())
					.filter((task) => task.background || isActive(task))
					.reduce((sum, task) => sum + task.usage.cost, 0),
		});
		ctx.ui.setWorkingMessage(workingMessageFor(modes.current().id));
	});

	pi.on("resources_discover", (_event, ctx) => {
		// Themes from the package are only registered once this event has been handled.
		if (ctx.mode === "tui") setTimeout(() => applyTheme(rt, ctx), 0);
		return {};
	});
}
