import type { IssueSourceType } from './types';

// Source badge label + DaisyUI colour, shared by the picker, the source-config
// UI, and the session header so the GH/LIN/CU styling lives in one place.
export const ISSUE_BADGE: Record<IssueSourceType, { label: string; cls: string }> = {
	github: { label: 'GH', cls: 'badge-neutral' },
	linear: { label: 'LIN', cls: 'badge-primary' },
	clickup: { label: 'CU', cls: 'badge-secondary' }
};

// Display form of an issue id, used by the header chip and by the session title
// both create paths derive from an issue. A GitHub issue id is the full
// `owner/repo#n`, which crowds the row and squeezes the title, so show just
// `#n` and lean on the chip's title tooltip for the full ref. Linear/ClickUp
// ids (`ABC-123`) are already short and pass through unchanged. Display only:
// the stored id, and anything matching or linking on it, keeps the full ref.
export function shortIssueId(source: IssueSourceType, id: string): string {
	if (source !== 'github') return id;
	const hash = id.lastIndexOf('#');
	return hash === -1 ? id : id.slice(hash);
}

// Issue titles run long; a session name is read in a one-line row, so cut it at
// a word boundary near this many characters.
const ISSUE_TITLE_MAX = 60;

export function trimIssueTitle(title: string, max = ISSUE_TITLE_MAX): string {
	// Code points, so an emoji is never split into a lone surrogate (which the
	// apps' JSON decoder rejects) and the count matches Swift's.
	const chars = [...title.replace(/\s+/g, ' ').trim()];
	if (chars.length <= max) return chars.join('');
	// Room for the ellipsis; a space right after the cut still counts as a boundary.
	const space = chars.lastIndexOf(' ', max - 1);
	// A word longer than half the budget is cut mid-word rather than leaving a stub.
	return `${chars.slice(0, space > max / 2 ? space : max - 1).join('').trimEnd()}…`;
}

// The title a session started on exactly one issue gets when the caller sends
// none: the issue's own title, trimmed, else its display id (automation and
// older clients that don't send the title). Empty for zero or several issues,
// where the caller falls back to the branch.
export function singleIssueTitle(issues: { source: IssueSourceType; id: string; title?: string }[]): string {
	if (issues.length !== 1) return '';
	const [issue] = issues;
	return trimIssueTitle(issue.title ?? '') || shortIssueId(issue.source, issue.id);
}

// A session's issues, reading the legacy single `issue` too.
export function sessionIssues<T>(session: { issues?: T[]; issue?: T }): T[] {
	return session.issues ?? (session.issue ? [session.issue] : []);
}

// The references a session can be found by in search, lowercased: each issue's
// id and its short forms (`owner/repo#315`, `repo#315`, `#315`, `315`) and the
// same for its PR. Matched whole, so `31` doesn't find `#315`.
export function sessionRefs(session: {
	issues?: { id: string }[];
	issue?: { id: string };
	pr?: { repo: string; number: number };
}): string[] {
	const ids = sessionIssues(session).map((i) => i.id);
	if (session.pr) ids.push(`${session.pr.repo}#${session.pr.number}`);
	const refs = new Set<string>();
	for (const id of ids) {
		const lower = id.toLowerCase();
		refs.add(lower);
		const hash = lower.lastIndexOf('#');
		if (hash === -1) continue;
		refs.add(lower.slice(hash));
		refs.add(lower.slice(hash + 1));
		refs.add(lower.slice(lower.lastIndexOf('/', hash) + 1));
	}
	refs.delete('');
	return [...refs];
}
