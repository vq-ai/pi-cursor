/**
 * Ask / Plan / Debug / Implement modes and custom modes from `.cursor/modes/*.md` and friends.
 * A mode is a prompt section plus a tool policy that is enforced at `tool_call`, not just requested.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isReadOnlyCommand } from "../core/shell.ts";
import { getTaskManager } from "../subagents/manager.ts";
import { configDirs, type Runtime } from "../core/runtime.ts";
import { asBoolean, asList, asString, parseFrontmatter } from "../core/text.ts";
import { ASK_PROMPT, DEBUG_PROMPT, IMPLEMENT_PROMPT, PLAN_PROMPT } from "./prompts.ts";

export interface ModeDef {
	id: string;
	label: string;
	icon: string;
	/** Theme color for the composer border and mode label. */
	color: "muted" | "success" | "warning" | "error" | "accent";
	description: string;
	prompt: string;
	readonly: boolean;
	tools?: string[];
	model?: string;
	thinking?: string;
	builtin: boolean;
}

export const BUILTIN_MODES: ModeDef[] = [
	{ id: "implement", label: "Implement", icon: "∞", color: "accent", description: "Build and change code, with all tools", prompt: IMPLEMENT_PROMPT, readonly: false, builtin: true },
	{ id: "plan", label: "Plan", icon: "≡", color: "warning", description: "Research, ask questions, write a plan to approve", prompt: PLAN_PROMPT, readonly: true, builtin: true },
	{ id: "ask", label: "Ask", icon: "?", color: "success", description: "Read-only questions about the code", prompt: ASK_PROMPT, readonly: true, builtin: true },
	{ id: "debug", label: "Debug", icon: "✱", color: "error", description: "Find root causes using runtime evidence", prompt: DEBUG_PROMPT, readonly: false, builtin: true },
];

const ALIASES: Record<string, string> = { agent: "implement", build: "implement", code: "implement" };

/** Tools that never change the workspace, so read-only modes may always use them. */
export const READ_ONLY_TOOLS = new Set([
	"read", "grep", "find", "ls", "ask_question", "todo_write", "web_fetch", "web_search", "task_control", "codemode", "tool_search",
	"mcp_list_resources", "mcp_read_resource", "create_plan", "goal_update",
]);

const MODE_ONLY_TOOLS = new Set(["create_plan", "debug_session", "goal_update"]);
const STATE_ENTRY = "pi-cursor.mode";
const DEFAULT_ACTIVE_EXTRAS = ["grep", "find", "ls"];

function loadCustomModes(rt: Runtime): ModeDef[] {
	const modes = new Map<string, ModeDef>();
	for (const { dir } of configDirs(rt, "modes").reverse()) {
		let files: string[];
		try {
			files = fs.readdirSync(dir);
		} catch {
			continue;
		}
		for (const file of files) {
			if (!file.endsWith(".md")) continue;
			let raw: string;
			try {
				raw = fs.readFileSync(path.join(dir, file), "utf8");
			} catch {
				continue;
			}
			const { frontmatter, body } = parseFrontmatter(raw);
			const id = asString(frontmatter.name) ?? file.replace(/\.md$/, "");
			if (BUILTIN_MODES.some((mode) => mode.id === id)) continue;
			modes.set(id, {
				id,
				label: id.charAt(0).toUpperCase() + id.slice(1),
				icon: asString(frontmatter.icon) ?? "◆",
				color: "accent",
				description: asString(frontmatter.description) ?? "Custom mode",
				prompt: body.trim(),
				readonly: asBoolean(frontmatter.readonly) ?? false,
				tools: asList(frontmatter.tools).length > 0 ? asList(frontmatter.tools) : undefined,
				model: asString(frontmatter.model),
				thinking: asString(frontmatter.thinking),
				builtin: false,
			});
		}
	}
	return [...modes.values()];
}

export type ModeListener = (mode: ModeDef) => void;

export interface ModesApi {
	all(): ModeDef[];
	current(): ModeDef;
	resolve(name: string): ModeDef | undefined;
	set(id: string, ctx: ExtensionContext): Promise<boolean>;
	cycle(ctx: ExtensionContext): Promise<void>;
	onChange(listener: ModeListener): void;
	/** Returns a reason when the current mode forbids this call. May rewrite `input` in place. */
	check(toolName: string, input: Record<string, unknown>): string | undefined;
}

