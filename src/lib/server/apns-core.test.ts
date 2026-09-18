import { describe, it, expect } from 'vitest';
import {
	upsertDevice,
	removeDevice,
	MAX_DEVICES,
	base64urlEncodeBytes,
	base64urlEncodeString,
	buildJwtHeader,
	buildJwtClaims,
	signingInput,
	assembleJwt,
	shouldRegenerateJwt,
	JWT_REUSE_MS,
	deriveTopic,
	toApnsPayload,
	registerDeviceSchema,
	type ApnsDevice
} from './apns-core';

const device = (over: Partial<ApnsDevice> = {}): ApnsDevice => ({
	token: 'tok',
	platform: 'ios',
	env: 'production',
	addedAt: 1000,
	...over
});

function decodeSegment(segment: string): unknown {
	// Segments are unpadded base64url; re-pad and swap the URL-safe alphabet
	// back before handing to node's base64 decoder.
	const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
	const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
	return JSON.parse(Buffer.from(padded + pad, 'base64').toString('utf8'));
}

describe('upsertDevice', () => {
	it('dedupes by token', () => {
		const list = upsertDevice(upsertDevice([], device()), device({ env: 'development' }));
		expect(list).toHaveLength(1);
		expect(list[0].env).toBe('development');
	});

	it('caps the list, keeping the newest', () => {
		let list: ApnsDevice[] = [];
		for (let i = 0; i < 30; i++) list = upsertDevice(list, device({ token: `t${i}`, addedAt: i }));
		expect(list).toHaveLength(MAX_DEVICES);
		expect(list[0].token).toBe('t10');
		expect(list.at(-1)?.token).toBe('t29');
	});
});

describe('removeDevice', () => {
	it('removes by token, leaving others untouched', () => {
		const list = [device({ token: 'a' }), device({ token: 'b' })];
		expect(removeDevice(list, 'a').map((d) => d.token)).toEqual(['b']);
	});

	it('is a no-op for an unknown token', () => {
		const list = [device({ token: 'a' })];
		expect(removeDevice(list, 'nope')).toEqual(list);
	});
});

describe('base64url encoding', () => {
	it('produces no padding and swaps the URL-unsafe characters', () => {
		// "??" -> base64 "Pz8=" has both padding and none of the swapped chars, so
		// exercise a byte sequence that actually needs +/ to prove the swap fires.
		const bytes = new Uint8Array([0xfb, 0xff, 0xfe]);
		const encoded = base64urlEncodeBytes(bytes);
		expect(encoded).not.toContain('+');
		expect(encoded).not.toContain('/');
		expect(encoded).not.toContain('=');
	});

	it('round-trips a UTF-8 string', () => {
		const encoded = base64urlEncodeString('{"alg":"ES256"}');
		expect(decodeSegment(encoded)).toEqual({ alg: 'ES256' });
	});
});

describe('JWT assembly', () => {
	it('builds the expected header and claims shape', () => {
		expect(buildJwtHeader('KEY123')).toEqual({ alg: 'ES256', kid: 'KEY123' });
		expect(buildJwtClaims('TEAM456', 1700000000)).toEqual({ iss: 'TEAM456', iat: 1700000000 });
	});

	it('signingInput is two dot-separated base64url segments decoding to header/claims', () => {
		const header = buildJwtHeader('KEY123');
		const claims = buildJwtClaims('TEAM456', 1700000000);
		const input = signingInput(header, claims);
		const parts = input.split('.');
		expect(parts).toHaveLength(2);
		expect(decodeSegment(parts[0])).toEqual(header);
		expect(decodeSegment(parts[1])).toEqual(claims);
	});

	it('assembleJwt signs the signing input and appends the signature as a third segment', () => {
		const header = buildJwtHeader('KEY123');
		const claims = buildJwtClaims('TEAM456', 1700000000);
		let signedInput: string | undefined;
		const jwt = assembleJwt(header, claims, (input) => {
			signedInput = input;
			return 'FAKESIG';
		});
		const parts = jwt.split('.');
		expect(parts).toHaveLength(3);
		expect(parts[2]).toBe('FAKESIG');
		expect(signedInput).toBe(`${parts[0]}.${parts[1]}`);
	});
});

describe('shouldRegenerateJwt', () => {
	it('regenerates when there is no cached token', () => {
		expect(shouldRegenerateJwt(null, 1000)).toBe(true);
	});

	it('reuses at exactly the 45-minute boundary', () => {
		expect(shouldRegenerateJwt(0, JWT_REUSE_MS)).toBe(false);
	});

	it('regenerates just past the 45-minute boundary', () => {
		expect(shouldRegenerateJwt(0, JWT_REUSE_MS + 1)).toBe(true);
	});

	it('reuses well within the window', () => {
		expect(shouldRegenerateJwt(0, JWT_REUSE_MS - 1)).toBe(false);
	});
});

