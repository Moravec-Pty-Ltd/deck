import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
// cross-spawn so agent CLIs installed as Windows .cmd/.bat shims still resolve.
import spawn from 'cross-spawn';

const RETRY_MS = 500;

// Why an agent CLI could not be launched, without the argv Node's own error
// carries (it holds the full system prompt and MCP config).
function spawnFailure(bin: string, err: NodeJS.ErrnoException, cwd?: string): string {
	if (err.code !== 'ENOENT') return `could not start ${bin} (${err.code ?? err.message})`;
	// Node reports a missing cwd as ENOENT too.
	if (cwd && !existsSync(cwd)) return `could not start ${bin}: the working directory ${cwd} no longer exists`;
	return `could not start ${bin}: it was not found on the server's PATH. It may not be installed, or it was mid self-update; try again in a moment.`;
}

// Spawn an agent CLI and wait until it is actually running. A spawn failure
// arrives as an `error` event, not `exit`; unheard it would crash the server.
// ENOENT gets one retry: a CLI self-update briefly leaves no binary on PATH.
export async function spawnAgent(
	bin: string,
	args: string[],
	opts: SpawnOptions,
	retryMs = RETRY_MS
): Promise<ChildProcess> {
	for (let attempt = 0; ; attempt++) {
		const child = spawn(bin, args, opts);
		const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
			child.once('spawn', () => resolve(null));
			// Stays attached after a good spawn, so a later error (a failed kill)
			// is absorbed too; the exit handler still reports what happened.
			child.on('error', resolve);
		});
		if (!err) return child;
		const cwd = opts.cwd?.toString();
		if (attempt > 0 || err.code !== 'ENOENT' || (cwd && !existsSync(cwd))) {
			throw new Error(spawnFailure(bin, err, cwd));
		}
		await new Promise((r) => setTimeout(r, retryMs));
	}
}
