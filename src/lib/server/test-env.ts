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
