/** `/loop [interval] <prompt>`: re-sends a prompt or slash command on a schedule while the session is open. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../core/runtime.ts";
import { oneLine } from "../core/text.ts";

const STATUS = "pi-cursor.loop";
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const UNITS: Record<string, number> = { s: 1000, sec: 1000, second: 1000, seconds: 1000, m: 60000, min: 60000, minute: 60000, minutes: 60000, h: 3600000, hour: 3600000, hours: 3600000, d: 86400000, day: 86400000, days: 86400000 };

export function parseLoop(text: string): { intervalMs: number; prompt: string } {
	const input = text.trim();
	const leading = /^(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hours?|d|days?)\s+(.+)$/is.exec(input);
	if (leading) return { intervalMs: Number(leading[1]) * (UNITS[(leading[2] as string).toLowerCase()] as number), prompt: (leading[3] as string).trim() };
	const trailing = /^(.+?)\s+every\s+(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hours?|d|days?)$/is.exec(input);
	if (trailing) return { intervalMs: Number(trailing[2]) * (UNITS[(trailing[3] as string).toLowerCase()] as number), prompt: (trailing[1] as string).trim() };
	return { intervalMs: DEFAULT_INTERVAL_MS, prompt: input };
}

function formatInterval(ms: number): string {
	if (ms >= 3600000) return `${Math.round(ms / 3600000)}h`;
	if (ms >= 60000) return `${Math.round(ms / 60000)}m`;
	return `${Math.round(ms / 1000)}s`;
}

export interface LoopApi {
	start(text: string, ctx: ExtensionContext): void;
	stop(ctx: ExtensionContext): boolean;
	describe(): string | undefined;
}

export function setupLoop(rt: Runtime): LoopApi {
	const { pi } = rt;
	let timer: NodeJS.Timeout | undefined;
	let current: { prompt: string; intervalMs: number } | undefined;
	let duePending = false;

	const send = () => {
		if (current) pi.sendUserMessage(current.prompt, { expandPromptTemplates: true });
	};

	const stop: LoopApi["stop"] = (ctx) => {
		const running = !!timer;
		if (timer) clearInterval(timer);
		timer = undefined;
		current = undefined;
		duePending = false;
		if (ctx.mode === "tui") ctx.ui.setStatus(STATUS, undefined);
		return running;
	};

	pi.on("agent_settled", () => {
		if (!duePending) return;
		duePending = false;
		send();
	});

	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	});

	return {
		start(text, ctx) {
			stop(ctx);
			const { intervalMs, prompt } = parseLoop(text);
			current = { prompt, intervalMs };
			if (ctx.mode === "tui") ctx.ui.setStatus(STATUS, ctx.ui.theme.fg("accent", `↻ ${formatInterval(intervalMs)}`));
			timer = setInterval(() => {
				if (ctx.isIdle()) send();
				else duePending = true;
			}, intervalMs);
			timer.unref();
			if (ctx.isIdle()) send();
			else duePending = true;
		},
		stop,
		describe: () => (current ? `every ${formatInterval(current.intervalMs)}: ${oneLine(current.prompt, 60)}` : undefined),
	};
}
