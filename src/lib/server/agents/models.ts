// Enumerate an agent CLI's configured models for the new-session picker. Shells
// the CLI read-only (execFile, array args, no shell) with a short timeout, and
// fails soft: a missing/hung/unconfigured CLI yields an empty list so the modal
// degrades to free-text instead of blocking session creation. The parsing lives
// in models-core.ts.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AgentKind, ModelChoice } from '$lib/types';
import { readSettings } from '../store';
import { AGENT_BINARIES } from './binaries';
import { parseCodexModels, parseOpencodeModels, parsePiModels } from './models-core';

const exec = promisify(execFile);

// Cap the listing so a wedged CLI (auth prompt, dead provider) can't hang the
// request, mirroring the gh helpers' timeout discipline.
const LIST_TIMEOUT_MS = 15_000;

const LISTERS: Partial<Record<AgentKind, { cmd: string; args: string[]; parse: (out: string) => ModelChoice[] }>> = {
	pi: { cmd: AGENT_BINARIES.pi, args: ['--list-models'], parse: parsePiModels },
	opencode: { cmd: AGENT_BINARIES.opencode, args: ['models'], parse: parseOpencodeModels }
};

export async function listAgentModels(kind: AgentKind): Promise<ModelChoice[]> {
	// claude enumerates nothing from its CLI, but locally-configured model
	// profiles are valid ids for it, so they are all it offers. Scoped to claude
	// because a profile carries claude-specific env (see ModelProfile); the other
	// kinds reach another backend through their own config instead.
	if (kind === 'claude') {
		return (readSettings().modelProfiles ?? []).map((p) => ({ model: p.id }));
	}
	// codex lists models only interactively, but keeps its fetched catalogue in
	// a cache file the CLI refreshes on every run; read that instead of shelling.
	if (kind === 'codex') {
		try {
			const raw = await fs.readFile(path.join(os.homedir(), '.codex', 'models_cache.json'), 'utf8');
			return parseCodexModels(raw);
		} catch {
			return [];
		}
	}
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
