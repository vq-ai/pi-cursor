/** Git worktree isolation for sub-agents, with Cursor's `.cursor/worktrees.json` setup commands. */

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { stateDir, readJson } from "../core/runtime.ts";

export interface WorktreeInfo {
	path: string;
	branch: string;
	base: string;
	repoRoot: string;
	setupWarning?: string;
	state: "active" | "applied" | "discarded";
	diff?: DiffSummary;
}

export interface DiffSummary {
	files: Array<{ path: string; added: number; removed: number }>;
	added: number;
	removed: number;
}

function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve) => {
		execFile("git", args, { cwd, maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
			resolve({ stdout, stderr, code: error ? (typeof error.code === "number" ? error.code : 1) : 0 });
		});
	});
}

/** For patches, which may hold bytes that are not valid text and must survive unchanged. */
function gitBytes(cwd: string, args: string[], input?: Buffer): Promise<{ stdout: Buffer; stderr: string; code: number }> {
	return new Promise((resolve) => {
		const child = execFile("git", args, { cwd, maxBuffer: 1024 * 1024 * 1024, encoding: "buffer" }, (error, stdout, stderr) => {
			resolve({ stdout, stderr: stderr.toString(), code: error ? (typeof error.code === "number" ? error.code : 1) : 0 });
		});
		if (input !== undefined) child.stdin?.end(input);
	});
}

/** Stages everything in the worktree. If this fails, what it would show is incomplete, so callers stop. */
async function stageAll(info: WorktreeInfo): Promise<void> {
	const result = await git(info.path, ["add", "-A"]);
	if (result.code !== 0) throw new Error(`Could not read the changes in ${info.path}, so they are still there: ${result.stderr.trim()}`);
}

export async function repoRootOf(cwd: string): Promise<string | undefined> {
	const result = await git(cwd, ["rev-parse", "--show-toplevel"]);
	return result.code === 0 ? fs.realpathSync(result.stdout.trim()) : undefined;
}

function setupCommands(repoRoot: string): string[] {
	const config = readJson<Record<string, string | string[]>>(path.join(repoRoot, ".cursor", "worktrees.json"));
	if (!config) return [];
	const specific = process.platform === "win32" ? config["setup-worktree-windows"] : config["setup-worktree-unix"];
	const chosen = specific ?? config["setup-worktree"];
	if (!chosen) return [];
	return Array.isArray(chosen) ? chosen : [chosen];
}

function runShell(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number; output: string }> {
	return new Promise((resolve) => {
		const child = spawn(process.env.SHELL || "sh", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
		let output = "";
		const collect = (data: Buffer) => {
			output = (output + data.toString()).slice(-4000);
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		const timer = setTimeout(() => {
			try {
				process.kill(-(child.pid as number), "SIGTERM");
			} catch {
				child.kill("SIGTERM");
			}
		}, 10 * 60 * 1000);
		// "exit", not "close": a daemon started by the command may hold the pipes open indefinitely.
		child.on("exit", (code) => {
			clearTimeout(timer);
			child.stdout.destroy();
			child.stderr.destroy();
			child.unref();
			resolve({ code: code ?? 1, output });
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ code: 1, output: String(error) });
		});
	});
}

/**
 * Creates a worktree at the current state of the checkout. `git stash create` captures uncommitted
 * tracked changes without touching them, so a later diff against `base` holds only the agent's work.
 */
export async function createWorktree(cwd: string, id: string, runSetup: boolean): Promise<WorktreeInfo> {
	const repoRoot = await repoRootOf(cwd);
	if (!repoRoot) throw new Error(`worktree isolation needs a git repository, and ${cwd} is not in one`);
	const head = await git(repoRoot, ["rev-parse", "HEAD"]);
	if (head.code !== 0) throw new Error("worktree isolation needs at least one commit in the repository");
	const stash = await git(repoRoot, ["stash", "create"]);
	const base = stash.stdout.trim() || head.stdout.trim();
	const hash = createHash("sha256").update(repoRoot).digest("hex").slice(0, 8);
	const location = path.join(stateDir(), "worktrees", `${path.basename(repoRoot)}-${hash}`, id);
	fs.mkdirSync(path.dirname(location), { recursive: true });
	const branch = `pi-cursor/${id}`;
	const added = await git(repoRoot, ["worktree", "add", "-q", "-b", branch, location, base]);
	if (added.code !== 0) throw new Error(`git worktree add failed: ${added.stderr.trim()}`);
	const info: WorktreeInfo = { path: location, branch, base, repoRoot, state: "active" };
	if (runSetup) {
		for (const command of setupCommands(repoRoot)) {
			const result = await runShell(command, location, { ...process.env, ROOT_WORKTREE_PATH: repoRoot });
			if (result.code !== 0) {
				info.setupWarning = `Setup command failed (${command}):\n${result.output.trim()}`;
				break;
			}
		}
	}
	return info;
}

export async function diffWorktree(info: WorktreeInfo): Promise<DiffSummary> {
	await stageAll(info);
	const result = await git(info.path, ["diff", "--cached", "--numstat", info.base]);
	const files = result.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [added, removed, ...name] = line.split("\t");
			return { path: name.join("\t"), added: Number(added) || 0, removed: Number(removed) || 0 };
		});
	return {
		files,
		added: files.reduce((sum, file) => sum + file.added, 0),
		removed: files.reduce((sum, file) => sum + file.removed, 0),
	};
}

export async function fullDiff(info: WorktreeInfo): Promise<string> {
	await stageAll(info);
	return (await git(info.path, ["diff", "--cached", info.base])).stdout;
}

export interface ApplyResult {
	ok: boolean;
	message: string;
}

/** Applies the agent's changes to the main checkout, keeping them unstaged whenever possible. */
export async function applyWorktree(info: WorktreeInfo): Promise<ApplyResult> {
	await stageAll(info);
	const diff = await gitBytes(info.path, ["diff", "--cached", "--binary", info.base]);
	if (diff.code !== 0) throw new Error(`Could not read the changes in ${info.path}, so they are still there: ${diff.stderr.trim()}`);
	const patch = diff.stdout;
	if (patch.length === 0) return { ok: true, message: "The agent made no changes." };
	const plain = await gitBytes(info.repoRoot, ["apply", "--whitespace=nowarn", "-"], patch);
	if (plain.code === 0) return { ok: true, message: "Applied the changes to the working tree (unstaged)." };
	const threeWay = await gitBytes(info.repoRoot, ["apply", "--3way", "--whitespace=nowarn", "-"], patch);
	if (threeWay.code === 0) return { ok: true, message: "Applied the changes with a 3-way merge; they are staged." };
	const conflicts = (await git(info.repoRoot, ["diff", "--name-only", "--diff-filter=U"])).stdout.trim();
	if (conflicts) return { ok: false, message: `The 3-way merge left conflicts to resolve in:\n${conflicts}` };
	return { ok: false, message: `Could not apply the changes:\n${(threeWay.stderr || plain.stderr).trim()}` };
}

export async function removeWorktree(info: WorktreeInfo): Promise<void> {
	await git(info.repoRoot, ["worktree", "remove", "--force", info.path]);
	await git(info.repoRoot, ["branch", "-q", "-D", info.branch]);
	fs.rmSync(info.path, { recursive: true, force: true });
}
