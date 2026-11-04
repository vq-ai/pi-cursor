/** `/goal <objective>`: keeps the agent working across turns until it reports the objective done. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Runtime } from "../core/runtime.ts";
import { stringEnum } from "../core/schema.ts";
import { oneLine } from "../core/text.ts";

const STATE_ENTRY = "pi-cursor.goal";
const STATUS = "pi-cursor.goal";
const MAX_CONTINUATIONS = 40;
const MAX_IDLE_CONTINUATIONS = 3;

interface GoalState {
	objective?: string;
}

export interface GoalApi {
	current(): string | undefined;
	set(objective: string | undefined, ctx: ExtensionContext): void;
}

export function setupGoal(rt: Runtime): GoalApi {
	const { pi } = rt;
	let objective: string | undefined;
	let continuations = 0;
	let idleContinuations = 0;
	let toolsThisRun = 0;

	const updateStatus = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setStatus(STATUS, objective ? ctx.ui.theme.fg("accent", `◎ goal: ${oneLine(objective, 30)}`) : undefined);
	};

	const syncTool = () => {
		const active = pi.getActiveTools();
		const has = active.includes("goal_update");
		if (objective && !has) pi.setActiveTools([...active, "goal_update"]);
		if (!objective && has) pi.setActiveTools(active.filter((name) => name !== "goal_update"));
	};

	const set: GoalApi["set"] = (next, ctx) => {
		objective = next;
		continuations = 0;
		idleContinuations = 0;
		pi.appendEntry(STATE_ENTRY, { objective } satisfies GoalState);
		syncTool();
		updateStatus(ctx);
	};

	pi.on("session_start", (_event, ctx) => {
		objective = undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_ENTRY) objective = (entry.data as GoalState).objective;
		}
		syncTool();
		updateStatus(ctx);
	});

	pi.on("before_agent_start", (event) => {
		// Switching modes rebuilds the active tool set.
		syncTool();
		if (objective) {
			event.systemPromptOptions.sections.active_goal = `The user set a goal that stays active across turns until it is complete:\n${objective}\n\nKeep the whole objective intact, and do not shrink it to something easier. Inspect the actual state of the code before relying on earlier conclusions. Call goal_update with status "complete" only when the end state is true and you have verified it; call it with status "blocked" if only the user can unblock you.`;
		} else {
			delete event.systemPromptOptions.sections.active_goal;
		}
		if (event.messageType === "user") {
			continuations = 0;
			idleContinuations = 0;
		}
	});

	pi.on("tool_execution_end", (event) => {
		if (event.toolName !== "goal_update") toolsThisRun++;
	});

	pi.on("agent_before_settle", (event, ctx) => {
		if (!objective) return;
		idleContinuations = toolsThisRun === 0 ? idleContinuations + 1 : 0;
		toolsThisRun = 0;
		if (continuations >= MAX_CONTINUATIONS || idleContinuations >= MAX_IDLE_CONTINUATIONS) {
			if (ctx.hasUI) ctx.ui.notify(`Goal paused after ${continuations} automatic continuations. Send a message to resume, or /goal clear.`, "warning");
			return;
		}
		continuations++;
		return {
			entries: [...event.entries, { type: "custom_message" as const, customType: "pi-cursor.goal-continue", content: `The goal is still active: ${objective}\nContinue with the next concrete step toward it. If the objective is complete and verified, call goal_update with status "complete".`, display: false }],
			continue: true,
		};
	});

	pi.registerTool({
		name: "goal_update",
		label: "Goal",
		description: "Report on the active goal set with /goal: complete (the end state is verified) or blocked (only the user can unblock it).",
		parameters: Type.Object({
			status: stringEnum(["complete", "blocked"] as const),
			evidence: Type.String({ description: "What proves the goal is complete, or what is blocking it." }),
		}),
		defaultActive: false,
		annotations: { readOnlyHint: true },
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const finished = objective;
			set(undefined, ctx);
			return {
				content: [{ type: "text", text: params.status === "complete" ? `Goal complete: ${finished}` : `Goal paused as blocked: ${finished}. Tell the user what you need.` }],
				details: { status: params.status, evidence: params.evidence, objective: finished },
			};
		},
		renderCall: (args, theme) => new Text(`${theme.fg("accent", "◎")} ${theme.fg("toolTitle", `Goal ${args.status}`)}`, 0, 0),
		renderResult: (result, _options, theme) => new Text(`  ${theme.fg("muted", oneLine((result.details as { evidence?: string }).evidence ?? "", 200))}`, 0, 0),
	});

	return { current: () => objective, set };
}
