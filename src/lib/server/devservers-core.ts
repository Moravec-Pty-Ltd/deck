import { z } from 'zod';
import type { DevConfig, PortSpec, PortStatus, ServerSpec, ServerState } from '$lib/types';

// Pure dev-server logic: config validation, tmux naming, readiness, and state
// derivation. Kept free of node/tmux imports so it stays unit-testable and the
// IO-heavy orchestration lives in devservers.ts.

const stepSchema = z.object({
	label: z.string().min(1),
	run: z.string().min(1),
	cwd: z.string().optional()
});

const portSchema = z.object({
	port: z.number().int().min(1).max(65535),
	label: z.string().optional(),
	primary: z.boolean().optional()
});

const serverSchema = z.object({
	name: z.string().min(1),
	run: z.string().min(1),
	cwd: z.string().optional(),
	setup: z.array(stepSchema).optional(),
	ports: z.array(portSchema).optional(),
	readyPattern: z.string().optional()
});

const devConfigSchema = z.object({
	copyFromMain: z.array(z.string().min(1)).optional(),
	setup: z.array(stepSchema).optional(),
	servers: z.array(serverSchema).optional()
});

function assertUniqueNames(servers: ServerSpec[]) {
	const names = new Set<string>();
	for (const s of servers) {
		if (names.has(s.name)) throw new Error(`duplicate server name: ${s.name}`);
		names.add(s.name);
	}
}

// Surface a bad readyPattern at write time rather than silently never matching.
function assertRegexes(servers: ServerSpec[]) {
	for (const s of servers) if (s.readyPattern) new RegExp(s.readyPattern);
}

// Validate raw config (throws on a schema mismatch, duplicate name, or bad
// regex). Used by the projects API on write and when reading config to act on.
export function parseDevConfig(raw: unknown): DevConfig {
	const cfg = devConfigSchema.parse(raw);
	const servers = cfg.servers ?? [];
	assertUniqueNames(servers);
	assertRegexes(servers);
	return cfg;
}

// Prefix for every dev-server tmux session, so they can be told apart from
// deck's shell/agent sessions and adhoc terminals (excluded from the main list).
export const SERVER_TMUX_PREFIX = 'deck-srv-';

// tmux session name for a server's dev pane. Session ids are already tmux-safe;
// the server name is sanitised so an arbitrary config value can't break the name.
export function serverTmuxName(sessionId: string, serverName: string): string {
	const safe = serverName.replace(/[^a-zA-Z0-9_-]/g, '-');
	return `${SERVER_TMUX_PREFIX}${sessionId}-${safe}`;
}

function primaryPort(ports: PortSpec[]): PortSpec | undefined {
	return ports.find((p) => p.primary) ?? ports[0];
}

// The captured URL comes from the dev server's pane output, so validate its
// scheme before it's rendered into an href: only http(s) is surfaced.
function httpUrl(u: string | undefined): string | undefined {
	if (!u) return undefined;
	try {
		const proto = new URL(u).protocol;
		return proto === 'http:' || proto === 'https:' ? u : undefined;
	} catch {
		return undefined;
	}
}

// Preview link: the readyPattern's captured URL if it matched a valid http(s)
// one, else http://localhost:<primary-or-first port>, else nothing.
export function derivePreviewUrl(server: ServerSpec, capturedUrl?: string): string | undefined {
	const captured = httpUrl(capturedUrl);
	if (captured) return captured;
	const p = primaryPort(server.ports ?? []);
	return p ? `http://localhost:${p.port}` : undefined;
}

function compile(pattern: string): RegExp | null {
	try {
		return new RegExp(pattern);
	} catch {
		return null;
	}
}

// Run readyPattern over a pane snapshot. Returns whether it matched and the
// first capture group (a URL, by convention) when present.
export function matchReady(pattern: string | undefined, text: string): { matched: boolean; url?: string } {
	const re = pattern ? compile(pattern) : null;
	const m = re ? re.exec(text) : null;
	return m ? { matched: true, url: m[1] } : { matched: false };
}

// Ready = every configured port is listening (or none configured) and the
// readyPattern has matched (or none configured).
export function computeReady(server: ServerSpec, ports: PortStatus[], patternMatched: boolean): boolean {
	const portsOk = (server.ports ?? []).length === 0 || ports.every((p) => p.listening);
	const patternOk = !server.readyPattern || patternMatched;
	return portsOk && patternOk;
}

// Whether a tmux pane is alive, dead-with-exit-code, and when it started.
export interface PaneStatus {
	dead: boolean;
	exitStatus: number | null;
	created: number;
	activity: number;
}

export interface StateInputs {
	pane: PaneStatus | null; // null => the tmux session is entirely gone
	stopRequested: boolean;
	launched: boolean;
	inSetup: boolean;
	bringingUp: boolean; // start requested; setup/launch in flight, no pane yet
	ready: boolean;
	runningSeen: boolean;
	startedAt: number;
	now: number;
}

// Past this with no readiness, a server is treated as stalled rather than still
// starting. A tunable constant in v1, not config.
export const GRACE_MS = 60_000;

function offState(i: StateInputs): ServerState {
	if (i.stopRequested) return 'stopped'; // wins even mid bring-up
	if (i.bringingUp) return 'starting'; // between kill and (re)launch
	return i.launched ? 'dead' : 'stopped';
}

function deadState(i: StateInputs): ServerState {
	if (i.stopRequested) return 'stopped';
	const code = i.pane?.exitStatus ?? 0;
	return code !== 0 ? 'errored' : 'dead';
}

function liveState(i: StateInputs): ServerState {
	if (i.ready) return 'running';
	if (i.runningSeen) return 'stalled'; // was ready, lost it
	return i.now - i.startedAt > GRACE_MS ? 'stalled' : 'starting';
}

// Derive a server's state from its pane status, readiness, and timing.
export function deriveState(i: StateInputs): ServerState {
	if (i.inSetup) return 'setup';
	if (!i.pane) return offState(i);
	if (i.pane.dead) return deadState(i);
	return liveState(i);
}
