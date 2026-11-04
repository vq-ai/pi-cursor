/**
 * Conservative shell-command analysis. `isReadOnlyCommand` backs the read-only guarantee of Ask and
 * Plan modes and of `readonly` sub-agents, and decides what runs without asking in allowlist mode.
 *
 * The parser only has to be right about commands it accepts. Whatever could make it disagree with
 * how bash reads a command (ANSI-C quoting, unquoted backslashes, parameter expansion, redirections
 * it cannot prove harmless) marks the command as complex, and a complex command is never read-only.
 * Per-command checks allow specific flags rather than deny bad ones wherever flags can run code or
 * write files, because deny lists miss abbreviations such as `--out=` for `--output=`.
 */

export interface ShellAnalysis {
	/** Simple commands, in order, with operators removed. */
	segments: string[];
	/** Anything the segments alone do not fully describe. */
	complex: boolean;
}

const SAFE_REDIRECT = /^(?:\d?>\s*\/dev\/null|\d?>&[12]|&>\s*\/dev\/null)(?=$|[\s;|&])/;

export function analyzeShell(command: string): ShellAnalysis {
	const segments: string[] = [];
	let current = "";
	let complex = false;
	let quote: '"' | "'" | undefined;
	const flush = () => {
		if (current.trim()) segments.push(current.trim());
		current = "";
	};
	for (let i = 0; i < command.length; i++) {
		const char = command[i] as string;
		const next = command[i + 1];
		if (quote === "'") {
			if (char === "'") quote = undefined;
			current += char;
			continue;
		}
		if (char === "\\") {
			if (next === "\n") {
				i++;
				continue;
			}
			// Inside double quotes a backslash only protects the next character. Outside them it can
			// hide a space, a quote or a comment marker from this parser.
			if (!quote) complex = true;
			current += char + (next ?? "");
			i++;
			continue;
		}
		if (char === "`" || (char === "$" && (next === "(" || next === "{" || next === "[" || next === "'" || next === '"'))) complex = true;
		if (quote === '"') {
			if (char === '"') quote = undefined;
			current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			current += char;
			continue;
		}
		if (char === "#" && (i === 0 || /\s/.test(command[i - 1] as string))) {
			while (i < command.length && command[i] !== "\n") i++;
			flush();
			continue;
		}
		if (char === "(" || char === ")") {
			complex = true;
			current += char;
			continue;
		}
		const redirectStart = char === ">" || (char === "<" && (next === "<" || next === "(" || next === ">"));
		if (redirectStart || (/\d/.test(char) && next === ">") || (char === "&" && next === ">")) {
			const safe = SAFE_REDIRECT.exec(command.slice(i));
			if (safe) {
				i += safe[0].length - 1;
				continue;
			}
			complex = true;
			current += char;
			continue;
		}
		if (char === ";" || char === "\n" || char === "|" || char === "&") {
			if ((char === "|" || char === "&") && next === char) i++;
			flush();
			continue;
		}
		current += char;
	}
	if (quote) complex = true;
	flush();
	return { segments, complex };
}

export function splitWords(segment: string): string[] {
	const words: string[] = [];
	let current = "";
	let started = false;
	let quote: '"' | "'" | undefined;
	for (let i = 0; i < segment.length; i++) {
		const char = segment[i] as string;
		if (quote) {
			if (char === quote) quote = undefined;
			else if (char === "\\" && quote === '"' && i + 1 < segment.length) current += segment[++i];
			else current += char;
		} else if (char === "'" || char === '"') {
			quote = char;
			started = true;
		} else if (char === "\\" && i + 1 < segment.length) {
			current += segment[++i];
			started = true;
		} else if (/\s/.test(char)) {
			if (started || current) words.push(current);
			current = "";
			started = false;
		} else {
			current += char;
		}
	}
	if (started || current) words.push(current);
	return words;
}

/** Commands with no flag that writes a file or runs anything. */
const PLAIN_COMMANDS = new Set([
	"basename", "cat", "cd", "cmp", "column", "comm", "cut", "date", "df", "dirname", "du", "echo", "egrep", "false",
	"fgrep", "grep", "head", "hexdump", "id", "ls", "lsof", "md5", "md5sum", "nl", "od", "printenv", "ps", "pwd",
	"readlink", "realpath", "rev", "seq", "sha1sum", "sha256sum", "shasum", "stat", "strings", "sw_vers", "tac", "tail",
	"tr", "true", "type", "uname", "uptime", "wc", "whereis", "which", "whoami",
]);

