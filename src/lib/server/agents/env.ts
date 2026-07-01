// Stamp the deck session id into a spawned agent's environment so an external
// stop hook can link its notification back to deck's own /s/<id> route instead
// of the transcript-path scheme, which deck can't resolve.
export function agentEnv(id: string): NodeJS.ProcessEnv {
	return { ...process.env, DECK_SESSION_ID: id };
}
