import { describe, it, expect } from 'vitest';
import {
	parseNameStatus,
	parseNumstatRows,
	joinDiffFiles,
	diffStats,
	baseRefCandidates
} from './diff-core';

// Real `git diff --name-status -M -z` / `--numstat -M -z` output for one of each
// change kind: an added (untracked, intent-to-add) file, a modified binary, a
// deletion, a text modification, and a rename-with-edit.
const NAME_STATUS =
	'A\x00added.txt\x00M\x00bin.bin\x00D\x00del.txt\x00M\x00mod.txt\x00R080\x00rename-me.txt\x00renamed.txt\x00';
const NUMSTAT =
	'1\t0\tadded.txt\x00-\t-\tbin.bin\x000\t3\tdel.txt\x002\t1\tmod.txt\x001\t0\t\x00rename-me.txt\x00renamed.txt\x00';

describe('parseNameStatus', () => {
	it('reads status and path for each change kind', () => {
		expect(parseNameStatus(NAME_STATUS)).toEqual([
			{ status: 'added', path: 'added.txt' },
			{ status: 'modified', path: 'bin.bin' },
			{ status: 'deleted', path: 'del.txt' },
			{ status: 'modified', path: 'mod.txt' },
			{ status: 'renamed', path: 'renamed.txt', oldPath: 'rename-me.txt' }
		]);
	});

	it('is empty for an empty diff', () => {
		expect(parseNameStatus('')).toEqual([]);
	});
});

describe('parseNumstatRows', () => {
	it('reads counts, flags binary rows, and resolves rename paths to the new path', () => {
		expect(parseNumstatRows(NUMSTAT)).toEqual([
			{ path: 'added.txt', additions: 1, deletions: 0, binary: false },
			{ path: 'bin.bin', additions: 0, deletions: 0, binary: true },
			{ path: 'del.txt', additions: 0, deletions: 3, binary: false },
			{ path: 'mod.txt', additions: 2, deletions: 1, binary: false },
			{ path: 'renamed.txt', additions: 1, deletions: 0, binary: false }
		]);
	});

	it('handles a pure rename (0/0) with no content change', () => {
		expect(parseNumstatRows('0\t0\t\x00old.ts\x00new.ts\x00')).toEqual([
			{ path: 'new.ts', additions: 0, deletions: 0, binary: false }
		]);
	});
});

describe('joinDiffFiles', () => {
	it('joins status with counts on the new path, in git order', () => {
		expect(joinDiffFiles(NAME_STATUS, NUMSTAT)).toEqual([
			{ path: 'added.txt', status: 'added', additions: 1, deletions: 0, binary: false },
			{ path: 'bin.bin', status: 'modified', additions: 0, deletions: 0, binary: true },
			{ path: 'del.txt', status: 'deleted', additions: 0, deletions: 3, binary: false },
			{ path: 'mod.txt', status: 'modified', additions: 2, deletions: 1, binary: false },
			{
				path: 'renamed.txt',
				status: 'renamed',
				oldPath: 'rename-me.txt',
				additions: 1,
				deletions: 0,
				binary: false
			}
		]);
	});

	it('defaults counts to zero when a file is absent from numstat', () => {
		expect(joinDiffFiles('M\x00only.txt\x00', '')).toEqual([
			{ path: 'only.txt', status: 'modified', additions: 0, deletions: 0, binary: false }
		]);
	});
});

describe('diffStats', () => {
	it('sums counts and counts files (renames as one)', () => {
		expect(diffStats(joinDiffFiles(NAME_STATUS, NUMSTAT))).toEqual({
			fileCount: 5,
			additions: 4,
			deletions: 4
		});
	});

	it('is empty for no files', () => {
		expect(diffStats([])).toEqual({ fileCount: 0, additions: 0, deletions: 0 });
	});
});

describe('baseRefCandidates', () => {
	it('prefers the remote-tracking ref for a plain branch name, then the local branch', () => {
		expect(baseRefCandidates('main')).toEqual(['origin/main', 'main']);
	});

	it('prefixes branch names that contain slashes (e.g. release/2.0)', () => {
		expect(baseRefCandidates('release/2.0')).toEqual(['origin/release/2.0', 'release/2.0']);
	});

	it('uses an already remote-qualified base verbatim (no double-prefix)', () => {
		expect(baseRefCandidates('origin/main')).toEqual(['origin/main']);
	});

	it('uses a full refs/ ref verbatim', () => {
		expect(baseRefCandidates('refs/heads/main')).toEqual(['refs/heads/main']);
	});
});
