// Test-only helper: pin env vars before importing a module that reads them at
// import time (config.ts and everything that pulls it in), returning the
// restore for afterAll. `undefined` pins a var as unset.
export function pinEnv(vars: Record<string, string | undefined>): () => void {
	const original = Object.keys(vars).map((k) => [k, process.env[k]] as const);
	for (const [k, v] of Object.entries(vars)) setEnv(k, v);
	return () => original.forEach(([k, v]) => setEnv(k, v));
}

function setEnv(key: string, value: string | undefined) {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

// The status and message a SvelteKit `error()` threw, for testing the bits of a
// route boundary that reject a request. `error()` throws a plain object rather
// than an Error, so there is nothing on it a matcher reads usefully; this turns
// it into the two things a test cares about. Fails loudly if nothing was thrown,
// since a boundary check that silently passes is the bug being looked for.
export function thrownError(run: () => unknown): { status: number; message: string } {
	try {
		run();
	} catch (e) {
		const err = e as { status: number; body?: { message?: string } };
		return { status: err.status, message: err.body?.message ?? '' };
	}
	throw new Error('expected a rejection, but the call returned');
}
