// Two lookups the session view needs while rendering: tool_use_id → tool_result
// block, and ask tool_use id → chosen answers. The view folds events into these
// maps incrementally as they stream in, instead of re-deriving both over the
// whole transcript on every event (O(n) per event janks long sessions).

type AnyEvent = Record<string, any>;

export type Answer = { header: string; labels: string[] };

export type IndexMaps = {
	results: Map<string, AnyEvent>;
	answered: Map<string, Answer[]>;
};

function isToolResultBlock(block: AnyEvent): boolean {
	return block.type === 'tool_result' && Boolean(block.tool_use_id);
}

// tool_use_id → tool_result block pairs an event carries. Only `user` events
// hold tool_result blocks; anything else contributes nothing.
export function toolResultsIn(ev: AnyEvent): Array<[string, AnyEvent]> {
	if (ev.type !== 'user') return [];
	const content = ev.message?.content;
	if (!Array.isArray(content)) return [];
	return content
		.filter(isToolResultBlock)
		.map((block) => [block.tool_use_id, block] as [string, AnyEvent]);
}

const ANSWER_TYPES = new Set(['deck.answer', 'deck.user']);

// The answer payload an event records against an open ask tool call, keyed by
// the tool_use id it answers (`answersFor`). Null when the event answers nothing.
export function answerIn(ev: AnyEvent): { id: string; answers: Answer[] } | null {
	if (!ANSWER_TYPES.has(ev.type)) return null;
	if (!ev.answersFor) return null;
	return { id: ev.answersFor, answers: ev.answers ?? [] };
}

// Fold a newly-arrived event into the maps, newest-wins. Used for the forward
// stream and for rebuilding from a snapshot in transcript order.
export function indexForward(maps: IndexMaps, ev: AnyEvent) {
	for (const [id, block] of toolResultsIn(ev)) maps.results.set(id, block);
	const ans = answerIn(ev);
	if (ans) maps.answered.set(ans.id, ans.answers);
}

// Fold one older event without overwriting an id already present (it came from
// a newer event, which must win).
function indexOlder(maps: IndexMaps, ev: AnyEvent) {
	for (const [id, block] of toolResultsIn(ev)) if (!maps.results.has(id)) maps.results.set(id, block);
	const ans = answerIn(ev);
	if (ans && !maps.answered.has(ans.id)) maps.answered.set(ans.id, ans.answers);
}

// Fold a contiguous batch of older events (history pulled in after the fact)
// into the maps. Iterating newest-first means that within the batch the newest
// event wins on a duplicate id, while keep-existing protects even-newer entries
// already in the maps. The result equals a front-to-back rebuild of the whole
// transcript, regardless of the order rows actually loaded in.
export function indexOlderBatch(maps: IndexMaps, events: AnyEvent[]) {
	for (let i = events.length - 1; i >= 0; i--) indexOlder(maps, events[i]);
}