/**
 * Only tools whose version flag cannot be intercepted by files in the workspace. `yarn` honors
 * `yarnPath` and `cargo` and `rustc` honor `rust-toolchain.toml`, either of which runs repository code.
 */
const VERSION_COMMANDS = new Set(["clang", "gcc", "gh", "git", "java", "node", "npm", "python", "python3", "ruby"]);

const GIT_READ = new Set([
	"blame", "cat-file", "describe", "diff", "diff-tree", "for-each-ref", "grep", "log", "ls-files", "ls-tree", "merge-base",
	"name-rev", "rev-list", "rev-parse", "shortlog", "show", "show-ref", "status", "whatchanged",
]);

/** Commands where a word that turns into a flag after expansion could write a file or run something. */
const FLAG_SENSITIVE = new Set(["awk", "fd", "fdfind", "file", "find", "gawk", "gh", "git", "npm", "printf", "rg", "sed", "sort", "tree", "uniq"]);

/**
 * True if bash would rewrite part of this segment before running it. `find . {-delete,}`,
 * `find . $UNSET-delete` and a file named `-delete` matched by `*` all reach find as `-delete`,
 * though none of them looks like that flag here.
 */
export function hasExpansion(segment: string): boolean {
	let quote: '"' | "'" | undefined;
	for (let i = 0; i < segment.length; i++) {
		const char = segment[i] as string;
		if (quote === "'") {
			if (char === "'") quote = undefined;
		} else if (quote === '"') {
			if (char === '"') quote = undefined;
			else if (char === "\\") i++;
			else if (char === "$") return true;
		} else if (char === "'" || char === '"') {
			quote = char;
		} else if (char === "\\") {
			i++;
		} else if ("$*?[{".includes(char)) {
			return true;
		}
	}
	return false;
}

function hasFlag(words: string[], ...patterns: RegExp[]): boolean {
	return words.some((word) => patterns.some((pattern) => pattern.test(word)));
}

function positionals(words: string[]): string[] {
	return words.filter((word) => word === "-" || !word.startsWith("-"));
}

function gitIsReadOnly(words: string[]): boolean {
	// Global flags such as -c and --exec-path run arbitrary commands, and -C can select a bare
	// repository checked into the workspace, whose config runs commands too.
	const sub = words[1];
	if (!sub || sub.startsWith("-")) return false;
	const rest = words.slice(2);
	// Prefixes, since git accepts unambiguous abbreviations of long options.
	if (hasFlag(rest, /^--out/, /^--ext/, /^--textc/, /^--filt/, /^-O/, /^--open/, /^--exec/, /^--no-i/)) return false;
	if (GIT_READ.has(sub)) return true;
	if (sub === "branch") {
		return rest.every((word) => /^(-a|-r|-v|-vv|--all|--remotes|--list|--show-current|--no-color|--color)$/.test(word));
	}
	if (sub === "tag") return rest.length === 0 || ((rest[0] === "-l" || rest[0] === "--list") && rest.slice(1).every((word) => !word.startsWith("-")));
	if (sub === "remote") return rest.length === 0 || (rest.length === 1 && rest[0] === "-v") || (rest[0] === "get-url" && rest.length === 2);
	if (sub === "stash") return rest[0] === "list" || rest[0] === "show";
	if (sub === "config") return (rest[0] === "--get" || rest[0] === "--get-all") && rest.length === 2 || (rest.length === 1 && (rest[0] === "--list" || rest[0] === "-l"));
	if (sub === "reflog") return rest.length === 0 || rest[0] === "show";
	if (sub === "worktree") return rest[0] === "list";
	if (sub === "submodule") return rest[0] === "status";
	return false;
}

