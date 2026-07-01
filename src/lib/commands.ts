// Command registry for the Cmd+K palette. Pure and node-free (no fetch, no DOM):
// buildCommands(ctx) assembles the session-aware list, filterCommands(list, q)
// scores it. Every side effect goes through a CommandContext method the palette
// supplies, so the registry stays unit-testable in isolation.
import type { DeckSession, ServerRuntime } from './types';
import { canStart, canStop, isInFlight, type ServerAction } from './servers-client';

export type MergeMethod = 'squash' | 'merge' | 'rebase';
export type ReviewDecision = 'approve' | 'request-changes' | 'comment';

// The two payload shapes the /api/sessions/[id]/pr POST accepts (see that route).
export type PrActionPayload =
	| { action: 'review'; decision: ReviewDecision; body: string }
	| { action: 'merge'; method: MergeMethod; deleteBranch: boolean };

// What a command's run() reaches for. The palette implements these against the
// browser + the existing endpoints; commands.ts never touches them directly.
export interface CommandContext {
	// The session whose page is open, or null off a /s/[id] route. Gates the
	// PR/issue commands.
	session: DeckSession | null;
	// All sessions, for the "go to session" switch list.
	sessions: DeckSession[];
	// The current session's configured servers (empty when it runs none), for the
	// run/stop/restart commands.
	servers: ServerRuntime[];
	goto: (url: string) => void;
	openUrl: (url: string) => void;
	copy: (text: string) => void;
	cycleTheme: () => void;
	notificationsSupported: boolean;
	toggleNotifications: () => void;
	// PR review/merge; rejects with gh's message on failure so the palette shows it.
	prAction: (payload: PrActionPayload) => Promise<void>;
	dismissPr: () => Promise<void>;
	// Run a lifecycle action on one of the current session's servers.
	serverAction: (name: string, action: ServerAction) => Promise<void>;
}

// A command awaiting a second step before it runs: 'text' collects a message,
// 'merge' collects method + delete-branch. Absent means run immediately.
export type CommandStep = 'text' | 'merge';

// Values the palette collects in the second step and hands back to run().
export interface CommandInput {
	text?: string;
	method?: MergeMethod;
	deleteBranch?: boolean;
}

export interface Command {
	id: string;
	title: string;
	// Extra terms the filter matches on beyond the title.
	keywords?: string[];
	// Right-aligned context (a tally, a repo ref, a category).
	hint?: string;
	// Renders in the error colour (destructive actions).
	danger?: boolean;
	// A second step to collect input before running; absent = instant.
	step?: CommandStep;
	// Placeholder for the 'text' step.
	placeholder?: string;
	run: (input?: CommandInput) => void | Promise<void>;
}

// Review/merge actions on the current session's captured PR. Merge is offered
// only for a clean, mergeable, open (non-draft) PR, the same gate PrMenu uses;
// its hint carries the approval tally deck tracks (it has no check-run data).
function prCommands(ctx: CommandContext, pr: NonNullable<DeckSession['pr']>): Command[] {
	const approvals = pr.approvals ?? 0;
	const cmds: Command[] = [
		{
			id: 'pr-open',
			title: 'Open PR on GitHub',
			keywords: ['pr', 'pull request', 'github', 'browser'],
			hint: `${pr.repo}#${pr.number}`,
			run: () => ctx.openUrl(pr.url)
		},
		{
			id: 'pr-copy',
			title: 'Copy PR URL',
			keywords: ['pr', 'pull request', 'clipboard', 'link'],
			run: () => ctx.copy(pr.url)
		}
	];
	if (pr.state === 'open') {
		cmds.push({
			id: 'pr-approve',
			title: 'Approve PR',
			keywords: ['pr', 'review', 'approve'],
			run: () => ctx.prAction({ action: 'review', decision: 'approve', body: '' })
		});
	}
	cmds.push(
		{
			id: 'pr-request-changes',
			title: 'Request changes on PR…',
			keywords: ['pr', 'review', 'changes', 'reject'],
			step: 'text',
			placeholder: 'Required message',
			run: (i) =>
				ctx.prAction({ action: 'review', decision: 'request-changes', body: (i?.text ?? '').trim() })
		},
		{
			id: 'pr-comment',
			title: 'Comment on PR…',
			keywords: ['pr', 'review', 'comment'],
			step: 'text',
			placeholder: 'Required message',
			run: (i) => ctx.prAction({ action: 'review', decision: 'comment', body: (i?.text ?? '').trim() })
		}
	);
	if (pr.state === 'open' && pr.mergeable === 'MERGEABLE') {
		cmds.push({
			id: 'pr-merge',
			title: 'Merge PR',
			keywords: ['pr', 'merge', 'squash', 'rebase'],
			hint: approvals > 0 ? `${approvals} approval${approvals === 1 ? '' : 's'}` : 'mergeable',
			step: 'merge',
			run: (i) =>
				ctx.prAction({
					action: 'merge',
					method: i?.method ?? 'squash',
					deleteBranch: i?.deleteBranch ?? false
				})
		});
	}
	cmds.push({
		id: 'pr-dismiss',
		title: 'Dismiss PR chip',
		keywords: ['pr', 'dismiss', 'hide', 'clear'],
		danger: true,
		run: () => ctx.dismissPr()
	});
	return cmds;
}

