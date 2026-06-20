import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { isFlagSafe } from './agents/args';

const exec = promisify(execFile);

async function git(repo: string, ...args: string[]): Promise<string> {
	const { stdout } = await exec('git', ['-C', repo, ...args]);
	return stdout;
}

export async function isGitRepo(dir: string): Promise<boolean> {
	try {
		await git(dir, 'rev-parse', '--git-dir');
		return true;
	} catch {
		return false;
	}
}

export async function listBranches(repo: string): Promise<string[]> {
	const out = await git(repo, 'branch', '-a', '--format', '%(refname:short)');
	const branches = out
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((b) => b.replace(/^origin\//, ''))
		.filter((b) => b !== 'HEAD' && !b.includes(' '));
	return [...new Set(branches)];
}

export interface WorktreeEntry {
	path: string;
	branch: string;
	isMain: boolean;
}

// Existing worktrees for a repo, parsed from `git worktree list --porcelain`.
// The first entry git reports is the main working tree (the repo itself).
export async function listWorktrees(repo: string): Promise<WorktreeEntry[]> {
	let out: string;
	try {
		out = await git(repo, 'worktree', 'list', '--porcelain');
	} catch {
		return [];
	}
	const entries: WorktreeEntry[] = [];
	let current: { path?: string; branch?: string } = {};
	const flush = () => {
		if (current.path) {
			entries.push({
				path: current.path,
				branch: current.branch ?? '(detached)',
				isMain: entries.length === 0
			});
		}
		current = {};
	};
	for (const line of out.split('\n')) {
		if (line.startsWith('worktree ')) {
			flush();
			current.path = line.slice('worktree '.length).trim();
		} else if (line.startsWith('branch ')) {
			current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
		}
	}
	flush();
	return entries;
}

// Build the `git worktree add` argv. Positional args (the worktree dir and the
// branch/base ref) go after `--` so none can be read as an option even if an
// upstream guard is missed.
export function worktreeAddArgs(
	dir: string,
	branch: string,
	opts: { newBranch?: boolean; base?: string }
): string[] {
	if (!opts.newBranch) return ['worktree', 'add', '--', dir, branch];
	const args = ['worktree', 'add', '-b', branch, '--', dir];
	if (opts.base) args.push(opts.base);
	return args;
}

// Worktrees land next to the repo: <repo>-worktrees/<branch>
export async function createWorktree(
	repo: string,
	branch: string,
	opts: { newBranch?: boolean; base?: string } = {}
): Promise<string> {
	// branch/base reach git as ref arguments; a value starting with `-` would be
	// parsed as a flag (the class isFlagSafe guards elsewhere), and `.`/`..`
	// survive the dir sanitiser as path segments. Reject crafted refs, keep the
	// worktree dir a direct child of the -worktrees root, and pass positionals
	// after `--` (see worktreeAddArgs).
	if (!isFlagSafe(branch)) throw new Error(`unsafe branch name: ${branch}`);
	if (opts.base !== undefined && !isFlagSafe(opts.base))
		throw new Error(`unsafe base branch: ${opts.base}`);
	const safe = branch.replace(/[^a-zA-Z0-9._/-]/g, '-').replace(/\//g, '-');
	const worktrees = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`);
	const dir = path.join(worktrees, safe);
	if (!dir.startsWith(worktrees + path.sep)) throw new Error(`unsafe branch name: ${branch}`);
	if (fs.existsSync(dir)) return dir;
	fs.mkdirSync(path.dirname(dir), { recursive: true });
	await git(repo, ...worktreeAddArgs(dir, branch, opts));
	return dir;
}

export async function removeWorktree(
	repo: string,
	worktreeDir: string,
	opts: { deleteBranch?: boolean; branch?: string } = {}
) {
	// --force: drop the worktree even with uncommitted changes (user opted in)
	await git(repo, 'worktree', 'remove', '--force', worktreeDir);
	if (opts.deleteBranch && opts.branch) {
		try {
			await git(repo, 'branch', '-D', opts.branch);
		} catch {
			// branch may be checked out elsewhere or already gone — non-fatal
		}
	}
}
