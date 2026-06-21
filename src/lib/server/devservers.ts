import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import type { ChildProcess } from 'node:child_process';
import spawn from 'cross-spawn';
import type {
	DeckSession,
	DevConfig,
	PortSpec,
	PortStatus,
	Project,
	ServerRuntime,
	ServerSpec,
	ServerState,
	SetupStep,
	SetupStepProgress
} from '$lib/types';
import { isAgentKind } from '$lib/types';
import { listProjects, getStoredSession } from './store';
import { confineRelative } from './confine';
import {
	createDevPane,
	hasTmuxSession,
	killTmuxSession,
	listTmuxSessions,
	paneStatus,
	snapshotTag,
	stableSnapshot
} from './tmux';
import {
	computeReady,
	deriveState,
	derivePreviewUrl,
	matchReady,
	parseDevConfig,
	SERVER_TMUX_PREFIX,
	serverTmuxName,
	type PaneStatus
} from './devservers-core';
import { notify } from './push';

// Runtime state of a managed dev server, held in memory (globalThis so it
// survives HMR). The authoritative liveness/health is always re-derived from
// tmux per poll; this only tracks what tmux can't tell us: setup progress,
// whether setup is done for this worktree, and the captured preview URL.
interface Instance {
	setup: SetupStepProgress[];
	setupComplete: boolean;
	setupRunning: boolean;
	launched: boolean;
	starting: boolean; // bring-up (setup + launch) in flight
	stopRequested: boolean;
	runningSeen: boolean;
	startedAt: number;
	// Bumped by every start/stop/restart/teardown. A background bring-up captures
	// the epoch it was launched under and bails (no launch, no mutation) once it no
	// longer matches, so a superseding action can't race it into a double-launch or
	// a launch into a torn-down worktree.
	epoch: number;
	child?: ChildProcess; // the current setup step's process, so a cancel can kill it
	previewUrl?: string;
	error?: string;
}

const SETUP_OUTPUT_CAP = 8000;

function instances(): Map<string, Instance> {
	const g = globalThis as { __deckServers?: Map<string, Instance> };
	return (g.__deckServers ??= new Map());
}

function key(sessionId: string, serverName: string): string {
	return `${sessionId}:${serverName}`;
}

function freshInstance(): Instance {
	return {
		setup: [],
		setupComplete: false,
		setupRunning: false,
		launched: false,
		starting: false,
		stopRequested: false,
		runningSeen: false,
		startedAt: 0,
		epoch: 0
	};
}

// Kill a setup child and its descendants. The step runs detached (its own process
// group), so a negative-pid signal reaches the whole tree (the shell *and* the
// pnpm/sleep/... it spawned), not just the shell — otherwise a killed `sh -c`
// would orphan its children.
function killTree(child: ChildProcess) {
	if (child.pid === undefined) return;
	try {
		process.kill(-child.pid, 'SIGTERM');
	} catch {
		child.kill('SIGTERM'); // group gone / not a leader: best-effort single kill
	}
}

// Supersede any in-flight bring-up: bump the epoch (so its post-await guards bail)
// and kill the running setup child process tree if there is one.
function cancel(inst: Instance) {
	inst.epoch++;
	if (inst.child) killTree(inst.child);
	inst.child = undefined;
}

function getInstance(sessionId: string, serverName: string): Instance {
	const map = instances();
	const k = key(sessionId, serverName);
	const existing = map.get(k);
	if (existing) return existing;
	const inst = freshInstance();
	map.set(k, inst);
	return inst;
}

// --- config / session resolution -----------------------------------------

function safeParse(raw: unknown): DevConfig | null {
	try {
		return parseDevConfig(raw);
	} catch {
		return null;
	}
}

function devConfigOf(project: Project | undefined): DevConfig | null {
	if (!project?.dev) return null;
	return safeParse(project.dev);
}

// The project a session belongs to: matched by the worktree's repo path, falling
// back to a session whose cwd is the project root itself.
function projectForSession(session: DeckSession): Project | undefined {
	const repo = session.worktree?.repo;
	const byRepo = repo ? listProjects().find((p) => p.path === repo) : undefined;
	if (byRepo) return byRepo;
	return listProjects().find((p) => session.cwd === p.path);
}

