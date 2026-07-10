// Aggregate a session's per-turn `result` events into one running total (cost,
// turns, duration). Every agent harness (claude/pi/codex/opencode) emits a
// `result` per turn carrying that turn's own figures, so the session total is
// their sum. (Verified empirically for claude's long-lived stream: successive
// results' total_cost_usd frequently drops, so it's per-turn, not cumulative.)
//
// Node-free so the server (base over the full transcript) and the client
// (folding live results on top of that base) share one implementation.

export interface CostSummary {
	costUsd: number;
	turns: number;
	durationMs: number;
	results: number;
}

export function emptyCostSummary(): CostSummary {
	return { costUsd: 0, turns: 0, durationMs: 0, results: 0 };
}

function num(v: unknown): number {
	return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// Fold one event into the running summary. Non-`result` events pass through
// unchanged, so callers can fold a raw event stream without pre-filtering.
export function foldResult(sum: CostSummary, event: unknown): CostSummary {
	const e = event as { type?: unknown; total_cost_usd?: unknown; num_turns?: unknown; duration_ms?: unknown };
	if (!e || e.type !== 'result') return sum;
	return {
		costUsd: sum.costUsd + num(e.total_cost_usd),
		// num_turns is per-result; fall back to counting the result as one turn
		// when it's absent or non-finite, so a bad value can't make turns NaN.
		turns: sum.turns + (Number.isFinite(e.num_turns) ? (e.num_turns as number) : 1),
		durationMs: sum.durationMs + num(e.duration_ms),
		results: sum.results + 1
	};
}

export function sessionCostSummary(events: Iterable<unknown>): CostSummary {
	let sum = emptyCostSummary();
	for (const e of events) sum = foldResult(sum, e);
	return sum;
}

// Compact duration for a session total: seconds under a minute, else m/s, else
// h/m. A per-turn footer shows tenths of a second, but a whole-session total is
// better read as `4m 18s` than `258.0s`.
export function formatDuration(ms: number): string {
	const totalSec = Math.max(0, Math.round(ms / 1000));
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

// e.g. `$0.42 · 12 turns · 4m 18s`. Like the per-turn footer, only segments the
// session actually has are shown: harnesses that report no cost (pi/codex/
// opencode often report $0) drop the `$` segment, and a missing duration drops
// its segment rather than showing `0s`.
export function formatCostSummary(sum: CostSummary): string {
	const parts: string[] = [];
	if (sum.costUsd > 0) parts.push(`$${sum.costUsd.toFixed(2)}`);
	parts.push(`${sum.turns} ${sum.turns === 1 ? 'turn' : 'turns'}`);
	if (sum.durationMs > 0) parts.push(formatDuration(sum.durationMs));
	return parts.join(' · ');
}
