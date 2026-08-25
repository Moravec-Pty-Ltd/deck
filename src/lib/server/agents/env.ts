import path from 'node:path';
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
export function agentEnv(
	id: string,
	cwd: string,
	extra?: Record<string, string>
): NodeJS.ProcessEnv {
	return {
		...process.env,
		PWD: path.resolve(cwd),
		DECK_SESSION_ID: id,
		DECK_BASE_URL: baseUrl,
		DECK_TOKEN: authToken,
		...extra
	};
}
