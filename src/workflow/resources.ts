/**
 * Makes Cursor's resources visible to Pi: skills from `.cursor/skills` (plus `.claude` and `.codex`),
 * and `.cursor/commands` as prompt templates. Also lets `/skill-name` work the way it does in Cursor.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { configDirs, packageDir, type Runtime } from "../core/runtime.ts";
import { asString, parseFrontmatter } from "../core/text.ts";

const MAX_SKILL_DEPTH = 5;

/** Depth is limited because skills are often symlinked, and a link can point back up the tree. */
export function findSkillDirs(root: string, depth = 0): string[] {
	const out: string[] = [];
	if (depth > MAX_SKILL_DEPTH) return out;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = path.join(root, entry.name);
		let isDir = entry.isDirectory();
		if (entry.isSymbolicLink()) {
			try {
				isDir = fs.statSync(full).isDirectory();
			} catch {
				continue;
			}
		}
		if (isDir && fs.statSync(path.join(full, "SKILL.md"), { throwIfNoEntry: false })?.isFile()) out.push(full);
		else if (isDir && !entry.name.startsWith(".")) out.push(...findSkillDirs(full, depth + 1));
	}
	return out;
}

function skillName(dir: string): string {
	try {
		const { frontmatter } = parseFrontmatter(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"));
		return asString(frontmatter.name) ?? path.basename(dir);
	} catch {
		return path.basename(dir);
	}
}

/**
 * Lists skill directories Pi does not find on its own. The same skill is often installed in several
 * tools' folders; passing each only once avoids a collision warning for every duplicate at startup.
 */
export function collectSkillPaths(rt: Runtime): string[] {
	const native = [path.join(os.homedir(), ".agents", "skills"), path.join(getAgentDir(), "skills")];
	if (rt.projectTrusted) native.push(path.join(rt.root, ".pi", "skills"), path.join(rt.root, ".agents", "skills"));
	const seen = new Set(native.flatMap(findSkillDirs).map(skillName));
	const out: string[] = [];
	const add = (dir: string) => {
		for (const skill of findSkillDirs(dir)) {
			const name = skillName(skill);
			if (!seen.has(name)) {
				seen.add(name);
				out.push(skill);
			}
		}
	};
	for (const { dir, origin } of configDirs(rt, "skills")) {
		if (origin !== "pi") add(dir);
	}
	if (rt.config.compat.cursorBuiltinSkills) add(path.join(os.homedir(), ".cursor", "skills-cursor"));
	add(path.join(packageDir(), "skills"));
	return out;
}

/** Bodies of every skill the session can load on demand, keyed by skill name. */
export function installedSkillBodies(rt: Runtime): Map<string, string> {
	const roots = [path.join(os.homedir(), ".agents", "skills"), ...configDirs(rt, "skills").map((item) => item.dir)];
	if (rt.projectTrusted) roots.push(path.join(rt.root, ".agents", "skills"));
	const bodies = new Map<string, string>();
	for (const skill of roots.flatMap(findSkillDirs)) {
		try {
			bodies.set(skillName(skill), parseFrontmatter(fs.readFileSync(path.join(skill, "SKILL.md"), "utf8")).body.trim());
		} catch {
			// An unreadable skill cannot duplicate anything.
		}
	}
	return bodies;
}

export function setupResources(rt: Runtime): void {
	const { pi } = rt;

	pi.on("resources_discover", () => ({
		skillPaths: collectSkillPaths(rt),
		promptPaths: [...configDirs(rt, "commands").filter((item) => item.origin !== "pi").map((item) => item.dir), path.join(packageDir(), "prompts")],
		themePaths: [path.join(packageDir(), "themes")],
	}));

	pi.on("input", (event) => {
		const match = /^\/([a-z0-9][a-z0-9-]*)(\s[\s\S]*)?$/.exec(event.text);
		if (!match) return { action: "continue" };
		const commands = pi.getCommands();
		const name = match[1] as string;
		if (commands.some((command) => command.name === name)) return { action: "continue" };
		if (commands.some((command) => command.source === "skill" && command.name === `skill:${name}`)) {
			return { action: "transform", text: `/skill:${name}${match[2] ?? ""}` };
		}
		return { action: "continue" };
	});
}
