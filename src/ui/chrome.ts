/** Header, footer, theme and working indicators. */

import * as os from "node:os";
import { VERSION, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Runtime } from "../core/runtime.ts";
import { formatTokens } from "../core/text.ts";
import { createComposerFactory, type ComposerDeps } from "./composer.ts";

function shortCwd(cwd: string): string {
	const home = os.homedir();
	return cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

export interface ChromeDeps extends ComposerDeps {
	stats(): string;
	approvals(): string;
	extraCost(): number;
}

const WORKING: Record<string, string> = { plan: "Planning", ask: "Looking into it", debug: "Investigating", implement: "Working" };

export function applyTheme(rt: Runtime, ctx: ExtensionContext): void {
	const setting = rt.config.ui.theme;
	if (setting === false) return;
	const saved = rt.pi.getSettings().theme;
	if (setting === "auto" && saved && saved !== "system") return;
	const name = setting === "auto" ? (ctx.ui.theme.appearance === "light" ? "cursor-light" : "cursor-dark") : setting;
	const theme = ctx.ui.getTheme(name);
	// Passing the theme object leaves the user's saved theme setting alone.
	if (theme) ctx.ui.setTheme(theme);
}

export function installChrome(rt: Runtime, ctx: ExtensionContext, deps: ChromeDeps): void {
	const { ui } = rt.config;
	if (ui.composer) ctx.ui.setEditorComponent(createComposerFactory(deps));
	if (ui.header) {
		ctx.ui.setHeader((_tui, theme: Theme) => ({
			render(width: number): string[] {
				const title = `${theme.fg("accent", "⬡")} ${theme.bold("pi")}${theme.fg("dim", ` · cursor mode · v${VERSION}`)}`;
				const lines = [
					"",
					` ${title}`,
					` ${theme.fg("muted", deps.stats())}`,
					` ${theme.fg("dim", "shift+tab mode · @ mention · / commands · alt+a agents · /restore rewind")}`,
					"",
				];
				return lines.map((line) => truncateToWidth(line, width));
			},
			invalidate() {},
		}));
	}
	if (ui.footer) {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number): string[] {
					let input = 0;
					let output = 0;
					let cost = deps.extraCost();
					for (const entry of ctx.sessionManager.getBranch()) {
						if (entry.type !== "message") continue;
						const usage = (entry.message as { usage?: { input: number; output: number; cost: { total: number } } }).usage;
						if (!usage) continue;
						input += usage.input;
						output += usage.output;
						cost += usage.cost.total;
					}
					const branch = footerData.getGitBranch();
					const statuses = [...footerData.getExtensionStatuses().values()].filter(Boolean);
					const left = theme.fg("dim", ` ${shortCwd(ctx.cwd)}${branch ? `  ⎇ ${branch}` : ""}`);
					const tokens = input + output > 0 ? `↑${formatTokens(input)} ↓${formatTokens(output)} $${cost.toFixed(3)} · ` : "";
					// Statuses sit on the right so that a long path cannot push them off the line.
					const right = `${statuses.length ? `${statuses.join(theme.fg("dim", " · "))}  ` : ""}${theme.fg("dim", `${tokens}${deps.approvals()} `)}`;
					const room = Math.max(0, width - visibleWidth(right) - 1);
					const clipped = truncateToWidth(left, room, "…");
					const pad = " ".repeat(Math.max(1, width - visibleWidth(clipped) - visibleWidth(right)));
					return [truncateToWidth(clipped + pad + right, width)];
				},
			};
		});
	}
	const dots = ["·", "•", "●", "•"].map((frame) => ctx.ui.theme.fg("accent", frame));
	ctx.ui.setWorkingIndicator({ frames: dots, intervalMs: 160 });
	ctx.ui.setHiddenThinkingLabel("Thought");
	ctx.ui.setTitle(`pi - ${shortCwd(ctx.cwd)}`);
}

export function workingMessageFor(mode: string): string {
	return `${WORKING[mode] ?? "Working"}…`;
}