interface ServerCtx {
	sessionId: string;
	worktree: string;
	mainPath: string;
	dev: DevConfig;
	server: ServerSpec;
}

function findServer(dev: DevConfig, name: string): ServerSpec | undefined {
	return dev.servers?.find((s) => s.name === name);
}

// The stored record is enough here (cwd/worktree/kind); using getStoredSession
// rather than sessions.getSession keeps devservers off the sessions import cycle
// (sessions -> devservers for teardown). Live status isn't needed to resolve a
// server, and adhoc `t_` shells aren't agents anyway.
function agentSessionOf(sessionId: string): DeckSession | null {
	const session = getStoredSession(sessionId);
	if (!session) return null;
	if (!isAgentKind(session.kind)) return null;
	return session;
}

function resolveCtx(sessionId: string, serverName: string): ServerCtx | null {
	const session = agentSessionOf(sessionId);
	if (!session) return null;
	const project = projectForSession(session);
	const dev = devConfigOf(project);
	if (!dev) return null;
	const server = findServer(dev, serverName);
	if (!server) return null;
	return { sessionId, worktree: session.cwd, mainPath: project!.path, dev, server };
}

// Resolve the action context + in-memory instance for a server, or throw if the
// server isn't configured for the session. Shared by start/stop/restart.
function resolveInstance(sessionId: string, serverName: string): { ctx: ServerCtx; inst: Instance } {
	const ctx = resolveCtx(sessionId, serverName);
	if (!ctx) throw new Error('server not configured');
	return { ctx, inst: getInstance(sessionId, serverName) };
}

// --- setup execution ------------------------------------------------------

interface StepResult {
	code: number;
	output: string;
}

interface Task {
	label: string;
	exec: () => Promise<StepResult>;
}

// The child is registered on the instance so a cancel (stop/restart/delete) can
// kill an in-flight setup step rather than leaking it (e.g. a long pnpm install).
function runShell(command: string, cwd: string, inst: Instance): Promise<StepResult> {
	return new Promise((resolve) => {
		// detached so the step leads its own process group; cancel kills the group.
		const child = spawn(command, [], { cwd, shell: true, detached: true });
		inst.child = child;
		let out = '';
		const cap = (b: Buffer) => {
			out = (out + b.toString()).slice(-SETUP_OUTPUT_CAP);
		};
		const finish = (r: StepResult) => {
			if (inst.child === child) inst.child = undefined;
			resolve(r);
		};
		child.stdout?.on('data', cap);
		child.stderr?.on('data', cap);
		child.on('error', (e) => finish({ code: 1, output: out + String(e) }));
		// A signal exit (e.g. a cancel's SIGTERM) is a non-zero result, so a killed
		// step is recorded as failed and never marks setup complete.
		child.on('close', (code, signal) => finish({ code: signal ? 1 : (code ?? 0), output: out }));
	});
}

function shellTask(step: SetupStep, worktree: string, inst: Instance): Task {
	return {
		label: step.label,
		exec: () => {
			const cwd = confineRelative(worktree, step.cwd ?? '.');
			if (!cwd) return Promise.resolve({ code: 1, output: `cwd escapes worktree: ${step.cwd}` });
			return runShell(step.run, cwd, inst);
		}
	};
}

// Copy one config file from the main worktree to the session worktree, confining
// both ends so neither can read from / write to outside the registered tree. A
// destination that resolves to the worktree root itself (empty / `.` / self-
// cancelling rel) names no file, so it's rejected rather than copying onto a dir.
function copyOne(from: string, to: string, rel: string): string | null {
	const src = confineRelative(from, rel);
	const dst = confineRelative(to, rel);
	if (!src || !dst) return `unsafe path: ${rel}`;
	if (dst === path.resolve(to)) return `copy target is not a file: ${rel}`;
	try {
		fs.mkdirSync(path.dirname(dst), { recursive: true });
		fs.copyFileSync(src, dst);
		return null;
	} catch (e) {
		return `copy failed (${rel}): ${e}`;
	}
}

function copyFiles(files: string[], from: string, to: string): StepResult {
	for (const rel of files) {
		const err = copyOne(from, to, rel);
		if (err) return { code: 1, output: err };
	}
	return { code: 0, output: `copied ${files.length} file(s)` };
}