// One "Open issue" per attached issue that has a url (older sessions store a
// single `issue`, newer ones an `issues` array; read them together).
function issueCommands(ctx: CommandContext, s: DeckSession): Command[] {
	const issues = s.issues ?? (s.issue ? [s.issue] : []);
	return issues
		.filter((issue) => issue.url)
		.map((issue) => ({
			id: `issue-open:${issue.source}:${issue.id}`,
			title: `Open issue ${issue.id}`,
			keywords: ['issue', 'ticket', issue.source],
			hint: issue.source,
			run: () => ctx.openUrl(issue.url)
		}));
}

// Run/stop/restart the current session's primary (first) server, sharing the
// servers-client code path the header Run button uses. The caret menu on that
// button covers the rest; the palette keeps to the common one-server case.
function serverCommands(ctx: CommandContext): Command[] {
	const primary = ctx.servers[0];
	if (!primary) return [];
	const cmds: Command[] = [];
	if (canStart(primary.state)) {
		cmds.push({
			id: 'server-run',
			title: 'Run dev server',
			keywords: ['run', 'start', 'server', 'dev'],
			hint: primary.name,
			run: () => ctx.serverAction(primary.name, 'start')
		});
	}
	if (canStop(primary.state)) {
		cmds.push({
			id: 'server-stop',
			title: 'Stop dev server',
			keywords: ['stop', 'server', 'dev'],
			hint: primary.name,
			run: () => ctx.serverAction(primary.name, 'stop')
		});
		if (!isInFlight(primary.state)) {
			cmds.push({
				id: 'server-restart',
				title: 'Restart dev server',
				keywords: ['restart', 'server', 'dev'],
				hint: primary.name,
				run: () => ctx.serverAction(primary.name, 'restart')
			});
		}
	}
	return cmds;
}

// Always-available actions, independent of any session.
function globalCommands(ctx: CommandContext): Command[] {
	const cmds: Command[] = [
		{
			id: 'new-session',
			title: 'New session',
			keywords: ['create', 'add', 'start'],
			run: () => ctx.goto('/?new=1')
		},
		{
			id: 'switch-theme',
			title: 'Switch theme',
			keywords: ['theme', 'dark', 'light', 'eink', 'appearance'],
			run: () => ctx.cycleTheme()
		}
	];
	if (ctx.notificationsSupported) {
		cmds.push({
			id: 'toggle-notifications',
			title: 'Toggle notifications',
			keywords: ['notifications', 'push', 'bell', 'alerts'],
			run: () => ctx.toggleNotifications()
		});
	}
	return cmds;
}

// Jump to any other session by name — the supacode-style quick switch.
function jumpCommands(ctx: CommandContext): Command[] {
	return ctx.sessions
		.filter((other) => other.id !== ctx.session?.id)
		.map((other) => ({
			id: `goto:${other.id}`,
			title: other.title,
			keywords: ['go to session', 'switch', 'jump', other.kind],
			hint: 'session',
			run: () => ctx.goto(`/s/${encodeURIComponent(other.id)}`)
		}));
}

// Assemble the applicable commands for the current context. Commands that need a
// session (PR/issue actions) are simply absent off a session page, so the palette
// never shows an inapplicable action.
export function buildCommands(ctx: CommandContext): Command[] {
	const s = ctx.session;
	return [
		...(s?.pr ? prCommands(ctx, s.pr) : []),
		...(s ? issueCommands(ctx, s) : []),
		...(s ? serverCommands(ctx) : []),
		...globalCommands(ctx),
		...jumpCommands(ctx)
	];
}

// Score `text` against a lowercase `query`: prefix beats a word-boundary hit
// beats a mid-word substring beats a scattered subsequence; 0 means no match.
function score(query: string, text: string): number {
	const t = text.toLowerCase();
	const idx = t.indexOf(query);
	if (idx === 0) return 100;
	if (idx > 0) return (t[idx - 1] === ' ' ? 80 : 60) - Math.min(idx, 40) * 0.1;
	// Subsequence: every query char appears in order, not necessarily adjacent.
	let ti = 0;
	for (const ch of query) {
		ti = t.indexOf(ch, ti);
		if (ti === -1) return 0;
		ti++;
	}
	return 30;
}

// Filter + rank commands for a query. Empty query keeps registry order (the
// palette's default view); otherwise best-scoring first, ties by original order.
export function filterCommands(commands: Command[], query: string): Command[] {
	const q = query.trim().toLowerCase();
	if (!q) return commands;
	return commands
		.map((c, i) => {
			const best = Math.max(score(q, c.title), ...(c.keywords ?? []).map((k) => score(q, k)));
			return { c, i, best };
		})
		.filter((x) => x.best > 0)
		.sort((a, b) => b.best - a.best || a.i - b.i)
		.map((x) => x.c);
}
