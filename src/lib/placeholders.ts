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
export function expandPlaceholders(text: string, ctx: PlaceholderContext): string {
	return text
		.replaceAll('[title]', ctx.title ?? '')
		.replaceAll('[branch-name]', ctx.branch ?? '')
		.replaceAll('[base-branch]', ctx.base ?? '')
		.replaceAll('[branch]', ctx.branch ?? '')
		.replaceAll('[cwd]', ctx.cwd ?? '')
		.replaceAll('[issue_id]', ctx.issueId ?? '')
		.replaceAll('[issue_url]', ctx.issueUrl ?? '')
		.replaceAll('[pr_url]', ctx.prUrl ?? '')
		.replaceAll('[pr_number]', ctx.prNumber ?? '')
		.replaceAll('[pr_title]', ctx.prTitle ?? '')
		.replaceAll('[pr_branch]', ctx.prBranch ?? '')
		.replaceAll('[pr_base]', ctx.prBase ?? '')
		.trim();
}

// Build the expansion context from a live session: title, worktree branch/base,
// cwd, the issue it was launched from, and the captured PR. For a Review-mode
// session the worktree branch is the checked-out `pr/<n>` head and its base is
// the PR's base ref, so [pr_branch]/[pr_base] resolve to the diff's two ends.
export function contextFromSession(session: DeckSession): PlaceholderContext {
	return {
		title: session.title,
		branch: session.worktree?.branch,
		base: session.worktree?.base,
		cwd: session.cwd,
		issueId: session.issue?.id,
		issueUrl: session.issue?.url,
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
