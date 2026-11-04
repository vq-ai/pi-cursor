import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ApprovalMode = "auto" | "allowlist" | "ask";

export interface PiCursorConfig {
	defaultMode: string;
	approvals: ApprovalMode;
	allow: string[];
	deny: string[];
	/** Names of rules that should never apply. */
	disabledRules: string[];
	fastModel?: string;
	subagents: { maxConcurrent: number; maxDepth: number; maxParallelTasks: number };
	ui: { composer: boolean; header: boolean; footer: boolean; toolRows: boolean; theme: string | false };
	compat: { cursor: boolean; claude: boolean; codex: boolean; cursorBuiltinSkills: boolean };
	checkpoints: boolean;
	hooks: boolean;
	mcp: boolean;
	web: boolean;
	/** sharedCache: summarize from the conversation's prompt cache. request: how the model is asked. */
	compaction: { sharedCache: boolean; request: "auto" | "user" | "tool" };
	modes: Record<string, { model?: string; thinking?: string }>;
}

const DEFAULTS: PiCursorConfig = {
	defaultMode: "implement",
	approvals: "allowlist",
	allow: [],
	deny: [],
	disabledRules: [],
	subagents: { maxConcurrent: 6, maxDepth: 2, maxParallelTasks: 12 },
	ui: { composer: true, header: true, footer: true, toolRows: true, theme: "auto" },
	compat: { cursor: true, claude: true, codex: true, cursorBuiltinSkills: false },
	checkpoints: true,
	hooks: true,
	mcp: true,
	web: true,
	compaction: { sharedCache: true, request: "auto" },
	modes: {},
};

/** Set when this process is a sub-agent spawned by the task manager. */
export interface Role {
	subagent: boolean;
	depth: number;
	readonly: boolean;
	agent?: string;
	taskId?: string;
}

export function detectRole(): Role {
	const taskId = process.env.PI_CURSOR_TASK_ID;
	return {
		subagent: !!taskId,
		depth: Number(process.env.PI_CURSOR_DEPTH ?? 0) || 0,
		readonly: process.env.PI_CURSOR_READONLY === "1",
		agent: process.env.PI_CURSOR_AGENT,
		taskId,
	};
}

export function stateDir(): string {
	return path.join(getAgentDir(), "pi-cursor");
}

