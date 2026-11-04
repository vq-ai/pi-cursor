/** The live agents strip above the composer and the `/tasks` overlay for managing them. */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import type { Runtime } from "../core/runtime.ts";
import { formatTokens, oneLine } from "../core/text.ts";
import { boxEdge, boxLine, colorizeDiff } from "../ui/viewer.ts";
import { getTaskManager, isActive, type TaskListener, type TaskSnapshot } from "./manager.ts";
import { elapsed, latestActivity, statusIcon, taskStats } from "./render.ts";
import type { SubagentsApi } from "./tools.ts";

const WIDGET = "pi-cursor.tasks";
const MAX_WIDGET_ROWS = 6;

export interface PanelApi {
	open(ctx: ExtensionContext): Promise<void>;
	badge(theme: Theme): string;
}

function needsReview(task: TaskSnapshot): boolean {
	return task.worktree?.state === "active" && !isActive(task) && (task.worktree.diff?.files.length ?? 0) > 0;
}

export function setupTaskPanel(rt: Runtime, api: SubagentsApi): PanelApi {
	const { pi } = rt;
	const manager = getTaskManager();
	let ticker: NodeJS.Timeout | undefined;
	let listener: TaskListener | undefined;

	const sessionTasks = () => manager.list(api.sessionId());

	const renderWidget = () => {
		const ctx = rt.ctx;
		if (!ctx || ctx.mode !== "tui") return;
		const theme = ctx.ui.theme;
		const tasks = sessionTasks();
		const running = tasks.filter((task) => isActive(task) && task.background);
		const review = tasks.filter(needsReview);
		if (running.length === 0 && review.length === 0) {
			ctx.ui.setWidget(WIDGET, undefined);
			if (ticker) clearInterval(ticker);
			ticker = undefined;
			return;
		}
		const lines = running.slice(0, MAX_WIDGET_ROWS).map((task) => {
			const activity = latestActivity(task);
			return `${statusIcon(task, theme)} ${theme.fg("toolTitle", task.agent)} ${theme.fg("muted", oneLine(task.description, 40))} ${theme.fg("dim", elapsed(task))}${activity ? theme.fg("dim", `  ${oneLine(activity, 50)}`) : ""}`;
		});
		if (running.length > MAX_WIDGET_ROWS) lines.push(theme.fg("dim", `  … ${running.length - MAX_WIDGET_ROWS} more`));
		if (review.length > 0) lines.push(`${theme.fg("warning", "◆")} ${theme.fg("muted", `${review.length} worktree result${review.length === 1 ? "" : "s"} to review`)} ${theme.fg("dim", "alt+a")}`);
		ctx.ui.setWidget(WIDGET, lines);
		if (running.length > 0 && !ticker) {
			ticker = setInterval(renderWidget, 200);
			ticker.unref();
		}
		if (running.length === 0 && ticker) {
			clearInterval(ticker);
			ticker = undefined;
		}
	};

	pi.on("session_start", () => {
		listener = () => renderWidget();
		manager.listeners.add(listener);
		renderWidget();
	});

	pi.on("session_shutdown", () => {
		if (listener) manager.listeners.delete(listener);
		if (ticker) clearInterval(ticker);
		ticker = undefined;
	});

	const open: PanelApi["open"] = async (ctx) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify(sessionTasks().map((task) => `${task.id} ${task.agent} ${task.status} ${task.description}`).join("\n") || "No agents in this session.", "info");
			return;
		}
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => new TasksOverlay(tui, theme, api, done, sessionTasks),
			{ overlay: true, overlayOptions: { width: "94%", maxHeight: "88%", anchor: "center" } },
		);
		renderWidget();
	};

	return {
		open,
		badge(theme) {
			const count = sessionTasks().filter(isActive).length;
			return count > 0 ? theme.fg("accent", `⬡ ${count}`) : "";
		},
	};
}

class TasksOverlay {
	private index = 0;
	private scroll = 0;
	private input?: Input;
	private inputLabel = "";
	private message = "";
	private diffText?: string;
	private readonly unlisten: () => void;
	private readonly ticker: NodeJS.Timeout;
	private hasFocus = false;

	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly api: SubagentsApi;
	private readonly done: () => void;
	private readonly tasks: () => TaskSnapshot[];

