/** `ask_question`: multiple-choice questions, answered in a keyboard-driven panel. */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Runtime } from "../core/runtime.ts";

interface Question {
	id: string;
	prompt: string;
	options: Array<{ id: string; label: string }>;
	allow_multiple?: boolean;
}

interface Answer {
	id: string;
	prompt: string;
	selected: string[];
	other?: string;
}

const Params = Type.Object({
	questions: Type.Array(
		Type.Object({
			id: Type.String(),
			prompt: Type.String({ description: "The question." }),
			options: Type.Array(Type.Object({ id: Type.String(), label: Type.String() }), { description: "Choices. The user can also type their own answer." }),
			allow_multiple: Type.Optional(Type.Boolean({ description: "Let the user pick several." })),
		}),
	),
});

function askInPanel(ctx: ExtensionContext, questions: Question[]): Promise<Answer[] | undefined> {
	return ctx.ui.custom<Answer[] | undefined>(
		(tui, theme: Theme, _keybindings, done) => {
			let index = 0;
			let cursor = 0;
			let typing = false;
			let hasFocus = false;
			const checked = new Map<number, Set<number>>();
			const answers: Answer[] = [];
			const input = new Input();
			const question = () => questions[index] as Question;
			const rows = () => question().options.length + 1;
			const chosen = () => [...(checked.get(index) ?? [])].map((i) => question().options[i]?.label as string);
			const next = (selected: string[], other?: string) => {
				answers.push({ id: question().id, prompt: question().prompt, selected, other });
				if (index + 1 >= questions.length) {
					done(answers);
					return;
				}
				index++;
				cursor = 0;
				typing = false;
				input.focused = false;
				input.setValue("");
				tui.requestRender();
			};
			input.onSubmit = (value) => {
				const text = value.trim();
				if (text) next(chosen(), text);
			};
			return {
				get focused() {
					return hasFocus;
				},
				set focused(value: boolean) {
					hasFocus = value;
					input.focused = value && typing;
				},
				render(width: number): string[] {
					const q = question();
					const count = questions.length > 1 ? theme.fg("dim", ` (${index + 1}/${questions.length})`) : "";
					const lines = wrapTextWithAnsi(`${theme.fg("warning", "?")} ${theme.bold(q.prompt)}${count}`, width);
					const picks = checked.get(index);
					q.options.forEach((option, i) => {
						const pointer = i === cursor ? theme.fg("accent", "❯") : " ";
						const mark = q.allow_multiple ? (picks?.has(i) ? theme.fg("accent", "◉ ") : theme.fg("dim", "○ ")) : "";
						const label = i === cursor ? theme.fg("accent", option.label) : option.label;
						lines.push(truncateToWidth(` ${pointer} ${mark}${label}`, width));
					});
					const otherSelected = cursor === q.options.length;
					lines.push(truncateToWidth(` ${otherSelected ? theme.fg("accent", "❯") : " "} ${theme.fg(otherSelected ? "accent" : "muted", "Other…")}`, width));
					if (typing) lines.push(...input.render(Math.max(10, width - 4)).map((line) => `   ${line}`));
					const toggle = q.allow_multiple ? "space select · " : "";
					lines.push(theme.fg("dim", ` ↑↓ move · ${toggle}enter confirm · esc skip`));
					return lines;
				},
				handleInput(data: string): void {
					if (typing) {
						if (matchesKey(data, Key.escape)) {
							typing = false;
							input.focused = false;
						} else {
							input.handleInput(data);
						}
						tui.requestRender();
						return;
					}
					const q = question();
					if (matchesKey(data, Key.escape)) {
						done(undefined);
						return;
					}
					if (matchesKey(data, Key.up)) cursor = (cursor - 1 + rows()) % rows();
					else if (matchesKey(data, Key.down)) cursor = (cursor + 1) % rows();
					else if (matchesKey(data, Key.space) && q.allow_multiple && cursor < q.options.length) {
						const set = checked.get(index) ?? new Set<number>();
						if (set.has(cursor)) set.delete(cursor);
						else set.add(cursor);
						checked.set(index, set);
					} else if (matchesKey(data, Key.enter)) {
						if (cursor === q.options.length) {
							typing = true;
							input.focused = hasFocus;
						} else if (q.allow_multiple) {
							const picks = chosen();
							next(picks.length > 0 ? picks : [q.options[cursor]?.label as string]);
							return;
						} else {
							next([q.options[cursor]?.label as string]);
							return;
						}
					} else {
						const digit = Number(data);
						if (Number.isInteger(digit) && digit >= 1 && digit <= q.options.length) cursor = digit - 1;
						else return;
					}
					tui.requestRender();
				},
				invalidate() {},
			};
		},
		{ blocked: { kind: "question", message: questions[0]?.prompt ?? "Question" } },
	);
}

/** RPC clients only have plain dialogs, so a sub-agent's questions go through them one at a time. */
async function askWithDialogs(ctx: ExtensionContext, questions: Question[]): Promise<Answer[] | undefined> {
	const answers: Answer[] = [];
	for (const question of questions) {
		const other = "Other…";
		const value = await ctx.ui.select(question.prompt, [...question.options.map((option) => option.label), other]);
		if (value === undefined) return undefined;
		if (value === other) {
			const text = await ctx.ui.input(question.prompt);
			if (text === undefined) return undefined;
			answers.push({ id: question.id, prompt: question.prompt, selected: [], other: text });
		} else {
			answers.push({ id: question.id, prompt: question.prompt, selected: [value] });
		}
	}
	return answers;
}

export function setupAskQuestion(rt: Runtime): void {
	rt.pi.registerTool({
		name: "ask_question",
		label: "Question",
		description: "Ask the user one or more multiple-choice questions and wait for the answers. Use it for decisions only they can make, not for things you can find out yourself.",
		promptSnippet: "Ask the user multiple-choice questions and wait for the answers",
		parameters: Params,
		annotations: { readOnlyHint: true },
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return { content: [{ type: "text", text: "No user is available to answer. Choose the most reasonable option, state your assumption and continue." }], details: {}, isError: true };
			}
			const answers = ctx.mode === "tui" ? await askInPanel(ctx, params.questions) : await askWithDialogs(ctx, params.questions);
			if (!answers) {
				return { content: [{ type: "text", text: "The user dismissed the questions without answering. Do not ask again; state your assumption or wait for their next message." }], details: { answers: [] } };
			}
			const text = answers.map((answer) => `${answer.prompt}\nAnswer: ${[...answer.selected, ...(answer.other ? [answer.other] : [])].join(", ")}`).join("\n\n");
			return { content: [{ type: "text", text }], details: { answers } };
		},
		renderCall: (args, theme) => {
			const count = Array.isArray(args.questions) ? args.questions.length : 1;
			return new Text(`${theme.fg("warning", "?")} ${theme.fg("muted", `Asking ${count} question${count === 1 ? "" : "s"}`)}`, 0, 0);
		},
		renderResult: (result, _options, theme) => {
			const answers = (result.details as { answers?: Answer[] }).answers ?? [];
			if (answers.length === 0) return new Text(theme.fg("dim", "  No answer"), 0, 0);
			return new Text(answers.map((answer) => `  ${theme.fg("dim", answer.prompt)}\n  ${theme.fg("success", "→")} ${[...answer.selected, ...(answer.other ? [answer.other] : [])].join(", ")}`).join("\n"), 0, 0);
		},
	});
}
