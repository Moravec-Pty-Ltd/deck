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
	MAX_PER_MINUTE,
	MAX_WRONG_CODES,
	mayRequest,
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
		const list = addPairing([stale], fresh, PAIR_TTL_MS + 1)!;
		expect(list.map((x) => x.id)).toEqual(['fresh']);
	});

	it('refuses a new request when full, keeping the ones waiting', () => {
		let list: Pairing[] = [];
		for (let i = 0; i < MAX_PENDING; i++) list = addPairing(list, p({ id: `p${i}`, secret: `s${i}` }, 1000), 1000)!;
		expect(addPairing(list, p({ id: 'extra' }, 2000), 2000)).toBeNull();
		expect(addPairing(list, p({ id: 'later' }, PAIR_TTL_MS + 1001), PAIR_TTL_MS + 1001)).toHaveLength(1);
	});
});

it('allows only so many requests a minute', () => {
	const recent = Array.from({ length: MAX_PER_MINUTE }, () => 1000);
	expect(mayRequest(recent.slice(1), 2000)).toBe(true);
	expect(mayRequest(recent, 2000)).toBe(false);
	expect(mayRequest(recent, 61_000)).toBe(true);
});

describe('decide', () => {
	const right = { code: '000000' };

	it('approves with the code, and denies without one', () => {
		const approved = decide([p({ id: 'a' })], 'a', right, 1000);
		expect(approved).toMatchObject({ result: 'ok', status: 'approved' });
		expect(approved.list[0].status).toBe('approved');
		expect(decide([p({ id: 'a' })], 'a', null, 1000).list[0].status).toBe('denied');
	});

	it('refuses a wrong code and denies after too many', () => {
		let list = [p({ id: 'a' })];
		for (let i = 1; i < MAX_WRONG_CODES; i++) {
			const r = decide(list, 'a', { code: '' }, 1000);
			expect(r).toMatchObject({ result: 'wrong-code', status: 'pending' });
			list = r.list;
		}
		expect(decide(list, 'a', right, 1000).result).toBe('ok');
		const last = decide(list, 'a', { code: '111111' }, 1000);
		expect(last).toMatchObject({ result: 'wrong-code', status: 'denied' });
		expect(decide(last.list, 'a', right, 1000).result).toBe('gone');
	});

	it('is gone when unknown, already decided or expired', () => {
		expect(decide([p({ id: 'a' })], 'nope', right, 1000).result).toBe('gone');
		expect(decide([p({ id: 'a', status: 'approved' })], 'a', null, 1000).result).toBe('gone');
		expect(decide([p({ id: 'a' }, 0)], 'a', right, PAIR_TTL_MS + 1).result).toBe('gone');
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