export function setupModes(rt: Runtime): ModesApi {
	const { pi } = rt;
	let custom: ModeDef[] = [];
	let currentId = "implement";
	let baselineTools: string[] | undefined;
	let modelBeforeMode: string | undefined;
	const listeners: ModeListener[] = [];

	const all = () => [...BUILTIN_MODES, ...custom];
	const current = () => all().find((mode) => mode.id === currentId) ?? (BUILTIN_MODES[0] as ModeDef);
	const resolve = (name: string) => {
		const id = ALIASES[name.toLowerCase()] ?? name.toLowerCase();
		return all().find((mode) => mode.id === id);
	};

	const toolAllowed = (mode: ModeDef, name: string): boolean => {
		if (mode.tools) return mode.tools.includes(name) || name === "create_plan";
		if (!mode.readonly) return name !== "create_plan" || mode.id === "plan";
		if (name === "create_plan") return mode.id === "plan";
		if (name === "edit" || name === "write") return false;
		if (READ_ONLY_TOOLS.has(name) || name === "bash" || name === "task" || name === "task_group") return true;
		const info = pi.getAllTools().find((tool) => tool.name === name);
		return info?.annotations?.readOnlyHint === true;
	};

	const applyTools = (mode: ModeDef) => {
		if (!baselineTools) return;
		const names = pi.getAllTools().map((tool) => tool.name);
		const wanted = mode.tools ? names.filter((name) => toolAllowed(mode, name)) : baselineTools.filter((name) => toolAllowed(mode, name));
		const extras = mode.id === "plan" ? ["create_plan"] : mode.id === "debug" ? ["debug_session"] : [];
		pi.setActiveTools([...new Set([...wanted, ...extras])]);
	};

	const applyModel = async (mode: ModeDef, ctx: ExtensionContext) => {
		const override = rt.config.modes[mode.id] ?? {};
		const spec = override.model ?? mode.model;
		const thinking = override.thinking ?? mode.thinking;
		if (spec) {
			const [provider, ...rest] = spec.split("/");
			const model = rest.length > 0 ? ctx.modelRegistry.find(provider as string, rest.join("/")) : undefined;
			if (model) {
				if (!modelBeforeMode && ctx.model) modelBeforeMode = `${ctx.model.provider}/${ctx.model.id}`;
				await pi.setModel(model);
			}
		} else if (modelBeforeMode) {
			const [provider, ...rest] = modelBeforeMode.split("/");
			const model = ctx.modelRegistry.find(provider as string, rest.join("/"));
			modelBeforeMode = undefined;
			if (model) await pi.setModel(model);
		}
		if (thinking) pi.setThinkingLevel(thinking as never);
	};

	const set: ModesApi["set"] = async (id, ctx) => {
		const mode = resolve(id);
		if (!mode) return false;
		const changed = mode.id !== currentId;
		// Tools the user toggled while working in Implement mode should come back after a round trip.
		if (changed && currentId === "implement" && baselineTools) baselineTools = pi.getActiveTools().filter((name) => !MODE_ONLY_TOOLS.has(name));
		currentId = mode.id;
		applyTools(mode);
		await applyModel(mode, ctx);
		if (changed) pi.appendEntry(STATE_ENTRY, { mode: mode.id });
		for (const listener of listeners) listener(mode);
		return true;
	};

	const restoreFromBranch = (ctx: ExtensionContext): string | undefined => {
		let saved: string | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_ENTRY) saved = (entry.data as { mode?: string }).mode;
		}
		return saved;
	};

	pi.registerFlag("start-mode", { description: "Start in this mode (implement, plan, ask, debug or a custom mode)", type: "string" });

	pi.on("session_start", async (_event, ctx) => {
		custom = loadCustomModes(rt);
		const active = pi.getActiveTools();
		const available = new Set(pi.getAllTools().map((tool) => tool.name));
		baselineTools = [...new Set([...active, ...DEFAULT_ACTIVE_EXTRAS.filter((name) => available.has(name))])].filter((name) => !MODE_ONLY_TOOLS.has(name) && (rt.config.web || (name !== "web_fetch" && name !== "web_search")));
		pi.setActiveTools(baselineTools);
		const flag = pi.getFlag("start-mode");
		const requested = typeof flag === "string" ? flag : (restoreFromBranch(ctx) ?? rt.config.defaultMode);
		const target = resolve(requested) ?? (BUILTIN_MODES[0] as ModeDef);
		currentId = target.id;
		if (rt.role.subagent) {
			if (rt.role.readonly) pi.setActiveTools(baselineTools.filter((name) => name !== "edit" && name !== "write"));
			return;
		}
		await set(target.id, ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		const saved = restoreFromBranch(ctx);
		if (saved && saved !== currentId) await set(saved, ctx);
	});

	pi.on("before_agent_start", (event) => {
		if (rt.role.subagent) return;
		const mode = current();
		event.systemPromptOptions.sections.agent_mode = `Current mode: ${mode.label}.\n\n${mode.prompt}`;
	});

	const check: ModesApi["check"] = (toolName, input) => {
		const readonly = rt.role.subagent ? rt.role.readonly : current().readonly;
		const mode = rt.role.subagent
			? ({ ...(BUILTIN_MODES[2] as ModeDef), label: "read-only sub-agent", readonly } as ModeDef)
			: current();
		if (!readonly && !mode.tools) return undefined;
		if (toolName === "create_plan" && !rt.role.subagent) return toolAllowed(mode, toolName) ? undefined : `${mode.label} mode cannot create plans.`;
		if (!toolAllowed(mode, toolName)) {
			return `${toolName} is not available in ${mode.label} mode, which is read-only. Do not try another way to make this change. Tell the user what you would do; they can switch to Implement mode with Shift+Tab or /implement.`;
		}
		if (!readonly) return undefined;
		if (toolName === "bash" && typeof input.command === "string" && !isReadOnlyCommand(input.command)) {
			return `This command is not recognized as read-only, so ${mode.label} mode blocked it: ${input.command}\nUse only read-only commands here, or tell the user to switch to Implement mode.`;
		}
		if (toolName === "task_control" && (input.action === "apply" || input.action === "discard")) {
			return `${input.action} changes the workspace, so it is not available in ${mode.label} mode.`;
		}
		if (toolName === "task_control" && input.action === "send" && !getTaskManager().get(String(input.id))?.readonly) {
			return `That task can change files, so it cannot be directed from ${mode.label} mode.`;
		}
		// Sub-agents started from a read-only mode must stay read-only too.
		if (toolName === "task") input.readonly = true;
		if (toolName === "task_group") {
			input.readonly = true;
			if (input.mode === "best_of_n") return "best_of_n changes code, so it is not available in a read-only mode.";
		}
		return undefined;
	};

	return {
		all,
		current,
		resolve,
		set,
		async cycle(ctx) {
			const modes = all();
			const index = modes.findIndex((mode) => mode.id === currentId);
			await set((modes[(index + 1) % modes.length] as ModeDef).id, ctx);
		},
		onChange: (listener) => listeners.push(listener),
		check,
	};
}
