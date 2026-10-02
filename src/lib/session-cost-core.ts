// Aggregate a session's `result` events into one running total (cost, turns,
// duration). `num_turns` and `duration_ms` are each that result's own figures,
// so the session total is their sum. `total_cost_usd` is not, and that is the
// whole subtlety here.
//
// claude's CLI reports `total_cost_usd` as the *running total of its process*,
// so summing it re-adds every earlier turn and the session total grows with the
// square of its length. One real 155-result session read $48,756 against a true
// $713. What counts is the increment between consecutive results.
//
// The counter restarts at zero whenever deck respawns the process. `--resume`
// keeps the same `session_id` across a respawn, and `result_index` resets per
// prompt, so neither marks the boundary: the value falling is the only signal
// there is. A fall therefore means the whole value is new spend.
//
// The other harnesses (pi/codex/opencode) synthesize a result per turn carrying
// that turn's own cost (see server/agents/events.ts), which is already an
// increment, so those are summed as before. They are told apart by the usage
// figures only claude's CLI emits.
//
// Node-free so the server (base over the full transcript) and the client
// (folding live results on top of that base) share one implementation.

export interface CostSummary {
	costUsd: number;
	turns: number;
	durationMs: number;
	results: number;
	// The last running total claude reported, so the next result can be folded
	// as an increment. Part of the summary rather than a fold-local variable
	// because the client resumes folding from a server-computed base.
	lastReportedCost: number;
}

export function emptyCostSummary(): CostSummary {
	return { costUsd: 0, turns: 0, durationMs: 0, results: 0, lastReportedCost: 0 };
}

function num(v: unknown): number {
	return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

interface ResultEvent {
	type?: unknown;
	total_cost_usd?: unknown;
	num_turns?: unknown;
	duration_ms?: unknown;
	usage?: unknown;
	modelUsage?: unknown;
}

// Whether this came from claude's CLI, whose `total_cost_usd` is cumulative.
// Our own synthesized results carry no usage breakdown, so its presence is the
// tell; a harness that grows one would also have to report cost the same way.
function isCumulative(e: ResultEvent): boolean {
	return e.usage !== undefined || e.modelUsage !== undefined;
}

// What one result adds to the session total.
function costAdded(e: ResultEvent, lastReported: number): number {
	const reported = num(e.total_cost_usd);
	if (!isCumulative(e)) return reported;
	// A rise is this turn's spend. A fall means the process restarted with its
	// counter back at zero, so all of it is new. The one case this reads low is
	// a restarted run whose first result already exceeds the previous run's
	// last; undercounting there beats re-adding the whole history.
	return reported >= lastReported ? reported - lastReported : reported;
}

// Fold one event into the running summary. Non-`result` events pass through
// unchanged, so callers can fold a raw event stream without pre-filtering.
export function foldResult(sum: CostSummary, event: unknown): CostSummary {
	const e = event as ResultEvent;
	if (!e || e.type !== 'result') return sum;
	return {
		costUsd: sum.costUsd + costAdded(e, sum.lastReportedCost),
		lastReportedCost: isCumulative(e) ? num(e.total_cost_usd) : sum.lastReportedCost,
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
