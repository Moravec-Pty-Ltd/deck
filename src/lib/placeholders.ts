import type { DeckSession } from '$lib/types';

// Values a [token] expands to in a first-prompt template or a quick message.
// Built from the live session (see contextFromSession); every field is optional
// and a missing one expands to an empty string.
export interface PlaceholderContext {
	title?: string;
	branch?: string;
	base?: string;
	cwd?: string;
	issueId?: string;
	issueUrl?: string;
	// Fetched at session-create time (server/issues/detail.ts) and injected into
	// the first prompt; blank elsewhere since deck doesn't persist issue bodies.
	issueTitle?: string;
	issueBody?: string;
	issueComments?: string;
	prUrl?: string;
	prNumber?: string;
	prTitle?: string;
	prBranch?: string;
	prBase?: string;
}

// Substitute the supported [tokens] in `text`, then trim. [branch] is a
// back-compat alias for [branch-name]. A token with no value resolves to ''
// (e.g. no PR captured -> [pr_url] is blank). Shared by the new-session
// first-prompt path and quick messages so the token set lives in one place.
//
// Single pass over the template: every token is replaced once from `map`, so a
// token that appears *inside* a substituted value (e.g. "[pr_url]" written in a
// fetched issue body) is left literal rather than re-expanded. The regex is
// derived from the map keys so the two can't drift.
export function expandPlaceholders(text: string, ctx: PlaceholderContext): string {
	const map: Record<string, string> = {
		'[title]': ctx.title ?? '',
		'[branch-name]': ctx.branch ?? '',
		'[base-branch]': ctx.base ?? '',
		'[branch]': ctx.branch ?? '',
		'[cwd]': ctx.cwd ?? '',
		'[issue_id]': ctx.issueId ?? '',
		'[issue_url]': ctx.issueUrl ?? '',
		'[issue_title]': ctx.issueTitle ?? '',
		'[issue_body]': ctx.issueBody ?? '',
		'[issue_comments]': ctx.issueComments ?? '',
		'[pr_url]': ctx.prUrl ?? '',
		'[pr_number]': ctx.prNumber ?? '',
		'[pr_title]': ctx.prTitle ?? '',
		'[pr_branch]': ctx.prBranch ?? '',
		'[pr_base]': ctx.prBase ?? ''
	};
	const names = Object.keys(map).map((k) => k.slice(1, -1));
	const re = new RegExp(`\\[(?:${names.join('|')})\\]`, 'g');
	return text.replace(re, (m) => map[m]).trim();
}

// Build the expansion context from a live session: title, worktree branch/base,
// cwd, the issue it was launched from, and the captured PR. For a Review-mode
// session the worktree branch is the checked-out `pr/<n>` head and its base is
// the PR's base ref, so [pr_branch]/[pr_base] resolve to the diff's two ends.
export function contextFromSession(session: DeckSession): PlaceholderContext {
	// Multi-issue sessions store `issues`; older ones only `issue`. [issue_id] /
	// [issue_url] join across every attached issue (one issue => the value as
	// before). The richer [issue_title]/[issue_body]/[issue_comments] are only
	// filled by the create-time fetch, so they stay blank here.
	const issues = session.issues ?? (session.issue ? [session.issue] : []);
	return {
		title: session.title,
		branch: session.worktree?.branch,
		base: session.worktree?.base,
		cwd: session.cwd,
		issueId: issues.map((i) => i.id).join(' + ') || undefined,
		issueUrl: issues.map((i) => i.url).filter(Boolean).join(' ') || undefined,
		prUrl: session.pr?.url,
		prNumber: session.pr ? String(session.pr.number) : undefined,
		prTitle: session.pr?.title,
		// Only resolve the PR branch/base for a session that actually has a PR (a
		// review session), so these tokens stay blank in ordinary sessions rather
		// than expanding to the worktree's own branch/base.
		prBranch: session.pr ? session.worktree?.branch : undefined,
		prBase: session.pr ? session.worktree?.base : undefined
	};
}
