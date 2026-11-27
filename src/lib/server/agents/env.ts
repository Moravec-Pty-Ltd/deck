import path from 'node:path';
import type { DeckSession } from '$lib/types';
import { authToken, baseUrl } from '../config';

// Stamp the deck session id into a spawned agent's environment so an external
// stop hook can link its notification back to deck's own /s/<id> route instead
// of the transcript-path scheme, which deck can't resolve. The base URL and
// shared token let the agent call deck's own API (see /llms.txt) zero-config.
// `cwd` is the directory the child is spawned in. Spawning with a cwd doesn't
// update `PWD`, so without this a child that trusts `PWD` over `getcwd()` runs
// in deck's checkout instead of the session's project. opencode does exactly
// that; it's now told explicitly via `--dir`, but the other drivers pass no
// such flag and inherit this env.
// `extra` is merged last so a model profile can point the agent at another
// backend (ANTHROPIC_BASE_URL and friends) for this session only, without
// leaking that choice into deck's own process env.
// A review session runs in a pull request's checkout, whose files and agent
// settings its author chose, so it gets no token: it reports, and you act.
export function agentEnv(
	session: Pick<DeckSession, 'id' | 'prSeeded'>,
	cwd: string,
	extra?: Record<string, string | undefined>
): NodeJS.ProcessEnv {
	const { DECK_TOKEN: _token, ...env } = process.env;
	return {
		...env,
		PWD: path.resolve(cwd),
		DECK_SESSION_ID: session.id,
		DECK_BASE_URL: baseUrl,
		...(session.prSeeded ? {} : { DECK_TOKEN: authToken }),
		...extra
	};
}
