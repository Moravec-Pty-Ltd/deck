// Turning a requested branch name into something git will take as a ref.
// Sessions are conventionally named after the issue they came from, and a
// GitHub issue id is `owner/repo#number`: fine as a title, not as a ref, and
// not as the worktree directory that has to match it.

const MAX_LENGTH = 100;

// Everything git disallows in a ref (whitespace, control chars, `~^:?*[\`,
// `@{`, ...) falls outside this set, and so does `/`: the worktree dir is a
// flat child of the -worktrees root, so keeping slashes out of the ref is what
// lets the branch and the directory be the same string.
const UNSAFE = /[^A-Za-z0-9._-]+/g;

// Git rejects a ref that starts or ends with `.`, and a stray leading/trailing
// dash reads as a flag.
const trimEnds = (s: string) => s.replace(/^[-.]+/, '').replace(/[-.]+$/, '');

// A valid git branch name derived from `raw`, or '' when nothing usable is
// left (non-string input, or a name with no ASCII-safe characters at all).
// Already-valid simple refs like `ABC-123` pass through untouched.
export function slugifyBranch(raw: unknown): string {
	if (typeof raw !== 'string') return '';
	// Decompose first so accented latin reads through as its base letters
	// instead of collapsing to dashes.
	const folded = raw.normalize('NFKD').replace(/[̀-ͯ]/g, '');
	let s = trimEnds(folded.replace(UNSAFE, '-').replace(/-{2,}/g, '-').replace(/\.{2,}/g, '.'));
	s = trimEnds(s.slice(0, MAX_LENGTH));
	// `.lock` is reserved; a name ending in it can hide another behind it.
	while (s.toLowerCase().endsWith('.lock')) s = trimEnds(s.slice(0, -'.lock'.length));
	return s;
}

// The worktree directory name for a branch: a flat child of the -worktrees
// root. A slugified new branch is already its own dir name; this only does
// work for an existing branch checked out by its real (possibly nested) name.
export function worktreeDirName(branch: string): string {
	return branch.replace(/[^A-Za-z0-9._/-]/g, '-').replace(/\//g, '-');
}
