import type { DiffFile, DiffFileStatus } from '$lib/diff';

// Pure parsing for the worktree diff's per-file summary: join `git diff
// --name-status` (status letter + rename detection) with `git diff --numstat`
// (per-file line counts). Both are read with `-M -z`, so paths are raw (never
// escaped) and renames collapse to a single entry. Node-free; the git/fs
// orchestration that feeds it lives in the sibling git.ts.

export interface DiffStats {
	fileCount: number;
	additions: number;
	deletions: number;
}

interface NameStatusEntry {
	status: DiffFileStatus;
	path: string;
	oldPath?: string;
}

interface NumstatRow {
	path: string;
	additions: number;
	deletions: number;
	binary: boolean;
}

function statusFromCode(code: string): DiffFileStatus {
	switch (code[0]) {
		case 'A':
			return 'added';
		case 'D':
			return 'deleted';
		case 'R':
		case 'C':
			return 'renamed';
		default:
			// M (modified), T (type change), and anything else read as a modification.
			return 'modified';
	}
}

// Parse `git diff --name-status -M -z`: NUL-separated fields where A/M/D take one
// path and R/C (rename/copy) take two (old then new).
export function parseNameStatus(out: string): NameStatusEntry[] {
	const fields = out.split('\0');
	const entries: NameStatusEntry[] = [];
	let i = 0;
	while (i < fields.length) {
		const code = fields[i];
		if (!code) {
			i++;
			continue;
		}
		if (code[0] === 'R' || code[0] === 'C') {
			entries.push({ status: 'renamed', oldPath: fields[i + 1], path: fields[i + 2] });
			i += 3;
		} else {
			entries.push({ status: statusFromCode(code), path: fields[i + 1] });
			i += 2;
		}
	}
	return entries;
}

// Parse `git diff --numstat -M -z`: each row is `add \t del \t path`; a rename
// leaves the path empty and follows with two NUL fields (old then new); a binary
// file reports `-` for both counts.
export function parseNumstatRows(out: string): NumstatRow[] {
	const fields = out.split('\0');
	const rows: NumstatRow[] = [];
	let i = 0;
	while (i < fields.length) {
		const field = fields[i];
		const tab1 = field ? field.indexOf('\t') : -1;
		if (tab1 === -1) {
			i++;
			continue;
		}
		const tab2 = field.indexOf('\t', tab1 + 1);
		const addStr = field.slice(0, tab1);
		const delStr = field.slice(tab1 + 1, tab2);
		let path = field.slice(tab2 + 1);
		if (path === '') {
			// rename/copy: the new path is the second of the two trailing fields
			path = fields[i + 2];
			i += 3;
		} else {
			i += 1;
		}
		const binary = addStr === '-' || delStr === '-';
		rows.push({
			path,
			additions: binary ? 0 : Number(addStr) || 0,
			deletions: binary ? 0 : Number(delStr) || 0,
			binary
		});
	}
	return rows;
}

// Join name-status (authoritative status + paths) with numstat (per-file counts)
// on the new path, preserving git's file order so the list lines up with the patch.
export function joinDiffFiles(nameStatus: string, numstat: string): DiffFile[] {
	const counts = new Map<string, NumstatRow>();
	for (const row of parseNumstatRows(numstat)) counts.set(row.path, row);
	return parseNameStatus(nameStatus).map((entry) => {
		const n = counts.get(entry.path);
		const file: DiffFile = {
			path: entry.path,
			status: entry.status,
			additions: n?.additions ?? 0,
			deletions: n?.deletions ?? 0,
			binary: n?.binary ?? false
		};
		if (entry.oldPath !== undefined) file.oldPath = entry.oldPath;
		return file;
	});
}

// Ordered refs to try as the diff base for a stored base branch name. A plain
// branch name prefers its remote-tracking form (origin/<base>): the ref GitHub
// diffs the PR against, which stays current even when local <base> has drifted
// behind. It then falls back to the local branch (offline, or a local-only base
// with no remote). An already-qualified base (an origin/ prefix or a full
// refs/ ref) is used verbatim, never double-prefixed.
export function baseRefCandidates(base: string): string[] {
	if (base.startsWith('origin/') || base.startsWith('refs/')) return [base];
	return [`origin/${base}`, base];
}

// Totals for the summary badge, summed from the file list so badge and rows agree.
export function diffStats(files: DiffFile[]): DiffStats {
	let additions = 0;
	let deletions = 0;
	for (const file of files) {
		additions += file.additions;
		deletions += file.deletions;
	}
	return { fileCount: files.length, additions, deletions };
}
