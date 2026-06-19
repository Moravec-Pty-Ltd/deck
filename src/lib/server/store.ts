import type { DeckSession, IssueSource, Project } from '$lib/types';
import { readJson, writeJson } from './config';
import { invalidateIssues } from './issues/cache';

const SESSIONS_FILE = 'sessions.json';
const PROJECTS_FILE = 'projects.json';
const SECRETS_FILE = 'secrets.json';

export function listStoredSessions(): DeckSession[] {
	return readJson<DeckSession[]>(SESSIONS_FILE, []);
}

export function getStoredSession(id: string): DeckSession | undefined {
	return listStoredSessions().find((s) => s.id === id);
}

export function saveSession(session: DeckSession) {
	const sessions = listStoredSessions().filter((s) => s.id !== session.id);
	sessions.push(session);
	writeJson(SESSIONS_FILE, sessions);
}

export function updateSession(id: string, patch: Partial<DeckSession>): DeckSession | undefined {
	const sessions = listStoredSessions();
	const session = sessions.find((s) => s.id === id);
	if (!session) return undefined;
	Object.assign(session, patch);
	writeJson(SESSIONS_FILE, sessions);
	return session;
}

export function removeSession(id: string) {
	writeJson(
		SESSIONS_FILE,
		listStoredSessions().filter((s) => s.id !== id)
	);
}

export function listProjects(): Project[] {
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
	invalidateIssues(path);
}

// --- Issue sources (stored on the project, secrets kept separately) ---

export function addSource(projectPath: string, source: IssueSource): Project | undefined {
	const projects = listProjects();
	const project = projects.find((p) => p.path === projectPath);
	if (!project) return undefined;
	project.sources = [...(project.sources ?? []), source];
	writeJson(PROJECTS_FILE, projects);
	invalidateIssues(projectPath);
	return project;
}

export function removeSource(projectPath: string, sourceId: string): Project | undefined {
	const projects = listProjects();
	const project = projects.find((p) => p.path === projectPath);
	if (!project) return undefined;
	project.sources = (project.sources ?? []).filter((s) => s.id !== sourceId);
	writeJson(PROJECTS_FILE, projects);
	deleteSecret(sourceId);
	invalidateIssues(projectPath);
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
