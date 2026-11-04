/**
 * Cursor-style checkpoints. Before the agent first changes anything for a prompt, the workspace is
 * snapshotted into a private git directory, leaving the user's own repository and index untouched.
 * `/restore` rewinds files and/or conversation; `/changes` reviews and reverts what changed since.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stateDir, type Runtime } from "../core/runtime.ts";
import { isReadOnlyCommand } from "../core/shell.ts";
import { oneLine } from "../core/text.ts";

export interface Checkpoint {
	tree: string;
	at: number;
	label: string;
	/** The user message this snapshot was taken for. */
	entryId?: string;
}

export interface Change {
	status: string;
	path: string;
	/** A nested git repository, which a snapshot records only as a commit reference. */
	nestedRepo: boolean;
}

export interface RestoreResult {
	restored: number;
	removed: number;
	/** Paths left as they are, each with the reason. */
	kept: string[];
}

const STATE_ENTRY = "pi-cursor.checkpoint";
const SNAPSHOT_TIMEOUT_MS = 20000;
const GITLINK_MODE = "160000";

export class ShadowRepo {
	readonly gitDir: string;
	readonly workTree: string;
	private ready = false;

	constructor(workTree: string, baseDir = path.join(stateDir(), "checkpoints")) {
		this.workTree = workTree;
		this.gitDir = path.join(baseDir, createHash("sha256").update(workTree).digest("hex").slice(0, 16));
	}

