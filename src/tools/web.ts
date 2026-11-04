/** `web_fetch` and `web_search`. Search uses Brave or Tavily when a key is set, otherwise DuckDuckGo's HTML endpoint. */

import { DEFAULT_MAX_BYTES, truncateHead } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Runtime } from "../core/runtime.ts";
import { oneLine } from "../core/text.ts";

const USER_AGENT = "Mozilla/5.0 (compatible; pi-cursor/0.1; +https://pi.dev)";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

function decodeEntities(text: string): string {
	return text.replace(/&(#x?[0-9a-f]+|\w+);/gi, (whole, code: string) => {
		const known = ENTITIES[code.toLowerCase()];
		if (known) return known;
		if (code.startsWith("#x") || code.startsWith("#X")) return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
		if (code.startsWith("#")) return String.fromCodePoint(Number(code.slice(1)));
		return whole;
	});
}

export function htmlToText(html: string): string {
	const text = html
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(script|style|noscript|svg|head|nav|footer)\b[\s\S]*?<\/\1>/gi, "")
		.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, body: string) => `\n\n${"#".repeat(Number(level))} ${body}\n\n`)
		.replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, body: string) => `[${body}](${href})`)
		.replace(/<li\b[^>]*>/gi, "\n- ")
		.replace(/<(br|hr)\b[^>]*>/gi, "\n")
		.replace(/<\/(p|div|section|article|tr|ul|ol|pre|table|blockquote)>/gi, "\n\n")
		.replace(/<[^>]+>/g, "");
	return decodeEntities(text)
		.replace(/[ \t]+/g, " ")
		.replace(/\n[ \t]+/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function isPrivateHost(host: string): boolean {
	const name = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
	if (name.startsWith("::ffff:")) return true;
	if (name === "localhost" || name.endsWith(".localhost") || name.endsWith(".local") || name.endsWith(".internal")) return true;
	if (name === "::1" || /^(fc|fd|fe80)[0-9a-f:]*:/.test(name)) return true;
	const parts = name.split(".").map(Number);
	if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return false;
	const [a, b] = parts as [number, number, number, number];
	return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

async function fetchWithTimeout(url: string, signal: AbortSignal | undefined, init?: RequestInit): Promise<Response> {
	const timeout = AbortSignal.timeout(30000);
	return fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { "user-agent": USER_AGENT, ...init?.headers } });
}

interface SearchHit {
	title: string;
	url: string;
	snippet: string;
}

