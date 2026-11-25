import { describe, expect, it } from 'vitest';
import { hostName, refuseWrite } from './request-guard-core';

const hosts = ['localhost:4818', 'deck.example.com'];
const ROUTE = '/api/agent/sessions';
const SPEECH = '/api/agent/speech/transcribe';

function status(headers: Record<string, string> = {}, { method = 'POST', routeId = ROUTE as string | null, at = hosts } = {}) {
	return refuseWrite({ method, headers: new Headers(headers), routeId, hosts: at })?.status ?? null;
}

describe('origin', () => {
	it('passes an absent Origin (native clients, curl)', () => {
		expect(status()).toBe(null);
	});

	it('passes any host deck is reached at, whatever the scheme', () => {
		for (const origin of ['http://localhost:4818', 'https://localhost:4818', 'https://deck.example.com']) expect(status({ origin })).toBe(null);
		expect(status({ origin: 'https://deck.example.com' }, { at: ['Deck.Example.com:443'] })).toBe(null);
	});

	it('refuses another site, port or subdomain on every state-changing method', () => {
		for (const origin of ['https://other.example', 'http://localhost:3000', 'https://app.deck.example.com', 'https://deck.example.com.other.example', 'null', 'garbage']) {
			for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(status({ origin }, { method })).toBe(403);
		}
		expect(status({ origin: 'https://deck.example.com' }, { at: [''] })).toBe(403);
	});

	it('leaves reads alone', () => {
		for (const method of ['GET', 'HEAD', 'OPTIONS']) expect(status({ origin: 'https://other.example' }, { method })).toBe(null);
	});

	it('covers pages as well as the API', () => {
		expect(status({ origin: 'https://other.example' }, { routeId: '/login' })).toBe(403);
	});
});

describe('body type', () => {
	const send = (type: string | null, routeId: string | null = ROUTE) => status({ 'content-length': '2', ...(type === null ? {} : { 'content-type': type }) }, { routeId });

	it('takes JSON, with or without a charset', () => {
		expect(send('application/json')).toBe(null);
		expect(send('Application/JSON; charset=utf-8')).toBe(null);
	});

	it('refuses any other type, and none', () => {
		for (const type of [null, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'text/plain; application/json', 'audio/webm']) {
			expect(send(type)).toBe(415);
		}
		expect(status({ 'transfer-encoding': 'chunked' })).toBe(415);
	});

	it('takes audio on the speech routes', () => {
		for (const type of ['audio/webm;codecs=opus', 'video/mp4', 'application/octet-stream', null]) expect(send(type, SPEECH)).toBe(null);
		expect(send('text/plain', SPEECH)).toBe(415);
	});

	it('ignores an empty body and form posts to pages', () => {
		expect(status({ 'content-length': '0' })).toBe(null);
		expect(send('application/x-www-form-urlencoded', '/login')).toBe(null);
	});
});

it('reads the name out of a Host header', () => {
	expect(hostName('localhost:4818')).toBe('localhost');
	expect(hostName('[::1]:4818')).toBe('[::1]');
	expect(hostName(null)).toBe('');
});