function copyTask(files: string[], ctx: ServerCtx): Task {
	return {
		label: `copy ${files.length} file(s) from main`,
		exec: () => Promise.resolve(copyFiles(files, ctx.mainPath, ctx.worktree))
	};
}

// copyFromMain, then shared setup, then the server's own setup.
function buildTasks(ctx: ServerCtx, inst: Instance): Task[] {
	const tasks: Task[] = [];
	const copy = ctx.dev.copyFromMain ?? [];
	if (copy.length) tasks.push(copyTask(copy, ctx));
	for (const s of ctx.dev.setup ?? []) tasks.push(shellTask(s, ctx.worktree, inst));
	for (const s of ctx.server.setup ?? []) tasks.push(shellTask(s, ctx.worktree, inst));
	return tasks;
}

// Run one step, recording its result on the instance; returns whether it passed.
async function runOneStep(inst: Instance, tasks: Task[], i: number): Promise<boolean> {
	inst.setup[i] = { label: tasks[i].label, state: 'running' };
	const { code, output } = await tasks[i].exec();
	inst.setup[i] = {
		label: tasks[i].label,
		state: code === 0 ? 'ok' : 'failed',
		exitCode: code,
		output: output.slice(-SETUP_OUTPUT_CAP)
	};
	if (code !== 0) inst.error = `setup step "${tasks[i].label}" failed`;
	return code === 0;
}

// Run setup tasks in order, short-circuiting on the first failure or once the
// bring-up has been superseded (epoch changed). Returns whether all passed.
async function runTasks(inst: Instance, tasks: Task[], epoch: number): Promise<boolean> {
	inst.setup = tasks.map((t) => ({ label: t.label, state: 'pending' as const }));
	for (let i = 0; i < tasks.length; i++) {
		if (inst.epoch !== epoch) return false; // superseded
		if (!(await runOneStep(inst, tasks, i))) return false;
	}
	return true;
}

async function runSetup(inst: Instance, ctx: ServerCtx, epoch: number): Promise<boolean> {
	inst.setupRunning = true;
	inst.error = undefined;
	try {
		return await runTasks(inst, buildTasks(ctx, inst), epoch);
	} finally {
		inst.setupRunning = false;
	}
}

// --- launch / health ------------------------------------------------------

async function launch(inst: Instance, ctx: ServerCtx) {
	const name = serverTmuxName(ctx.sessionId, ctx.server.name);
	const cwd = confineRelative(ctx.worktree, ctx.server.cwd ?? '.');
	if (!cwd) throw new Error(`server cwd escapes worktree: ${ctx.server.cwd}`);
	await createDevPane(name, cwd, ctx.server.run);
	inst.launched = true;
	inst.startedAt = Date.now();
	inst.runningSeen = false;
	inst.previewUrl = undefined;
}

async function killName(name: string) {
	if (await hasTmuxSession(name)) await killTmuxSession(name);
}

function probePort(port: number, timeoutMs = 700): Promise<boolean> {
	return new Promise((resolve) => {
		const sock = net.connect({ host: '127.0.0.1', port });
		const done = (ok: boolean) => {
			sock.destroy();
			resolve(ok);
		};
		sock.setTimeout(timeoutMs);
		sock.once('connect', () => done(true));
		sock.once('timeout', () => done(false));
		sock.once('error', () => done(false));
	});
}

function probePorts(ports: PortSpec[]): Promise<PortStatus[]> {
	return Promise.all(ports.map(async (p) => ({ ...p, listening: await probePort(p.port) })));
}

async function paneSnapshot(name: string, pane: PaneStatus | null): Promise<string> {
	if (!pane || pane.dead) return '';
	try {
		return (await stableSnapshot(name)).text;
	} catch {
		return '';
	}
}

// A dev pane found alive that this process didn't start (deck restarted under it,
// see issue #32 rediscovery): adopt it so it reads as running, not starting.
function adoptIfRediscovered(inst: Instance, pane: PaneStatus | null) {
	if (inst.launched || !pane) return;
	inst.launched = true;
	inst.startedAt = pane.created || Date.now();
}

function updateReadiness(inst: Instance, server: ServerSpec, ready: boolean, capturedUrl?: string) {
	if (!ready) return;
	inst.runningSeen = true;
	inst.previewUrl ??= derivePreviewUrl(server, capturedUrl);
}

