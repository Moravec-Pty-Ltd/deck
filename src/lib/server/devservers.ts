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
import { listProjects, getStoredSession, listStoredSessions } from './store';
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
	warning?: string; // non-fatal: a port is held by a process deck didn't start
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
function runShell(
	command: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	inst: Instance
): Promise<StepResult> {
	return new Promise((resolve) => {
		// detached so the step leads its own process group; cancel kills the group.
		const child = spawn(command, [], { cwd, env, shell: true, detached: true });
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

// A resolved cwd that doesn't exist makes spawn fail with the opaque
// `spawn /bin/sh ENOENT` (node blames the shell, not the missing dir). Check
// first so a bad step/server cwd reports which directory is actually missing.
function isDir(p: string): boolean {
	return fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

// Env exposed to setup steps and the dev command so a script can reference the
// session worktree (and the project's main checkout) without hardcoding an
// absolute path — e.g. `cp "$DECK_MAIN/x" "$DECK_WORKTREE/x"`. Merged over the
// child's inherited env (setup steps) / seeded into the tmux pane (server).
function devEnv(ctx: ServerCtx): Record<string, string> {
	return { DECK_WORKTREE: path.resolve(ctx.worktree), DECK_MAIN: path.resolve(ctx.mainPath) };
}

function shellTask(step: SetupStep, ctx: ServerCtx, inst: Instance): Task {
	return {
		label: step.label,
		exec: () => {
			const cwd = confineRelative(ctx.worktree, step.cwd ?? '.');
			if (!cwd) return Promise.resolve({ code: 1, output: `cwd escapes worktree: ${step.cwd}` });
			if (!isDir(cwd))
				return Promise.resolve({ code: 1, output: `working directory does not exist: ${cwd}` });
			return runShell(step.run, cwd, { ...process.env, ...devEnv(ctx) }, inst);
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
	for (const s of ctx.dev.setup ?? []) tasks.push(shellTask(s, ctx, inst));
	for (const s of ctx.server.setup ?? []) tasks.push(shellTask(s, ctx, inst));
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

function portsOf(server: ServerSpec): number[] {
	return (server.ports ?? []).map((p) => p.port);
}

// Every deck-managed server across all agent sessions, with its tmux name and
// declared ports. Derived from config (not live tmux) so a sanitized pane name
// never has to be reversed back to a server name. The authoritative set for
// spotting a port squatter: the same fixed-port server left running in another
// worktree, or any server that shares a port.
function allDeckServers(): { sessionId: string; server: ServerSpec; tmuxName: string }[] {
	const out: { sessionId: string; server: ServerSpec; tmuxName: string }[] = [];
	for (const session of listStoredSessions()) {
		if (!isAgentKind(session.kind)) continue;
		for (const server of devConfigOf(projectForSession(session))?.servers ?? []) {
			out.push({ sessionId: session.id, server, tmuxName: serverTmuxName(session.id, server.name) });
		}
	}
	return out;
}

// Kill any *other* live deck server whose ports overlap ours, so a fixed-port
// server can move between worktrees without a manual stop first. Returns the
// ports we reclaimed, excluded from the external probe below since the just-
// killed process may not have released them yet.
async function killPortConflicts(self: ServerCtx): Promise<Set<number>> {
	const mine = new Set(portsOf(self.server));
	const reclaimed = new Set<number>();
	if (!mine.size) return reclaimed;
	const live = new Set((await listTmuxSessions()).map((t) => t.name));
	for (const ref of allDeckServers()) {
		if (ref.sessionId === self.sessionId && ref.server.name === self.server.name) continue;
		if (!live.has(ref.tmuxName)) continue;
		const overlap = portsOf(ref.server).filter((p) => mine.has(p));
		if (!overlap.length) continue;
		const other = getInstance(ref.sessionId, ref.server.name);
		// Same teardown as stopServer: cancel supersedes its bring-up, but its own
		// finally won't clear flags once the epoch moved, so reset them here (and set
		// stopRequested) or the killed server would read as perpetually 'starting'.
		cancel(other);
		other.stopRequested = true;
		other.starting = false;
		other.setupRunning = false;
		other.launched = false;
		await killName(ref.tmuxName);
		overlap.forEach((p) => reclaimed.add(p));
	}
	return reclaimed;
}

// A port still listening once deck's own conflicts are cleared is held by a
// process deck didn't start — surface it rather than killing an arbitrary
// process. Skips just-reclaimed ports (their old owner may still be exiting).
async function externalPortConflict(self: ServerCtx, reclaimed: Set<number>): Promise<string | undefined> {
	const busy: number[] = [];
	for (const p of portsOf(self.server)) {
		if (!reclaimed.has(p) && (await probePort(p))) busy.push(p);
	}
	if (!busy.length) return undefined;
	return `port ${busy.join(', ')} already in use by a process deck didn't start; the server may fail to bind`;
}

async function launch(inst: Instance, ctx: ServerCtx) {
	const name = serverTmuxName(ctx.sessionId, ctx.server.name);
	const cwd = confineRelative(ctx.worktree, ctx.server.cwd ?? '.');
	if (!cwd) throw new Error(`server cwd escapes worktree: ${ctx.server.cwd}`);
	if (!isDir(cwd)) throw new Error(`server working directory does not exist: ${cwd}`);
	const reclaimed = await killPortConflicts(ctx);
	inst.warning = await externalPortConflict(ctx, reclaimed);
	await createDevPane(name, cwd, ctx.server.run, devEnv(ctx));
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
	// The ports are bound now, so a launch-time "port in use" warning is stale:
	// clear it rather than leave it lingering on a server that reads as running.
	inst.warning = undefined;
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
	return {
		name: server.name,
		state,
		tmuxName,
		ports,
		previewUrl: inst.previewUrl,
		setup: inst.setup,
		error: inst.error,
		warning: inst.warning
	};
}

// --- public API (routes) --------------------------------------------------

export function listServers(sessionId: string): Promise<ServerRuntime[]> {
	const session = agentSessionOf(sessionId);
	if (!session) return Promise.resolve([]);
	const dev = devConfigOf(projectForSession(session));
	if (!dev) return Promise.resolve([]);
	return Promise.all((dev.servers ?? []).map((s) => computeRuntime(sessionId, s)));
}

// An in-flight bring-up is superseded when a stop/restart/delete bumped the epoch
// or requested a stop, so it must not launch.
function superseded(inst: Instance, epoch: number): boolean {
	return inst.stopRequested || inst.epoch !== epoch;
}

// Record a failure only if we still own the bring-up; a superseding action that
// moved the epoch owns its own error/flag state.
function failIfCurrent(inst: Instance, epoch: number, e: unknown) {
	if (inst.epoch !== epoch) return;
	inst.error = e instanceof Error ? e.message : 'failed to start';
}

// Run the setup work, then (re)launch unless it failed/was superseded or the
// caller asked not to relaunch (a re-run of a server that wasn't running).
async function runThenLaunch(
	inst: Instance,
	ctx: ServerCtx,
	epoch: number,
	prepare: () => Promise<boolean>,
	relaunch: boolean
) {
	if (!(await prepare())) return;
	if (!relaunch) return;
	if (superseded(inst, epoch)) return;
	await launch(inst, ctx);
}

// Shared bring-up driver: run `prepare` (setup work) then conditionally launch,
// with epoch-guarded error capture and the starting-flag teardown. Run in the
// background so a slow setup (pnpm install, ...) doesn't block the request and its
// per-step progress is pollable live. Bails without launching if superseded
// mid-flight, so it can't double-launch or launch into a torn-down worktree.
async function orchestrate(
	inst: Instance,
	ctx: ServerCtx,
	epoch: number,
	prepare: () => Promise<boolean>,
	relaunch: boolean
) {
	try {
		await runThenLaunch(inst, ctx, epoch, prepare, relaunch);
	} catch (e) {
		failIfCurrent(inst, epoch, e);
	} finally {
		if (inst.epoch === epoch) inst.starting = false;
	}
}

// Run setup unless it's already complete for this worktree; mark it complete on
// success. false => failed or superseded (don't launch).
async function prepareSetup(inst: Instance, ctx: ServerCtx, epoch: number): Promise<boolean> {
	if (inst.setupComplete) return true;
	if (!(await runSetup(inst, ctx, epoch))) return false;
	inst.setupComplete = true;
	return true;
}

function bringUp(inst: Instance, ctx: ServerCtx, epoch: number): Promise<void> {
	return orchestrate(inst, ctx, epoch, () => prepareSetup(inst, ctx, epoch), true);
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
	inst.warning = undefined;
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
	inst.warning = undefined;
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
	inst.error = undefined; // don't leak a prior failure into the relaunch
	inst.warning = undefined;
	try {
		await killName(serverTmuxName(sessionId, serverName));
		await launch(inst, ctx);
	} finally {
		if (inst.epoch === epoch) inst.starting = false;
	}
	return computeRuntime(sessionId, ctx.server);
}

// --- re-run setup (full re-standup or a single step) ----------------------

// Whether a server's dev pane is currently live (started, not exited). A re-run
// relaunches only a server that was alive, so a stopped one stays stopped.
async function isPaneAlive(name: string): Promise<boolean> {
	const pane = await paneStatus(name);
	return !!pane && !pane.dead;
}

// Reject a re-run while a bring-up/setup is already in flight for this server; the
// existing cancel/epoch supersede still covers concurrent stop/restart/delete.
function rejectIfBusy(inst: Instance) {
	if (inst.starting || inst.setupRunning)
		throw new Error('a setup or start is already in progress for this server');
}

// Stop the server and flip it to a fresh setup epoch, returning the epoch and
// whether the pane was alive (so only a running server is relaunched after). A
// server that wasn't running keeps stopRequested set, so it reads as stopped (not
// dead) once the re-run finishes.
async function beginRerun(inst: Instance, ctx: ServerCtx): Promise<{ epoch: number; wasAlive: boolean }> {
	const name = serverTmuxName(ctx.sessionId, ctx.server.name);
	// Claim the bring-up synchronously, before the first await, so a concurrent
	// re-run is rejected by rejectIfBusy; supersede anything stale + capture the epoch.
	cancel(inst);
	inst.starting = true;
	inst.error = undefined;
	inst.warning = undefined;
	try {
		const wasAlive = await isPaneAlive(name);
		inst.stopRequested = !wasAlive; // a server that wasn't running stays stopped, not dead
		await killName(name);
		return { epoch: inst.epoch, wasAlive };
	} catch (e) {
		inst.starting = false; // a probe/kill failure must not strand the server as 'starting'
		throw e;
	}
}

// Force the full standup, ignoring a prior setupComplete; re-mark complete on
// success. false => failed or superseded (don't relaunch).
async function prepareResetup(inst: Instance, ctx: ServerCtx, epoch: number): Promise<boolean> {
	const wasComplete = inst.setupComplete;
	inst.setupComplete = false; // a re-run re-derives completion from scratch
	const ok = await runSetup(inst, ctx, epoch);
	if (ok) inst.setupComplete = true;
	// Superseded (a stop/restart bumped the epoch) rather than failed: restore the
	// prior flag so the abandoned re-run doesn't force a needless setup next start.
	else if (inst.epoch !== epoch) inst.setupComplete = wasComplete;
	return ok;
}

// Keep the progress list aligned with the current task list so a single-step index
// maps to the right row; only reshape it when the config changed under us.
function ensureSetupShape(inst: Instance, tasks: Task[]) {
	if (inst.setup.length === tasks.length) return;
	inst.setup = tasks.map((t) => ({ label: t.label, state: 'pending' as const }));
}

// Run one task, recording its progress; leaves setupComplete untouched (a one-off,
// not a completion). false => superseded or the step failed (don't relaunch).
async function prepareStep(inst: Instance, tasks: Task[], index: number, epoch: number): Promise<boolean> {
	if (inst.epoch !== epoch) return false;
	ensureSetupShape(inst, tasks);
	inst.setupRunning = true;
	inst.error = undefined;
	try {
		return await runOneStep(inst, tasks, index);
	} finally {
		inst.setupRunning = false;
	}
}

// Resolve the task a single-step re-run names, rejecting a stale index or a label
// that no longer matches the live task list (the config changed since the page was
// rendered), so a stale per-step click is a clean error rather than the wrong step.
function resolveStepTask(tasks: Task[], index: number, label?: string): Task {
	const task = tasks[index];
	if (!task) throw new Error(`no setup step at index ${index}`);
	if (label !== undefined && task.label !== label)
		throw new Error('setup steps changed since the page loaded; re-run setup to refresh');
	return task;
}

// Shared re-run tail: stop, run `prepare` in the background, relaunch if the server
// was alive. Supersede-safe via the epoch captured in beginRerun.
async function rerun(
	ctx: ServerCtx,
	inst: Instance,
	prepare: (epoch: number) => Promise<boolean>
): Promise<ServerRuntime> {
	const { epoch, wasAlive } = await beginRerun(inst, ctx);
	void orchestrate(inst, ctx, epoch, () => prepare(epoch), wasAlive);
	return computeRuntime(ctx.sessionId, ctx.server);
}

// Force a complete re-standup (copy + all steps) ignoring setupComplete, then
// relaunch the server if it was running. Rejected if a bring-up is already in
// flight for the server.
export async function resetupServer(sessionId: string, serverName: string): Promise<ServerRuntime> {
	const { ctx, inst } = resolveInstance(sessionId, serverName);
	rejectIfBusy(inst);
	return rerun(ctx, inst, (epoch) => prepareResetup(inst, ctx, epoch));
}

// Run a single setup step by index into the freshly-built task list (the copy task
// first when present, then shared setup, then the server's own), then relaunch the
// server if it was running. `label` (when given) must still match the task at that
// index. Rejected if a bring-up is in flight or the index is out of range.
export async function runSetupStep(
	sessionId: string,
	serverName: string,
	index: number,
	label?: string
): Promise<ServerRuntime> {
	const { ctx, inst } = resolveInstance(sessionId, serverName);
	rejectIfBusy(inst);
	const tasks = buildTasks(ctx, inst);
	resolveStepTask(tasks, index, label); // validate index + label before we stop the server
	return rerun(ctx, inst, (epoch) => prepareStep(inst, tasks, index, epoch));
}

// Kill a session's server panes by tmux-name prefix, so panes whose config was
// removed/renamed mid-run (no longer in dev.servers) are still swept.
async function killServerPanes(sessionId: string) {
	const prefix = `${SERVER_TMUX_PREFIX}${sessionId}-`;
	for (const t of await listTmuxSessions()) {
		if (!t.name.startsWith(prefix)) continue;
		try {
			await killTmuxSession(t.name);
		} catch {
			// best-effort sweep: one failed kill must not strand the rest
		}
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
