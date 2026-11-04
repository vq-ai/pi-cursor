/**
 * Cursor rules. All four rule types behave as in Cursor:
 *   always (alwaysApply)   - in the system prompt for every request
 *   auto   (globs)         - attached as soon as a matching file is mentioned or touched
 *   agent  (description)   - listed; the model reads the file when it is relevant
 *   manual (neither)       - attached by `@rule-name`
 * Rules in a nested `.cursor/rules` and nested `AGENTS.md` only apply below their own directory.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { configDirs, relativeToCwd, resolveToolPath, type Runtime } from "../core/runtime.ts";
import { asBoolean, asList, asString, matchesGlobs, oneLine, parseFrontmatter } from "../core/text.ts";
import { installedSkillBodies } from "../workflow/resources.ts";

export type RuleType = "always" | "auto" | "agent" | "manual";

export interface Rule {
	id: string;
	name: string;
	path: string;
	type: RuleType;
	description?: string;
	globs: string[];
	/** Rule only applies to files under this directory; undefined for workspace-wide and user rules. */
	scopeDir?: string;
	origin: string;
	body: string;
}

const MAX_NESTED_DIRS = 4000;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "target", "vendor", ".next", ".venv", "venv", "__pycache__", ".cache", ".pi", ".claude", ".codex"]);
const STATE_ENTRY = "pi-cursor.rules";

function readText(file: string): string | undefined {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

function parseRuleFile(file: string, origin: string, scopeDir: string | undefined): Rule | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	const { frontmatter, body } = parseFrontmatter(raw);
	const base = path.basename(file).replace(/\.(mdc|md)$/, "");
	const name = base === "RULE" ? path.basename(path.dirname(file)) : base;
	const globs = asList(frontmatter.globs);
	const description = asString(frontmatter.description);
	const always = asBoolean(frontmatter.alwaysApply) === true;
	const type: RuleType = always ? "always" : globs.length > 0 ? "auto" : description ? "agent" : "manual";
	return { id: file, name, path: file, type, description, globs, scopeDir, origin, body: body.trim() };
}

function collectRuleFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (current: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (/\.(mdc|md)$/.test(entry.name)) out.push(full);
		}
	};
	walk(dir);
	return out;
}

/** Finds `.cursor/rules` directories and `AGENTS.md` files below the workspace root. */
function findNested(root: string): { ruleDirs: string[]; agentsFiles: string[] } {
	const ruleDirs: string[] = [];
	const agentsFiles: string[] = [];
	const queue = [root];
	let visited = 0;
	while (queue.length > 0 && visited < MAX_NESTED_DIRS) {
		const dir = queue.shift() as string;
		visited++;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.isFile() && entry.name === "AGENTS.md" && dir !== root) agentsFiles.push(path.join(dir, entry.name));
			if (!entry.isDirectory()) continue;
			if (entry.name === ".cursor") {
				const rules = path.join(dir, entry.name, "rules");
				if (dir !== root && fs.existsSync(rules)) ruleDirs.push(rules);
				continue;
			}
			if (entry.name.startsWith(".") && entry.name !== ".github") continue;
			if (!SKIP_DIRS.has(entry.name)) queue.push(path.join(dir, entry.name));
		}
	}
	return { ruleDirs, agentsFiles };
}

export interface RuleDiscovery {
	rules: Rule[];
	/** Rules left out because they repeat a skill or the configuration turns them off. */
	skipped: Array<{ name: string; reason: string }>;
}

