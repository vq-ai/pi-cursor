/**
 * The Cursor-style composer: a rounded box whose border takes the current mode's color, with the mode,
 * model and context usage in its bottom edge. Shift+Tab cycles modes, as it does in Cursor.
 */

import { CustomEditor, type ExtensionContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import type { ModesApi } from "../modes/modes.ts";

export interface ComposerDeps {
	modes: ModesApi;
	ctx(): ExtensionContext | undefined;
	thinking(): string;
	/** Short right-hand status, such as running agents. */
	badge(): string;
	detachForeground(): boolean;
	placeholder(): string;
}

function fit(left: string, right: string, width: number, border: (text: string) => string, corners: [string, string]): string {
	const inner = Math.max(0, width - 2);
	let leftText = left;
	let rightText = right;
	while (visibleWidth(leftText) + visibleWidth(rightText) + 2 > inner && visibleWidth(rightText) > 0) {
		rightText = truncateToWidth(rightText, visibleWidth(rightText) - 1, "");
	}
	while (visibleWidth(leftText) + visibleWidth(rightText) + 2 > inner && visibleWidth(leftText) > 0) {
		leftText = truncateToWidth(leftText, visibleWidth(leftText) - 1, "");
	}
	const gap = Math.max(0, inner - visibleWidth(leftText) - visibleWidth(rightText) - 2);
	return `${border(`${corners[0]}─`)}${leftText}${border("─".repeat(gap))}${rightText}${border(`─${corners[1]}`)}`;
}

function shortModel(id: string): string {
	return id.replace(/-\d{8}$/, "").replace(/^claude-/, "");
}

export function createComposerFactory(deps: ComposerDeps) {
	return (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => new Composer(tui, theme, keybindings, deps);
}

class Composer extends CustomEditor {
	private readonly deps: ComposerDeps;
	private bottomLine = "";

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, deps: ComposerDeps) {
		super(tui, theme, keybindings, { paddingX: 1 });
		this.deps = deps;
	}

	/** The app copies its own padding onto custom editors; the box needs its inner gutter. */
	override setPaddingX(): void {}

	private paint(text: string): string {
		const ctx = this.deps.ctx();
		if (!ctx) return text;
		return ctx.ui.theme.fg(this.deps.modes.current().color === "accent" ? "border" : this.deps.modes.current().color, text);
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		const full = width + 2;
		const label = hiddenLineCount > 0 ? ` ↑ ${hiddenLineCount} more ` : "";
		return fit("", label ? this.paint(label) : "", full, (text) => this.paint(text), ["╭", "╮"]);
	}

	protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
		const full = width + 2;
		const ctx = this.deps.ctx();
		const paint = (text: string) => this.paint(text);
		if (!ctx) {
			this.bottomLine = fit("", "", full, paint, ["╰", "╯"]);
			return this.bottomLine;
		}
		const ui = ctx.ui.theme;
		const mode = this.deps.modes.current();
		const parts = [ui.fg(mode.color, ui.bold(` ${mode.icon} ${mode.label} `))];
		if (ctx.model) {
			const thinking = this.deps.thinking();
			parts.push(ui.fg("muted", ` ${shortModel(ctx.model.id)}${thinking && thinking !== "off" ? ui.fg("dim", ` · ${thinking}`) : ""} `));
		}
		const right: string[] = [];
		if (hiddenLineCount > 0) right.push(ui.fg("dim", ` ↓ ${hiddenLineCount} more `));
		const badge = this.deps.badge();
		if (badge) right.push(` ${badge} `);
		const usage = ctx.getContextUsage();
		if (usage?.percent != null) {
			const percent = Math.round(usage.percent);
			right.push(ui.fg(percent >= 85 ? "error" : percent >= 65 ? "warning" : "dim", ` ${percent}% `));
		}
		this.bottomLine = fit(parts.join(""), right.join(""), full, paint, ["╰", "╯"]);
		return this.bottomLine;
	}

	override render(width: number): string[] {
		const inner = Math.max(4, width - 2);
		const lines = super.render(inner);
		const bottom = lines.lastIndexOf(this.bottomLine);
		const side = this.paint("│");
		const empty = this.getText() === "" && !this.isShowingAutocomplete();
		return lines.map((line, index) => {
			if (index === 0 || index === bottom) return line;
			if (index > bottom) return ` ${line}`;
			let content = line;
			if (index === 1 && empty) {
				const trailing = /( +)$/.exec(line);
				const hint = this.deps.placeholder();
				if (trailing && (trailing[1] as string).length > visibleWidth(hint) + 1) {
					const ctx = this.deps.ctx();
					const styled = ctx ? ctx.ui.theme.fg("dim", hint) : hint;
					content = `${line.slice(0, trailing.index)}${styled}${" ".repeat((trailing[1] as string).length - visibleWidth(hint))}`;
				}
			}
			return `${side}${content}${side}`;
		});
	}

	override handleMouse(event: Parameters<CustomEditor["handleMouse"]>[0]) {
		return super.handleMouse({ ...event, x: event.x - 1, width: event.width - 2 });
	}

	override handleInput(data: string): void {
		const ctx = this.deps.ctx();
		if (ctx && matchesKey(data, "shift+tab")) {
			void this.deps.modes.cycle(ctx).then(() => this.tui.requestRender());
			return;
		}
		if (matchesKey(data, "alt+t")) {
			this.actionHandlers.get("app.thinking.cycle")?.();
			return;
		}
		if (matchesKey(data, "ctrl+b") && this.deps.detachForeground()) return;
		super.handleInput(data);
	}
}
