/** `create_plan` and the plan-review flow: Build, edit or keep planning. */

import * as fs from "node:fs";
import * as path from "node:path";
import { getMarkdownTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Runtime } from "../core/runtime.ts";
import { parseFrontmatter, slugify } from "../core/text.ts";
import type { TodosApi } from "../tools/todo.ts";
import type { ModesApi } from "./modes.ts";

export interface PlanFile {
	path: string;
	title: string;
	overview: string;
	todos: string[];
	body: string;
	mtime: number;
}

export function plansDir(root: string): string {
	return path.join(root, ".pi", "plans");
}

export function parsePlan(file: string): PlanFile | undefined {
	let raw: string;
	let mtime = 0;
	try {
		raw = fs.readFileSync(file, "utf8");
		mtime = fs.statSync(file).mtimeMs;
	} catch {
		return undefined;
	}
	const { frontmatter, body } = parseFrontmatter(raw);
	const todos: string[] = [];
	const section = body.split(/^## To-dos\s*$/m)[1] ?? "";
	for (const match of section.matchAll(/^- \[[ xX]\] (.+)$/gm)) todos.push(match[1] as string);
	return {
		path: file,
		title: typeof frontmatter.name === "string" ? frontmatter.name : path.basename(file, ".plan.md"),
		overview: typeof frontmatter.overview === "string" ? frontmatter.overview : "",
		todos,
		body,
		mtime,
	};
}

export function listPlans(root: string): PlanFile[] {
	let files: string[];
	try {
		files = fs.readdirSync(plansDir(root));
	} catch {
		return [];
	}
	return files
		.filter((file) => file.endsWith(".plan.md"))
		.map((file) => parsePlan(path.join(plansDir(root), file)))
		.filter((plan): plan is PlanFile => !!plan)
		.sort((a, b) => b.mtime - a.mtime);
}

const Params = Type.Object({
	title: Type.String({ description: "Short title. Using the same title again revises that plan." }),
	overview: Type.String({ description: "One or two sentences on what the plan achieves." }),
	plan: Type.String({ description: "The plan in markdown: the approach, specific files and changes, and how the result will be verified." }),
	todos: Type.Array(Type.String(), { description: "Implementation steps as short imperatives." }),
});

function yamlString(value: string): string {
	return JSON.stringify(value.replace(/\s+/g, " ").trim());
}

export interface PlanApi {
	build(plan: PlanFile, ctx: ExtensionContext): Promise<void>;
}

export function setupPlan(rt: Runtime, modes: ModesApi, todos: TodosApi): PlanApi {
	const { pi } = rt;
	let pending: string | undefined;

	const build: PlanApi["build"] = async (plan, ctx) => {
		await modes.set("implement", ctx);
		if (plan.todos.length > 0) todos.seed(plan.todos);
		const relative = path.relative(rt.cwd, plan.path);
		const steps = plan.todos.length ? `\n\nThe checklist is already set up from the plan; update it with todo_write (merge by id: ${plan.todos.map((_, index) => `todo-${index + 1}`).join(", ")}) as you work.` : "";
		const message = `Implement the plan in ${relative}. Follow it, and call out any place you have to deviate.${steps}\n\n${plan.body.trim()}`;
		if (ctx.isIdle()) pi.sendUserMessage(message);
		else pi.sendUserMessage(message, { deliverAs: "followUp" });
	};

	const review = async (file: string, ctx: ExtensionContext) => {
		const plan = parsePlan(file);
		if (!plan) return;
		const choice = await ctx.ui.select(`Plan ready: ${plan.title}`, ["Build it", "Edit the plan", "Keep planning"]);
		if (choice === "Build it") {
			await build(plan, ctx);
		} else if (choice === "Edit the plan") {
			const current = fs.readFileSync(file, "utf8");
			const edited = await ctx.ui.editor(`Edit ${path.basename(file)}`, current);
			if (edited !== undefined && edited !== current) fs.writeFileSync(file, edited);
			await review(file, ctx);
		}
	};

	pi.on("agent_settled", (event, ctx) => {
		if (!pending) return;
		const file = pending;
		pending = undefined;
		if (event.aborted || !ctx.hasUI || rt.role.subagent) return;
		// The dialog waits on the user, which must not hold up the settle notification.
		setTimeout(() => {
			void review(file, ctx).catch((error: unknown) => ctx.ui.notify(`Plan review failed: ${String(error)}`, "error"));
		}, 0);
	});

	pi.registerTool({
		name: "create_plan",
		label: "Plan",
		description: "Save the implementation plan for the user to review. Call this once research is done and any questions are answered, then stop.",
		parameters: Params,
		defaultActive: false,
		annotations: { readOnlyHint: true },
		async execute(_id, params) {
			const dir = plansDir(rt.root);
			fs.mkdirSync(dir, { recursive: true });
			const file = path.join(dir, `${slugify(params.title)}.plan.md`);
			const checklist = params.todos.map((todo) => `- [ ] ${todo.replace(/\s+/g, " ").trim()}`).join("\n");
			const content = `---\nname: ${yamlString(params.title)}\noverview: ${yamlString(params.overview)}\ncreated: ${new Date().toISOString()}\n---\n\n# ${params.title}\n\n${params.overview}\n\n${params.plan.trim()}\n\n## To-dos\n\n${checklist}\n`;
			fs.writeFileSync(file, content);
			pending = file;
			return {
				content: [{ type: "text", text: `Plan saved to ${path.relative(rt.cwd, file)}. Stop here: the user will review it and choose whether to build.` }],
				details: { file, content: content.replace(/^---[\s\S]*?---\n/, "") },
				terminate: true,
			};
		},
		renderCall: (args, theme) => new Text(`${theme.fg("warning", "≡")} ${theme.fg("toolTitle", theme.bold("Plan"))} ${theme.fg("muted", String(args.title ?? ""))}`, 0, 0),
		renderResult: (result) => {
			const details = result.details as { content?: string };
			return new Markdown(details.content ?? "", 0, 0, getMarkdownTheme());
		},
	});

	return { build };
}