export function discoverRules(rt: Runtime): RuleDiscovery {
	const rules: Rule[] = [];
	const skipped: RuleDiscovery["skipped"] = [];
	const seen = new Set<string>();
	const skills = installedSkillBodies(rt);
	const add = (rule: Rule | undefined) => {
		if (!rule || seen.has(rule.id)) return;
		seen.add(rule.id);
		// Tools that sync skills often export them as always-on rules too. The skill already loads
		// on demand, so applying the copy would put it in every request for no gain.
		if (skills.get(rule.name) === rule.body) skipped.push({ name: rule.name, reason: "same as the skill of that name, which loads on demand" });
		else if (rt.config.disabledRules.includes(rule.name)) skipped.push({ name: rule.name, reason: "listed in disabledRules" });
		else rules.push(rule);
	};
	for (const { dir, origin } of configDirs(rt, "rules")) {
		for (const file of collectRuleFiles(dir)) add(parseRuleFile(file, origin, undefined));
	}
	if (rt.projectTrusted && rt.config.compat.cursor) {
		const legacy = path.join(rt.root, ".cursorrules");
		const legacyBody = readText(legacy);
		if (legacyBody !== undefined) add({ id: legacy, name: ".cursorrules", path: legacy, type: "always", globs: [], origin: "cursor", body: legacyBody.trim() });
		const nested = findNested(rt.root);
		for (const dir of nested.ruleDirs) {
			const scope = path.dirname(path.dirname(dir));
			for (const file of collectRuleFiles(dir)) add(parseRuleFile(file, "cursor", scope));
		}
		for (const file of nested.agentsFiles) {
			const scope = path.dirname(file);
			const body = readText(file);
			if (body === undefined) continue;
			add({
				id: file,
				name: `${path.relative(rt.root, scope)}/AGENTS.md`,
				path: file,
				type: "always",
				globs: [],
				scopeDir: scope,
				origin: "agents-md",
				body: body.trim(),
			});
		}
	}
	return { rules, skipped };
}

function inScope(rule: Rule, file: string): boolean {
	return !rule.scopeDir || file === rule.scopeDir || file.startsWith(rule.scopeDir + path.sep);
}

/** Whether touching `file` (a file, or a directory when `isDirectory`) brings `rule` into play. */
export function ruleAppliesTo(rule: Rule, file: string, root: string, isDirectory = false): boolean {
	if (!inScope(rule, file)) return false;
	if (rule.type === "always") return !!rule.scopeDir;
	if (rule.type !== "auto" || isDirectory) return false;
	const base = rule.scopeDir ?? root;
	const relative = path.relative(base, file);
	return !relative.startsWith("..") && matchesGlobs(relative, rule.globs);
}

const TOUCHING_TOOLS: Record<string, "file" | "dir"> = { read: "file", edit: "file", write: "file", ls: "dir", grep: "dir", find: "dir" };

export interface RulesApi {
	rules(): Rule[];
	skipped(): RuleDiscovery["skipped"];
	attached(): Set<string>;
	disabled(): Set<string>;
	stats(): Record<RuleType, number>;
	attach(rule: Rule): void;
	setDisabled(rule: Rule, disabled: boolean): void;
}

