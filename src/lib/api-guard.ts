// Defence-in-depth for issue #164. The root layout load stops an unauthenticated
// shell from rendering in the first place; this catches a session that lapses
// mid-use: if any same-origin /api call comes back 401, bounce to /login rather
// than letting the view wedge on failed data. Kept pure (no window/goto imports)
// so it unit-tests without a DOM; the layout wires in the real fetch/redirect.

// Does `input` address a same-origin /api/* request? Resolves relative URLs
// against `origin`; a malformed URL is treated as not-ours (leave it alone).
export function isApiRequest(input: RequestInfo | URL, origin: string): boolean {
	const raw =
		typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
	try {
		const url = new URL(raw, origin);
		return url.origin === origin && url.pathname.startsWith('/api/');
	} catch {
		return false;
	}
}

// Wrap `base` fetch so a 401 from a same-origin /api call fires `onUnauthorized`
// (which redirects to /login). The response is still returned so callers see the
// 401 and can handle it too.
export function guardedFetch(
	base: typeof fetch,
	origin: string,
	onUnauthorized: () => void
): typeof fetch {
	return async (input, init) => {
		const res = await base(input, init);
		if (res.status === 401 && isApiRequest(input, origin)) onUnauthorized();
		return res;
	};
}
