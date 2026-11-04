/** A scrollable read-only overlay for diffs, rule files and status reports. */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export function colorizeDiff(text: string, theme: Theme): string {
	return text
		.split("\n")
		.map((line) => {
			if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) return theme.fg("dim", line);
			if (line.startsWith("@@")) return theme.fg("accent", line);
			if (line.startsWith("+")) return theme.fg("success", line);
			if (line.startsWith("-")) return theme.fg("error", line);
			return theme.fg("muted", line);
		})
		.join("\n");
}

export function boxLine(content: string, width: number, border: (text: string) => string): string {
	const inner = Math.max(0, width - 4);
	const clipped = truncateToWidth(content, inner, "…");
	return `${border("│")} ${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))} ${border("│")}`;
}

export function boxEdge(width: number, border: (text: string) => string, label: string, corners: [string, string]): string {
	const inner = Math.max(0, width - 2);
	const clipped = truncateToWidth(label, Math.max(0, inner - 2), "");
	const fill = Math.max(0, inner - visibleWidth(clipped) - 1);
	return border(`${corners[0]}─`) + clipped + border(`${"─".repeat(fill)}${corners[1]}`);
}

export async function showViewer(ctx: ExtensionContext, title: string, text: string | ((theme: Theme) => string)): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`${title}\n${typeof text === "string" ? text : text(ctx.ui.theme)}`, "info");
		return;
	}
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			let scroll = 0;
			let cachedWidth = -1;
			let wrapped: string[] = [];
			const border = (value: string) => theme.fg("border", value);
			const body = typeof text === "string" ? text : text(theme);
			const pageSize = () => Math.max(5, Math.floor(tui.terminal.rows * 0.8) - 2);
			return {
				render(width: number): string[] {
					if (width !== cachedWidth) {
						cachedWidth = width;
						wrapped = body.split("\n").flatMap((line) => (line ? wrapTextWithAnsi(line, Math.max(10, width - 4)) : [""]));
					}
					const page = pageSize();
					scroll = Math.max(0, Math.min(scroll, Math.max(0, wrapped.length - page)));
					const visible = wrapped.slice(scroll, scroll + page);
					const position = wrapped.length > page ? theme.fg("dim", ` ${scroll + 1}-${scroll + visible.length}/${wrapped.length} `) : "";
					return [
						boxEdge(width, border, theme.bold(` ${title} `), ["╭", "╮"]),
						...visible.map((line) => boxLine(line, width, border)),
						boxEdge(width, border, `${position}${theme.fg("dim", " ↑↓ pgup pgdn scroll · esc close ")}`, ["╰", "╯"]),
					];
				},
				handleInput(data: string): void {
					if (matchesKey(data, Key.escape) || data === "q") {
						done();
						return;
					}
					if (matchesKey(data, Key.up)) scroll--;
					else if (matchesKey(data, Key.down)) scroll++;
					else if (matchesKey(data, "pageUp")) scroll -= pageSize();
					else if (matchesKey(data, "pageDown") || data === " ") scroll += pageSize();
					else return;
					tui.requestRender();
				},
				invalidate() {
					cachedWidth = -1;
				},
			};
		},
		{ overlay: true, overlayOptions: { width: "92%", maxHeight: "85%", anchor: "center" } },
	);
}
