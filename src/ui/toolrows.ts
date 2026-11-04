/**
 * Compact, Cursor-like rows for built-in tools: "Read src/a.ts", "Edited src/a.ts +3 -1", and so on.
 * Output stays folded until Ctrl+O, except diffs and a short tail of command output.
 */

import * as os from "node:os";
import { renderDiff, type ExtensionAPI, type Theme, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Box, Container, Text, type Component } from "@earendil-works/pi-tui";
import { formatDuration, oneLine } from "../core/text.ts";

const DIFF_PREVIEW_LINES = 14;
const COMMAND_TAIL_LINES = 6;

function shortPath(raw: unknown): string {
	const value = typeof raw === "string" ? raw : "";
	const home = os.homedir();
	return value.startsWith(home) ? `~${value.slice(home.length)}` : value;
}

function dot(theme: Theme, state: { executionStarted: boolean; isPartial: boolean; isError: boolean }): string {
	if (!state.executionStarted || state.isPartial) return theme.fg("dim", "○");
	return state.isError ? theme.fg("error", "●") : theme.fg("success", "●");
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

function row(context: { lastComponent?: Component }, text: string): Text {
	const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	component.setText(text);
	return component;
}

const nothing = () => new Container();

/** Keeps rows compact: no shaded box or vertical padding, only the transcript's left gutter. */
class Row extends Box {
	inner?: Component;
}

function padded(inner: Component, context: { outputPad: number; lastComponent?: Component }): Component {
	const row = context.lastComponent instanceof Row ? context.lastComponent : new Row(context.outputPad, 0);
	if (row.inner !== inner) {
		row.clear();
		row.addChild(inner);
		row.inner = inner;
	}
	return row;
}

function compact(renderers: ToolRenderers | undefined, name: string): ToolRenderers {
	const unwrap = <T extends { lastComponent?: Component }>(context: T): T => ({ ...context, lastComponent: context.lastComponent instanceof Row ? context.lastComponent.inner : undefined });
	return {
		renderShell: "self",
		renderCall: (args: any, theme, context) => {
			const inner = renderers?.renderCall ? renderers.renderCall(args, theme, unwrap(context)) : new Text(`${dot(theme, context)} ${theme.fg("toolTitle", name)} ${theme.fg("dim", oneLine(JSON.stringify(args ?? {}), 90))}`, 0, 0);
			return padded(inner, context);
		},
		renderResult: (result, options, theme, context) => {
			const inner = renderers?.renderResult ? renderers.renderResult(result, options, theme, unwrap(context)) : options.expanded || context.isError ? new Text(theme.fg(context.isError ? "error" : "toolOutput", resultText(result)), 0, 0) : nothing();
			return padded(inner, context);
		},
	};
}

/** A result can update its call row, but redrawing has to wait until the current draw has finished. */
function refreshLater(context: { invalidate(): void }): void {
	setTimeout(() => context.invalidate(), 0);
}

export function installToolRows(pi: ExtensionAPI, enabled: () => boolean): void {
	pi.registerToolRenderer((toolName, next) => {
		const base = next();
		if (!enabled()) return base;
		switch (toolName) {
			case "read":
				return compact({
					renderCall: (args: any, theme, context) => {
						const end = args.limit ? (args.offset ?? 1) + args.limit - 1 : undefined;
						const range = args.offset || end ? theme.fg("dim", ` L${args.offset ?? 1}${end ? `-${end}` : ""}`) : "";
						return row(context, `${dot(theme, context)} ${theme.fg("toolTitle", "Read")} ${theme.fg("accent", shortPath(args.path))}${range}`);
					},
					renderResult: (result, options, theme, context) => {
						if (context.isError) return new Text(`  ${theme.fg("error", oneLine(resultText(result), 200))}`, 0, 0);
						return options.expanded && base?.renderResult ? base.renderResult(result, options, theme, context) : nothing();
					},
				}, toolName);
			case "write":
				return compact({
					renderCall: (args: any, theme, context) => {
						const lines = typeof args.content === "string" ? args.content.split("\n").length : 0;
						const verb = context.isPartial || !context.executionStarted ? "Writing" : "Wrote";
						return row(context, `${dot(theme, context)} ${theme.fg("toolTitle", verb)} ${theme.fg("accent", shortPath(args.path))}${lines ? theme.fg("dim", ` ${lines} lines`) : ""}`);
					},
					renderResult: (result, options, theme, context) => {
						if (context.isError) return new Text(`  ${theme.fg("error", oneLine(resultText(result), 200))}`, 0, 0);
						return options.expanded && base?.renderResult ? base.renderResult(result, options, theme, context) : nothing();
					},
				}, toolName);
			case "edit":
				return compact({
					renderCall: (args: any, theme, context) => {
						const verb = context.isPartial || !context.executionStarted ? "Editing" : context.isError ? "Edit failed" : "Edited";
						const stats = (context.state as { stats?: string }).stats ?? "";
						return row(context, `${dot(theme, context)} ${theme.fg("toolTitle", verb)} ${theme.fg("accent", shortPath(args.path))}${stats ? ` ${stats}` : ""}`);
					},
					renderResult: (result, options, theme, context) => {
						if (context.isError) return new Text(`  ${theme.fg("error", oneLine(resultText(result), 300))}`, 0, 0);
						const diff = (result.details as { diff?: string } | undefined)?.diff;
						if (!diff) return options.isPartial || !base?.renderResult ? nothing() : base.renderResult(result, options, theme, context);
						const raw = diff.split("\n");
						const added = raw.filter((line) => line.startsWith("+")).length;
						const removed = raw.filter((line) => line.startsWith("-")).length;
						const state = context.state as { stats?: string };
						const stats = `${theme.fg("success", `+${added}`)} ${theme.fg("error", `-${removed}`)}`;
						if (state.stats !== stats) {
							state.stats = stats;
							refreshLater(context);
						}
						const rendered = renderDiff(diff).split("\n");
						const shown = options.expanded ? rendered : rendered.slice(0, DIFF_PREVIEW_LINES);
						const more = rendered.length - shown.length;
						const tail = more > 0 ? `\n${theme.fg("dim", `… ${more} more lines (${context.keyText("app.tools.expand")})`)}` : "";
						return new Text(shown.join("\n") + tail, 0, 0);
					},
				}, toolName);
			case "bash":
				return compact({
					renderCall: (args: any, theme, context) => {
						const time = context.durationMs !== undefined ? theme.fg("dim", ` ${formatDuration(context.durationMs)}`) : "";
						return row(context, `${dot(theme, context)} ${theme.fg("dim", "$")} ${theme.fg("toolTitle", oneLine(String(args.command ?? ""), context.expanded ? 2000 : 120))}${time}`);
					},
					renderResult: (result, options, theme, context) => {
						if (options.expanded && base?.renderResult) return base.renderResult(result, options, theme, context);
						const text = resultText(result).trimEnd();
						if (!text || text === "(no output)") return nothing();
						const lines = text.split("\n");
						const shown = lines.slice(-COMMAND_TAIL_LINES).map((line) => theme.fg(context.isError ? "error" : "toolOutput", line));
						const more = lines.length - shown.length;
						const head = more > 0 ? `${theme.fg("dim", `… ${more} earlier lines (${context.keyText("app.tools.expand")})`)}\n` : "";
						return new Text(head + shown.join("\n"), 0, 0);
					},
				}, toolName);
			case "grep":
			case "find":
			case "ls": {
				const verb = toolName === "grep" ? "Searched" : toolName === "find" ? "Found" : "Listed";
				return compact({
					renderCall: (args: any, theme, context) => {
						const subject = toolName === "ls" ? shortPath(args.path) || "." : `"${oneLine(String(args.pattern ?? ""), 60)}"`;
						const where = toolName !== "ls" && args.path ? theme.fg("dim", ` in ${shortPath(args.path)}`) : "";
						const count = (context.state as { count?: string }).count ?? "";
						return row(context, `${dot(theme, context)} ${theme.fg("toolTitle", verb)} ${theme.fg("accent", subject)}${where}${count ? theme.fg("dim", ` · ${count}`) : ""}`);
					},
					renderResult: (result, options, theme, context) => {
						if (context.isError) return new Text(`  ${theme.fg("error", oneLine(resultText(result), 200))}`, 0, 0);
						const text = resultText(result).trim();
						const lines = text && !/^No (files|matches)/i.test(text) ? text.split("\n").length : 0;
						const [one, many] = toolName === "grep" ? ["match", "matches"] : toolName === "find" ? ["file", "files"] : ["entry", "entries"];
						const state = context.state as { count?: string };
						const count = `${lines} ${lines === 1 ? one : many}`;
						if (!options.isPartial && state.count !== count) {
							state.count = count;
							refreshLater(context);
						}
						return options.expanded && base?.renderResult ? base.renderResult(result, options, theme, context) : nothing();
					},
				}, toolName);
			}
			default:
				return compact(base, toolName);
		}
	});
}
