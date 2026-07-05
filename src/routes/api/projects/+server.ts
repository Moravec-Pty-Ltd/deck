import { json, error } from '@sveltejs/kit';
import fs from 'node:fs';
import path from 'node:path';
import type { RequestHandler } from './$types';
import type { DevConfig, Project, Workflow } from '$lib/types';
import { listProjects, addProject, removeProject } from '$lib/server/store';
import { expandTilde } from '$lib/server/fsutil';
import { parseDevConfig } from '$lib/server/devservers-core';
import { parseWorkflows } from '$lib/workflows-core';

// Validate the dev-server config when present; carry the existing one across an
// edit that doesn't touch it (the form sends the whole object when it does). A
// bad config is a 400, not a 500.
function resolveDev(body: { dev?: unknown }, existing: DevConfig | undefined): DevConfig | undefined {
	if (body.dev === undefined) return existing;
	try {
		return parseDevConfig(body.dev);
	} catch (e) {
		error(400, e instanceof Error ? e.message : 'invalid dev config');
	}
}

// Carry an optional string field across a save that omits it, so a form that
// doesn't own the field can't clear it; a provided blank clears, and a
// malformed value is a 400 rather than a silent wipe.
function carryStr(v: unknown, existing: string | undefined, label: string): string | undefined {
	if (v === undefined) return existing;
	if (typeof v !== 'string') error(400, `${label} must be a string`);
	return v.trim() || undefined;
}

// An empty workflows list is stored as absent, falling back to the legacy
// template/reviewPrompt synthesis (see workflows-core.ts).
function nonEmpty(workflows: Workflow[]): Workflow[] | undefined {
	return workflows.length ? workflows : undefined;
}

// Validate configured workflows when sent; carry the existing list across a
// save that omits it (the main card and other forms never send `workflows`).
function resolveWorkflowsField(
	body: { workflows?: unknown },
	existing: Workflow[] | undefined
): Workflow[] | undefined {
	if (body.workflows === undefined) return existing;
	try {
		return nonEmpty(parseWorkflows(body.workflows));
	} catch (e) {
		error(400, e instanceof Error ? e.message : 'invalid workflows');
	}
}

export const GET: RequestHandler = async () => {
	return json(listProjects());
};

// A trimmed optional string field: blank/absent/non-string all mean "unset".
function optStr(v: unknown): string | undefined {
	return typeof v === 'string' ? v.trim() || undefined : undefined;
}

function resolveDir(body: { path?: unknown }): string {
	const dir = expandTilde(String(body.path ?? '').trim()).replace(/\/+$/, '');
	if (!dir || !isDirectory(dir)) error(400, 'path is not a directory');
	return dir;
}

function isDirectory(dir: string): boolean {
	return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
}

// Build the stored project from the request. Sources are managed through
// /api/projects/sources, never sent in this body, so carry the existing
// project's sources across an edit; every optional field likewise carries
// when omitted, so a form only overwrites what it actually sends.
function buildProject(body: Record<string, unknown>, dir: string): Project {
	const existing: Partial<Project> = listProjects().find((p) => p.path === dir) ?? {};
	return {
		name: optStr(body.name) || path.basename(dir),
		path: dir,
		group: carryStr(body.group, existing.group, 'group'),
		template: carryStr(body.template, existing.template, 'template'),
		reviewPrompt: carryStr(body.reviewPrompt, existing.reviewPrompt, 'reviewPrompt'),
		lastBase: carryStr(body.lastBase, existing.lastBase, 'lastBase'),
		sources: existing.sources,
		dev: resolveDev(body, existing.dev),
		workflows: resolveWorkflowsField(body, existing.workflows)
	};
}

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const dir = resolveDir(body);
	const project = buildProject(body, dir);
	addProject(project);
	return json(project, { status: 201 });
};

export const DELETE: RequestHandler = async ({ url }) => {
	const dir = url.searchParams.get('path');
	if (!dir) error(400, 'path required');
	removeProject(dir);
	return json({ ok: true });
};