async function computeRuntime(sessionId: string, server: ServerSpec): Promise<ServerRuntime> {
	const tmuxName = serverTmuxName(sessionId, server.name);
	const inst = getInstance(sessionId, server.name);
	const pane = await paneStatus(tmuxName);
	adoptIfRediscovered(inst, pane);
	const ports = await probePorts(server.ports ?? []);
	const snap = await paneSnapshot(tmuxName, pane);
	const rm = matchReady(server.readyPattern, snap);
	const ready = computeReady(server, ports, rm.matched);
	updateReadiness(inst, server, ready, rm.url);
	const state = deriveState({
		pane,
		stopRequested: inst.stopRequested,
		launched: inst.launched,
		inSetup: inst.setupRunning,
		bringingUp: inst.starting,
		ready,
		runningSeen: inst.runningSeen,
		startedAt: inst.startedAt,
		now: Date.now()
	});
	return { name: server.name, state, tmuxName, ports, previewUrl: inst.previewUrl, setup: inst.setup, error: inst.error };
}

// --- public API (routes) --------------------------------------------------

export function listServers(sessionId: string): Promise<ServerRuntime[]> {
	const session = agentSessionOf(sessionId);
	if (!session) return Promise.resolve([]);
	const dev = devConfigOf(projectForSession(session));
	if (!dev) return Promise.resolve([]);
	return Promise.all((dev.servers ?? []).map((s) => computeRuntime(sessionId, s)));
}

// Setup (file copy + steps) then launch the dev pane. Run in the background so a
// slow setup (pnpm install, ...) doesn't block the request and its per-step
// progress is pollable live. A failed step short-circuits before launch. Bails
// without launching if superseded mid-flight (epoch changed by stop/restart/
// delete), so it can't double-launch or launch into a torn-down worktree.
async function bringUp(inst: Instance, ctx: ServerCtx, epoch: number) {
	try {
		if (!inst.setupComplete) {
			if (!(await runSetup(inst, ctx, epoch))) return;
			inst.setupComplete = true;
		}
		if (inst.stopRequested || inst.epoch !== epoch) return;
		await launch(inst, ctx);
	} catch (e) {
		if (inst.epoch === epoch) inst.error = e instanceof Error ? e.message : 'failed to start';
	} finally {
		if (inst.epoch === epoch) inst.starting = false;
	}
}

function seedSetup(inst: Instance, ctx: ServerCtx) {
	if (inst.setupComplete) return;
	inst.setupRunning = true; // so the immediate response already reads as 'setup'
	inst.setup = buildTasks(ctx, inst).map((t) => ({ label: t.label, state: 'pending' as const }));
}

export async function startServer(sessionId: string, serverName: string): Promise<ServerRuntime> {
	const { ctx, inst } = resolveInstance(sessionId, serverName);
	if (inst.starting) return computeRuntime(sessionId, ctx.server); // already coming up
	cancel(inst); // supersede anything stale; capture the fresh epoch
	const epoch = inst.epoch;
	inst.stopRequested = false;
	inst.starting = true;
	inst.error = undefined;
	seedSetup(inst, ctx);
	await killName(serverTmuxName(sessionId, serverName));
	void bringUp(inst, ctx, epoch);
	return computeRuntime(sessionId, ctx.server);
}

export async function stopServer(sessionId: string, serverName: string): Promise<ServerRuntime> {
	const { ctx, inst } = resolveInstance(sessionId, serverName);
	cancel(inst); // kill any in-flight setup child + supersede the bring-up
	inst.stopRequested = true;
	inst.starting = false;
	inst.setupRunning = false; // the cancelled setup is no longer running
	await killName(serverTmuxName(sessionId, serverName));
	return computeRuntime(sessionId, ctx.server);
}

// Relaunch the dev command only; setup is per-worktree and is never re-run here.
export async function restartServer(sessionId: string, serverName: string): Promise<ServerRuntime> {
	const { ctx, inst } = resolveInstance(sessionId, serverName);
	cancel(inst); // supersede any in-flight bring-up before we relaunch
	const epoch = inst.epoch;
	inst.stopRequested = false;
	inst.starting = true;
	try {
		await killName(serverTmuxName(sessionId, serverName));
		await launch(inst, ctx);
	} finally {
		if (inst.epoch === epoch) inst.starting = false;
	}
	return computeRuntime(sessionId, ctx.server);
}

