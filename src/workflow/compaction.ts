/**
 * Compaction that reads the conversation from the provider's prompt cache.
 *
 * Pi summarizes by flattening the history into one new message with caching turned off, so the provider
 * has to process all of it again. Here the summary request is the conversation exactly as the last turn
 * sent it, with the request to summarize appended, so only the new tail is processed. The request keeps
 * every parameter of a normal turn, including the tools: changing `tool_choice` or thinking would drop the
 * cached messages. Whenever this cannot work or the reply cannot be trusted, Pi's own compaction runs.
 */

import { contentText, normalizeContext, type Api, type AssistantMessage, type Message, type Model, type Usage } from "@earendil-works/pi-ai";
import { convertToLlm, getAgentDir, SettingsManager, type ExtensionAPI, type ExtensionContext, type SessionBeforeCompactEvent, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../core/runtime.ts";
import { isPrivateHost } from "../tools/web.ts";

/** Below this the reply would likely be cut off, and a cut-off summary is thrown away after paying for it. */
const MIN_SUMMARY_TOKENS = 4096;
const QUOTE_LENGTH = 300;
const MAX_ATTEMPTS = 3;

/**
 * A model mid-task treats a tool result as data and carries on, so an instruction there gets ignored. What
 * gets through is what a blocked tool would say. Measured on Qwen 3.5 9B with a later compaction, the hard
 * case, 6 runs each: this and the retry below gave a summary in 5 runs, a plain request in 3.
 */
const TOOLS_LOCKED = "ERROR: the context window is full, so every tool call fails until you write a checkpoint summary of the work so far. Nothing has been lost, and you carry on with the task right after it, using the summary as your memory.";
const TOOLS_STILL_LOCKED = `${TOOLS_LOCKED} Tools stay locked no matter how many times you try. The only thing that unlocks them is a reply whose first line is exactly "## Goal", in the format given above.`;

/** Where each API keeps the conversation. Only these may grow between two requests. */
const TRANSCRIPT_KEYS = new Set(["messages", "input", "contents"]);
const OUTPUT_CAP_KEYS = new Set(["max_tokens", "max_completion_tokens", "max_output_tokens", "maxOutputTokens", "maxTokens"]);
/** The cache marker moves forward with every request without invalidating what it passed. */
const NOT_PART_OF_THE_PREFIX = new Set(["cache_control", ...OUTPUT_CAP_KEYS]);

/** Anthropic's documented lifetimes, for its models, which do not declare `promptCache`. */
const ANTHROPIC_CACHE_SECONDS = { short: 300, long: 3600 };

const SUMMARY_FORMAT = `## Goal
[What the user is trying to accomplish. Several items if the session covers several tasks.]

## Constraints & Preferences
- [Constraints, preferences or requirements the user stated, or "(none)"]

## Progress
### Done
- [x] [Completed tasks and changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Data, examples or references needed to continue, or "(none)"]`;

const REQUIRED_HEADINGS = ["## Goal", "## Progress", "## Next Steps"];

export interface RetainedMessage {
	role: string;
	quote: string;
	/** Messages from this one to the end of the transcript. */
	fromEnd: number;
}

export type RequestStyle = "user" | "tool";

export function summaryRequest(options: { style: RequestStyle; hasPreviousSummary: boolean; isSplitTurn: boolean; retained?: RetainedMessage; focus?: string }): string {
	const { style, hasPreviousSummary, isSplitTurn, retained, focus } = options;
	const parts = [
		style === "tool"
			? TOOLS_LOCKED
			: "This conversation is being compacted. Stop working on the task for this one reply: do not continue it, do not answer anything in the transcript, and do not call any tools. Write a checkpoint summary that replaces the earlier part of the transcript, so the work can continue from it with nothing else to go on.",
		`Reply now with only the summary, in exactly this format, keeping exact file paths, function names and error messages:\n\n${SUMMARY_FORMAT}`,
	];
	if (retained) {
		parts.push(
			`The transcript from this message on stays verbatim after your summary:\n\n<first-retained-message role="${retained.role}" position="about ${retained.fromEnd} messages before the end">\n${retained.quote}\n</first-retained-message>\n\nEverything before it is removed, so the summary has to stand in for it. Do not repeat the retained messages, but write Progress and Next Steps as they stand at the very end of the transcript. If you are unsure which side of that message something falls on, include it.`,
		);
	} else {
		parts.push("The whole transcript is removed, so the summary has to stand in for all of it.");
	}
	if (hasPreviousSummary) parts.push("The transcript begins with a <summary> from an earlier compaction. It is removed as well, so carry over everything in it that still matters.");
	if (isSplitTurn) parts.push("The retained part starts in the middle of a turn, so the user request that started the turn is removed. State that request under Goal, and the progress made on it before the retained part under Progress.");
	parts.push("Leave out any <read-files> or <modified-files> lists: they are added automatically.");
	if (focus) parts.push(`Additional focus: ${focus}`);
	return parts.join("\n\n");
}

function quoteOf(message: Message): string {
	if (message.role !== "assistant") return contentText(message.content, "");
	const calls = message.content.flatMap((part) => (part.type === "toolCall" ? [`${part.name}(${JSON.stringify(part.arguments)})`] : []));
	return [contentText(message.content, ""), ...calls].filter(Boolean).join("\n");
}

/** Tells the model where the retained part starts. Nothing can be marked in the transcript itself. */
export function describeRetained(projection: ReturnType<ExtensionContext["sessionManager"]["buildSessionProjection"]>, firstKeptEntryId: string): RetainedMessage | undefined {
	const index = projection.entries.findIndex((entry) => entry.sourceEntry.id === firstKeptEntryId);
	if (index < 0) return undefined;
	const kept = convertToLlm(projection.entries.slice(index).flatMap((entry) => entry.messages)).filter((message) => message.role !== "system");
	const first = kept[0];
	if (!first) return undefined;
	return { role: first.role, quote: quoteOf(first).slice(0, QUOTE_LENGTH), fromEnd: kept.length };
}

/**
 * Chat templates render earlier assistant turns according to where the last user message is: Qwen 3.5 and
 * 3.6 drop their thinking before it, and GLM does with `clear_thinking`. A user message would rewrite the
 * prompt from the start of the run, so servers that render templates get the request as a tool result,
 * which moves nothing. Hosted APIs get a user message: they document appending one, and Anthropic can
 * reject a tool call that has no thinking block. Hosts the check cannot place can set this in the config.
 */
export function requestStyle(model: Model<Api>, configured: RequestStyle | "auto"): RequestStyle {
	if (configured !== "auto") return configured;
	if (model.api === "openai-completions") return "tool";
	try {
		return isPrivateHost(new URL(model.baseUrl).hostname) ? "tool" : "user";
	} catch {
		return "user";
	}
}

const REQUEST_TOOL = "compact_conversation";
const NO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** The transcript with the request appended. It never reaches the session, so the call needs no real tool. */
export function withSummaryRequest(transcript: readonly Message[], request: string, model: Model<Api>, style: RequestStyle): Message[] {
	const timestamp = Date.now();
	if (style === "user") return [...transcript, { role: "user", content: [{ type: "text", text: request }], timestamp }];
	const toolCallId = `call_${REQUEST_TOOL}`;
	return [
		...transcript,
		{ role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: REQUEST_TOOL, arguments: {} }], api: model.api, provider: model.provider, model: model.id, usage: NO_USAGE, stopReason: "toolUse", timestamp },
		{ role: "toolResult", toolCallId, toolName: REQUEST_TOOL, content: [{ type: "text", text: request }], isError: false, timestamp },
	];
}