export function packageDir(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function readJson<T>(file: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

export function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
	fs.renameSync(tmp, file);
}

/** Nearest ancestor holding `.git`, otherwise the working directory itself. */
export function findProjectRoot(cwd: string): string {
	let dir = path.resolve(cwd);
	while (true) {
		if (fs.existsSync(path.join(dir, ".git"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return path.resolve(cwd);
		dir = parent;
	}
}

function deepMerge<T>(base: T, patch: unknown): T {
	if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return (patch ?? base) as T;
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [key, value] of Object.entries(patch)) out[key] = deepMerge(out[key], value);
	return out as T;
}

export function configPaths(root: string): { user: string; project: string } {
	return { user: path.join(getAgentDir(), "pi-cursor.json"), project: path.join(root, ".pi", "pi-cursor.json") };
}

const APPROVAL_RANK: Record<ApprovalMode, number> = { auto: 0, allowlist: 1, ask: 2 };

/** Settings a workspace may set for itself without approval, since none of them loosen anything. */
const HARMLESS_PROJECT_KEYS = ["defaultMode", "modes", "fastModel", "ui"] as const;

/** A workspace file that asks for more trust than the user gave has to be approved like a hook. */
function projectConfigGrants(root: string): string[] {
	const files: string[] = [];
	const own = path.join(root, ".pi", "pi-cursor.json");
	const config = readJson<Record<string, unknown>>(own);
	if (config) {
		const widens = config.approvals === "auto" || (Array.isArray(config.allow) && config.allow.length > 0) || ["hooks", "checkpoints", "compat", "mcp"].some((key) => key in config);
		if (widens) files.push(own);
	}
	const cli = path.join(root, ".cursor", "cli.json");
	const allow = readJson<{ permissions?: { allow?: unknown } }>(cli)?.permissions?.allow;
	if (Array.isArray(allow) && allow.length > 0) files.push(cli);
	return files;
}

export function loadConfig(root: string, projectTrusted: boolean, execTrusted: boolean): PiCursorConfig {
	const cursorCli = readJson<{ approvalMode?: string; permissions?: { allow?: string[]; deny?: string[] } }>(
		path.join(os.homedir(), ".cursor", "cli-config.json"),
	);
	const fromCursor: Partial<PiCursorConfig> = {
		allow: cursorCli?.permissions?.allow ?? [],
		deny: cursorCli?.permissions?.deny ?? [],
	};
	if (cursorCli?.approvalMode === "allowlist" || cursorCli?.approvalMode === "ask" || cursorCli?.approvalMode === "auto") {
		fromCursor.approvals = cursorCli.approvalMode;
	}
	const paths = configPaths(root);
	let config = deepMerge(DEFAULTS, fromCursor);
	const user = readJson<Partial<PiCursorConfig>>(paths.user);
	config = deepMerge(config, user);
	// Lists from separate sources add up, so a later layer can never remove a user's deny rule.
	config.allow = [...new Set([...(fromCursor.allow ?? []), ...(user?.allow ?? [])])];
	config.deny = [...new Set([...(fromCursor.deny ?? []), ...(user?.deny ?? [])])];
	if (!projectTrusted) return config;
	const project = readJson<Partial<PiCursorConfig>>(paths.project) ?? {};
	const cli = readJson<{ permissions?: { allow?: string[]; deny?: string[] } }>(path.join(root, ".cursor", "cli.json"))?.permissions;
	const deny = [...config.deny, ...(project.deny ?? []), ...(cli?.deny ?? [])];
	const allow = execTrusted ? [...config.allow, ...(project.allow ?? []), ...(cli?.allow ?? [])] : config.allow;
	const userApprovals = config.approvals;
	if (execTrusted) {
		config = deepMerge(config, project);
	} else {
		// A cloned repository must not be able to relax the user's settings on its own.
		for (const key of HARMLESS_PROJECT_KEYS) {
			if (project[key] !== undefined) config = deepMerge(config, { [key]: project[key] });
		}
		if (project.approvals && APPROVAL_RANK[project.approvals] > APPROVAL_RANK[userApprovals]) config.approvals = project.approvals;
		if (project.web === false) config.web = false;
		for (const key of ["maxConcurrent", "maxDepth", "maxParallelTasks"] as const) {
			const value = project.subagents?.[key];
			if (typeof value === "number" && value < config.subagents[key]) config.subagents = { ...config.subagents, [key]: value };
		}
	}
	config.disabledRules = [...new Set([...(user?.disabledRules ?? []), ...(project.disabledRules ?? [])])];
	config.allow = [...new Set(allow)];
	config.deny = [...new Set(deny)];
	return config;
}

interface WorkspaceRecord {
	allow?: string[];
	exec?: { decision: "yes" | "no"; hash: string };
}

function workspacesFile(): string {
	return path.join(stateDir(), "workspaces.json");
}

export function readWorkspace(root: string): WorkspaceRecord {
	return readJson<Record<string, WorkspaceRecord>>(workspacesFile())?.[root] ?? {};
}

export function updateWorkspace(root: string, update: (record: WorkspaceRecord) => void): void {
	const all = readJson<Record<string, WorkspaceRecord>>(workspacesFile()) ?? {};
	const record = all[root] ?? {};
	update(record);
	all[root] = record;
	writeJson(workspacesFile(), all);
}

/** Workspace files that make Pi run commands. They are gated by a decision tied to their contents. */
export function executableConfigFiles(root: string): string[] {
	return [
		path.join(root, ".cursor", "hooks.json"),
		path.join(root, ".pi", "hooks.json"),
		path.join(root, ".cursor", "mcp.json"),
		path.join(root, ".cursor", "worktrees.json"),
		...projectConfigGrants(root),
	].filter((file) => fs.statSync(file, { throwIfNoEntry: false })?.isFile());
}

/** Depends on names relative to the root, so that a worktree of the same repository hashes the same. */
export function hashExecConfig(root: string): string {
	const hash = createHash("sha256");
	for (const file of executableConfigFiles(root)) {
		hash.update(path.relative(root, file));
		hash.update(fs.readFileSync(file));
	}
	return hash.digest("hex");
}

export interface Runtime {
	pi: ExtensionAPI;
	role: Role;
	config: PiCursorConfig;
	cwd: string;
	root: string;
	/** Instruction-only files in the workspace (rules, agents, skills, commands) may load. */
	projectTrusted: boolean;
	/** Workspace files that execute commands (hooks, MCP, worktree setup) may run. */
	execTrusted: boolean;
	/** What the user approved, which a sub-agent's workspace has to match to inherit that approval. */
	execHash: string;
	ctx?: ExtensionContext;
	/** Refreshes every per-session value. Called first on each `session_start`. */
	refresh(ctx: ExtensionContext): Promise<void>;
}

export function createRuntime(pi: ExtensionAPI): Runtime {
	const role = detectRole();
	const rt: Runtime = {
		pi,
		role,
		config: DEFAULTS,
		cwd: process.cwd(),
		root: findProjectRoot(process.cwd()),
		projectTrusted: true,
		execTrusted: false,
		execHash: "",
		async refresh(ctx) {
			rt.ctx = ctx;
			rt.cwd = ctx.cwd;
			rt.root = findProjectRoot(ctx.cwd);
			rt.projectTrusted = ctx.isProjectTrusted();
			// Nothing in the workspace may keep the user's own settings from loading, so these come first
			// and anything unexpected while resolving trust counts as not approved.
			rt.config = loadConfig(rt.root, rt.projectTrusted, false);
			rt.execTrusted = false;
			try {
				rt.execHash = hashExecConfig(rt.root);
				rt.execTrusted = await resolveExecTrust(rt, ctx);
			} catch {
				rt.execHash = "";
			}
			if (rt.execTrusted) rt.config = loadConfig(rt.root, rt.projectTrusted, true);
		},
	};
	return rt;
}

async function resolveExecTrust(rt: Runtime, ctx: ExtensionContext): Promise<boolean> {
	if (!rt.projectTrusted) return false;
	const files = executableConfigFiles(rt.root);
	if (files.length === 0) return true;
	const hash = rt.execHash;
	// A sub-agent inherits the parent's decision only for the exact files the parent approved.
	if (rt.role.subagent) return process.env.PI_CURSOR_EXEC_HASH === hash;
	const saved = readWorkspace(rt.root).exec;
	if (saved?.hash === hash) return saved.decision === "yes";
	// RPC clients cannot answer a dialog yet at this stage of startup; asking would hang them.
	if (ctx.mode !== "tui") return false;
	const names = files.map((file) => path.relative(rt.root, file)).join(", ");
	const choice = await ctx.ui.select(`This workspace can run commands or relax approvals through ${names}. Allow?`, [
		"Allow and remember until these files change",
		"Allow for this session only",
		"Don't allow",
	]);
	if (choice?.startsWith("Allow and")) {
		updateWorkspace(rt.root, (record) => {
			record.exec = { decision: "yes", hash };
		});
		return true;
	}
	if (choice === "Don't allow") {
		updateWorkspace(rt.root, (record) => {
			record.exec = { decision: "no", hash };
		});
	}
	return choice === "Allow for this session only";
}

/** Directories that may hold config of `kind` (`rules`, `agents`, `skills`, `commands`), highest priority first. */
export function configDirs(rt: Runtime, kind: string): Array<{ dir: string; scope: "project" | "user"; origin: string }> {
	const home = os.homedir();
	const out: Array<{ dir: string; scope: "project" | "user"; origin: string }> = [];
	const add = (dir: string, scope: "project" | "user", origin: string) => {
		if (fs.existsSync(dir)) out.push({ dir, scope, origin });
	};
	const { cursor, claude, codex } = rt.config.compat;
	if (rt.projectTrusted) {
		add(path.join(rt.root, ".pi", kind), "project", "pi");
		if (cursor) add(path.join(rt.root, ".cursor", kind), "project", "cursor");
		if (claude) add(path.join(rt.root, ".claude", kind), "project", "claude");
		if (codex) add(path.join(rt.root, ".codex", kind), "project", "codex");
	}
	add(path.join(getAgentDir(), kind), "user", "pi");
	if (cursor) add(path.join(home, ".cursor", kind), "user", "cursor");
	if (claude) add(path.join(home, ".claude", kind), "user", "claude");
	if (codex) add(path.join(home, ".codex", kind), "user", "codex");
	return out;
}

export function relativeToCwd(rt: Runtime, file: string): string {
	const relative = path.relative(rt.cwd, file);
	return relative && !relative.startsWith("..") ? relative : file;
}

/**
 * Resolves a tool's `path` argument exactly as the built-in tools do, including the `@` some models
 * prepend, `~`, unicode spaces and `file://` URLs. A gate that reads a path differently from the
 * tool that uses it can be walked around.
 */
export function resolveToolPath(cwd: string, raw: unknown): string | undefined {
	if (typeof raw !== "string" || !raw) return undefined;
	let cleaned = raw.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
	if (cleaned.startsWith("@")) cleaned = cleaned.slice(1);
	if (cleaned.startsWith("file://")) {
		try {
			cleaned = fileURLToPath(cleaned);
		} catch {
			return undefined;
		}
	}
	if (cleaned === "~") return os.homedir();
	if (cleaned.startsWith("~/")) return path.join(os.homedir(), cleaned.slice(2));
	return path.resolve(cwd, cleaned);
}

/** Where a path really leads, following symlinks in whichever of its ancestors already exist. */
export function canonicalPath(file: string): string {
	let current = file;
	const missing: string[] = [];
	for (;;) {
		try {
			return path.join(fs.realpathSync(current), ...missing);
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return file;
			missing.unshift(path.basename(current));
			current = parent;
		}
	}
}

export function isInside(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
