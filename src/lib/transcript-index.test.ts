import { describe, it, expect } from 'vitest';
import {
	toolResultsIn,
	answerIn,
	indexForward,
	indexOlderBatch,
	type Answer,
	type IndexMaps
} from './transcript-index';

const userResult = (...blocks: Record<string, any>[]) => ({
	type: 'user',
	message: { content: blocks }
});
const result = (id: string, extra: Record<string, any> = {}) => ({
	type: 'tool_result',
	tool_use_id: id,
	...extra
});
const emptyMaps = (): IndexMaps => ({ results: new Map(), answered: new Map() });

describe('toolResultsIn', () => {
	it('pairs each tool_result block by its tool_use_id', () => {
		const ev = userResult(result('a', { content: 'A' }), result('b', { content: 'B' }));
		expect(toolResultsIn(ev)).toEqual([
			['a', result('a', { content: 'A' })],
			['b', result('b', { content: 'B' })]
		]);
	});

	it('ignores non-user events', () => {
		expect(toolResultsIn({ type: 'assistant', message: { content: [result('a')] } })).toEqual([]);
	});

	it('ignores user events whose content is not an array', () => {
		expect(toolResultsIn({ type: 'user', message: { content: 'hi' } })).toEqual([]);
		expect(toolResultsIn({ type: 'user' })).toEqual([]);
	});

	it('skips non-result blocks and results missing a tool_use_id', () => {
		const ev = userResult({ type: 'text', text: 'hi' }, { type: 'tool_result' }, result('ok'));
		expect(toolResultsIn(ev)).toEqual([['ok', result('ok')]]);
	});
});

describe('answerIn', () => {
	const answers: Answer[] = [{ header: 'Pick', labels: ['Yes'] }];

	it('reads the answer payload from a deck.answer event', () => {
		expect(answerIn({ type: 'deck.answer', answersFor: 't1', answers })).toEqual({
			id: 't1',
			answers
		});
	});

	it('reads the answer payload from a deck.user event', () => {
		expect(answerIn({ type: 'deck.user', answersFor: 't2', answers })).toEqual({
			id: 't2',
			answers
		});
	});

	it('defaults answers to an empty array when absent', () => {
		expect(answerIn({ type: 'deck.answer', answersFor: 't3' })).toEqual({ id: 't3', answers: [] });
	});

	it('returns null for unrelated events or missing answersFor', () => {
		expect(answerIn({ type: 'assistant', answersFor: 't4', answers })).toBeNull();
		expect(answerIn({ type: 'deck.answer', answers })).toBeNull();
	});
});

describe('incremental folding matches a full rebuild', () => {
	// The view maintains these maps incrementally; this proves folding
	// event-by-event yields the same maps as scanning the whole list, including
	// later entries overwriting earlier ones for the same id.
	const events = [
		{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'q1' }] } },
		userResult(result('q1', { content: 'first' })),
		{ type: 'deck.user', answersFor: 'ask1', answers: [{ header: 'H', labels: ['x'] }] },
		userResult(result('q1', { content: 'second' }), result('q2', { content: 'other' })),
		{ type: 'deck.answer', answersFor: 'ask1', answers: [{ header: 'H', labels: ['y'] }] }
	];

	const rebuild = (list: Record<string, any>[]) => {
		const maps = emptyMaps();
		for (const ev of list) indexForward(maps, ev);
		return maps;
	};

	it('produces identical maps whether folded forward or rebuilt at once', () => {
		const live = emptyMaps();
		for (let i = 0; i < events.length; i++) {
			indexForward(live, events[i]);
			const full = rebuild(events.slice(0, i + 1));
			expect([...live.results.entries()]).toEqual([...full.results.entries()]);
			expect([...live.answered.entries()]).toEqual([...full.answered.entries()]);
		}
	});

	it('keeps the latest result and answer for a repeated id', () => {
		const { results, answered } = rebuild(events);
		expect(results.get('q1')).toEqual(result('q1', { content: 'second' }));
		expect(answered.get('ask1')).toEqual([{ header: 'H', labels: ['y'] }]);
	});
});

describe('indexOlderBatch preserves newest-wins regardless of load order', () => {
	// loadOlder prepends older history after newer events are already indexed.
	// The batch must never clobber a newer entry, so the maps equal a single
	// front-to-back rebuild of the whole transcript.
	const older = [
		userResult(result('dup', { content: 'OLD' })),
		{ type: 'deck.answer', answersFor: 'ask', answers: [{ header: 'H', labels: ['old'] }] }
	];
	const newer = [
		userResult(result('dup', { content: 'NEW' }), result('only-new', { content: 'n' })),
		{ type: 'deck.user', answersFor: 'ask', answers: [{ header: 'H', labels: ['new'] }] }
	];

	it('older history fills gaps but does not overwrite newer ids', () => {
		const maps = emptyMaps();
		for (const ev of newer) indexForward(maps, ev); // newer arrives first (stream/snapshot)
		indexOlderBatch(maps, older); // older pulled in afterwards
		expect(maps.results.get('dup')).toEqual(result('dup', { content: 'NEW' }));
		expect(maps.results.get('only-new')).toEqual(result('only-new', { content: 'n' }));
		expect(maps.answered.get('ask')).toEqual([{ header: 'H', labels: ['new'] }]);
	});

	it('keeps the newest entry when an id repeats within the older batch', () => {
		// Two answers for the same id inside one fetched slice: the later (newer)
		// one must win, matching a front-to-back rebuild of that slice.
		const olderWithDup = [
			{ type: 'deck.user', answersFor: 'ask-dup', answers: [{ header: 'H', labels: ['old'] }] },
			{ type: 'deck.answer', answersFor: 'ask-dup', answers: [{ header: 'H', labels: ['newer'] }] }
		];
		const batch = emptyMaps();
		indexOlderBatch(batch, olderWithDup);
		const rebuilt = emptyMaps();
		for (const ev of olderWithDup) indexForward(rebuilt, ev);
		expect(batch.answered.get('ask-dup')).toEqual([{ header: 'H', labels: ['newer'] }]);
		expect(batch.answered.get('ask-dup')).toEqual(rebuilt.answered.get('ask-dup'));
	});

	it('matches a front-to-back rebuild of older ++ newer', () => {
		const incremental = emptyMaps();
		for (const ev of newer) indexForward(incremental, ev);
		indexOlderBatch(incremental, older);

		const rebuilt = emptyMaps();
		for (const ev of [...older, ...newer]) indexForward(rebuilt, ev);

		expect([...incremental.results.entries()].sort()).toEqual(
			[...rebuilt.results.entries()].sort()
		);
		expect([...incremental.answered.entries()].sort()).toEqual(
			[...rebuilt.answered.entries()].sort()
		);
	});
});
