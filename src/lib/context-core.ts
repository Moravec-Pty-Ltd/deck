// How full a session's context window is, and when to compact it.
//
// The live context size is the *last assistant message's* usage, not the
// result footer's: a result sums every API call in the turn, so a long turn
// reports millions of tokens against a 1M window. Measured against the
// stream's own `pre_tokens` at a compact boundary, the last assistant message
// lands within 0.5%, and the result footer is out by several times over.
//
// The window comes from the result's `modelUsage[model].contextWindow`, so
// deck never has to keep a model-to-window table: 200k and 1M sessions report
// their own size. A compaction resets the count on its own, since the assistant
// message after the boundary carries the post-compaction usage.
//
// Node-free so the server (base over the transcript tail) and the client
// (folding live events on top of that base) share one implementation.

export interface ContextUsage {
	// Tokens the next request would carry: everything in the window right now.
	used: number;
	// 0 when the session has not finished a turn yet, so nothing has reported a
	// window. Callers show the raw count and no percentage.
	window: number;
}

export function emptyContext(): ContextUsage {
	return { used: 0, window: 0 };
}

function num(v: unknown): number {
	return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

// Everything that counts against the window: fresh input, what was written to
// the cache, what was read from it, and what the model just produced.
export function usedTokens(usage: unknown): number {
	const u = usage as Record<string, unknown> | null;
	if (!u || typeof u !== 'object') return 0;
	return (
		num(u.input_tokens) +
		num(u.cache_creation_input_tokens) +
		num(u.cache_read_input_tokens) +
		num(u.output_tokens)
	);
}

// The largest context window any model in this result reported. A turn normally
// names one model; a turn that used a subagent on another names both, and the
// session's own limit is the larger.
export function resultWindow(event: unknown): number {
	const modelUsage = (event as { modelUsage?: unknown })?.modelUsage;
	if (!modelUsage || typeof modelUsage !== 'object') return 0;
	let window = 0;
	for (const entry of Object.values(modelUsage as Record<string, unknown>)) {
		const w = num((entry as { contextWindow?: unknown })?.contextWindow);
		if (w > window) window = w;
	}
	return window;
}

// Fold one transcript event into the running figure. An assistant message
// replaces `used` (it is a level, not a sum); a result contributes the window
// only. Anything else passes through, so a caller can fold a raw stream.
export function foldContext(state: ContextUsage, event: unknown): ContextUsage {
	const e = event as { type?: unknown; message?: { usage?: unknown } } | null;
	if (!e || typeof e !== 'object') return state;
	if (e.type === 'assistant') {
		const used = usedTokens(e.message?.usage);
		return used > 0 ? { ...state, used } : state;
	}
	if (e.type === 'result') {
		const window = resultWindow(e);
		return window > 0 ? { ...state, window } : state;
	}
	return state;
}

// 0 to 100, rounded. 0 when no window has been reported yet.
export function contextPercent(context: ContextUsage): number {
	if (context.window <= 0) return 0;
	return Math.min(100, Math.round((context.used / context.window) * 100));
}

// `248k`, `1.0M`. Thousands below a million, because a window is read as "how
// much of my million" and `0.2M` reads worse than `248k`.
export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(Math.max(0, Math.round(n)));
}

// `248k / 1.0M`, for the chip's tooltip. Just the count when no window is known.
export function formatContext(context: ContextUsage): string {
	if (context.window <= 0) return `${formatTokens(context.used)} tokens`;
	return `${formatTokens(context.used)} / ${formatTokens(context.window)} tokens`;
}

export const COMPACT_PERCENT_MIN = 50;
export const COMPACT_PERCENT_MAX = 95;
export const DEFAULT_COMPACT_PERCENT = 80;

// Claude's own auto-compaction only fires once the window is genuinely full
// (measured across this machine's sessions: 999k to 1003k of 1M) and takes the
// best part of a minute. Compacting earlier, on a threshold you choose, keeps
// that off the end of a turn you were waiting on. Below 50% there is too little
// history to be worth summarising; above 95% Claude gets there first.
export function clampCompactPercent(raw: unknown): number {
	const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : DEFAULT_COMPACT_PERCENT;
	return Math.min(COMPACT_PERCENT_MAX, Math.max(COMPACT_PERCENT_MIN, n));
}

export function overCompactThreshold(context: ContextUsage, percent: number): boolean {
	if (context.window <= 0 || context.used <= 0) return false;
	return context.used / context.window >= percent / 100;
}

// What to keep when deck compacts a session. These are the handoff skill's
// headings: the same question ("what does the next context need to carry on?")
// gets the same answer, whether a human reads it or the session keeps going.
const COMPACT_INSTRUCTION =
	'Preserve, in this order: the goal; what is done; what is in progress and its current state; ' +
	'the next concrete steps; blockers and open questions; key files with their paths; ' +
	'decisions made and why; and the git state (branch, uncommitted work, recent commits). ' +
	'Keep file paths and identifiers exact.';

// The message deck sends to compact a session.
export function compactCommand(): string {
	return `/compact ${COMPACT_INSTRUCTION}`;
}