async function searchBrave(query: string, count: number, key: string, signal?: AbortSignal): Promise<SearchHit[]> {
	const response = await fetchWithTimeout(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`, signal, { headers: { accept: "application/json", "x-subscription-token": key } });
	if (!response.ok) throw new Error(`Brave search returned HTTP ${response.status}`);
	const data = (await response.json()) as { web?: { results?: Array<{ title: string; url: string; description?: string }> } };
	return (data.web?.results ?? []).map((hit) => ({ title: hit.title, url: hit.url, snippet: htmlToText(hit.description ?? "") }));
}

async function searchTavily(query: string, count: number, key: string, signal?: AbortSignal): Promise<SearchHit[]> {
	const response = await fetchWithTimeout("https://api.tavily.com/search", signal, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
		body: JSON.stringify({ query, max_results: count }),
	});
	if (!response.ok) throw new Error(`Tavily search returned HTTP ${response.status}`);
	const data = (await response.json()) as { results?: Array<{ title: string; url: string; content?: string }> };
	return (data.results ?? []).map((hit) => ({ title: hit.title, url: hit.url, snippet: hit.content ?? "" }));
}

export function parseDuckDuckGo(html: string, count: number): SearchHit[] {
	const hits: SearchHit[] = [];
	for (const block of html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/).slice(1)) {
		const link = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
		if (!link) continue;
		const snippet = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(block);
		let url = decodeEntities(link[1] as string);
		const redirect = /[?&]uddg=([^&]+)/.exec(url);
		if (redirect) url = decodeURIComponent(redirect[1] as string);
		if (url.startsWith("//")) url = `https:${url}`;
		if (url.includes("duckduckgo.com/y.js")) continue;
		hits.push({ title: htmlToText(link[2] as string), url, snippet: htmlToText(snippet?.[1] ?? "") });
		if (hits.length >= count) break;
	}
	return hits;
}

async function searchDuckDuckGo(query: string, count: number, signal?: AbortSignal): Promise<SearchHit[]> {
	const response = await fetchWithTimeout("https://html.duckduckgo.com/html/", signal, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: `q=${encodeURIComponent(query)}`,
	});
	if (!response.ok) throw new Error(`DuckDuckGo returned HTTP ${response.status}`);
	return parseDuckDuckGo(await response.text(), count);
}

export function setupWebTools(rt: Runtime): void {
	const { pi } = rt;
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description: "Fetch a URL and return its content as text. HTML is converted to readable text. Use it for documentation, or for a page the user points to.",
		promptSnippet: "Fetch a web page as text",
		parameters: Type.Object({ url: Type.String({ description: "An http or https URL." }) }),
		annotations: { readOnlyHint: true, openWorldHint: true },
		async execute(_id, params, signal) {
			const url = new URL(params.url);
			if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Only http and https URLs are supported, not ${url.protocol}`);
			// Redirects are followed by hand: a public page must not be able to bounce this to a private address.
			let response = await fetchWithTimeout(url.href, signal, { redirect: "manual" });
			for (let hops = 0; response.status >= 300 && response.status < 400 && response.headers.has("location"); hops++) {
				if (hops >= 5) throw new Error("Too many redirects");
				const target = new URL(response.headers.get("location") as string, url);
				if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error(`Refusing to follow a redirect to ${target.protocol}`);
				if (isPrivateHost(target.hostname) && !isPrivateHost(url.hostname)) throw new Error(`Refusing to follow a redirect from a public address to ${target.hostname}`);
				url.href = target.href;
				response = await fetchWithTimeout(url.href, signal, { redirect: "manual" });
			}
			const type = response.headers.get("content-type") ?? "";
			const body = await response.text();
			const text = type.includes("html") ? htmlToText(body) : body;
			const truncated = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: 2000 });
			const note = truncated.truncated ? "\n\n[Content truncated]" : "";
			return { content: [{ type: "text", text: `HTTP ${response.status} ${url.href}\n\n${truncated.content}${note}` }], details: { status: response.status, bytes: body.length }, isError: !response.ok };
		},
		renderCall: (args, theme) => new Text(`${theme.fg("toolTitle", "Fetched")} ${theme.fg("accent", oneLine(String(args.url ?? ""), 90))}`, 0, 0),
		renderResult: (result, { expanded }, theme) => {
			const text = result.content.find((part) => part.type === "text");
			if (!expanded || text?.type !== "text") return new Text("", 0, 0);
			return new Text(theme.fg("toolOutput", text.text), 0, 0);
		},
	});
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: "Search the web and return titles, URLs and snippets. Use it for information that is recent or not in the codebase, then web_fetch the pages worth reading.",
		promptSnippet: "Search the web",
		parameters: Type.Object({
			query: Type.String(),
			max_results: Type.Optional(Type.Number({ description: "Default 8." })),
		}),
		annotations: { readOnlyHint: true, openWorldHint: true },
		async execute(_id, params, signal) {
			const count = Math.min(params.max_results ?? 8, 20);
			const brave = process.env.BRAVE_API_KEY;
			const tavily = process.env.TAVILY_API_KEY;
			const hits = brave ? await searchBrave(params.query, count, brave, signal) : tavily ? await searchTavily(params.query, count, tavily, signal) : await searchDuckDuckGo(params.query, count, signal);
			if (hits.length === 0) return { content: [{ type: "text", text: `No results for: ${params.query}` }], details: { hits } };
			const text = hits.map((hit, index) => `${index + 1}. ${hit.title}\n   ${hit.url}\n   ${hit.snippet}`).join("\n\n");
			return { content: [{ type: "text", text }], details: { hits } };
		},
		renderCall: (args, theme) => new Text(`${theme.fg("toolTitle", "Searched web")} ${theme.fg("accent", `"${oneLine(String(args.query ?? ""), 80)}"`)}`, 0, 0),
		renderResult: (result, { expanded }, theme) => {
			const hits = (result.details as { hits?: SearchHit[] }).hits ?? [];
			const rows = hits.slice(0, expanded ? 20 : 3).map((hit) => `  ${theme.fg("muted", oneLine(hit.title, 70))} ${theme.fg("dim", oneLine(hit.url, 50))}`);
			return new Text(rows.join("\n"), 0, 0);
		},
	});
}
