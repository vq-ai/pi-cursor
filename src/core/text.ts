/**
 * Small, dependency-free parsers for the file formats Cursor uses.
 *
 * Cursor rule frontmatter is routinely not valid YAML (`globs: **\/*.ts` starts with an alias marker),
 * so a tolerant line parser is used here rather than a YAML library.
 */

export interface ParsedMarkdown {
	frontmatter: Record<string, unknown>;
	body: string;
}

function parseScalar(raw: string): unknown {
	let value = raw.trim();
	if (value.startsWith('"') || value.startsWith("'")) {
		const quote = value[0];
		const end = value.indexOf(quote as string, 1);
		if (end > 0) {
			const inner = value.slice(1, end);
			return quote === '"' ? inner.replace(/\\n/g, "\n").replace(/\\"/g, '"') : inner.replace(/''/g, "'");
		}
	}
	const comment = value.search(/\s#/);
	if (comment >= 0) value = value.slice(0, comment).trim();
	if (value === "" || value === "~" || value === "null") return undefined;
	if (value === "true") return true;
	if (value === "false") return false;
	if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
	if (value.startsWith("[") && value.endsWith("]")) {
		return value
			.slice(1, -1)
			.split(",")
			.map((item) => parseScalar(item))
			.filter((item) => item !== undefined);
	}
	return value;
}

export function parseFrontmatter(raw: string): ParsedMarkdown {
	const text = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
	if (!text.startsWith("---\n") && text !== "---") return { frontmatter: {}, body: text };
	const end = text.indexOf("\n---", 3);
	if (end < 0) return { frontmatter: {}, body: text };
	const after = text.indexOf("\n", end + 1);
	const body = after < 0 ? "" : text.slice(after + 1);
	const lines = text.slice(4, end).split("\n");
	const frontmatter: Record<string, unknown> = {};
	for (let i = 0; i < lines.length; i++) {
		const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(lines[i] as string);
		if (!match) continue;
		const key = match[1] as string;
		const value = match[2] as string;
		const block: string[] = [];
		while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1] as string) || /^-\s/.test(lines[i + 1] as string))) {
			block.push(lines[++i] as string);
		}
		const marker = value.trim();
		if (marker === "|" || marker === "|-" || marker === ">" || marker === ">-") {
			const trimmed = block.map((line) => line.trim());
			frontmatter[key] = marker.startsWith("|") ? trimmed.join("\n") : trimmed.join(" ");
		} else if (marker === "" && block.some((line) => /^\s*-\s/.test(line))) {
			frontmatter[key] = block
				.filter((line) => /^\s*-\s/.test(line))
				.map((line) => parseScalar(line.replace(/^\s*-\s/, "")))
				.filter((item) => item !== undefined);
		} else if (marker === "" && block.length > 0) {
			frontmatter[key] = block.map((line) => line.trim()).join(" ");
		} else {
			const parsed = parseScalar(value);
			frontmatter[key] =
				block.length > 0 && typeof parsed === "string" ? [parsed, ...block.map((l) => l.trim())].join(" ") : parsed;
		}
	}
	return { frontmatter, body };
}

export function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (value === "true") return true;
	if (value === "false") return false;
	return undefined;
}

/** Comma-or-array list, as both spellings are in use for `globs` and `tools`. */
export function asList(value: unknown): string[] {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? splitTopLevelCommas(value) : [];
	return raw
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter(Boolean);
}

/** Splits on commas, leaving `{a,b}` brace groups intact. */
function splitTopLevelCommas(value: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = "";
	for (const char of value) {
		if (char === "{") depth++;
		if (char === "}") depth--;
		if (char === "," && depth === 0) {
			parts.push(current);
			current = "";
		} else {
			current += char;
		}
	}
	parts.push(current);
	return parts;
}

function expandBraces(glob: string): string[] {
	const open = glob.indexOf("{");
	if (open < 0) return [glob];
	let depth = 0;
	for (let i = open; i < glob.length; i++) {
		if (glob[i] === "{") depth++;
		else if (glob[i] === "}" && --depth === 0) {
			const head = glob.slice(0, open);
			const tail = glob.slice(i + 1);
			return splitTopLevelCommas(glob.slice(open + 1, i)).flatMap((part) => expandBraces(head + part + tail));
		}
	}
	return [glob];
}

function compileGlob(glob: string): string {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const char = glob[i] as string;
		if (char === "*") {
			if (glob[i + 1] === "*") {
				const before = i === 0 || glob[i - 1] === "/";
				if (glob[i + 2] === "/" && before) {
					out += "(?:.*/)?";
					i += 2;
				} else if (i + 2 === glob.length && i > 0 && glob[i - 1] === "/") {
					out += ".*";
					i += 1;
				} else {
					out += ".*";
					i += 1;
				}
			} else {
				out += "[^/]*";
			}
		} else if (char === "?") {
			out += "[^/]";
		} else if (char === "[") {
			const close = glob.indexOf("]", i + 1);
			if (close < 0) out += "\\[";
			else {
				const body = glob.slice(i + 1, close).replace(/\\/g, "\\\\");
				out += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
				i = close;
			}
		} else {
			out += char.replace(/[.+^${}()|\\\]]/g, "\\$&");
		}
	}
	return out;
}

export function globToRegExp(glob: string): RegExp {
	const alternatives = expandBraces(glob).map(compileGlob);
	return new RegExp(`^(?:${alternatives.join("|")})$`);
}

function normalizeGlob(glob: string): string {
	let pattern = glob.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\//, "");
	if (pattern.endsWith("/")) pattern += "**";
	return pattern.includes("/") ? pattern : `**/${pattern}`;
}

/** Cursor glob semantics: a pattern without a slash matches at any depth. `!pattern` excludes. */
export function matchesGlobs(relativePath: string, patterns: string[]): boolean {
	const path = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
	let matched = false;
	for (const pattern of patterns) {
		const negated = pattern.startsWith("!");
		const regex = globToRegExp(normalizeGlob(negated ? pattern.slice(1) : pattern));
		if (regex.test(path)) {
			if (negated) return false;
			matched = true;
		}
	}
	return matched;
}

/** Evaluates gitignore-format lines (`.cursorignore`) in order; later lines win. */
export function ignoreMatcher(source: string): (relativePath: string) => boolean {
	const rules = source
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#"))
		.map((line) => {
			const negated = line.startsWith("!");
			let body = negated ? line.slice(1) : line;
			const directoryOnly = body.endsWith("/");
			if (directoryOnly) body = body.slice(0, -1);
			const anchored = body.includes("/");
			body = body.replace(/^\//, "");
			const prefix = anchored ? "" : "**/";
			const file = globToRegExp(`${prefix}${body}`);
			const nested = globToRegExp(`${prefix}${body}/**`);
			return { negated, directoryOnly, file, nested };
		});
	return (relativePath) => {
		const path = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
		let ignored = false;
		for (const rule of rules) {
			if (rule.nested.test(path) || (!rule.directoryOnly && rule.file.test(path))) ignored = !rule.negated;
		}
		return ignored;
	};
}

export function slugify(text: string, max = 48): string {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, max)
		.replace(/-+$/, "");
	return slug || "untitled";
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function oneLine(text: string, max = 100): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}
