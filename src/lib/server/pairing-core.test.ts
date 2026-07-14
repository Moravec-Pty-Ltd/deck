import { describe, it, expect } from 'vitest';
import {
	makePairing,
	isExpired,
	prune,
	activePending,
	codeInUse,
	addPairing,
	decide,
	consumeBySecret,
	PAIR_TTL_MS,
	MAX_PENDING,
	type Pairing
} from './pairing-core';

const p = (over: Partial<Pairing> = {}, now = 1000): Pairing => ({
	...makePairing({ id: 'id', secret: 'sec', code: '000000' }, now),
	...over
});

describe('makePairing', () => {
	it('starts pending with a TTL window', () => {
		const r = makePairing({ id: 'a', secret: 's', code: '123456' }, 1000);
		expect(r.status).toBe('pending');
		expect(r.createdAt).toBe(1000);
		expect(r.expiresAt).toBe(1000 + PAIR_TTL_MS);
	});
});

describe('isExpired / prune', () => {
	it('expires exactly at expiresAt', () => {
		const r = makePairing({ id: 'a', secret: 's', code: '1' }, 0);
		expect(isExpired(r, PAIR_TTL_MS - 1)).toBe(false);
		expect(isExpired(r, PAIR_TTL_MS)).toBe(true);
	});

	it('drops expired records regardless of status', () => {
		const live = p({ id: 'live' }, 1000);
		const stale = p({ id: 'stale', status: 'approved' }, 0);
		const list = prune([live, stale], PAIR_TTL_MS + 1);
		expect(list.map((x) => x.id)).toEqual(['live']);
	});
});

describe('activePending / codeInUse', () => {
	it('only lists live pending requests', () => {
		const list = [
			p({ id: 'a', status: 'pending' }, 1000),
			p({ id: 'b', status: 'approved' }, 1000),
			p({ id: 'c', status: 'pending' }, 0) // expired at now below
		];
		const now = PAIR_TTL_MS + 500;
		expect(activePending(list, now).map((x) => x.id)).toEqual(['a']);
	});

	it('codeInUse ignores expired holders of the same code', () => {
		const list = [p({ id: 'old', code: '424242' }, 0)];
		expect(codeInUse(list, '424242', 1000)).toBe(true);
		expect(codeInUse(list, '424242', PAIR_TTL_MS + 1)).toBe(false);
	});
});

describe('addPairing', () => {
	it('prunes expired before appending', () => {
		const stale = p({ id: 'stale' }, 0);
		const fresh = p({ id: 'fresh' }, PAIR_TTL_MS + 1);
		const list = addPairing([stale], fresh, PAIR_TTL_MS + 1);
		expect(list.map((x) => x.id)).toEqual(['fresh']);
	});

	it('evicts the oldest live request when at the cap', () => {
		let list: Pairing[] = [];
		for (let i = 0; i < MAX_PENDING; i++) {
			list = addPairing(list, p({ id: `p${i}`, secret: `s${i}` }, 1000 + i), 1000 + i);
		}
		expect(list).toHaveLength(MAX_PENDING);
		const extra = p({ id: 'newest', secret: 'sx' }, 2000);
		list = addPairing(list, extra, 2000);
		expect(list).toHaveLength(MAX_PENDING);
		expect(list.map((x) => x.id)).not.toContain('p0'); // oldest evicted
		expect(list.map((x) => x.id)).toContain('newest');
	});
});

describe('decide', () => {
	it('approves a live pending request', () => {
		const { list, changed } = decide([p({ id: 'a' })], 'a', 'approved', 1000);
		expect(changed).toBe(true);
		expect(list[0].status).toBe('approved');
	});

	it('is a no-op for an unknown id', () => {
		const { changed } = decide([p({ id: 'a' })], 'nope', 'approved', 1000);
		expect(changed).toBe(false);
	});

	it('is a no-op once already decided', () => {
		const { changed } = decide([p({ id: 'a', status: 'approved' })], 'a', 'denied', 1000);
		expect(changed).toBe(false);
	});

	it('is a no-op for an expired request', () => {
		const { changed } = decide([p({ id: 'a' }, 0)], 'a', 'approved', PAIR_TTL_MS + 1);
		expect(changed).toBe(false);
	});
});

describe('consumeBySecret (single-use)', () => {
	it('returns pending while undecided, without consuming', () => {
		const list = [p({ secret: 'sec' })];
		const r = consumeBySecret(list, 'sec', 1000);
		expect(r.result).toBe('pending');
		expect(r.list).toHaveLength(1);
	});

	it('returns approved once, then unknown (single-use)', () => {
		const list = [p({ secret: 'sec', status: 'approved' })];
		const first = consumeBySecret(list, 'sec', 1000);
		expect(first.result).toBe('approved');
		expect(first.list).toHaveLength(0);
		const second = consumeBySecret(first.list, 'sec', 1000);
		expect(second.result).toBe('unknown');
	});

	it('consumes a denied request too', () => {
		const list = [p({ secret: 'sec', status: 'denied' })];
		const r = consumeBySecret(list, 'sec', 1000);
		expect(r.result).toBe('denied');
		expect(r.list).toHaveLength(0);
	});

	it('reports expired for a stale request', () => {
		const list = [p({ secret: 'sec', status: 'approved' }, 0)];
		const r = consumeBySecret(list, 'sec', PAIR_TTL_MS + 1);
		expect(r.result).toBe('expired');
	});

	it('reports unknown for an unrecognised secret', () => {
		expect(consumeBySecret([p({ secret: 'sec' })], 'other', 1000).result).toBe('unknown');
	});
});
