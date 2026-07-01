import { describe, it, expect, vi } from 'vitest';
import { buildCommands, filterCommands, type CommandContext } from './commands';
import type { DeckSession, SessionPR } from './types';

function session(over: Partial<DeckSession> = {}): DeckSession {
	return {
		id: 's1',
		kind: 'claude',
		title: 'web',
		cwd: '/path/to/web',
		createdAt: 0,
		lastActiveAt: 0,
		status: 'idle',
		...over
	};
}

function pr(over: Partial<SessionPR> = {}): SessionPR {
	return { url: 'https://github.com/acme/web/pull/7', repo: 'acme/web', number: 7, seenAt: 0, ...over };
}

function ctx(over: Partial<CommandContext> = {}): CommandContext {
	return {
		session: null,
		sessions: [],
		serverStates: [],
		goto: vi.fn(),
		openUrl: vi.fn(),
		copy: vi.fn(),
		cycleTheme: vi.fn(),
		notificationsSupported: false,
		toggleNotifications: vi.fn(),
		prAction: vi.fn().mockResolvedValue(undefined),
		dismissPr: vi.fn().mockResolvedValue(undefined),
		...over
	};
}

const ids = (c: CommandContext) => buildCommands(c).map((cmd) => cmd.id);

describe('buildCommands', () => {
	it('off a session page: only the global actions, no PR/issue commands', () => {
		const list = ids(ctx());
		expect(list).toContain('new-session');
		expect(list).toContain('switch-theme');
		expect(list).not.toContain('toggle-notifications');
		expect(list.some((id) => id.startsWith('pr-'))).toBe(false);
	});

	it('includes toggle-notifications only when supported', () => {
		expect(ids(ctx({ notificationsSupported: true }))).toContain('toggle-notifications');
	});

	it('a session with an open mergeable PR exposes the full PR action set', () => {
		const list = ids(ctx({ session: session({ pr: pr({ state: 'open', mergeable: 'MERGEABLE' }) }) }));
		expect(list).toEqual(
			expect.arrayContaining([
				'pr-open',
				'pr-copy',
				'pr-approve',
				'pr-request-changes',
				'pr-comment',
				'pr-merge',
				'pr-dismiss'
			])
		);
	});

	it('hides Merge unless the PR is open and MERGEABLE', () => {
		expect(ids(ctx({ session: session({ pr: pr({ state: 'open', mergeable: 'CONFLICTING' }) }) }))).not.toContain('pr-merge');
		expect(ids(ctx({ session: session({ pr: pr({ state: 'merged', mergeable: 'MERGEABLE' }) }) }))).not.toContain('pr-merge');
	});

	it('hides Approve unless the PR is open', () => {
		expect(ids(ctx({ session: session({ pr: pr({ state: 'draft' }) }) }))).not.toContain('pr-approve');
		expect(ids(ctx({ session: session({ pr: pr({ state: 'closed' }) }) }))).not.toContain('pr-approve');
	});

	it('surfaces an Open issue command per issue that has a url', () => {
		const s = session({
			issues: [
				{ source: 'github', id: 'acme/web#42', url: 'https://example.test/42' },
				{ source: 'linear', id: 'LIN-9', url: '' }
			]
		});
		const list = ids(ctx({ session: s }));
		expect(list).toContain('issue-open:github:acme/web#42');
		expect(list).not.toContain('issue-open:linear:LIN-9'); // no url, skipped
	});

	it('reads the legacy single `issue` field', () => {
		const s = session({ issue: { source: 'linear', id: 'LIN-9', url: 'https://example.test/lin-9' } });
		expect(ids(ctx({ session: s }))).toContain('issue-open:linear:LIN-9');
	});

	it('offers a jump command for every other session, not the current one', () => {
		const c = ctx({
			session: session({ id: 's1' }),
			sessions: [session({ id: 's1' }), session({ id: 's2', title: 'api' })]
		});
		const list = ids(c);
		expect(list).toContain('goto:s2');
		expect(list).not.toContain('goto:s1');
	});
});

describe('command dispatch', () => {
	it('Approve posts an empty-body approve review', async () => {
		const c = ctx({ session: session({ pr: pr({ state: 'open' }) }) });
		const approve = buildCommands(c).find((cmd) => cmd.id === 'pr-approve')!;
		await approve.run();
		expect(c.prAction).toHaveBeenCalledWith({ action: 'review', decision: 'approve', body: '' });
	});

	it('Merge defaults to squash and passes the collected input', async () => {
		const c = ctx({ session: session({ pr: pr({ state: 'open', mergeable: 'MERGEABLE' }) }) });
		const merge = buildCommands(c).find((cmd) => cmd.id === 'pr-merge')!;
		expect(merge.step).toBe('merge');
		await merge.run({ method: 'rebase', deleteBranch: true });
		expect(c.prAction).toHaveBeenCalledWith({ action: 'merge', method: 'rebase', deleteBranch: true });
	});

	it('Request changes trims the message into a request-changes review', async () => {
		const c = ctx({ session: session({ pr: pr({ state: 'open' }) }) });
		const rc = buildCommands(c).find((cmd) => cmd.id === 'pr-request-changes')!;
		expect(rc.step).toBe('text');
		await rc.run({ text: '  needs tests  ' });
		expect(c.prAction).toHaveBeenCalledWith({
			action: 'review',
			decision: 'request-changes',
			body: 'needs tests'
		});
	});
});

describe('filterCommands', () => {
	const c = ctx({ session: session({ pr: pr({ state: 'open', mergeable: 'MERGEABLE' }) }) });
	const all = buildCommands(c);

	it('empty query keeps every command in registry order', () => {
		expect(filterCommands(all, '')).toEqual(all);
		expect(filterCommands(all, '   ')).toEqual(all);
	});

	it('matches on title substring', () => {
		expect(filterCommands(all, 'merge').map((x) => x.id)).toContain('pr-merge');
	});

	it('matches on keywords, not just the title', () => {
		// "appearance" is only a keyword of Switch theme.
		expect(filterCommands(all, 'appearance').map((x) => x.id)).toEqual(['switch-theme']);
	});

	it('ranks a prefix hit above a scattered subsequence', () => {
		const ranked = filterCommands(all, 'appr').map((x) => x.id);
		expect(ranked[0]).toBe('pr-approve');
	});

	it('drops non-matches', () => {
		expect(filterCommands(all, 'zzzzz')).toEqual([]);
	});
});