// Kill a session's server panes by tmux-name prefix, so panes whose config was
// removed/renamed mid-run (no longer in dev.servers) are still swept.
async function killServerPanes(sessionId: string) {
	const prefix = `${SERVER_TMUX_PREFIX}${sessionId}-`;
	for (const t of await listTmuxSessions()) {
		if (t.name.startsWith(prefix)) await killTmuxSession(t.name);
	}
}

function dropInstances(sessionId: string) {
	const map = instances();
	const prefix = `${sessionId}:`;
	for (const k of [...map.keys()]) {
		if (!k.startsWith(prefix)) continue;
		cancel(map.get(k)!); // stop in-flight setup + supersede the bring-up
		map.delete(k);
	}
}

// Teardown for session/worktree deletion: cancel in-flight bring-ups, forget the
// instances, then kill every dev pane for the session.
export async function stopSessionServers(sessionId: string): Promise<void> {
	dropInstances(sessionId);
	await killServerPanes(sessionId);
}

interface LogResult {
	text?: string;
	cleared?: boolean;
	dead?: boolean;
	h?: string;
	unchanged?: boolean;
}

// A snapshot of a server's dev pane for the log view, with the same
// tag/unchanged round-trip as the terminal snapshot endpoint.
export async function serverLogs(
	sessionId: string,
	serverName: string,
	prevTag: string | null
): Promise<LogResult | null> {
	const ctx = resolveCtx(sessionId, serverName);
	if (!ctx) return null;
	const name = serverTmuxName(sessionId, serverName);
	const pane = await paneStatus(name);
	if (!pane) return { text: '(not running)', dead: true };
	const { text, cleared } = await stableSnapshot(name);
	const h = snapshotTag(text, cleared);
	if (prevTag === h) return { unchanged: true, h };
	return { text, cleared, dead: pane.dead, h };
}

// --- monitor poll + notifications ----------------------------------------

function serverStatusMap(): Map<string, ServerState> {
	const g = globalThis as { __deckServerStatus?: Map<string, ServerState> };
	return (g.__deckServerStatus ??= new Map());
}

function transitionNotice(rt: ServerRuntime): { title: string; body: string } | null {
	if (rt.state === 'errored') return { title: `Server errored · ${rt.name}`, body: rt.error ?? rt.name };
	if (rt.state === 'dead') return { title: `Server stopped · ${rt.name}`, body: rt.name };
	if (rt.state === 'running') return { title: `Server ready · ${rt.name}`, body: rt.previewUrl ?? rt.name };
	return null;
}

function maybeNotify(session: DeckSession, rt: ServerRuntime, before: ServerState | undefined) {
	if (!before) return; // first observation (or after a restart); don't spam
	if (before === rt.state) return;
	const notice = transitionNotice(rt);
	if (notice) notify({ ...notice, tag: key(session.id, rt.name), url: `/s/${session.id}` });
}

async function pollSession(session: DeckSession, prev: Map<string, ServerState>, seen: Set<string>) {
	const dev = devConfigOf(projectForSession(session));
	for (const server of dev?.servers ?? []) {
		const rt = await computeRuntime(session.id, server);
		const k = key(session.id, server.name);
		seen.add(k);
		maybeNotify(session, rt, prev.get(k));
		prev.set(k, rt.state);
	}
}

// Refresh every configured server's state and fire push notifications on
// errored / dead / ready transitions. Called from the monitor's 10s poll.
export async function pollServers(sessions: DeckSession[]): Promise<void> {
	const prev = serverStatusMap();
	const seen = new Set<string>();
	for (const session of sessions) {
		if (isAgentKind(session.kind)) await pollSession(session, prev, seen);
	}
	for (const k of [...prev.keys()]) if (!seen.has(k)) prev.delete(k);
}

// Per-session server states from the monitor's last poll (cheap, no fresh
// probing) for the sidebar dots and header chip.
export function cachedServerStates(): Record<string, ServerState[]> {
	const out: Record<string, ServerState[]> = {};
	for (const [k, state] of serverStatusMap()) {
		const id = k.slice(0, k.lastIndexOf(':'));
		(out[id] ??= []).push(state);
	}
	return out;
}