describe('deriveTopic', () => {
	it('ios uses the base topic unchanged', () => {
		expect(deriveTopic('tech.moravec.deck', 'ios')).toBe('tech.moravec.deck');
	});

	it('watchos appends .watchkitapp', () => {
		expect(deriveTopic('tech.moravec.deck', 'watchos')).toBe('tech.moravec.deck.watchkitapp');
	});

	it('respects a configurable base topic', () => {
		expect(deriveTopic('com.example.app', 'watchos')).toBe('com.example.app.watchkitapp');
	});
});

describe('toApnsPayload', () => {
	it('maps all fields when present', () => {
		expect(toApnsPayload({ title: 'Hi', body: 'there', url: '/s/1', tag: 'deck-ask' })).toEqual({
			aps: { alert: { title: 'Hi', body: 'there' }, sound: 'default', 'thread-id': 'deck-ask' },
			url: '/s/1'
		});
	});

	it('omits absent optional fields rather than sending them as null/undefined', () => {
		const result = toApnsPayload({ title: 'Hi' });
		expect(result).toEqual({ aps: { alert: { title: 'Hi' }, sound: 'default' } });
		expect('body' in result.aps.alert).toBe(false);
		expect('thread-id' in result.aps).toBe(false);
		expect('url' in result).toBe(false);
	});
});

describe('registerDeviceSchema', () => {
	it('accepts a well-formed device', () => {
		const parsed = registerDeviceSchema.parse({ token: 'aB01', platform: 'ios', env: 'production' });
		expect(parsed).toEqual({ token: 'aB01', platform: 'ios', env: 'production' });
	});

	it('rejects a non-hex token', () => {
		expect(() =>
			registerDeviceSchema.parse({ token: 'not-hex!', platform: 'ios', env: 'production' })
		).toThrow();
	});

	it('rejects an empty token', () => {
		expect(() =>
			registerDeviceSchema.parse({ token: '', platform: 'ios', env: 'production' })
		).toThrow();
	});

	it('rejects a token over 200 hex chars', () => {
		expect(() =>
			registerDeviceSchema.parse({ token: 'a'.repeat(201), platform: 'ios', env: 'production' })
		).toThrow();
	});

	it('rejects an unknown platform or env', () => {
		expect(() =>
			registerDeviceSchema.parse({ token: 'aa', platform: 'android', env: 'production' })
		).toThrow();
		expect(() =>
			registerDeviceSchema.parse({ token: 'aa', platform: 'ios', env: 'staging' })
		).toThrow();
	});
});

describe('ask notifications', () => {
	it('sets the answer category and carries the ask', async () => {
		const { askNotificationBody, ASK_CATEGORY } = await import('./apns-core');
		const ask = { sessionId: 's', askId: 'toolu_1', options: ['Red', 'Blue'], questions: 1 };
		const payload = toApnsPayload({ title: 'Q', body: 'b', ask });
		expect(payload.aps.category).toBe(ASK_CATEGORY);
		expect(payload.ask).toEqual(ask);
		expect(toApnsPayload({ title: 'Q' }).aps.category).toBeUndefined();
		expect(askNotificationBody('Which colour?', ['Red', 'Blue'])).toBe('Which colour?\n1 Red · 2 Blue');
		expect(askNotificationBody('Continue?', [])).toBe('Continue?');
	});
});

describe('live activity pushes', () => {
	it('registers and prunes activity tokens', async () => {
		const { upsertActivity, removeActivityToken, registerActivitySchema } = await import('./apns-core');
		const a = { sessionId: 's1', token: 'aa', env: 'production' as const, addedAt: 1 };
		const list = upsertActivity(upsertActivity([], a), { ...a, sessionId: 's2' });
		expect(list).toHaveLength(1);
		expect(list[0].sessionId).toBe('s2');
		expect(removeActivityToken(list, 'aa')).toEqual([]);
		expect(() => registerActivitySchema.parse({ sessionId: 's', token: 'zz', env: 'production' })).toThrow();
	});
	it('builds update and end pushes with stale and dismissal dates', async () => {
		const { toActivityPush, activityText, shouldPushText, activityTopic, ACTIVITY_TEXT_INTERVAL_MS } = await import('./apns-core');
		const state = { status: 'running', awaitingInput: false, lastText: 'x', costUsd: 0.1, turns: 2, updatedAt: 0 };
		const running = toActivityPush(state, 'update', 10_000);
		expect(running.aps).toEqual({ timestamp: 10, event: 'update', 'content-state': state });
		const idle = toActivityPush({ ...state, status: 'idle' }, 'update', 10_000);
		expect(idle.aps['stale-date']).toBe(10 + 30 * 60);
		const end = toActivityPush(state, 'end', 10_000);
		expect(end.aps['dismissal-date']).toBe(70);
		expect(activityText('  a  \n b ' + 'c'.repeat(300))).toHaveLength(160);
		expect(activityText(null)).toBe('');
		expect(shouldPushText(undefined, 0)).toBe(true);
		expect(shouldPushText(0, ACTIVITY_TEXT_INTERVAL_MS - 1)).toBe(false);
		expect(shouldPushText(0, ACTIVITY_TEXT_INTERVAL_MS)).toBe(true);
		expect(activityTopic('tech.example.app')).toBe('tech.example.app.push-type.liveactivity');
	});
});
