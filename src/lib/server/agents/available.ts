import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveAvailability, type AgentAvailability } from './available-core';

const exec = promisify(execFile);

// Cap the probe so a hung `which` can't stall the request, mirroring the
// models.ts shell-out discipline: execFile, array args, no shell. Like models.ts
// it re-probes every request (installed state is cheap to check and can change
// mid-session), so there's no cache to go stale.
const WHICH_TIMEOUT_MS = 5_000;

// `which <cmd>` exits 0 when the binary resolves on PATH; a non-zero exit or a
// spawn failure throws, which resolveAvailability reads as "not installed".
async function onPath(cmd: string): Promise<boolean> {
	await exec('which', [cmd], { timeout: WHICH_TIMEOUT_MS });
	return true;
}

export function agentAvailability(): Promise<AgentAvailability> {
	return resolveAvailability(onPath);
}
