import type { DeckSession, IssueSource, Project } from '$lib/types';
import { readJson, writeJson } from './config';
import { invalidateIssues } from './issues/cache';
import { invalidatePrs } from './prs';
import { DEMO, demoProjects } from './demo';

const SESSIONS_FILE = 'sessions.json';
const PROJECTS_FILE = 'projects.json';
const SECRETS_FILE = 'secrets.json';

// In-memory cache of the sessions store. This module is the sole writer of
// sessions.json, so every mutation here invalidates the cache and reads
// repopulate it lazily. Avoids a full readFileSync + JSON.parse on each poll,
// which the session list and monitor hit constantly (see #9).
let sessionsCache: DeckSession[] | null = null;
let sessionsById: Map<string, DeckSession> | null = null;

// sessions.ts hooks its own list memo here so any store write also drops it,
// without store.ts importing sessions.ts (that would be an import cycle).
let onSessionsMutated: (() => void) | null = null;
export function setSessionsMutatedHook(cb: () => void) {
	onSessionsMutated = cb;
}

function loadSessions(): DeckSession[] {
	if (!sessionsCache) {
		sessionsCache = readJson<DeckSession[]>(SESSIONS_FILE, []);
		sessionsById = new Map(sessionsCache.map((s) => [s.id, s]));
	}
	return sessionsCache;
}

function writeSessions(sessions: DeckSession[]) {
	writeJson(SESSIONS_FILE, sessions);
	sessionsCache = null;
	sessionsById = null;
	onSessionsMutated?.();
}

// Returns the shared cached array; callers must treat it (and its sessions) as
// read-only and mutate only through updateSession/saveSession/removeSession,
// which is the contract the in-memory cache relies on.
export function listStoredSessions(): DeckSession[] {
	return loadSessions();
}

export function getStoredSession(id: string): DeckSession | undefined {
	loadSessions();
	return sessionsById!.get(id);
}

export function saveSession(session: DeckSession) {
	const sessions = loadSessions().filter((s) => s.id !== session.id);
	sessions.push(session);
	writeSessions(sessions);
}

export function updateSession(id: string, patch: Partial<DeckSession>): DeckSession | undefined {
	const sessions = loadSessions();
	const session = sessions.find((s) => s.id === id);
	if (!session) return undefined;
	Object.assign(session, patch);
	writeSessions(sessions);
	return session;
}

export function removeSession(id: string) {
	writeSessions(loadSessions().filter((s) => s.id !== id));
}

// Volatile run status, written on every message_start and turn boundary. The
// list/SSE read path derives running/idle live from the process map (see
// sessions.ts agentStatus), so a persisted `running` is never trusted across a
// read. That lets the hot per-message_start flip stay in memory: mutate the
// cached record in place and bust the list memo so the new lastActiveAt shows up
// on the next poll, but don't rewrite sessions.json. Only the terminal
// idle/error states are flushed (they clear a prior error and survive a
// restart). A later write of the whole array can still carry an in-memory
// `running` to disk, which is harmless because the read path downgrades it.
export function setSessionStatus(
	id: string,
	status: 'running' | 'idle' | 'error',
	lastActiveAt: number
) {
	loadSessions();
	const session = sessionsById!.get(id);
	if (!session) return;
	Object.assign(session, { status, lastActiveAt });
	if (status === 'running') onSessionsMutated?.();
	else writeSessions(sessionsCache!);
}

// Drop both on-demand caches for a project (issues + PRs) after a source/project
// mutation so neither keeps serving a stale list for the rest of its TTL window.
function invalidateProjectCaches(projectPath: string) {
	invalidateIssues(projectPath);
	invalidatePrs(projectPath);
}

export function listProjects(): Project[] {
	if (DEMO) return demoProjects();
	return readJson<Project[]>(PROJECTS_FILE, []);
}

export function addProject(project: Project) {
	const projects = listProjects().filter((p) => p.path !== project.path);
	projects.push(project);
	projects.sort((a, b) => a.name.localeCompare(b.name));
	writeJson(PROJECTS_FILE, projects);
}

// Merge a patch into an existing project (preserves other fields).
export function updateProject(path: string, patch: Partial<Project>): Project | undefined {
	const projects = listProjects();
	const project = projects.find((p) => p.path === path);
	if (!project) return undefined;
	Object.assign(project, patch);
	writeJson(PROJECTS_FILE, projects);
	return project;
}

export function removeProject(path: string) {
	const project = listProjects().find((p) => p.path === path);
	// Persist the removal first; only then drop the sources' secrets, so a failed
	// write can't strand a still-listed project with its keys already gone.
	writeJson(
		PROJECTS_FILE,
		listProjects().filter((p) => p.path !== path)
	);
	for (const s of project?.sources ?? []) deleteSecret(s.id);
	invalidateProjectCaches(path);
}

// --- Issue sources (stored on the project, secrets kept separately) ---

export function addSource(projectPath: string, source: IssueSource): Project | undefined {
	const projects = listProjects();
	const project = projects.find((p) => p.path === projectPath);
	if (!project) return undefined;
	project.sources = [...(project.sources ?? []), source];
	writeJson(PROJECTS_FILE, projects);
	invalidateProjectCaches(projectPath);
	return project;
}

export function removeSource(projectPath: string, sourceId: string): Project | undefined {
	const projects = listProjects();
	const project = projects.find((p) => p.path === projectPath);
	if (!project) return undefined;
	project.sources = (project.sources ?? []).filter((s) => s.id !== sourceId);
	writeJson(PROJECTS_FILE, projects);
	deleteSecret(sourceId);
	invalidateProjectCaches(projectPath);
	return project;
}

// --- Secrets (~/.deck/secrets.json, keyed by source id) ---
// Linear/ClickUp API keys live here, never in projects.json, mirroring the way
// `token` / `vapid.json` sit apart from the project + session stores.

type SecretsFile = Record<string, { apiKey: string }>;

export function readSecret(sourceId: string): string | undefined {
	return readJson<SecretsFile>(SECRETS_FILE, {})[sourceId]?.apiKey;
}

export function setSecret(sourceId: string, apiKey: string) {
	const secrets = readJson<SecretsFile>(SECRETS_FILE, {});
	secrets[sourceId] = { apiKey };
	// 0o600 — API keys must not be world/group readable (cf. the auth token).
	writeJson(SECRETS_FILE, secrets, 0o600);
}

function deleteSecret(sourceId: string) {
	const secrets = readJson<SecretsFile>(SECRETS_FILE, {});
	if (!(sourceId in secrets)) return;
	delete secrets[sourceId];
	writeJson(SECRETS_FILE, secrets, 0o600);
}
