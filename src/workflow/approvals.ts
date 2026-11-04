/**
 * Approval gate, modelled on Cursor's auto-run settings and permission format:
 *   auto       run everything except what `deny` lists
 *   allowlist  edits inside the workspace and read-only commands run; everything else asks
 *   ask        as allowlist, but edits ask too
 * Permissions use Cursor's syntax: Shell(git), Shell(npm run:*), Read(glob), Write(glob), WebFetch(host), Mcp(server:tool).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canonicalPath, isInside, readWorkspace, resolveToolPath, updateWorkspace, type ApprovalMode, type Runtime } from "../core/runtime.ts";
import { analyzeShell, isReadOnlyCommand, splitWords } from "../core/shell.ts";
import { globToRegExp, ignoreMatcher, matchesGlobs, oneLine } from "../core/text.ts";
import { isPrivateHost } from "../tools/web.ts";

export interface Permission {
	kind: string;
	pattern: string;
}

export function parsePermission(text: string): Permission | undefined {
	const match = /^(\w+)\((.*)\)$/.exec(text.trim());
	return match ? { kind: (match[1] as string).toLowerCase(), pattern: (match[2] as string).trim() } : undefined;
}

export function shellMatches(segment: string, pattern: string): boolean {
	const normalized = pattern.replace(/:\*$/, "").replace(/\s+\*$/, "").replace(/^([\w.-]+):/, "$1 ");
	if (normalized === "*") return true;
	if (normalized.includes("*")) {
		const regex = new RegExp(`^${normalized.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
		return regex.test(segment);
	}
	return segment === normalized || segment.startsWith(`${normalized} `);
}

function hostMatches(host: string, pattern: string): boolean {
	if (pattern === "*") return true;
	if (pattern.startsWith("*.")) return host === pattern.slice(2) || host.endsWith(pattern.slice(1));
	return host === pattern;
}

/** Words of a command worth remembering: `git commit`, `npm run`, `ls`. */
export function suggestShellPattern(segment: string): string {
	const words = splitWords(segment);
	const [first, second] = words;
	if (!first) return segment;
	const hasSubcommands = ["git", "npm", "pnpm", "yarn", "bun", "cargo", "go", "docker", "kubectl", "gh", "make", "uv", "pip", "brew"].includes(first);
	if (hasSubcommands && second && !second.startsWith("-")) return `${first} ${second}`;
	return first;
}

/** Files whose contents later run as code or change what is allowed. Lower case: macOS paths ignore case. */
const SENSITIVE_WRITE = ["**/.git/**", ".env", ".env.*", "**/.cursor/**", "**/.pi/**", "**/.vscode/**", "**/.claude/**", ".cursorignore"];

/**
 * The command a segment really runs, seeing through `\\curl`, `"curl"`, `(curl`, `/usr/bin/curl` and
 * `FOO=1 curl`. Deny rules are matched on this. They remain best effort, since a shell can always
 * build a command name at run time; only a sandbox can guarantee a command does not run.
 */
