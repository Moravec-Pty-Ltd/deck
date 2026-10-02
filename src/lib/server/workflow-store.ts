// Durable state for workflow runs (issue #233): every run in ~/.deck/runs.json,
// read once at boot and written whole on each change (single user, a handful of
// runs). Workflow definitions come from ~/.deck/workflows.json merged over the
// built-ins, and the per-client loop settings from the dev-workflow skill's own
// clients.json, so there is no second config to keep in step with the skills.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, writeJson } from './config';
import { normalizeRun, resolveWorkflows, type ClientProfile } from './workflow-core';
import type { WorkflowDef, WorkflowRun } from '$lib/workflows';

const RUNS_FILE = 'runs.json';
const WORKFLOWS_FILE = 'workflows.json';

interface RunsFile {
	runs: WorkflowRun[];
	overseerId?: string;
}

// Survives HMR in dev so the runner and the routes share one copy.
const g = globalThis as { __deckRuns?: RunsFile };

function state(): RunsFile {
	if (!g.__deckRuns) {
		const raw = readJson<Partial<RunsFile>>(RUNS_FILE, {});
		const now = Date.now();
		const runs = Array.isArray(raw.runs) ? raw.runs.map((r) => normalizeRun(r, now)) : [];
		g.__deckRuns = { runs, overseerId: raw.overseerId };
	}
	return g.__deckRuns;
}

function persist(): void {
	writeJson(RUNS_FILE, state());
}

export function listRuns(): WorkflowRun[] {
	return state().runs;
}

export function getRun(id: string): WorkflowRun | undefined {
	return state().runs.find((r) => r.id === id);
}

// Insert or replace a run and write the file.
export function saveRun(run: WorkflowRun): void {
	const s = state();
	const i = s.runs.findIndex((r) => r.id === run.id);
	if (i === -1) s.runs.push(run);
	else s.runs[i] = run;
	persist();
}

// Remove runs by id with one write.
export function removeRuns(ids: readonly string[]): void {
	const s = state();
	s.runs = s.runs.filter((r) => !ids.includes(r.id));
	persist();
}

export function overseerId(): string | undefined {
	return state().overseerId;
}

export function setOverseerId(id: string | undefined): void {
	state().overseerId = id;
	persist();
}

export function loadWorkflows(): { workflows: WorkflowDef[]; problems: string[] } {
	return resolveWorkflows(readJson<unknown>(WORKFLOWS_FILE, {}));
}

// The skill's client profiles with the local overlay merged over them, the
// same top-level merge the skill does. A fixed, known file outside the project
// set, read only; absent or unreadable means no profiles.
const PROFILE_DIR = path.join(os.homedir(), '.claude', 'skills', 'dev-workflow-common');

function readProfiles(file: string): Record<string, ClientProfile> {
	try {
		return JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, file), 'utf8'));
	} catch {
		return {};
	}
}

export function loadProfiles(): Record<string, ClientProfile> {
	return { ...readProfiles('clients.json'), ...readProfiles('clients.local.json') };
}
