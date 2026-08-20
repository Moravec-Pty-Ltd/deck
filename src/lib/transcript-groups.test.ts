import { describe, expect, it } from 'vitest';
import {
	chunkKeyFor,
	flattenTranscript,
	groupRuns,
	ungrouped,
	type AnyEvent,
	type Chunk
} from './transcript-groups';

const assistant = (...blocks: AnyEvent[]): AnyEvent => ({
	type: 'assistant',
	message: { content: blocks }
});
const tool = (name: string, id = name): AnyEvent => ({ type: 'tool_use', name, id });
const text = (t: string): AnyEvent => ({ type: 'text', text: t });
const thinking = (t: string): AnyEvent => ({ type: 'thinking', thinking: t });
const toolResult = (id: string): AnyEvent => ({
	type: 'user',
	message: { content: [{ type: 'tool_result', tool_use_id: id }] }
});

function group(events: AnyEvent[], first = 0): Chunk[] {
	return groupRuns(flattenTranscript(events, first));
}

function shape(chunks: Chunk[]): string[] {
	return chunks.map((c) =>
		c.kind === 'run' ? `run:${c.count}` : (c.row.block?.type ?? c.row.event.type)
	);
}

describe('flattenTranscript', () => {
	it('drops what renders nothing so it cannot split a run', () => {
		const rows = flattenTranscript(
			[
				assistant(tool('Bash', 'a')),
				toolResult('a'),
				{ type: 'system', subtype: 'init' },
				assistant(text('   '), thinking(''), tool('Read', 'b'))
			],
			0
		);
		expect(rows.map((r) => r.tool)).toEqual(['Bash', 'Read']);
	});

	it('keys rows by absolute index so widening the window reuses them', () => {
		const events = [assistant(tool('Bash', 'a')), { type: 'result', total_cost_usd: 1 }];
		expect(flattenTranscript(events, 40).map((r) => r.key)).toEqual(['40:0', '41']);
		// The same events one row further into a longer window keep row-to-key sync.
		expect(flattenTranscript(events, 41).map((r) => r.key)).toEqual(['41:0', '42']);
	});
});

describe('groupRuns', () => {
	it('condenses a run that spans several events', () => {
		const chunks = group([
			assistant(text('on it')),
			assistant(tool('Bash', 'a')),
			assistant(tool('Bash', 'b')),
			toolResult('a'),
			toolResult('b'),
			assistant(thinking('hmm')),
			assistant(tool('Read', 'c')),
			toolResult('c'),
			assistant(text('done'))
		]);
		expect(shape(chunks)).toEqual(['text', 'run:3', 'text']);
		const run = chunks[1];
		if (run.kind !== 'run') throw new Error('expected a run');
		expect(run.tools).toEqual(['Bash', 'Read']);
		expect(run.rows).toHaveLength(4); // the thinking rides along
		expect(run.key).toBe('1:0'); // first row of the run
	});

	it('breaks a run on replies, user messages, errors, markers, and cost lines', () => {
		for (const boundary of [
			{ type: 'deck.user', text: 'stop' },
			{ type: 'deck.error', text: 'boom' },
			{ type: 'deck.model', model: 'opus' },
			{ type: 'deck.effort', effort: 'high' },
			{ type: 'result', total_cost_usd: 1 },
			assistant(text('a word'))
		]) {
			const chunks = group([
				assistant(tool('Bash', 'a'), tool('Bash', 'b')),
				boundary,
				assistant(tool('Read', 'c'), tool('Read', 'd'))
			]);
			expect(shape(chunks)).toHaveLength(3);
			expect(shape(chunks)[0]).toBe('run:2');
			expect(shape(chunks)[2]).toBe('run:2');
		}
	});

	it('never condenses an ask, and breaks the run around it', () => {
		const chunks = group([
			assistant(tool('Bash', 'a'), tool('Bash', 'b')),
			assistant(tool('mcp__deck__ask', 'q')),
			assistant(tool('Bash', 'c'), tool('Bash', 'd'))
		]);
		expect(shape(chunks)).toEqual(['run:2', 'tool_use', 'run:2']);
		expect(chunks[1].kind === 'row' && chunks[1].row.block?.name).toBe('mcp__deck__ask');
	});

	it('leaves a single call as the call itself', () => {
		const chunks = group([assistant(thinking('hmm')), assistant(tool('Bash', 'a'))]);
		expect(shape(chunks)).toEqual(['thinking', 'tool_use']);
	});

	it('leaves thinking alone when no call follows it', () => {
		expect(shape(group([assistant(thinking('hmm'))]))).toEqual(['thinking']);
	});
});

describe('chunkKeyFor', () => {
	const events = [
		assistant(text('on it')),
		assistant(tool('Bash', 'a'), tool('Read', 'b')),
		assistant(text('done'))
	];

	it('finds the run a row was folded into', () => {
		const rows = flattenTranscript(events, 0);
		expect(chunkKeyFor(groupRuns(rows), '1:1')).toBe('1:0');
		expect(chunkKeyFor(ungrouped(rows), '1:1')).toBe('1:1');
	});

	it('returns null for a row outside the window', () => {
		expect(chunkKeyFor(group(events), '99')).toBeNull();
	});
});
