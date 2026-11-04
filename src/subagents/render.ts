import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { formatDuration, formatTokens, oneLine } from "../core/text.ts";
import { isActive, type TaskSnapshot } from "./manager.ts";

export interface TaskToolDetails {
	mode: "single" | "parallel" | "chain" | "best_of_n" | "control";
	tasks: TaskSnapshot[];
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinnerFrame(): string {
	return SPINNER[Math.floor(Date.now() / 90) % SPINNER.length] as string;
}

export function statusIcon(task: TaskSnapshot, theme: Theme): string {
	switch (task.status) {
		case "queued":
			return theme.fg("dim", "○");
		case "starting":
		case "running":
			return theme.fg("accent", spinnerFrame());
		case "completed":
			return theme.fg("success", "✓");
		case "failed":
			return theme.fg("error", "✗");
		case "stopped":
			return theme.fg("warning", "■");
		case "interrupted":
			return theme.fg("warning", "◌");
	}
}

export function elapsed(task: TaskSnapshot): string {
	if (!task.startedAt) return task.status === "queued" ? "queued" : "";
	return formatDuration((task.endedAt ?? Date.now()) - task.startedAt);
}

export function taskStats(task: TaskSnapshot): string {
	const parts = [elapsed(task)];
	if (task.toolCount) parts.push(`${task.toolCount} tool${task.toolCount === 1 ? "" : "s"}`);
	const tokens = task.usage.input + task.usage.output;
	if (tokens) parts.push(`${formatTokens(tokens)} tokens`);
	if (task.usage.cost) parts.push(`$${task.usage.cost.toFixed(3)}`);
	const diff = task.worktree?.diff;
	if (diff) parts.push(`+${diff.added} -${diff.removed}`);
	return parts.filter(Boolean).join(" · ");
}

export function latestActivity(task: TaskSnapshot): string {
	const item = task.activity[task.activity.length - 1];
	return item ? oneLine(item.text, 80) : "";
}

function taskHeader(task: TaskSnapshot, theme: Theme): string {
	const tags: string[] = [];
	if (task.background) tags.push("background");
	if (task.readonly) tags.push("read-only");
	if (task.wantsWorktree) tags.push("worktree");
	const name = theme.fg("toolTitle", theme.bold(task.agent));
	const tagText = tags.length ? theme.fg("dim", ` [${tags.join(", ")}]`) : "";
	return `${statusIcon(task, theme)} ${name} ${theme.fg("muted", oneLine(task.description, 70))}${tagText} ${theme.fg("dim", taskStats(task))}`;
}

export function renderTaskCall(args: Record<string, any>, theme: Theme): Text {
	const label = typeof args.description === "string" ? oneLine(args.description, 70) : "";
	const agent = typeof args.subagent_type === "string" ? args.subagent_type : args.resume ? `resume ${args.resume}` : "general-purpose";
	const flags = [args.run_in_background ? "background" : "", args.isolation === "worktree" ? "worktree" : "", typeof args.model === "string" ? args.model : ""].filter(Boolean);
	const tail = flags.length ? theme.fg("dim", ` [${flags.join(", ")}]`) : "";
	return new Text(`${theme.fg("accent", "⬡")} ${theme.fg("toolTitle", theme.bold(agent))} ${theme.fg("muted", label)}${tail}`, 0, 0);
}

export function renderGroupCall(args: Record<string, any>, theme: Theme): Text {
	const count = Array.isArray(args.tasks) ? args.tasks.length : Array.isArray(args.models) ? args.models.length : (args.n ?? "");
	const mode = args.mode === "best_of_n" ? "best of" : String(args.mode ?? "group");
	const tail = args.run_in_background ? theme.fg("dim", " [background]") : "";
	return new Text(`${theme.fg("accent", "⬡⬡")} ${theme.fg("toolTitle", theme.bold(`${mode} ${count}`))}${tail}`, 0, 0);
}

export function renderTaskResult(details: TaskToolDetails | undefined, expanded: boolean, theme: Theme, keyHint: (id: any, text: string) => string): Container {
	const box = new Container();
	const tasks = details?.tasks ?? [];
	for (const task of tasks) {
		box.addChild(new Text(taskHeader(task, theme), 0, 0));
		if (isActive(task)) {
			for (const item of task.activity.slice(expanded ? -30 : -3)) {
				box.addChild(new Text(`  ${theme.fg(item.error ? "error" : "dim", oneLine(item.text, 110))}`, 0, 0));
			}
			continue;
		}
		if (task.error) box.addChild(new Text(`  ${theme.fg("error", expanded ? task.error : oneLine(task.error, 160))}`, 0, 0));
		if (expanded) {
			for (const item of task.activity.slice(-30)) {
				if (item.kind === "tool") box.addChild(new Text(`  ${theme.fg(item.error ? "error" : "dim", oneLine(item.text, 110))}`, 0, 0));
			}
			if (task.finalText) box.addChild(new Markdown(task.finalText, 2, 0, getMarkdownTheme()));
		} else if (task.finalText) {
			const lines = task.finalText.split("\n").filter((line) => line.trim());
			const preview = lines.slice(0, tasks.length > 1 ? 1 : 3).map((line) => `  ${theme.fg("toolOutput", oneLine(line, 120))}`);
			box.addChild(new Text(preview.join("\n"), 0, 0));
		}
		if (task.worktree?.diff && task.worktree.state === "active") {
			const diff = task.worktree.diff;
			box.addChild(new Text(`  ${theme.fg("dim", `${diff.files.length} file${diff.files.length === 1 ? "" : "s"} changed in worktree; review with /tasks`)}`, 0, 0));
		}
	}
	if (!expanded && tasks.some((task) => !isActive(task) && task.finalText)) {
		box.addChild(new Text(`  ${theme.fg("dim", keyHint("app.tools.expand", "for full output"))}`, 0, 0));
	}
	return box;
}