export function setupRules(rt: Runtime): RulesApi {
	const { pi } = rt;
	let rules: Rule[] = [];
	let skipped: RuleDiscovery["skipped"] = [];
	let attached = new Set<string>();
	let disabled = new Set<string>();
	/** Rules already delivered inside a tool result, so they stay out of the prompt until compaction. */
	let delivered = new Set<string>();

	const persist = () => pi.appendEntry(STATE_ENTRY, { attached: [...attached], disabled: [...disabled], delivered: [...delivered] });

	const restore = (ctx: ExtensionContext) => {
		attached = new Set();
		disabled = new Set();
		delivered = new Set();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_ENTRY) {
				const data = entry.data as { attached?: string[]; disabled?: string[]; delivered?: string[] };
				attached = new Set(data.attached ?? []);
				disabled = new Set(data.disabled ?? []);
				delivered = new Set(data.delivered ?? []);
			}
		}
	};

	const active = (rule: Rule) => !disabled.has(rule.id);

	const renderRule = (rule: Rule) => `<rule name="${rule.name}" path="${relativeToCwd(rt, rule.path)}">\n${rule.body}\n</rule>`;

	const buildSection = (): string | undefined => {
		const always = rules.filter((rule) => active(rule) && rule.type === "always" && !rule.scopeDir);
		const sticky = rules.filter(
			(rule) => active(rule) && attached.has(rule.id) && !delivered.has(rule.id) && !(rule.type === "always" && !rule.scopeDir),
		);
		const requestable = rules.filter((rule) => active(rule) && rule.type === "agent" && !attached.has(rule.id));
		if (always.length + sticky.length + requestable.length === 0) return undefined;
		const parts = ["These rules come from the user and the project. Follow them; they take priority over your defaults."];
		for (const rule of [...always, ...sticky]) parts.push(renderRule(rule));
		if (requestable.length > 0) {
			parts.push(
				"Read a rule with the read tool when its description applies to the task:",
				requestable.map((rule) => `- ${rule.name}: ${rule.description} (${relativeToCwd(rt, rule.path)})`).join("\n"),
			);
		}
		return parts.join("\n\n");
	};

	const attachFromPrompt = (text: string) => {
		let changed = false;
		for (const match of text.matchAll(/(?:^|\s)@([\w./-]+)/g)) {
			const mention = match[1] as string;
			const rule = rules.find((candidate) => candidate.name === mention);
			if (rule && active(rule) && !attached.has(rule.id)) {
				attached.add(rule.id);
				changed = true;
			}
		}
		for (const token of text.split(/[\s"'`()[\]{},:;]+/)) {
			const cleaned = token.replace(/^@/, "");
			if (!cleaned || !/[./]/.test(cleaned)) continue;
			const file = path.resolve(rt.cwd, cleaned);
			if (file.length > 1024 || !fs.existsSync(file)) continue;
			const isDirectory = fs.statSync(file).isDirectory();
			for (const rule of rules) {
				if (active(rule) && !attached.has(rule.id) && ruleAppliesTo(rule, file, rt.root, isDirectory)) {
					attached.add(rule.id);
					changed = true;
				}
			}
		}
		if (changed) persist();
	};

	pi.on("session_start", (_event, ctx) => {
		({ rules, skipped } = discoverRules(rt));
		restore(ctx);
	});
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_compact", () => {
		// The delivering tool results were summarized away, so attached rules go back in the prompt.
		delivered = new Set();
		persist();
	});

	pi.on("input", (event) => {
		attachFromPrompt(event.text);
		return { action: "continue" };
	});

	pi.on("before_agent_start", (event) => {
		const section = buildSection();
		if (section) event.systemPromptOptions.sections.cursor_rules = section;
		else delete event.systemPromptOptions.sections.cursor_rules;
	});

	pi.on("tool_result", (event) => {
		const kind = TOUCHING_TOOLS[event.toolName];
		if (!kind || event.isError) return;
		const file = resolveToolPath(rt.cwd, (event.input as { path?: unknown }).path);
		if (!file) return;
		const fresh = rules.filter(
			(rule) => active(rule) && !attached.has(rule.id) && ruleAppliesTo(rule, file, rt.root, kind === "dir"),
		);
		if (fresh.length === 0) return;
		for (const rule of fresh) {
			attached.add(rule.id);
			delivered.add(rule.id);
		}
		persist();
		const block = `\n\n<attached_rules>\nThese rules now apply because of ${relativeToCwd(rt, file)}. Follow them for this and later changes.\n${fresh.map(renderRule).join("\n")}\n</attached_rules>`;
		return { content: [...event.content, { type: "text" as const, text: block }] };
	});

	return {
		rules: () => rules,
		skipped: () => skipped,
		attached: () => attached,
		disabled: () => disabled,
		stats: () => {
			const counts: Record<RuleType, number> = { always: 0, auto: 0, agent: 0, manual: 0 };
			for (const rule of rules) counts[rule.type]++;
			return counts;
		},
		attach(rule) {
			attached.add(rule.id);
			delivered.delete(rule.id);
			persist();
		},
		setDisabled(rule, value) {
			if (value) disabled.add(rule.id);
			else disabled.delete(rule.id);
			persist();
		},
	};
}

export function describeRule(rule: Rule): string {
	const scope = rule.scopeDir ? ` in ${path.basename(rule.scopeDir)}/` : "";
	const detail = rule.type === "auto" ? rule.globs.join(", ") : (rule.description ?? "");
	return `${rule.type}${scope}${detail ? ` · ${oneLine(detail, 60)}` : ""}`;
}
