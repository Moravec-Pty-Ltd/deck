import { describe, it, expect, vi } from 'vitest';
import { isApiRequest, guardedFetch } from './api-guard';

const ORIGIN = 'https://deck.example.com';

describe('isApiRequest', () => {
	it('matches same-origin /api requests as string, relative, URL, or Request', () => {
		expect(isApiRequest('/api/sessions', ORIGIN)).toBe(true);
		expect(isApiRequest(`${ORIGIN}/api/x`, ORIGIN)).toBe(true);
		expect(isApiRequest(new URL('/api/x', ORIGIN), ORIGIN)).toBe(true);
		expect(isApiRequest(new Request(`${ORIGIN}/api/x`), ORIGIN)).toBe(true);
	});

	it('rejects non-api paths and cross-origin requests', () => {
		expect(isApiRequest('/', ORIGIN)).toBe(false);
		expect(isApiRequest('/login', ORIGIN)).toBe(false);
		expect(isApiRequest('/apiary', ORIGIN)).toBe(false);
		expect(isApiRequest('https://evil.test/api/x', ORIGIN)).toBe(false);
	});

	it('treats a malformed url as not-ours', () => {
		expect(isApiRequest('http://[', ORIGIN)).toBe(false);
	});
});

describe('guardedFetch', () => {
	const respond = (status: number) =>
		vi.fn(() => Promise.resolve(new Response('', { status }))) as unknown as typeof fetch;

	it('fires onUnauthorized on a 401 from /api and still returns the response', async () => {
		const onUnauthorized = vi.fn();
		const res = await guardedFetch(respond(401), ORIGIN, onUnauthorized)('/api/x');
		expect(res.status).toBe(401);
		expect(onUnauthorized).toHaveBeenCalledOnce();
	});

	it('ignores a 401 from a non-api path', async () => {
		const onUnauthorized = vi.fn();
		await guardedFetch(respond(401), ORIGIN, onUnauthorized)('/login');
		expect(onUnauthorized).not.toHaveBeenCalled();
	});

	it('ignores a non-401 api response', async () => {
		const onUnauthorized = vi.fn();
		await guardedFetch(respond(200), ORIGIN, onUnauthorized)('/api/x');
		expect(onUnauthorized).not.toHaveBeenCalled();
	});
});
