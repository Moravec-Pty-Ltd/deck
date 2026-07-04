// Enumerate an agent CLI's configured models for the new-session picker. Shells
// the CLI read-only (execFile, array args, no shell) with a short timeout, and
// fails soft: a missing/hung/unconfigured CLI yields an empty list so the modal
// degrades to free-text instead of blocking session creation. The parsing lives
// in models-core.ts.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentKind, ModelChoice } from '$lib/types';
import { parseOpencodeModels, parsePiModels } from './models-core';

const exec = promisify(execFile);

// Cap the listing so a wedged CLI (auth prompt, dead provider) can't hang the
// request, mirroring the gh helpers' timeout discipline.
const LIST_TIMEOUT_MS = 15_000;

const LISTERS: Partial<Record<AgentKind, { cmd: string; args: string[]; parse: (out: string) => ModelChoice[] }>> = {
	pi: { cmd: 'pi', args: ['--list-models'], parse: parsePiModels },
	opencode: { cmd: 'opencode', args: ['models'], parse: parseOpencodeModels }
};

export async function listAgentModels(kind: AgentKind): Promise<ModelChoice[]> {
	const lister = LISTERS[kind];
	if (!lister) return [];
	try {
		const { stdout } = await exec(lister.cmd, lister.args, {
			maxBuffer: 4 * 1024 * 1024,
			timeout: LIST_TIMEOUT_MS
		});
		return lister.parse(stdout);
	} catch {
		return [];
	}
}
