import { describe, it, expect } from 'vitest';
import type { DeckSession, SessionKind } from '$lib/types';
import { flattenVisibleBuckets } from '$lib/sidebar-neighbor';
import { allSelected, rangeIds, staleIds } from './session-select';

function session(id: string, kind: SessionKind = 'claude'): DeckSession {
	return { id, kind, title: id, cwd: '/x', createdAt: 0, lastActiveAt: 0, status: 'idle' };
}

const order = ['a', 'b', 'c', 'd'].map((id) => session(id));

describe('rangeIds', () => {
	it('returns the run between the anchor and the clicked row, inclusive', () => {
		expect(rangeIds(order, 'b', 'd')).toEqual(['b', 'c', 'd']);
	});

	it('is direction-agnostic', () => {
		expect(rangeIds(order, 'd', 'b')).toEqual(['b', 'c', 'd']);
	});

	it('returns the single row when the anchor is the clicked row', () => {
		expect(rangeIds(order, 'c', 'c')).toEqual(['c']);
	});

	it('returns nothing when either end is off screen', () => {
		expect(rangeIds(order, 'gone', 'c')).toEqual([]);
		expect(rangeIds(order, 'c', 'gone')).toEqual([]);
	});
});

describe('staleIds', () => {
	it('reports ids the list no longer knows about, and only those', () => {
		expect(staleIds(['a', 'gone', 'c'], order)).toEqual(['gone']);
	});

	it('reports nothing for a selection the poll left untouched', () => {
		expect(staleIds(['a', 'b'], order)).toEqual([]);
	});

	it('reports the whole selection when every session is gone', () => {
		expect(staleIds(['a', 'b'], [])).toEqual(['a', 'b']);
	});

	it('reports rows the active filter hides, so the batch matches the list', () => {
		const sessions = [session('a', 'claude'), session('b', 'shell')];
		const visible = sessions.filter((s) => s.kind === 'claude');
		expect(staleIds(['a', 'b'], visible)).toEqual(['b']);
	});
});

describe('allSelected', () => {
	it('is true only once every visible row is picked', () => {
		expect(allSelected(order, new Set(['a', 'b', 'c']))).toBe(false);
		expect(allSelected(order, new Set(['a', 'b', 'c', 'd']))).toBe(true);
	});

	it('is false for an empty list', () => {
		expect(allSelected([], new Set())).toBe(false);
	});

	it('covers exactly the sessions visible under the active filter', () => {
		const sessions = [session('a', 'claude'), session('b', 'shell'), session('c', 'claude')];
		const visible = sessions.filter((s) => s.kind === 'claude');
		const order = flattenVisibleBuckets([{ key: 'idle', label: 'Idle', sessions: visible }], () => false);
		const selectAll = new Set(order.map((s) => s.id));

		expect([...selectAll]).toEqual(['a', 'c']);
		expect(allSelected(order, selectAll)).toBe(true);
		// The row the filter hides isn't picked, so it isn't in the batch either.
		expect(selectAll.has('b')).toBe(false);
	});

	it('ignores rows inside a collapsed section', () => {
		const order = flattenVisibleBuckets(
			[
				{ key: 'active', label: 'Active', sessions: [session('a')] },
				{ key: 'idle', label: 'Idle', sessions: [session('b')] }
			],
			(k) => k === 'idle'
		);

		expect(order.map((s) => s.id)).toEqual(['a']);
		expect(allSelected(order, new Set(['a']))).toBe(true);
	});
});