	constructor(tui: TUI, theme: Theme, api: SubagentsApi, done: () => void, tasks: () => TaskSnapshot[]) {
		this.tui = tui;
		this.theme = theme;
		this.api = api;
		this.done = done;
		this.tasks = tasks;
		const manager = getTaskManager();
		const listener: TaskListener = () => tui.requestRender();
		manager.listeners.add(listener);
		this.unlisten = () => manager.listeners.delete(listener);
		this.ticker = setInterval(() => {
			if (this.tasks().some(isActive)) tui.requestRender();
		}, 250);
		this.ticker.unref();
		const list = tasks();
		const firstActive = list.findIndex(isActive);
		this.index = firstActive >= 0 ? firstActive : Math.max(0, list.length - 1);
	}

	get focused(): boolean {
		return this.hasFocus;
	}

	set focused(value: boolean) {
		this.hasFocus = value;
		if (this.input) this.input.focused = value;
	}

	private selected(): TaskSnapshot | undefined {
		const list = this.tasks();
		this.index = Math.max(0, Math.min(this.index, list.length - 1));
		return list[this.index];
	}

	private detail(task: TaskSnapshot, width: number): string[] {
		const theme = this.theme;
		const wrap = (text: string) => text.split("\n").flatMap((line) => (line ? wrapTextWithAnsi(line, width) : [""]));
		if (this.diffText !== undefined) return wrap(colorizeDiff(this.diffText || "(no changes)", theme));
		const lines: string[] = [];
		const meta = [task.model, task.thinking && task.thinking !== "off" ? task.thinking : "", task.readonly ? "read-only" : "", task.background ? "background" : "foreground"].filter(Boolean).join(" · ");
		lines.push(theme.fg("dim", `${task.id} · ${meta}`));
		const usage = task.usage;
		if (usage.input + usage.output > 0) lines.push(theme.fg("dim", `↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)} · $${usage.cost.toFixed(4)} · ${task.turns} turns · ${task.toolCount} tools`));
		if (task.worktree) {
			const diff = task.worktree.diff;
			lines.push(theme.fg("dim", `worktree ${task.worktree.state}: ${task.worktree.path}${diff ? ` · ${diff.files.length} files +${diff.added} -${diff.removed}` : ""}`));
			if (task.worktree.setupWarning) lines.push(...wrap(theme.fg("warning", task.worktree.setupWarning)));
		}
		lines.push("", theme.bold("Prompt"), ...wrap(theme.fg("muted", task.prompt)), "", theme.bold("Activity"));
		for (const item of task.activity) lines.push(...wrap(theme.fg(item.error ? "error" : item.kind === "tool" ? "dim" : "muted", item.text)));
		const stream = getTaskManager().streamingText(task.id);
		if (stream) lines.push(...wrap(theme.fg("muted", stream)));
		if (task.error) lines.push("", ...wrap(theme.fg("error", task.error)));
		if (task.finalText) lines.push("", theme.bold("Result"), ...wrap(task.finalText));
		return lines;
	}

