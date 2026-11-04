/**
 * Custom agents. Same format and locations as Cursor (`.cursor/agents/*.md`, `~/.cursor/agents/*.md`),
 * with `.pi`, `.claude` and `.codex` read too. The body is the agent's system prompt.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { configDirs, packageDir, type PiCursorConfig, type Runtime } from "../core/runtime.ts";
import { asBoolean, asList, asString, parseFrontmatter } from "../core/text.ts";

export interface AgentDef {
	name: string;
	description: string;
	prompt: string;
	/** `inherit`, `fast`, or a model pattern. */
	model?: string;
	thinking?: string;
	readonly: boolean;
	background: boolean;
	tools?: string[];
	isolation?: "worktree";
	maxTurns?: number;
	scope: "project" | "user" | "builtin";
	origin: string;
	path?: string;
}

const ALIASES: Record<string, string> = {
	generalpurpose: "general-purpose",
	general: "general-purpose",
	worker: "general-purpose",
	bash: "shell",
	reviewer: "code-reviewer",
	review: "code-reviewer",
	debug: "debugger",
	plan: "planner",
};

export function parseAgentFile(file: string, scope: AgentDef["scope"], origin: string): AgentDef | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	const { frontmatter, body } = parseFrontmatter(raw);
	const name = asString(frontmatter.name) ?? path.basename(file).replace(/\.md$/, "");
	const description = asString(frontmatter.description);
	if (!description) return undefined;
	const tools = asList(frontmatter.tools);
	const maxTurns = frontmatter.max_turns ?? frontmatter.maxTurns;
	return {
		name,
		description,
		prompt: body.trim(),
		model: asString(frontmatter.model),
		thinking: asString(frontmatter.thinking),
		readonly: asBoolean(frontmatter.readonly) ?? false,
		background: asBoolean(frontmatter.is_background) ?? asBoolean(frontmatter.background) ?? false,
		tools: tools.length > 0 ? tools : undefined,
		isolation: asString(frontmatter.isolation) === "worktree" ? "worktree" : undefined,
		maxTurns: typeof maxTurns === "number" ? maxTurns : undefined,
		scope,
		origin,
		path: file,
	};
}

export function discoverAgents(rt: Runtime): AgentDef[] {
	const agents = new Map<string, AgentDef>();
	const add = (dir: string, scope: AgentDef["scope"], origin: string) => {
		let files: string[];
		try {
			files = fs.readdirSync(dir);
		} catch {
			return;
		}
		for (const file of files) {
			if (!file.endsWith(".md")) continue;
			const agent = parseAgentFile(path.join(dir, file), scope, origin);
			if (agent) agents.set(agent.name, agent);
		}
	};
	// Lowest priority first, so later entries replace earlier ones of the same name.
	add(path.join(packageDir(), "agents"), "builtin", "pi-cursor");
	for (const { dir, scope, origin } of configDirs(rt, "agents").reverse()) add(dir, scope, origin);
	return [...agents.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findAgent(agents: AgentDef[], name: string): AgentDef | undefined {
	const lower = name.toLowerCase();
	const target = ALIASES[lower] ?? lower;
	return agents.find((agent) => agent.name.toLowerCase() === target);
}

export interface ResolvedModel {
	/** `provider/id`, or undefined to let the child use its default. */
	spec?: string;
	thinking?: string;
	note?: string;
}

/** Resolves `inherit`, `fast` and fuzzy names against the models that actually have credentials. */
export function resolveModel(spec: string | undefined, ctx: ExtensionContext, config: PiCursorConfig, thinking?: string): ResolvedModel {
	const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	const inherit: ResolvedModel = { spec: current, thinking: thinking ?? ctx.thinkingLevel };
	if (!spec || spec === "inherit") return inherit;
	const available = ctx.modelRegistry.getAvailable();
	const id = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;
	if (spec === "fast") {
		if (config.fastModel) return resolveModel(config.fastModel, ctx, { ...config, fastModel: undefined }, thinking);
		const sameProvider = available.filter((model) => model.provider === ctx.model?.provider && model.cost.input > 0);
		const cheapest = [...sameProvider].sort((a, b) => a.cost.input - b.cost.input)[0];
		return cheapest ? { spec: id(cheapest), thinking: thinking ?? "off" } : inherit;
	}
	const lower = spec.toLowerCase();
	const match =
		available.find((model) => id(model).toLowerCase() === lower) ??
		available.find((model) => model.id.toLowerCase() === lower) ??
		available.find((model) => id(model).toLowerCase().includes(lower));
	if (match) return { spec: id(match), thinking };
	return { ...inherit, note: `Model "${spec}" is not available; used ${current ?? "the default model"} instead.` };
}
