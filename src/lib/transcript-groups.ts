// Render-time grouping for the condensed Chat tab (issue #216). Pure: no DOM and
// no runes. Both tabs render the rows this module produces, so the flattening
// here is the single description of what the transcript paints; Chat only differs
// in that runs of tool calls collapse to one line.

export type AnyEvent = Record<string, any>;

// One rendered thing, in transcript order. Tool calls and thinking arrive as
// blocks inside assistant events; everything else is a whole event.
export type Row = {
	key: string;
	event: AnyEvent;
	block?: AnyEvent;
	// Whether this row can live inside a condensed run: tool calls, plus the
	// thinking between them (thinking is work, not prose, and appears between
	// almost every pair of calls).
	runnable: boolean;
	tool?: string;
};

export type Chunk =
	| { kind: 'row'; key: string; row: Row }
	| { kind: 'run'; key: string; rows: Row[]; count: number; tools: string[] };

export function isAskTool(block: AnyEvent): boolean {
	return block.name === 'mcp__deck__ask' || block.name === 'AskUserQuestion';
}

const EVENT_ROWS = new Set(['deck.user', 'deck.error', 'deck.model', 'deck.effort', 'result']);

// The row an assistant content block paints, or null when it paints nothing (an
// empty text or thinking block).
function blockRow(event: AnyEvent, block: AnyEvent, key: string): Row | null {
	if (block.type === 'text') {
		return block.text?.trim() ? { key, event, block, runnable: false } : null;
	}
	if (block.type === 'thinking') {
		return block.thinking?.trim() ? { key, event, block, runnable: true } : null;
	}
	if (block.type !== 'tool_use') return null;
	// An ask is how a blocked session gets answered, so it never condenses.
	const ask = isAskTool(block);
	return { key, event, block, runnable: !ask, tool: ask ? undefined : block.name };
}

// Flatten the visible window into the rows the transcript actually paints.
// Anything that renders nothing (the tool_result `user` events between two calls,
// empty text) is dropped here so it can't split a run. `first` is the absolute
// index of events[0]; keys are absolute so widening the window or prepending
// older history keeps the same key on the same row.
export function flattenTranscript(events: AnyEvent[], first: number): Row[] {
	const rows: Row[] = [];
	for (let i = 0; i < events.length; i++) {
		const event = events[i];
		const key = String(first + i);
		if (EVENT_ROWS.has(event.type)) {
			rows.push({ key, event, runnable: false });
			continue;
		}
		if (event.type !== 'assistant') continue;
		const content = event.message?.content;
		if (!Array.isArray(content)) continue;
		for (let j = 0; j < content.length; j++) {
			const row = blockRow(event, content[j], `${key}:${j}`);
			if (row) rows.push(row);
		}
	}
	return rows;
}

// Collapse each maximal run of tool calls into one chunk. A run holding a single
// call stays as it is: a summary line wrapping one call reads worse than the call.
export function groupRuns(rows: Row[]): Chunk[] {
	const chunks: Chunk[] = [];
	let run: Row[] = [];

	function flush() {
		if (!run.length) return;
		const calls = run.filter((r) => r.tool);
		if (calls.length > 1) {
			chunks.push({
				kind: 'run',
				key: run[0].key,
				rows: run,
				count: calls.length,
				tools: [...new Set(calls.map((r) => r.tool as string))]
			});
		} else {
			for (const row of run) chunks.push({ kind: 'row', key: row.key, row });
		}
		run = [];
	}

	for (const row of rows) {
		if (row.runnable) {
			run.push(row);
			continue;
		}
		flush();
		chunks.push({ kind: 'row', key: row.key, row });
	}
	flush();
	return chunks;
}

export function ungrouped(rows: Row[]): Chunk[] {
	return rows.map((row) => ({ kind: 'row', key: row.key, row }));
}

// The chunk a row ended up in, so the reader's place survives a Thread <-> Chat
// switch: the row they were anchored on may now be inside a collapsed run.
export function chunkKeyFor(chunks: Chunk[], rowKey: string): string | null {
	for (const chunk of chunks) {
		if (chunk.kind === 'row') {
			if (chunk.key === rowKey) return chunk.key;
		} else if (chunk.rows.some((r) => r.key === rowKey)) {
			return chunk.key;
		}
	}
	return null;
}
