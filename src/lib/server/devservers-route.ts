import { error, json } from '@sveltejs/kit';
import {
	cachedServerStates,
	listServers,
	restartServer,
	resetupServer,
	runSetupStep,
	serverLogs,
	startServer,
	stopServer
} from './devservers';
import { parseStepIndex } from './devservers-core';
import { sessionOr404 } from './http';

// Dev-server handlers, each shared verbatim by a browser route and its agent
// API twin. Every action targets the session's own worktree, resolved
// server-side from the stored session, never a request-supplied path. Auth is
// enforced globally by hooks.server.ts.

interface ServerEvent {
	params: Partial<Record<string, string>>;
	url: URL;
	request: Request;
}

// Per-session server states from the monitor's last poll (no fresh probing),
// keyed by session id.
export function serverStatesRoute(): Response {
	return json(cachedServerStates());
}

// Configured dev servers with live status for one session's worktree.
export async function sessionServersRoute({ params }: Pick<ServerEvent, 'params'>): Promise<Response> {
	const session = await sessionOr404(params.id!);
	return json({ servers: await listServers(session.id) });
}

const ACTIONS = {
	start: startServer,
	stop: stopServer,
	restart: restartServer,
	resetup: resetupServer
} as const;

// Own-property lookup only, so an inherited key (toString, constructor, ...) from
// untrusted input can't slip past the guard into an unexpected call path.
function actionFor(name: unknown) {
	if (typeof name !== 'string' || !Object.hasOwn(ACTIONS, name)) return undefined;
	return ACTIONS[name as keyof typeof ACTIONS];
}

// A single-step re-run carries a numeric index plus the label the client rendered
// (so a stale step list is caught server-side).
function stepCall(body: { step?: unknown; label?: unknown }, id: string, name: string) {
	const index = parseStepIndex(body.step);
	if (index === null) error(400, 'invalid step index');
	if (body.label !== undefined && typeof body.label !== 'string') error(400, 'invalid step label');
	return () => runSetupStep(id, name, index, body.label as string | undefined);
}

function resolveCall(body: { action?: unknown; step?: unknown; label?: unknown }, id: string, name: string) {
	if (body.action === 'step') return stepCall(body, id, name);
	const action = actionFor(body.action);
	if (!action) error(400, 'invalid action');
	return () => action(id, name);
}

// Start / stop / restart / re-run setup (or one setup step) for one server.
export async function serverActionRoute({ params, request }: Omit<ServerEvent, 'url'>): Promise<Response> {
	const body = await request.json().catch(() => ({}));
	const call = resolveCall(body ?? {}, params.id!, params.name!);
	try {
		return json(await call());
	} catch (e) {
		error(400, e instanceof Error ? e.message : 'failed to run action');
	}
}

// A snapshot of the server's tmux pane, with the terminal snapshot's
// ?h=<tag> -> { unchanged: true } round-trip.
export async function serverLogsRoute({ params, url }: Omit<ServerEvent, 'request'>): Promise<Response> {
	const res = await serverLogs(params.id!, params.name!, url.searchParams.get('h'));
	if (!res) error(404, 'server not found');
	return json(res);
}
