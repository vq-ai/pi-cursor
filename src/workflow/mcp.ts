/** Connects the MCP servers from Cursor's `mcp.json` files through Pi's built-in MCP support. */

import * as os from "node:os";
import * as path from "node:path";
import { readJson, type Runtime } from "../core/runtime.ts";

const KNOWN_FIELDS = ["command", "args", "env", "cwd", "url", "headers", "oauth", "timeout", "enabled", "exposure", "toolExposure", "description"];

/** Replaces Cursor's config variables: `${env:NAME}`, `${userHome}`, `${workspaceFolder}`, and so on. */
export function interpolate(value: unknown, root: string): unknown {
	if (typeof value === "string") {
		return value
			.replace(/\$\{env:([\w]+)\}/g, (_match, name: string) => process.env[name] ?? "")
			.replace(/\$\{userHome\}/g, os.homedir())
			.replace(/\$\{workspaceFolder\}/g, root)
			.replace(/\$\{workspaceFolderBasename\}/g, path.basename(root))
			.replace(/\$\{pathSeparator\}/g, path.sep);
	}
	if (Array.isArray(value)) return value.map((item) => interpolate(item, root));
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolate(item, root)]));
	}
	return value;
}

export function toPiServer(raw: Record<string, unknown>, root: string): Record<string, unknown> {
	const server: Record<string, unknown> = {};
	for (const field of KNOWN_FIELDS) {
		if (raw[field] !== undefined) server[field] = interpolate(raw[field], root);
	}
	return server;
}

export interface McpApi {
	imported(): string[];
	errors(): string[];
}

export function setupCursorMcp(rt: Runtime): McpApi {
	const registered: string[] = [];
	const failures: string[] = [];

	rt.pi.on("session_start", () => {
		registered.length = 0;
		failures.length = 0;
		if (!rt.config.mcp || !rt.config.compat.cursor) return;
		const sources = [path.join(os.homedir(), ".cursor", "mcp.json")];
		if (rt.execTrusted) sources.push(path.join(rt.root, ".cursor", "mcp.json"));
		const servers = new Map<string, Record<string, unknown>>();
		for (const file of sources) {
			const config = readJson<{ mcpServers?: Record<string, Record<string, unknown>> }>(file);
			for (const [name, raw] of Object.entries(config?.mcpServers ?? {})) servers.set(name, toPiServer(raw, rt.root));
		}
		for (const [name, server] of servers) {
			try {
				rt.pi.registerMcpServer(name, server as never);
				registered.push(name);
			} catch (error) {
				failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	});

	return { imported: () => registered, errors: () => failures };
}