	private git(args: string[], input?: string, timeout = SNAPSHOT_TIMEOUT_MS): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> {
		return new Promise((resolve) => {
			const child = execFile(
				"git",
				["-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", "core.fsmonitor=false", ...args],
				{ cwd: this.workTree, timeout, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_DIR: this.gitDir, GIT_WORK_TREE: this.workTree, GIT_INDEX_FILE: path.join(this.gitDir, "index") } },
				(error, stdout, stderr) => resolve({ stdout, stderr, code: error ? (typeof error.code === "number" ? error.code : 1) : 0, killed: !!error?.killed }),
			);
			if (input !== undefined) child.stdin?.end(input);
		});
	}

	private async init(): Promise<void> {
		if (this.ready) return;
		if (!fs.existsSync(path.join(this.gitDir, "HEAD"))) {
			fs.mkdirSync(this.gitDir, { recursive: true });
			const result = await this.git(["init", "-q"]);
			if (result.code !== 0) throw new Error(`Could not create checkpoint store: ${result.stderr.trim()}`);
			await this.git(["config", "gc.auto", "0"]);
		}
		this.ready = true;
	}

	/**
	 * Writes the current workspace state and returns its tree hash. Honors .gitignore. A file git
	 * cannot add, such as an empty nested repository, is left out rather than failing the snapshot.
	 */
	async snapshot(): Promise<string> {
		await this.init();
		const added = await this.git(["add", "-A", "--ignore-errors", "."]);
		if (added.killed) throw new Error("the workspace is too large to snapshot quickly");
		const tree = await this.git(["write-tree"]);
		if (tree.code !== 0) throw new Error(tree.stderr.trim() || "write-tree failed");
		return tree.stdout.trim();
	}

	/** `-z` because a name may contain a tab, a quote or a newline. */
	async changedFiles(from: string, to: string): Promise<Change[]> {
		const result = await this.git(["diff", "--raw", "-z", "--no-abbrev", "--no-renames", from, to]);
		const fields = result.stdout.split("\0");
		const changes: Change[] = [];
		for (let i = 0; i + 1 < fields.length; i += 2) {
			const [oldMode, newMode, , , status] = (fields[i] as string).replace(/^:/, "").split(" ");
			changes.push({ status: status as string, path: fields[i + 1] as string, nestedRepo: oldMode === GITLINK_MODE || newMode === GITLINK_MODE });
		}
		return changes;
	}

	async diff(from: string, to: string, file?: string): Promise<string> {
		const result = await this.git(["diff", "--no-renames", from, to, ...(file ? ["--", file] : [])]);
		return result.stdout;
	}

	/** The absolute path, if nothing between the workspace and the file is a symlink out of it. */
	private safePath(relative: string): string | undefined {
		const full = path.resolve(this.workTree, relative);
		if (!full.startsWith(this.workTree + path.sep)) return undefined;
		let current = this.workTree;
		for (const part of path.relative(this.workTree, path.dirname(full)).split(path.sep).filter(Boolean)) {
			current = path.join(current, part);
			const stat = fs.lstatSync(current, { throwIfNoEntry: false });
			if (!stat) return full;
			if (stat.isSymbolicLink() || !stat.isDirectory()) return undefined;
		}
		return full;
	}

	private removeEmptyParents(full: string): void {
		let dir = path.dirname(full);
		while (dir.startsWith(this.workTree + path.sep)) {
			try {
				fs.rmdirSync(dir);
			} catch {
				return;
			}
			dir = path.dirname(dir);
		}
	}

	/**
	 * Makes the workspace match `tree`. Anything this cannot do safely it leaves alone and reports:
	 * a snapshot cannot speak for files it never held, so removing those would destroy user data.
	 */
	async restore(tree: string): Promise<RestoreResult> {
		const current = await this.snapshot();
		const changes = await this.changedFiles(tree, current);
		const kept: string[] = [];
		for (const change of changes) {
			if (change.nestedRepo) kept.push(`${change.path} (nested git repository; restore it with git)`);
		}
		const candidates = changes.filter((change) => change.status === "A" && !change.nestedRepo);

		const read = await this.git(["read-tree", tree]);
		if (read.code !== 0) throw new Error(read.stderr.trim());
		const stage = (await this.git(["ls-files", "-s", "-z"])).stdout;
		for (const line of stage.split("\0")) {
			if (!line.startsWith(`${GITLINK_MODE} `)) continue;
			const name = line.split("\t")[1] as string;
			if (!changes.some((change) => change.path === name && change.nestedRepo)) kept.push(`${name} (nested git repository; checkpoints do not cover its contents)`);
		}

		// The checkpoint's own ignore rules decide what it was never responsible for. If a .gitignore
		// has changed since, a file like .env can look newly added when it merely wasn't ignored.
		const ignoreFiles = (await this.git(["ls-files", "-z", "--", ":(glob)**/.gitignore"])).stdout.split("\0").filter((name) => name && this.canWrite(name));
		if (ignoreFiles.length > 0) await this.git(["checkout-index", "-f", "-z", "--stdin"], ignoreFiles.join("\0"));
		const names = candidates.map((change) => change.path).join("\0");
		const ignoredOutput = names ? (await this.git(["check-ignore", "-z", "--no-index", "--stdin"], names)).stdout : "";
		const ignored = new Set(ignoredOutput.split("\0").filter(Boolean));

		// Deleting comes first: what is there now can block a file or folder coming back.
		let removed = 0;
		for (const change of candidates) {
			if (ignored.has(change.path)) {
				kept.push(`${change.path} (ignored by the checkpoint's .gitignore)`);
				continue;
			}
			const full = this.safePath(change.path);
			const stat = full ? fs.lstatSync(full, { throwIfNoEntry: false }) : undefined;
			if (!full || !stat || stat.isDirectory()) {
				if (stat?.isDirectory() || !full) kept.push(`${change.path} (not a plain file inside the workspace)`);
				continue;
			}
			fs.rmSync(full, { force: true });
			this.removeEmptyParents(full);
			removed++;
		}

		// checkout-index -f deletes whatever is in a file's way, including a folder of ignored files or
		// a nested repository, and neither could be brought back. Only changed paths are written, and
		// none that is blocked by something that had to stay.
		const wanted = changes.filter((change) => change.status !== "A" && !change.nestedRepo);
		const writable = wanted.filter((change) => {
			if (this.canWrite(change.path)) return true;
			kept.push(`${change.path} (something that was left in place is in its way)`);
			return false;
		});
		if (writable.length > 0) {
			const checkout = await this.git(["checkout-index", "-f", "-z", "--stdin"], writable.map((change) => change.path).join("\0"));
			if (checkout.code !== 0) kept.push(`Some files could not be restored:\n${checkout.stderr.trim()}`);
		}
		return { restored: writable.length, removed, kept };
	}

	/** Whether writing this file would not need to delete anything already on disk. */
	private canWrite(relative: string): boolean {
		const full = this.safePath(relative);
		return !!full && !fs.lstatSync(full, { throwIfNoEntry: false })?.isDirectory();
	}

	/** Puts one file back to how it was in `tree`, deleting it if it did not exist there. */
	async revertFile(tree: string, relative: string): Promise<void> {
		const inTree = await this.git(["cat-file", "-e", `${tree}:${relative}`]);
		const full = this.safePath(relative);
		if (!full) throw new Error(`${relative} is not a plain path inside the workspace`);
		if (inTree.code !== 0) {
			const stat = fs.lstatSync(full, { throwIfNoEntry: false });
			if (stat?.isDirectory()) throw new Error(`${relative} is a directory, so it was left alone`);
			fs.rmSync(full, { force: true });
			return;
		}
		if (fs.lstatSync(full, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${relative} is now a directory, so it was left alone`);
		const result = await this.git(["checkout", tree, "--", relative]);
		if (result.code !== 0) throw new Error(result.stderr.trim());
	}
}

export interface CheckpointsApi {
	list(ctx: ExtensionContext): Checkpoint[];
	restoreCommand(ctx: ExtensionCommandContext): Promise<void>;
	repo(): ShadowRepo | undefined;
	baseline(ctx: ExtensionContext): Checkpoint | undefined;
	/** Takes a snapshot now if this tool call may change files and none exists for the current prompt. */
	beforeTool(toolName: string, input: Record<string, unknown>, ctx: ExtensionContext): Promise<void>;
}

export function setupCheckpoints(rt: Runtime): CheckpointsApi {
	const { pi } = rt;
	let repo: ShadowRepo | undefined;
	let takenForPrompt = false;
	let disabledReason: string | undefined;

	const mayChangeFiles = (toolName: string, input: Record<string, unknown>): boolean => {
		if (toolName === "edit" || toolName === "write") return true;
		if (toolName === "bash") return typeof input.command === "string" && !isReadOnlyCommand(input.command);
		if (toolName === "background_shell") return input.action === "start";
		if (toolName === "task") return input.readonly !== true && input.isolation !== "worktree";
		if (toolName === "task_group") return input.readonly !== true && input.mode !== "best_of_n";
		return false;
	};

	const list = (ctx: ExtensionContext): Checkpoint[] => {
		const out: Checkpoint[] = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_ENTRY) out.push(entry.data as Checkpoint);
		}
		return out;
	};

	const lastUserEntry = (ctx: ExtensionContext) => {
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry?.type === "message" && entry.message.role === "user") {
				const content = entry.message.content;
				const text = typeof content === "string" ? content : content.map((part) => (part.type === "text" ? part.text : "")).join("");
				return { id: entry.id, text };
			}
		}
		return undefined;
	};

	pi.on("session_start", () => {
		takenForPrompt = false;
		disabledReason = undefined;
		const home = os.homedir();
		if (!rt.config.checkpoints || rt.role.subagent) repo = undefined;
		else if (rt.root === home || rt.root === path.parse(rt.root).root) repo = undefined;
		else repo = new ShadowRepo(rt.root);
	});

	pi.on("before_agent_start", (event) => {
		if (event.messageType === "user") takenForPrompt = false;
	});

	const restoreCommand: CheckpointsApi["restoreCommand"] = async (ctx) => {
		if (!repo) {
			ctx.ui.notify(disabledReason ?? "Checkpoints are off for this workspace.", "warning");
			return;
		}
		const checkpoints = list(ctx).reverse();
		if (checkpoints.length === 0) {
			ctx.ui.notify("No checkpoints yet. One is taken before the agent first changes anything for a prompt.", "info");
			return;
		}
		const labels = checkpoints.map((checkpoint) => `${new Date(checkpoint.at).toLocaleTimeString()}  ${oneLine(checkpoint.label, 70)}`);
		const picked = await ctx.ui.select("Restore to before which prompt?", labels);
		if (picked === undefined) return;
		const checkpoint = checkpoints[labels.indexOf(picked)] as Checkpoint;
		const scope = await ctx.ui.select("What should be restored?", ["Files and conversation", "Files only", "Conversation only"]);
		if (scope === undefined) return;
		await ctx.waitForIdle();
		const summary: string[] = [];
		let kept: string[] = [];
		if (scope !== "Conversation only") {
			const safety = await repo.snapshot();
			pi.appendEntry(STATE_ENTRY, { tree: safety, at: Date.now(), label: `Before restoring to: ${checkpoint.label}` } satisfies Checkpoint);
			const result = await repo.restore(checkpoint.tree);
			kept = result.kept;
			summary.push(`${result.restored} files restored, ${result.removed} removed`);
		}
		if (scope !== "Files only" && checkpoint.entryId) {
			const result = await ctx.navigateTree(checkpoint.entryId, { summarize: false });
			if (!result.cancelled) {
				ctx.ui.setEditorText(checkpoint.label);
				summary.push("conversation rewound");
			}
		}
		const details = kept.length ? `\nLeft as they are:\n${kept.join("\n")}` : "";
		ctx.ui.notify(`Restored: ${summary.join("; ")}.${details}`, kept.length ? "warning" : "info");
	};

	return {
		list,
		restoreCommand,
		repo: () => repo,
		baseline: (ctx) => list(ctx)[0],
		async beforeTool(toolName, input, ctx) {
			if (!repo || takenForPrompt || disabledReason || !mayChangeFiles(toolName, input)) return;
			takenForPrompt = true;
			try {
				const tree = await repo.snapshot();
				const user = lastUserEntry(ctx);
				pi.appendEntry(STATE_ENTRY, { tree, at: Date.now(), label: user?.text ?? "(no prompt)", entryId: user?.id } satisfies Checkpoint);
			} catch (error) {
				disabledReason = `Checkpoints are off for this session: ${error instanceof Error ? error.message : String(error)}`;
				if (ctx.hasUI) ctx.ui.notify(disabledReason, "warning");
			}
		},
	};
}
