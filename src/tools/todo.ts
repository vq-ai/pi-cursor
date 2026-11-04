/** `todo_write`: the agent's visible checklist. State lives in tool results, so it follows session branches. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Runtime } from "../core/runtime.ts";
import { stringEnum } from "../core/schema.ts";
import { oneLine } from "../core/text.ts";

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface Todo {
	id: string;
	content: string;
	status: TodoStatus;
}

const STATE_ENTRY = "pi-cursor.todos";
const WIDGET = "pi-cursor.todos";
const MAX_VISIBLE = 8;

const Params = Type.Object({
	todos: Type.Array(
		Type.Object({
			id: Type.Optional(Type.String({ description: "Stable ID. Required when merging." })),
			content: Type.Optional(Type.String({ description: "What to do, as a short imperative. Required for new items." })),
			status: Type.Optional(stringEnum(["pending", "in_progress", "completed", "cancelled"] as const)),
		}),
	),
	merge: Type.Optional(Type.Boolean({ description: "Update items by id and keep the others. Otherwise this list replaces the whole checklist." })),
});

export interface TodosApi {
	list(): Todo[];
	seed(items: string[]): void;
	clear(ctx: ExtensionContext): void;
}

export function setupTodos(rt: Runtime): TodosApi {
	const { pi } = rt;
	let todos: Todo[] = [];
	let hideWhenDone = false;

	const render = (ctx: ExtensionContext | undefined) => {
		if (!ctx || ctx.mode !== "tui") return;
		const active = todos.filter((todo) => todo.status !== "cancelled");
		const done = active.filter((todo) => todo.status === "completed").length;
		if (active.length === 0 || (hideWhenDone && done === active.length)) {
			ctx.ui.setWidget(WIDGET, undefined);
			return;
		}
		const theme = ctx.ui.theme;
		const lines = [`${theme.fg("accent", "☰")} ${theme.bold("To-dos")} ${theme.fg("dim", `${done}/${active.length}`)}`];
		const open = active.findIndex((todo) => todo.status !== "completed");
		const start = active.length <= MAX_VISIBLE ? 0 : Math.min(Math.max(0, open - 1), active.length - MAX_VISIBLE);
		const visible = active.slice(start, start + MAX_VISIBLE);
		for (const todo of visible) {
			if (todo.status === "completed") lines.push(`  ${theme.fg("success", "✓")} ${theme.fg("dim", theme.strikethrough(oneLine(todo.content, 100)))}`);
			else if (todo.status === "in_progress") lines.push(`  ${theme.fg("accent", "◐")} ${theme.fg("text", oneLine(todo.content, 100))}`);
			else lines.push(`  ${theme.fg("muted", "○")} ${theme.fg("muted", oneLine(todo.content, 100))}`);
		}
		if (active.length > visible.length) lines.push(theme.fg("dim", `  … ${active.length - visible.length} more`));
		ctx.ui.setWidget(WIDGET, lines);
	};

	const restore = (ctx: ExtensionContext) => {
		todos = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_ENTRY) todos = (entry.data as { todos: Todo[] }).todos;
			if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "todo_write") {
				const details = entry.message.details as { todos?: Todo[] } | undefined;
				if (details?.todos) todos = details.todos;
			}
		}
		hideWhenDone = todos.every((todo) => todo.status === "completed" || todo.status === "cancelled");
		render(ctx);
	};

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("before_agent_start", (_event, ctx) => {
		hideWhenDone = true;
		render(ctx);
	});

	pi.registerTool({
		name: "todo_write",
		label: "To-dos",
		description: "Create and update a checklist the user can see. Use it for work with several steps; skip it for single, simple tasks. Keep exactly one item in_progress, and mark items completed as soon as they are done.",
		promptSnippet: "Track multi-step work in a checklist visible to the user",
		parameters: Params,
		annotations: { readOnlyHint: true },
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			hideWhenDone = false;
			if (params.merge) {
				for (const item of params.todos) {
					const existing = todos.find((todo) => todo.id === item.id);
					if (existing) {
						if (item.content) existing.content = item.content;
						if (item.status) existing.status = item.status;
					} else if (item.content) {
						todos.push({ id: item.id ?? `todo-${todos.length + 1}`, content: item.content, status: item.status ?? "pending" });
					}
				}
			} else {
				todos = params.todos
					.filter((item) => item.content)
					.map((item, index) => ({ id: item.id ?? `todo-${index + 1}`, content: item.content as string, status: item.status ?? "pending" }));
			}
			render(ctx);
			const summary = todos.map((todo) => `[${todo.status}] ${todo.id}: ${todo.content}`).join("\n");
			return { content: [{ type: "text", text: `Checklist updated:\n${summary}` }], details: { todos: todos.map((todo) => ({ ...todo })) } };
		},
		renderCall: () => new Text("", 0, 0),
		renderResult: () => new Text("", 0, 0),
	});

	return {
		list: () => todos,
		seed(items) {
			todos = items.map((content, index) => ({ id: `todo-${index + 1}`, content, status: "pending" }));
			hideWhenDone = false;
			pi.appendEntry(STATE_ENTRY, { todos });
			render(rt.ctx);
		},
		clear(ctx) {
			todos = [];
			pi.appendEntry(STATE_ENTRY, { todos });
			render(ctx);
		},
	};
}