	render(width: number): string[] {
		const theme = this.theme;
		const border = (text: string) => theme.fg("border", text);
		const inner = Math.max(10, width - 4);
		const rows = Math.max(12, Math.floor(this.tui.terminal.rows * 0.88));
		const tasks = this.tasks();
		const active = tasks.filter(isActive).length;
		const out = [boxEdge(width, border, theme.bold(` Agents `) + theme.fg("dim", `${active} running · ${tasks.length - active} finished `), ["╭", "╮"])];
		if (tasks.length === 0) {
			out.push(boxLine(theme.fg("muted", "No agents in this session yet. Start one with /bg <prompt>, or ask for one."), width, border));
			out.push(boxEdge(width, border, theme.fg("dim", " esc close "), ["╰", "╯"]));
			return out;
		}
		const listRows = Math.min(tasks.length, Math.max(3, Math.floor(rows / 3)));
		const selected = this.selected() as TaskSnapshot;
		const start = Math.max(0, Math.min(this.index - Math.floor(listRows / 2), tasks.length - listRows));
		tasks.slice(start, start + listRows).forEach((task, offset) => {
			const isSelected = start + offset === this.index;
			const pointer = isSelected ? theme.fg("accent", "❯") : " ";
			const name = isSelected ? theme.fg("accent", task.agent) : theme.fg("toolTitle", task.agent);
			const review = needsReview(task) ? theme.fg("warning", " ◆") : "";
			out.push(boxLine(`${pointer} ${statusIcon(task, theme)} ${name} ${theme.fg("muted", oneLine(task.description, 44))}${review} ${theme.fg("dim", taskStats(task))}`, width, border));
		});
		out.push(boxEdge(width, border, "", ["├", "┤"]));
		const footerRows = this.input ? 2 : this.message ? 1 : 0;
		const detailRows = Math.max(3, rows - out.length - 1 - footerRows);
		const detail = this.detail(selected, inner);
		this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, detail.length - detailRows)));
		for (const line of detail.slice(this.scroll, this.scroll + detailRows)) out.push(boxLine(line, width, border));
		if (this.input) {
			out.push(boxLine(theme.fg("accent", this.inputLabel), width, border));
			out.push(boxLine(this.input.render(inner)[0] ?? "", width, border));
		} else if (this.message) {
			out.push(boxLine(theme.fg("warning", this.message), width, border));
		}
		const keys: string[] = ["↑↓ select", "pgup pgdn scroll"];
		if (isActive(selected)) keys.push("s steer", "f follow-up", "x stop");
		else keys.push("r resume");
		if (selected.worktree?.state === "active" && !isActive(selected)) keys.push("v diff", "a apply", "d discard");
		keys.push("esc close");
		out.push(boxEdge(width, border, theme.fg("dim", ` ${keys.join(" · ")} `), ["╰", "╯"]));
		return out;
	}

	private ask(label: string, action: (value: string) => void): void {
		const input = new Input();
		input.focused = this.hasFocus;
		input.onSubmit = (value) => {
			this.input = undefined;
			if (value.trim()) action(value.trim());
			this.tui.requestRender();
		};
		input.onEscape = () => {
			this.input = undefined;
			this.tui.requestRender();
		};
		this.input = input;
		this.inputLabel = label;
	}

	private run(work: () => Promise<string>): void {
		void work()
			.then((text) => {
				this.message = text;
			})
			.catch((error: unknown) => {
				this.message = error instanceof Error ? error.message : String(error);
			})
			.finally(() => this.tui.requestRender());
	}

	handleInput(data: string): void {
		if (this.input) {
			this.input.handleInput(data);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			if (this.diffText !== undefined) {
				this.diffText = undefined;
				this.scroll = 0;
				this.tui.requestRender();
				return;
			}
			this.dispose();
			this.done();
			return;
		}
		const task = this.selected();
		const page = Math.max(3, Math.floor(this.tui.terminal.rows * 0.4));
		this.message = "";
		if (matchesKey(data, Key.up) && this.tasks().length > 0) {
			this.index = Math.max(0, this.index - 1);
			this.scroll = 0;
			this.diffText = undefined;
		} else if (matchesKey(data, Key.down)) {
			this.index = Math.min(this.tasks().length - 1, this.index + 1);
			this.scroll = 0;
			this.diffText = undefined;
		} else if (matchesKey(data, "pageUp")) {
			this.scroll -= page;
		} else if (matchesKey(data, "pageDown")) {
			this.scroll += page;
		} else if (task) {
			const manager = getTaskManager();
			if (data === "s" && isActive(task)) this.ask(`Steer ${task.agent}:`, (value) => manager.send(task.id, value, "steer"));
			else if (data === "f" && isActive(task)) this.ask(`Follow-up for ${task.agent}:`, (value) => manager.send(task.id, value, "follow_up"));
			else if (data === "x" && isActive(task)) manager.stop(task.id);
			else if (data === "r" && !isActive(task)) this.ask(`Resume ${task.agent} with:`, (value) => this.run(async () => (this.api.resume(task.id, value, true), `Resumed ${task.id} in the background.`)));
			else if (data === "a" && task.worktree?.state === "active" && !isActive(task)) this.run(() => this.api.apply(task.id));
			else if (data === "d" && task.worktree?.state === "active" && !isActive(task)) this.run(() => this.api.discard(task.id));
			else if (data === "v" && task.worktree?.state === "active" && !isActive(task)) {
				this.run(async () => {
					this.diffText = await this.api.diff(task.id);
					this.scroll = 0;
					return "";
				});
			} else return;
		} else return;
		this.tui.requestRender();
	}

	invalidate(): void {}

	dispose(): void {
		this.unlisten();
		clearInterval(this.ticker);
	}
}
