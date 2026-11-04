/** `background_shell`: long-running commands such as dev servers, which the blocking `bash` tool cannot host. */

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { truncateTail } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { stateDir, type Runtime } from "../core/runtime.ts";
import { stringEnum } from "../core/schema.ts";
import { formatDuration, oneLine } from "../core/text.ts";

interface Shell {
	id: string;
	command: string;
	logFile: string;
	startedAt: number;
	endedAt?: number;
	exitCode?: number | null;
	proc?: ChildProcess;
}

const Params = Type.Object({
	action: stringEnum(["start", "output", "stop", "list"] as const, { description: "start: launch command in the background. output: read its recent output. stop: terminate it. list: show all." }),
	command: Type.Optional(Type.String({ description: "Command to run, for start." })),
	id: Type.Optional(Type.String({ description: "Shell ID, for output and stop." })),
	tail_lines: Type.Optional(Type.Number({ description: "Lines of output to return. Default 100." })),
	wait_seconds: Type.Optional(Type.Number({ description: "For start: wait this long, then include the output so far." })),
});

function killGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
	if (!proc.pid) return;
	try {
		process.kill(-proc.pid, signal);
	} catch {
		proc.kill(signal);
	}
}

export function setupBackgroundShell(rt: Runtime): void {
	const shells = new Map<string, Shell>();
	const readOutput = (shell: Shell, lines: number) => {
		let text = "";
		try {
			text = fs.readFileSync(shell.logFile, "utf8");
		} catch {
			// Nothing written yet.
		}
		return truncateTail(text, { maxLines: lines, maxBytes: 30000 }).content;
	};
	const describe = (shell: Shell) => {
		const state = shell.endedAt ? `exited ${shell.exitCode ?? "by signal"}` : `running ${formatDuration(Date.now() - shell.startedAt)}`;
		return `${shell.id} · ${state} · ${shell.command}`;
	};

	rt.pi.on("session_shutdown", () => {
		for (const shell of shells.values()) {
			if (shell.proc && !shell.endedAt) killGroup(shell.proc, "SIGTERM");
		}
	});

	rt.pi.registerTool({
		name: "background_shell",
		label: "Background Shell",
		description: "Run a long-lived command, such as a dev server or a watcher, in the background, and read its output later. Use bash for commands that finish on their own.",
		promptSnippet: "Run long-lived commands in the background and read their output",
		parameters: Params,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const text = (value: string, shell?: Shell) => ({ content: [{ type: "text" as const, text: value }], details: { command: shell?.command, id: shell?.id } });
			const find = () => {
				const shell = shells.get(params.id ?? "");
				if (!shell) throw new Error(`No background shell with id ${params.id}`);
				return shell;
			};
			switch (params.action) {
				case "start": {
					if (!params.command) throw new Error('action "start" needs a command');
					const id = `s${randomBytes(3).toString("hex")}`;
					const logFile = path.join(stateDir(), "shells", `${id}.log`);
					fs.mkdirSync(path.dirname(logFile), { recursive: true });
					const log = fs.openSync(logFile, "a");
					const proc = spawn(process.env.SHELL || "sh", ["-c", params.command], { cwd: ctx.cwd, detached: true, stdio: ["ignore", log, log] });
					fs.closeSync(log);
					const shell: Shell = { id, command: params.command, logFile, startedAt: Date.now(), proc };
					shells.set(id, shell);
					proc.on("close", (code) => {
						shell.endedAt = Date.now();
						shell.exitCode = code;
					});
					proc.on("error", (error) => {
						shell.endedAt = Date.now();
						fs.appendFileSync(logFile, `Could not start: ${error.message}\n`);
					});
					proc.unref();
					const wait = Math.min(params.wait_seconds ?? 2, 60);
					await new Promise<void>((resolve) => {
						const timer = setTimeout(resolve, wait * 1000);
						signal?.addEventListener("abort", () => {
							clearTimeout(timer);
							resolve();
						});
					});
					return text(`Started ${describe(shell)}\nLog: ${logFile}\n\n${readOutput(shell, params.tail_lines ?? 40)}`, shell);
				}
				case "output": {
					const shell = find();
					return text(`${describe(shell)}\n\n${readOutput(shell, params.tail_lines ?? 100)}`, shell);
				}
				case "stop": {
					const shell = find();
					if (shell.proc && !shell.endedAt) {
						killGroup(shell.proc, "SIGTERM");
						const proc = shell.proc;
						setTimeout(() => {
							if (!shell.endedAt) killGroup(proc, "SIGKILL");
						}, 3000).unref();
					}
					return text(`Stopping ${describe(shell)}`, shell);
				}
				case "list":
					return text([...shells.values()].map(describe).join("\n") || "No background shells.");
				default:
					throw new Error(`Unknown action ${params.action as string}`);
			}
		},
		renderCall: (args, theme) => new Text(`${theme.fg("toolTitle", `Background ${args.action}`)} ${theme.fg("muted", oneLine(String(args.command ?? args.id ?? ""), 90))}`, 0, 0),
		renderResult: (result, { expanded }, theme) => {
			const part = result.content.find((item) => item.type === "text");
			if (!expanded || part?.type !== "text") return new Text("", 0, 0);
			return new Text(theme.fg("toolOutput", part.text), 0, 0);
		},
	});
}
