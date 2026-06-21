import { describe, it, expect } from 'vitest';
import {
	computeReady,
	deriveState,
	derivePreviewUrl,
	GRACE_MS,
	matchReady,
	parseDevConfig,
	serverTmuxName,
	type PaneStatus,
	type StateInputs
} from './devservers-core';
import type { ServerSpec } from '$lib/types';

const server = (over: Partial<ServerSpec> = {}): ServerSpec => ({ name: 'web', run: 'pnpm dev', ...over });

describe('parseDevConfig', () => {
	it('accepts a full valid config', () => {
		const cfg = parseDevConfig({
			copyFromMain: ['.env'],
			setup: [{ label: 'install', run: 'pnpm i' }],
			servers: [{ name: 'web', run: 'pnpm dev', ports: [{ port: 5173, primary: true }], readyPattern: 'Local:\\s+(http\\S+)' }]
		});
		expect(cfg.servers?.[0].name).toBe('web');
	});

	it('rejects a missing server name', () => {
		expect(() => parseDevConfig({ servers: [{ run: 'pnpm dev' }] })).toThrow();
	});

	it('rejects an out-of-range port', () => {
		expect(() => parseDevConfig({ servers: [{ name: 'w', run: 'x', ports: [{ port: 0 }] }] })).toThrow();
	});

	it('rejects duplicate server names', () => {
		expect(() =>
			parseDevConfig({ servers: [{ name: 'w', run: 'a' }, { name: 'w', run: 'b' }] })
		).toThrow(/duplicate/);
	});

	it('rejects an uncompilable readyPattern', () => {
		expect(() => parseDevConfig({ servers: [{ name: 'w', run: 'x', readyPattern: '(' }] })).toThrow();
	});
});

describe('serverTmuxName', () => {
	it('sanitises the server name and keeps the session id', () => {
		expect(serverTmuxName('c_abc123', 'web api')).toBe('deck-srv-c_abc123-web-api');
		expect(serverTmuxName('c_abc123', 'a/b:c')).toBe('deck-srv-c_abc123-a-b-c');
	});
});

describe('derivePreviewUrl', () => {
	it('prefers a captured URL', () => {
		expect(derivePreviewUrl(server({ ports: [{ port: 5173 }] }), 'http://x:1/')).toBe('http://x:1/');
	});
	it('uses the primary port', () => {
		expect(derivePreviewUrl(server({ ports: [{ port: 8787 }, { port: 5173, primary: true }] }))).toBe(
			'http://localhost:5173'
		);
	});
	it('falls back to the first port', () => {
		expect(derivePreviewUrl(server({ ports: [{ port: 8787 }, { port: 5173 }] }))).toBe('http://localhost:8787');
	});
	it('is undefined with no ports and no capture', () => {
		expect(derivePreviewUrl(server())).toBeUndefined();
	});
	it('ignores a non-http(s) captured URL and falls back to the port', () => {
		expect(derivePreviewUrl(server({ ports: [{ port: 5173 }] }), 'javascript:alert(1)')).toBe(
			'http://localhost:5173'
		);
	});
});

describe('matchReady', () => {
	it('captures the first group', () => {
		expect(matchReady('Local:\\s+(http\\S+)', '  Local:   http://localhost:5173/')).toEqual({
			matched: true,
			url: 'http://localhost:5173/'
		});
	});
	it('does not match when absent', () => {
		expect(matchReady('ready', 'still building').matched).toBe(false);
	});
	it('treats no pattern as unmatched', () => {
		expect(matchReady(undefined, 'anything').matched).toBe(false);
	});
});

describe('computeReady', () => {
	it('is ready when all ports listen and the pattern matched', () => {
		expect(
			computeReady(server({ ports: [{ port: 1 }, { port: 2 }], readyPattern: 'x' }), [
				{ port: 1, listening: true },
				{ port: 2, listening: true }
			], true)
		).toBe(true);
	});
	it('is not ready when a port is down', () => {
		expect(computeReady(server({ ports: [{ port: 1 }] }), [{ port: 1, listening: false }], false)).toBe(false);
	});
	it('is not ready when the pattern has not matched', () => {
		expect(computeReady(server({ readyPattern: 'x' }), [], false)).toBe(false);
	});
	it('is ready with no ports and no pattern', () => {
		expect(computeReady(server(), [], false)).toBe(true);
	});
});

describe('deriveState', () => {
	const pane = (over: Partial<PaneStatus> = {}): PaneStatus => ({
		dead: false,
		exitStatus: null,
		created: 0,
		activity: 0,
		...over
	});
	const base = (over: Partial<StateInputs>): StateInputs => ({
		pane: pane(),
		stopRequested: false,
		launched: true,
		inSetup: false,
		bringingUp: false,
		ready: false,
		runningSeen: false,
		startedAt: 1000,
		now: 1000,
		...over
	});

	it('is setup while setup runs', () => {
		expect(deriveState(base({ inSetup: true }))).toBe('setup');
	});
	it('is stopped when never launched', () => {
		expect(deriveState(base({ pane: null, launched: false }))).toBe('stopped');
	});
	it('is dead when the session vanished after launch', () => {
		expect(deriveState(base({ pane: null }))).toBe('dead');
	});
	it('is starting during bring-up before the pane exists', () => {
		expect(deriveState(base({ pane: null, launched: false, bringingUp: true }))).toBe('starting');
	});
	it('is stopped when the user stopped it', () => {
		expect(deriveState(base({ pane: null, stopRequested: true }))).toBe('stopped');
	});
	it('is errored when the command exited non-zero', () => {
		expect(deriveState(base({ pane: pane({ dead: true, exitStatus: 1 }) }))).toBe('errored');
	});
	it('is dead when the command exited cleanly', () => {
		expect(deriveState(base({ pane: pane({ dead: true, exitStatus: 0 }) }))).toBe('dead');
	});
	it('is starting within the grace window', () => {
		expect(deriveState(base({ startedAt: 1000, now: 1000 + GRACE_MS - 1 }))).toBe('starting');
	});
	it('is stalled past the grace window with no readiness', () => {
		expect(deriveState(base({ startedAt: 1000, now: 1000 + GRACE_MS + 1 }))).toBe('stalled');
	});
	it('is running once ready', () => {
		expect(deriveState(base({ ready: true }))).toBe('running');
	});
	it('is stalled when a previously-ready server loses readiness', () => {
		expect(deriveState(base({ ready: false, runningSeen: true }))).toBe('stalled');
	});
});
