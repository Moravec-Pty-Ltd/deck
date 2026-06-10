import { json, error } from '@sveltejs/kit';
import fs from 'node:fs';
import type { RequestHandler } from './$types';
import { listSessions, createSession } from '$lib/server/sessions';
import { createWorktree, isGitRepo } from '$lib/server/git';
import { startTurn } from '$lib/server/claude';

export const GET: RequestHandler = async () => {
	return json(await listSessions());
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { kind, title, model, permissionMode, command, prompt } = body;
	let cwd: string = body.cwd;

	if (!cwd || !fs.existsSync(cwd)) error(400, 'cwd does not exist');
	if (kind !== 'claude' && kind !== 'shell') error(400, 'invalid kind');

	if (body.worktree?.branch) {
		if (!(await isGitRepo(cwd))) error(400, 'worktree requested but cwd is not a git repo');
		cwd = await createWorktree(cwd, body.worktree.branch, {
			newBranch: body.worktree.newBranch,
			base: body.worktree.base || undefined
		});
	}

	const session = await createSession({
		kind,
		title: title || body.worktree?.branch,
		cwd,
		model,
		permissionMode,
		command
	});

	if (kind === 'claude' && typeof prompt === 'string' && prompt.trim()) {
		const resolved = prompt
			.replaceAll('[title]', session.title)
			.replaceAll('[branch]', body.worktree?.branch ?? '')
			.replaceAll('[cwd]', cwd);
		startTurn(session.id, resolved.trim());
	}

	return json(session, { status: 201 });
};