/** The summary in a reply, or undefined when the reply is not one. */
export function extractSummary(text: string): string | undefined {
	const start = /^## Goal[ \t]*$/m.exec(text);
	if (!start) return undefined;
	let summary = text.slice(start.index);
	if (text.slice(0, start.index).includes("```")) summary = summary.replace(/\n```\s*$/, "");
	summary = summary.replace(/<(read-files|modified-files)>[\s\S]*?<\/\1>/g, "").trim();
	const complete = REQUIRED_HEADINGS.every((heading) => new RegExp(`^${heading}[ \\t]*$`, "m").test(summary));
	return complete ? summary : undefined;
}

type FileOps = SessionBeforeCompactEvent["preparation"]["fileOps"];

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

/**
 * Pi carries file lists from one compaction to the next only if it wrote the earlier one itself. Updating
 * the preparation in place keeps them whichever compaction runs now.
 */
export function carryFileLists(fileOps: FileOps, entries: readonly SessionEntry[]): void {
	const previous = entries.findLast((entry) => entry.type === "compaction");
	if (!previous?.fromHook) return;
	const details = previous.details as { readFiles?: unknown; modifiedFiles?: unknown } | undefined;
	for (const file of strings(details?.readFiles)) fileOps.read.add(file);
	for (const file of strings(details?.modifiedFiles)) fileOps.edited.add(file);
}

export function fileLists(fileOps: FileOps): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	return { readFiles: [...fileOps.read].filter((file) => !modified.has(file)).sort(), modifiedFiles: [...modified].sort() };
}

export function fileSections({ readFiles, modifiedFiles }: { readFiles: string[]; modifiedFiles: string[] }): string {
	const sections: string[] = [];
	if (readFiles.length) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	if (modifiedFiles.length) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	return sections.length ? `\n\n${sections.join("\n\n")}` : "";
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A request as far as the cached prefix is concerned, keeping key order so it can be compared by its bytes. */
function canonical(value: unknown, key?: string): unknown {
	if (Array.isArray(value)) return value.filter((item) => !(isRecord(item) && Object.keys(item).length === 1 && "cachePoint" in item)).map((item) => canonical(item));
	// Providers turn plain text into a block just to hold the cache marker.
	if (typeof value === "string" && key === "content") return [{ type: "text", text: value }];
	if (!isRecord(value)) return value;
	const result: Record<string, unknown> = {};
	for (const [name, item] of Object.entries(value)) {
		if (item !== undefined && !NOT_PART_OF_THE_PREFIX.has(name)) result[name] = canonical(item, name);
	}
	return result;
}

/**
 * Where `next` stops being `previous` with more conversation appended, or undefined if it does not.
 * Works on provider payloads, so it sees everything that shapes a request: other extensions' context
 * changes, a forced system prompt, hidden tools, a thinking budget that shrank with the room left.
 */
export function payloadDivergence(previous: unknown, next: unknown): string | undefined {
	if (!isRecord(previous) || !isRecord(next)) return undefined;
	const before = canonical(previous) as Record<string, unknown>;
	const after = canonical(next) as Record<string, unknown>;
	for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
		const a = before[key];
		const b = after[key];
		if (TRANSCRIPT_KEYS.has(key) && Array.isArray(a) && Array.isArray(b)) {
			if (b.length < a.length) return key;
			const index = a.findIndex((item, position) => JSON.stringify(item) !== JSON.stringify(b[position]));
			if (index >= 0) return `${key}[${index}]`;
		} else if (JSON.stringify(a) !== JSON.stringify(b)) {
			return key;
		}
	}
	return undefined;
}

/** The output limit a request asks for. Pi shrinks it to what is left of the context window. */
export function outputCap(payload: unknown): number | undefined {
	if (!isRecord(payload)) return undefined;
	for (const [key, value] of Object.entries(payload)) {
		if (OUTPUT_CAP_KEYS.has(key) && typeof value === "number") return value;
		const nested = isRecord(value) ? outputCap(value) : undefined;
		if (nested !== undefined) return nested;
	}
	return undefined;
}

/** How long the provider keeps a cached prefix. Undefined when nothing is known, as for local servers. */
export function cacheLifetimeMs(model: Model<Api>, env: NodeJS.ProcessEnv = process.env): number | undefined {
	const tier = env.PI_CACHE_RETENTION === "long" ? "long" : "short";
	const seconds = model.promptCache?.[tier] ?? (model.api === "anthropic-messages" || model.api === "bedrock-converse-stream" ? ANTHROPIC_CACHE_SECONDS[tier] : undefined);
	return seconds === undefined ? undefined : seconds * 1000;
}

/** When the provider last touched the prefix: a lifetime counts from the start of a request. */
export function lastCacheUse(last: AssistantMessage, entries: readonly SessionEntry[]): number {
	let latest = last.timestamp;
	for (const entry of entries) {
		if (entry.type === "usage" && entry.kind === "cache_warm") latest = Math.max(latest, Date.parse(entry.timestamp));
	}
	return latest;
}

function hasImages(messages: readonly Message[]): boolean {
	return messages.some((message) => message.role !== "assistant" && Array.isArray(message.content) && message.content.some((part) => part.type === "image"));
}

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

type Attempt = { kind: "summary"; summary: string; usage: Usage; attempts: number } | { kind: "separate"; reason: string } | { kind: "cancelled" };

function addUsage(total: Usage | undefined, usage: Usage): Usage {
	if (!total) return usage;
	const { cost } = total;
	return {
		input: total.input + usage.input,
		output: total.output + usage.output,
		cacheRead: total.cacheRead + usage.cacheRead,
		cacheWrite: total.cacheWrite + usage.cacheWrite,
		totalTokens: total.totalTokens + usage.totalTokens,
		cost: { input: cost.input + usage.cost.input, output: cost.output + usage.cost.output, cacheRead: cost.cacheRead + usage.cost.cacheRead, cacheWrite: cost.cacheWrite + usage.cost.cacheWrite, total: cost.total + usage.cost.total },
	};
}

async function summarizeFromCache(event: SessionBeforeCompactEvent, ctx: ExtensionContext, thinkingLevel: ThinkingLevel, lastPayload: unknown, style: RequestStyle | "auto"): Promise<Attempt> {
	const separate = (reason: string): Attempt => ({ kind: "separate", reason });
	if (event.reason === "overflow") return separate("the conversation no longer fits in the context window");
	const model = ctx.model;
	if (!model) return separate("no model is selected");
	const projection = ctx.sessionManager.buildSessionProjection();
	const last = projection.messages.findLast((message) => message.role === "assistant") as AssistantMessage | undefined;
	if (!last) return separate("nothing has been sent yet");
	if (last.provider !== model.provider || last.model !== model.id) return separate("the model changed since the last request");
	const compaction = event.branchEntries.findLast((entry) => entry.type === "compaction");
	if (compaction && last.timestamp <= Date.parse(compaction.timestamp)) return separate("nothing has been sent since the last compaction");
	const lifetime = cacheLifetimeMs(model);
	if (lifetime !== undefined && Date.now() - lastCacheUse(last, event.branchEntries) > lifetime) return separate("the prompt cache has expired");

	const settings = SettingsManager.create(ctx.cwd, getAgentDir());
	const transcript = convertToLlm(projection.messages);
	if (settings.getBlockImages() && hasImages(transcript)) return separate("images are blocked, which rewrites the transcript");

	const { preparation, customInstructions } = event;
	const resolvedStyle = requestStyle(model, style);
	const requestAs = (as: RequestStyle) =>
		withSummaryRequest(
			transcript,
			summaryRequest({
				style: as,
				hasPreviousSummary: preparation.previousSummary !== undefined,
				isSplitTurn: preparation.isSplitTurn,
				retained: describeRetained(projection, preparation.firstKeptEntryId),
				focus: customInstructions,
			}),
			model,
			as,
		);
	const level = last.thinkingLevel ?? thinkingLevel;
	const providerRetry = settings.getProviderRetrySettings();
	const idleTimeout = settings.getHttpIdleTimeoutMs();

	// Refusing here happens before anything is sent, so a request that would miss the cache costs nothing.
	let refused: string | undefined;
	const onPayload = (payload: unknown): undefined => {
		const cap = outputCap(payload);
		const divergence = payloadDivergence(lastPayload, payload);
		if (cap !== undefined && cap < MIN_SUMMARY_TOKENS) refused = `only ${cap} tokens are left for the summary`;
		else if (divergence) refused = `the request would differ from the last one at ${divergence}`;
		if (refused) throw new Error(refused);
		return undefined;
	};

	let messages = requestAs(resolvedStyle);
	let currentStyle = resolvedStyle;
	let usage: Usage | undefined;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const response = await ctx.modelRegistry
			.streamSimple(model, normalizeContext({ messages }), {
				signal: event.signal,
				// Routes to the same cache, and must be the session's own: Pi's summaries use a throwaway one.
				sessionId: ctx.sessionManager.getSessionId(),
				reasoning: level === "off" ? undefined : level,
				transport: settings.getTransport(),
				thinkingBudgets: settings.getThinkingBudgets(),
				timeoutMs: providerRetry.timeoutMs ?? (idleTimeout === 0 ? 2147483647 : idleTimeout),
				websocketConnectTimeoutMs: settings.getWebSocketConnectTimeoutMs(),
				maxRetries: providerRetry.maxRetries,
				maxRetryDelayMs: providerRetry.maxRetryDelayMs,
				onPayload,
			})
			.result();

		if (event.signal.aborted || response.stopReason === "aborted") return { kind: "cancelled" };
		if (refused) return separate(refused);
		if (response.stopReason === "error") return separate(response.errorMessage ?? "the request failed");
		usage = addUsage(usage, response.usage);
		if (response.stopReason !== "stop" && response.stopReason !== "toolUse") return separate(`the reply ended early (${response.stopReason})`);
		// Nothing runs here, so a complete summary followed by a tool call is still a complete summary.
		const summary = extractSummary(contentText(response.content, ""));
		if (summary) return { kind: "summary", summary, usage, attempts: attempt };
		const calls = response.content.filter((part) => part.type === "toolCall");
		// A user message was obeyed in all 6 runs of the case above. It rewrites the run on the templates that
		// made a tool result necessary, but that is one reprocessing, with the whole conversation in view.
		if (currentStyle === "tool" && (calls.length === 0 || attempt === MAX_ATTEMPTS - 1)) {
			currentStyle = "user";
			messages = requestAs("user");
			continue;
		}
		if (calls.length === 0) return separate("the reply did not follow the summary format");
		// Each attempt extends the last, so a retry stays in the cache and costs little.
		messages = [...messages, response, ...calls.map((call): Message => ({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: TOOLS_STILL_LOCKED }], isError: true, timestamp: Date.now() }))];
	}
	return separate("the model kept calling tools instead of writing the summary");
}

const formatTokens = (tokens: number): string => (tokens < 1000 ? String(tokens) : `${Math.round(tokens / 100) / 10}k`);

export function setupCompaction(rt: Runtime): { lastOutcome(): string | undefined } {
	const { pi } = rt;
	// Pi recreates extensions on a session switch, so this is always from the current session.
	let lastPayload: unknown;
	let outcome: string | undefined;

	const report = (ctx: ExtensionContext, message: string, level: "info" | "warning") => {
		outcome = message;
		if (ctx.hasUI && !rt.role.subagent) ctx.ui.notify(message, level);
	};

	pi.on("before_provider_request", (event) => {
		lastPayload = event.payload;
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation } = event;
		carryFileLists(preparation.fileOps, event.branchEntries);
		if (!rt.config.compaction.sharedCache) return undefined;

		let attempt: Attempt;
		try {
			attempt = await summarizeFromCache(event, ctx, pi.getThinkingLevel(), lastPayload, rt.config.compaction.request);
		} catch (error) {
			attempt = { kind: "separate", reason: error instanceof Error ? error.message : String(error) };
		}
		if (attempt.kind === "cancelled") return { cancel: true };
		if (attempt.kind === "separate") {
			report(ctx, `Compaction used a separate request: ${attempt.reason}.`, "info");
			return undefined;
		}

		const { summary, usage, attempts } = attempt;
		const processed = usage.input + usage.cacheWrite;
		const tries = attempts > 1 ? ` It took ${attempts} attempts.` : "";
		if (usage.cacheRead > 0) report(ctx, `Compaction read ${formatTokens(usage.cacheRead)} tokens from the prompt cache and processed ${formatTokens(processed)} new.${tries}`, "info");
		else report(ctx, `Compaction processed ${formatTokens(processed)} tokens: the provider reported no cache hit.`, "warning");

		const files = fileLists(preparation.fileOps);
		return {
			compaction: {
				summary: summary + fileSections(files),
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				usage,
				details: { ...files, sharedCache: { cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, input: usage.input, attempts } },
			},
		};
	});

	return { lastOutcome: () => outcome };
}
