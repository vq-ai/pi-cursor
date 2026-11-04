/**
 * Debug mode's runtime evidence loop: a local log endpoint that instrumented code posts to, and a
 * reproduction step that waits for the user and returns what was captured.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { createServer, type Server } from "node:http";
import * as path from "node:path";
import { truncateTail } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { stateDir, type Runtime } from "../core/runtime.ts";
import { stringEnum } from "../core/schema.ts";

interface DebugSession {
	server: Server;
	url: string;
	logFile: string;
}

const Params = Type.Object({
	action: stringEnum(["start", "await_reproduction", "read", "clear", "stop"] as const, {
		description: "start: open the log endpoint. await_reproduction: clear the log, wait for the user to reproduce, return the log. read: return the log. clear: empty the log. stop: close the endpoint.",
	}),
	steps: Type.Optional(Type.String({ description: "For await_reproduction: exact steps for the user to follow." })),
	tail_lines: Type.Optional(Type.Number({ description: "For read: lines to return. Default 400." })),
});

const instructions = (url: string, logFile: string) => `Log endpoint: POST JSON to ${url}
Log file: ${logFile}

Wrap every insertion in pi-debug markers so that it can be removed later.

JavaScript / TypeScript (browser or Node):
// #region pi-debug
fetch(${JSON.stringify(url)}, { method: "POST", body: JSON.stringify({ hypothesis: "A", location: "file.ts:42", message: "...", data: { value } }) }).catch(() => {});
// #endregion pi-debug

Python:
# region pi-debug
import json, urllib.request; urllib.request.urlopen(urllib.request.Request(${JSON.stringify(url)}, data=json.dumps({"hypothesis": "A", "location": "file.py:42", "message": "...", "data": {"value": value}}).encode()))
# endregion pi-debug

Any other language: send the same POST, or append one JSON object per line to the log file.`;

export function setupDebug(rt: Runtime): void {
	const { pi } = rt;
	let session: DebugSession | undefined;

	const close = () => {
		session?.server.close();
		session = undefined;
	};

	const start = async (sessionId: string): Promise<DebugSession> => {
		if (session) return session;
		const logFile = path.join(stateDir(), "debug", `${sessionId}.ndjson`);
		fs.mkdirSync(path.dirname(logFile), { recursive: true });
		fs.writeFileSync(logFile, "");
		const token = randomBytes(8).toString("hex");
		const server = createServer((request, response) => {
			response.setHeader("access-control-allow-origin", "*");
			response.setHeader("access-control-allow-headers", "content-type");
			if (request.method === "OPTIONS") {
				response.writeHead(204).end();
				return;
			}
			if (request.method !== "POST" || request.url !== `/ingest/${token}`) {
				response.writeHead(404).end();
				return;
			}
			let body = "";
			request.on("data", (chunk: Buffer) => {
				if (body.length < 1024 * 1024) body += chunk.toString();
			});
			request.on("end", () => {
				let record: unknown;
				try {
					record = JSON.parse(body);
				} catch {
					record = { message: body };
				}
				fs.appendFileSync(logFile, `${JSON.stringify({ time: new Date().toISOString(), ...(record as object) })}\n`);
				response.writeHead(204).end();
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		server.unref();
		const address = server.address() as { port: number };
		session = { server, url: `http://127.0.0.1:${address.port}/ingest/${token}`, logFile };
		return session;
	};

	const readLog = (active: DebugSession, lines: number): string => {
		const text = fs.readFileSync(active.logFile, "utf8");
		if (!text.trim()) return "(The log is empty: no instrumented code ran, or it could not reach the endpoint.)";
		const truncated = truncateTail(text, { maxLines: lines, maxBytes: 40000 });
		return `${truncated.truncated ? `[Showing the last ${truncated.outputLines} of ${truncated.totalLines} lines]\n` : ""}${truncated.content}`;
	};

	pi.on("session_shutdown", close);

	pi.registerTool({
		name: "debug_session",
		label: "Debug Session",
		description: "Runtime evidence for debugging: opens a local log endpoint for instrumented code, waits for the user to reproduce a problem, and returns what was logged.",
		parameters: Params,
		defaultActive: false,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const text = (value: string, extra: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: value }], details: { action: params.action, ...extra } });
			if (params.action === "start") {
				const active = await start(ctx.sessionManager.getSessionId());
				return text(instructions(active.url, active.logFile));
			}
			if (params.action === "stop") {
				close();
				return text("Log endpoint closed. Remember to remove every pi-debug region.");
			}
			if (!session) throw new Error('Call debug_session with action "start" first.');
			if (params.action === "clear") {
				fs.writeFileSync(session.logFile, "");
				return text("Log cleared.");
			}
			if (params.action === "read") return text(readLog(session, params.tail_lines ?? 400));
			if (!ctx.hasUI) throw new Error("No user is available to reproduce this. Reproduce it yourself by running a command, then use action read.");
			fs.writeFileSync(session.logFile, "");
			const fixedLabel = "It works now";
			const title = `Reproduce the issue, then continue${params.steps ? `:\n${params.steps}` : ""}`;
			const choice = await ctx.ui.select(title, ["Reproduced: analyze the logs", fixedLabel, "Cancel"]);
			if (choice === undefined || choice === "Cancel") return text("The user cancelled the reproduction step. Wait for their next message.");
			const log = readLog(session, params.tail_lines ?? 400);
			if (choice === fixedLabel) return text(`The user reports that the problem no longer occurs. Confirm with the log, then clean up the instrumentation.\n\n${log}`);
			return text(`The user reproduced the issue. Captured log:\n\n${log}`);
		},
		renderCall: (args, theme) => new Text(`${theme.fg("error", "✱")} ${theme.fg("toolTitle", "Debug")} ${theme.fg("muted", String(args.action ?? ""))}`, 0, 0),
		renderResult: (result, { expanded }, theme) => {
			const part = result.content.find((item) => item.type === "text");
			if (!expanded || part?.type !== "text") return new Text("", 0, 0);
			return new Text(theme.fg("toolOutput", part.text), 0, 0);
		},
	});
}