function npmIsReadOnly(args: string[]): boolean {
	const [sub, ...rest] = args;
	const flagsOk = rest.every((word) => !word.startsWith("-") || /^--(json|all|long|parseable|prod|dev|depth(=\d+)?)$/.test(word));
	if (!sub || !flagsOk) return false;
	if (["ls", "list", "view", "info", "outdated", "why", "root", "prefix"].includes(sub)) return true;
	if (sub === "audit") return positionals(rest).length === 0;
	if (sub === "config") return rest[0] === "get" || rest[0] === "list";
	return false;
}

function ghIsReadOnly(args: string[]): boolean {
	const [group, action, ...rest] = args;
	if (!group || !action || hasFlag(rest, /^-w$/, /^--web$/)) return false;
	const allowed: Record<string, string[]> = {
		pr: ["view", "list", "diff", "checks", "status"],
		issue: ["view", "list", "status"],
		repo: ["view", "list"],
		run: ["view", "list"],
		release: ["view", "list"],
		workflow: ["view", "list"],
	};
	return allowed[group]?.includes(action) ?? false;
}

function sedIsReadOnly(args: string[]): boolean {
	const flags = args.filter((word) => word.startsWith("-"));
	const [script] = args.filter((word) => !word.startsWith("-"));
	if (!script || !flags.includes("-n") || flags.some((flag) => flag !== "-n" && flag !== "-E" && flag !== "-r")) return false;
	// An address or range followed by p. Nothing else in sed's language is known to be harmless:
	// `w` writes files and GNU's `e` runs commands, and both can hide inside longer scripts.
	return /^(\d+|\$|\/[^/]*\/)(,(\d+|\$|\/[^/]*\/))?p$/.test(script);
}

function awkIsReadOnly(args: string[]): boolean {
	for (let i = 0; i < args.length; i++) {
		const word = args[i] as string;
		if (/system|getline|\||>|@|ENVIRON/.test(word)) return false;
		if (!word.startsWith("-")) continue;
		// Only -F and -v. Others load code or, like gawk's -o and -d, write files.
		if (word === "-v" || word === "-F") i++;
		else if (!/^-[Fv]./.test(word)) return false;
	}
	return true;
}

function wordIsReadOnly(words: string[]): boolean {
	const command = words[0];
	if (!command) return true;
	if (command.includes("/") || command.includes("=") || command.includes("$")) return false;
	const args = words.slice(1);
	if (args.length === 1 && args[0] === "--version" && VERSION_COMMANDS.has(command)) return true;
	if (PLAIN_COMMANDS.has(command)) return true;
	switch (command) {
		case "env":
			return args.length === 0;
		case "hostname":
			return args.length === 0;
		case "printf":
			// `printf -v PATH ...` changes how the rest of the command line resolves.
			return args[0] !== "-v";
		case "file":
			return !hasFlag(args, /^-[a-zA-Z]*C/, /^--comp/);
		case "sort":
			return !hasFlag(args, /^-[a-zA-Z]*o/, /^--/);
		case "uniq":
			return positionals(args).length <= 1;
		case "tree":
			return !hasFlag(args, /^-[a-zA-Z]*o/, /^--/);
		case "find":
			return !hasFlag(args, /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/);
		case "fd":
		case "fdfind":
			return !hasFlag(args, /^-[^-]*[xX]/, /^--exec/);
		case "rg":
			return !hasFlag(args, /^--pre/, /^--hostname-bin/);
		case "jq":
			return true;
		case "sed":
			return sedIsReadOnly(args);
		case "awk":
		case "gawk":
			return awkIsReadOnly(args);
		case "git":
			return gitIsReadOnly(words);
		case "gh":
			return ghIsReadOnly(args);
		case "npm":
			return npmIsReadOnly(args);
		default:
			return false;
	}
}

export function isReadOnlyCommand(command: string): boolean {
	const { segments, complex } = analyzeShell(command);
	if (complex || segments.length === 0) return false;
	const parsed = segments.map(splitWords);
	// After a `cd`, git could be reading a repository config chosen by whoever wrote the workspace.
	if (parsed.some((words) => words[0] === "cd") && parsed.some((words) => words[0] === "git" || words[0] === "npm" || words[0] === "gh")) return false;
	if (segments.some((segment, index) => FLAG_SENSITIVE.has(parsed[index]?.[0] ?? "") && hasExpansion(segment))) return false;
	return parsed.every(wordIsReadOnly);
}
