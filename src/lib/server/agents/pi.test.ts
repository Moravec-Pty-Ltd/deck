import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DeckEvent, TurnContext } from './types';
import { piDriver } from './pi';

// Recorded from `pi -p --mode json`: three bash calls, then a reply. Streaming
// deltas are trimmed, and only the turn_end costs were edited (to 0.01..0.04) so
// the sum is visible; the message costs elsewhere still read 0.
const recorded = readFileSync(new URL('./fixtures/pi-three-tools.jsonl', import.meta.url), 'utf8')
	.trim()
	.split('\n')
	.map((l) => JSON.parse(l));

function run(lines: Record<string, unknown>[]) {
	const appended: DeckEvent[] = [];
	const c: TurnContext = { append: (e) => appended.push(e), emit: () => {}, setAgentSessionId: () => {} };
	for (const line of lines) piDriver.handleLine(line, c);
	return appended;
}

function expectOneResultAtEnd(appended: DeckEvent[], cost: number) {
	const results = appended.filter((e) => e.type === 'result');
	expect(results).toHaveLength(1);
	expect(appended.at(-1)).toBe(results[0]);
	expect(results[0].total_cost_usd).toBeCloseTo(cost);
}

describe('piDriver.handleLine', () => {
	it('emits one result per prompt, at the end, with the summed cost', () => {
		const appended = run(recorded);
		expectOneResultAtEnd(appended, 0.1);
	});

	it('attaches each tool result to its call', () => {
		const appended = run(recorded);
		const callIds = appended.flatMap((e) =>
			((e.message as { content?: { type: string; id: string }[] })?.content ?? [])
				.filter((b) => b.type === 'tool_use')
				.map((b) => b.id)
		);
		const resultIds = appended.flatMap((e) =>
			((e.message as { content?: { type: string; tool_use_id: string }[] })?.content ?? [])
				.filter((b) => b.type === 'tool_result')
				.map((b) => b.tool_use_id)
		);
		expect(callIds).toHaveLength(3);
		expect(resultIds).toEqual(callIds);
	});

	it('holds the footer through a retried run and sums both runs', () => {
		const step = (total: number) => ({ type: 'turn_end', message: { usage: { cost: { total } } } });
		const appended = run([
			step(0.2),
			{ type: 'agent_end', willRetry: true },
			step(0.3),
			{ type: 'agent_end', willRetry: false }
		]);
		expectOneResultAtEnd(appended, 0.5);
	});
});
