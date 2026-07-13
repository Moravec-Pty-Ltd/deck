import { describe, it, expect } from 'vitest';
import type { DeckSession } from '$lib/types';
import type { SessionGroup } from '$lib/groups';
import type { StatusBucket, StatusBucketKey } from '$lib/status-groups';
import { flattenVisibleGroups, flattenVisibleBuckets, pickNeighbor } from './sidebar-neighbor';

function session(id: string): DeckSession {
	return { id, kind: 'claude', title: id, cwd: '/x', createdAt: 0, lastActiveAt: 0, status: 'idle' };
}

function subgroup(key: string, ...ids: string[]) {
	return { key, label: key, sessions: ids.map(session), lastActiveAt: 0 };
}

function group(name: string, ...subgroups: ReturnType<typeof subgroup>[]): SessionGroup {
	return { name, subgroups, sessionCount: subgroups.reduce((n, s) => n + s.sessions.length, 0) };
}

function bucket(key: StatusBucketKey, ...ids: string[]): StatusBucket {
	return { key, label: key, sessions: ids.map(session) };
}

describe('flattenVisibleGroups', () => {
	const groups = [
		group('A', subgroup('a1', 'a', 'b'), subgroup('a2', 'c')),
		group('B', subgroup('b1', 'd'))
	];

	it('flattens groups -> subgroups -> sessions in render order when all expanded', () => {
		expect(flattenVisibleGroups(groups, () => true).map((s) => s.id)).toEqual(['a', 'b', 'c', 'd']);
	});

	it('skips sessions inside collapsed groups', () => {
		expect(flattenVisibleGroups(groups, (n) => n === 'B').map((s) => s.id)).toEqual(['d']);
	});
});

describe('flattenVisibleBuckets', () => {
	const buckets = [bucket('needs-attention', 'x'), bucket('active', 'y', 'z'), bucket('idle', 'w')];

	it('flattens open buckets in render order', () => {
		expect(flattenVisibleBuckets(buckets, () => false).map((s) => s.id)).toEqual(['x', 'y', 'z', 'w']);
	});

	it('skips sessions inside collapsed buckets', () => {
		expect(flattenVisibleBuckets(buckets, (k) => k === 'active').map((s) => s.id)).toEqual(['x', 'w']);
	});
});

describe('pickNeighbor', () => {
	const order = ['a', 'b', 'c'].map(session);

	it('picks the row immediately below', () => {
		expect(pickNeighbor(order, 'b')?.id).toBe('c');
	});

	it('falls back to the row above when removing the last row', () => {
		expect(pickNeighbor(order, 'c')?.id).toBe('b');
	});

	it('returns null when it was the only row', () => {
		expect(pickNeighbor([session('solo')], 'solo')).toBeNull();
	});

	it('returns null when the id is not visible', () => {
		expect(pickNeighbor(order, 'missing')).toBeNull();
	});

	it('crosses group boundaries (neighbor is whatever is visually adjacent)', () => {
		// The flattened order already crosses group/bucket boundaries, so the row
		// below the last session of one group is the first session of the next.
		const flat = flattenVisibleGroups(
			[group('A', subgroup('a1', 'a')), group('B', subgroup('b1', 'b'))],
			() => true
		);
		expect(pickNeighbor(flat, 'a')?.id).toBe('b');
	});
});