export function normalizeSegment(segment: string): string {
	const words = splitWords(segment.replace(/^[({\s]+/, ""));
	while (words[0] && /^[A-Za-z_]\w*=/.test(words[0])) words.shift();
	if (words[0]) words[0] = path.basename(words[0]);
	return words.join(" ");
}

export function isDeniedCommand(command: string, patterns: string[]): string | undefined {
	const { segments, complex } = analyzeShell(command);
	for (const segment of segments) {
		const normalized = normalizeSegment(segment);
		const hit = patterns.find((pattern) => shellMatches(normalized, pattern));
		if (hit) return segment;
	}
	if (!complex) return undefined;
	// Inside substitutions and subshells, fall back to looking for the command's name anywhere.
	const flat = command.replace(/\\/g, "").replace(/["']/g, "");
	for (const pattern of patterns) {
		const name = pattern.replace(/:\*$/, "").replace(/\s+\*$/, "").split(/[\s:]/)[0] as string;
		if (name !== "*" && new RegExp(`(^|[^\\w.-])${name.replace(/[.+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w.-])`).test(flat)) return name;
	}
	return undefined;
}

/** macOS and Windows paths usually ignore case, so `LOCKED/x` and `locked/x` are the same file there. */
function foldCase(text: string): string {
	return process.platform === "darwin" || process.platform === "win32" ? text.toLowerCase() : text;
}

export interface ToolVerdict {
	permission?: "allow" | "deny" | "ask";
	message?: string;
}

export interface ApprovalsApi {
	mode(): ApprovalMode;
	setMode(mode: ApprovalMode): void;
	check(toolName: string, input: Record<string, unknown>, ctx: ExtensionContext, hook?: ToolVerdict): Promise<string | undefined>;
}

export function setupApprovals(rt: Runtime): ApprovalsApi {
	let override: ApprovalMode | undefined = (process.env.PI_CURSOR_APPROVALS as ApprovalMode | undefined) || undefined;
	let ignored: (relative: string) => boolean = () => false;
	const headless = process.env.PI_CURSOR_HEADLESS === "1";

	const mode = () => override ?? rt.config.approvals;

	const permissions = (): { allow: Permission[]; deny: Permission[] } => {
		const parse = (items: string[]) => items.map(parsePermission).filter((item): item is Permission => !!item);
		return {
			allow: parse([...rt.config.allow, ...(readWorkspace(rt.root).allow ?? [])]),
			deny: parse(rt.config.deny),
		};
	};

	rt.pi.on("session_start", () => {
		ignored = () => false;
		try {
			const match = ignoreMatcher(foldCase(fs.readFileSync(path.join(rt.root, ".cursorignore"), "utf8")));
			ignored = (view) => match(foldCase(view));
		} catch {
			// No .cursorignore, or something unreadable in its place.
		}
	});

	const relativeToRoot = (file: string) => path.relative(rt.root, file);

	const remember = (permission: string) => {
		updateWorkspace(rt.root, (record) => {
			record.allow = [...new Set([...(record.allow ?? []), permission])];
		});
	};

	/** Asks the user. Returns a block reason, or undefined when allowed. */
	const prompt = async (ctx: ExtensionContext, title: string, permission: string | undefined, runLabel: string): Promise<string | undefined> => {
		if (!ctx.hasUI || headless) return undefined;
		const always = permission ? `Always allow ${permission} in this workspace` : undefined;
		const skip = "Skip";
		const skipWithNote = "Skip and tell the agent what to do instead";
		const options = [runLabel, ...(always ? [always] : []), skip, skipWithNote];
		const choice = await ctx.ui.select(title, options);
		if (choice === runLabel) return undefined;
		if (always && choice === always) {
			remember(permission as string);
			return undefined;
		}
		if (choice === skipWithNote) {
			const note = await ctx.ui.input("What should the agent do instead?");
			return `The user declined this. Their instructions: ${note ?? "(none given)"}`;
		}
		return "The user declined this. Do not retry it; ask them how to proceed, or take a different approach.";
	};

	const checkShell = async (command: string, ctx: ExtensionContext, verdict: ToolVerdict | undefined): Promise<string | undefined> => {
		const { allow, deny } = permissions();
		const { segments, complex } = analyzeShell(command);
		const denied = isDeniedCommand(command, deny.filter((rule) => rule.kind === "shell").map((rule) => rule.pattern));
		if (denied) return `This command is denied by the permissions configuration: ${denied}`;
		if (verdict?.permission === "allow") return undefined;
		if (mode() === "auto" && verdict?.permission !== "ask") return undefined;
		const allowed = (segment: string) => isReadOnlyCommand(segment) || allow.some((rule) => rule.kind === "shell" && shellMatches(segment, rule.pattern));
		if (!complex && verdict?.permission !== "ask" && segments.length > 0 && segments.every(allowed)) return undefined;
		const unlisted = segments.find((segment) => !allowed(segment)) ?? segments[0] ?? command;
		const suggestion = complex ? undefined : `Shell(${suggestShellPattern(unlisted)})`;
		return prompt(ctx, `Run this command?\n$ ${oneLine(command, 400)}`, suggestion, "Run");
	};

	const checkPath = async (toolName: string, raw: unknown, ctx: ExtensionContext, verdict: ToolVerdict | undefined): Promise<string | undefined> => {
		const file = resolveToolPath(rt.cwd, raw);
		if (!file) return undefined;
		// Symlinks are followed, so that a link inside the workspace cannot reach past these checks.
		const root = canonicalPath(rt.root);
		const real = canonicalPath(file);
		const relative = isInside(root, real) ? path.relative(root, real) : relativeToRoot(file);
		const lexical = relativeToRoot(file);
		const views = [...new Set([relative, lexical])].filter((view) => view && !view.startsWith(".."));
		if (views.some((view) => ignored(view))) return `${relative} is excluded by .cursorignore, so it cannot be read or changed.`;
		const writes = toolName === "edit" || toolName === "write";
		const { allow, deny } = permissions();
		const kind = writes ? "write" : "read";
		const matchesPath = (rule: Permission) => {
			if (rule.kind !== kind) return false;
			const pattern = foldCase(rule.pattern);
			return views.some((view) => matchesGlobs(foldCase(view), [pattern])) || globToRegExp(pattern).test(foldCase(real));
		};
		if (deny.some(matchesPath)) return `${relative || file} is denied by the permissions configuration.`;
		if (!writes) return undefined;
		const outside = !isInside(root, real);
		const sensitive = !outside && views.some((view) => matchesGlobs(view.toLowerCase(), SENSITIVE_WRITE));
		if (verdict?.permission === "allow" || allow.some(matchesPath)) return undefined;
		if (mode() === "auto" && verdict?.permission !== "ask") return undefined;
		if (mode() === "allowlist" && !outside && !sensitive && verdict?.permission !== "ask") return undefined;
		const reason = outside ? "outside the workspace" : sensitive ? "a sensitive file" : "";
		const title = `${toolName === "edit" ? "Edit" : "Write"} ${outside ? file : relative}${reason ? ` (${reason})` : ""}?`;
		return prompt(ctx, title, outside ? undefined : `Write(${relative})`, "Allow");
	};

	const checkMcp = async (toolName: string, ctx: ExtensionContext, verdict: ToolVerdict | undefined): Promise<string | undefined> => {
		const [, server = "", tool = ""] = toolName.split("__");
		const { allow, deny } = permissions();
		const matches = (rule: Permission) => {
			if (rule.kind !== "mcp") return false;
			const [ruleServer = "*", ruleTool = "*"] = rule.pattern.split(":");
			return (ruleServer === "*" || ruleServer === server) && (ruleTool === "*" || ruleTool === tool);
		};
		if (deny.some(matches)) return `${toolName} is denied by the permissions configuration.`;
		if (verdict?.permission === "allow" || allow.some(matches)) return undefined;
		if (mode() === "auto" && verdict?.permission !== "ask") return undefined;
		const info = rt.pi.getAllTools().find((candidate) => candidate.name === toolName);
		if (info?.annotations?.readOnlyHint === true && verdict?.permission !== "ask") return undefined;
		return prompt(ctx, `Call MCP tool ${tool} on ${server}?`, `Mcp(${server}:${tool})`, "Allow");
	};

	const checkFetch = async (url: unknown, ctx: ExtensionContext, verdict: ToolVerdict | undefined): Promise<string | undefined> => {
		if (typeof url !== "string") return undefined;
		let host: string;
		try {
			host = new URL(url).hostname;
		} catch {
			return undefined;
		}
		const { allow, deny } = permissions();
		const matches = (rule: Permission) => rule.kind === "webfetch" && hostMatches(host, rule.pattern);
		if (deny.some(matches)) return `Fetching ${host} is denied by the permissions configuration.`;
		if (verdict?.permission === "allow" || allow.some(matches) || mode() === "auto") return undefined;
		if (!isPrivateHost(host) && verdict?.permission !== "ask") return undefined;
		return prompt(ctx, `Fetch ${url}? This is a local or private address.`, `WebFetch(${host})`, "Allow");
	};

	return {
		mode,
		setMode(next) {
			override = next;
		},
		async check(toolName, input, ctx, hook) {
			if (hook?.permission === "deny") return hook.message ?? "A hook denied this tool call.";
			if (toolName === "bash" && typeof input.command === "string") return checkShell(input.command, ctx, hook);
			if (toolName === "background_shell" && input.action === "start" && typeof input.command === "string") return checkShell(input.command, ctx, hook);
			if (toolName === "read" || toolName === "edit" || toolName === "write" || toolName === "grep" || toolName === "ls" || toolName === "find") return checkPath(toolName, input.path, ctx, hook);
			if (toolName.startsWith("mcp__")) return checkMcp(toolName, ctx, hook);
			if (toolName === "web_fetch") return checkFetch(input.url, ctx, hook);
			if (hook?.permission === "ask") return prompt(ctx, `Allow ${toolName}?`, undefined, "Allow");
			return undefined;
		},
	};
}
