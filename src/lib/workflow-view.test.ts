import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	allowedControls,
	api,
	basename,
	chainOrder,
	defaultWorkflow,
	graphEdges,
	parseIssueRef,
	parsePrRef,
	pollWhileVisible,
	visitBadge,
	visitLabel,
	workflowsByCategory
} from './workflow-view';
import type { RunPhaseDigest, WorkflowDef } from './workflows';

function phase(id: string, next: string, extra: Partial<RunPhaseDigest> = {}): RunPhaseDigest {
	return { id, label: id, role: 'implement', status: 'pending', visits: 0, next, sessions: [], decisions: [], ...extra };
}

// implement -> verify -> review -> pr -> done, review fails to fix, fix returns to verify.
const DEV = [
	phase('implement', 'verify'),
	phase('verify', 'review', { onFail: 'fix' }),
	phase('review', 'pr', { onFail: 'fix', cap: 5 }),
	phase('fix', 'verify'),
	phase('pr', 'done')
];

describe('parseIssueRef', () => {
	it('reads owner/repo#n as a GitHub issue', () => {
		expect(parseIssueRef(' acme/web#123 ')).toEqual({
			source: 'github',
			id: 'acme/web#123',
			url: 'https://github.com/acme/web/issues/123'
		});
	});

	it('reads a GitHub issue URL', () => {
		expect(parseIssueRef('https://github.com/acme/web/issues/42#issuecomment-1')?.id).toBe('acme/web#42');
	});

	it('reads a Linear id and a Linear URL', () => {
		expect(parseIssueRef('abc-123')).toEqual({ source: 'linear', id: 'ABC-123' });
		expect(parseIssueRef('https://linear.app/acme/issue/ABC-9/some-title')).toMatchObject({ source: 'linear', id: 'ABC-9' });
	});

	it('rejects anything else, including a PR URL', () => {
		expect(parseIssueRef('123')).toBeNull();
		expect(parseIssueRef('https://github.com/acme/web/pull/4')).toBeNull();
		expect(parseIssueRef('')).toBeNull();
	});
});

describe('parsePrRef', () => {
	it('reads a PR URL and owner/repo#n', () => {
		expect(parsePrRef('https://github.com/acme/web/pull/7/files')).toEqual({
			repo: 'acme/web',
			number: 7,
			url: 'https://github.com/acme/web/pull/7'
		});
		expect(parsePrRef('acme/web#8')).toMatchObject({ repo: 'acme/web', number: 8 });
	});

	it('rejects a bare number (no repo) and an issue URL', () => {
		expect(parsePrRef('42')).toBeNull();
		expect(parsePrRef('https://github.com/acme/web/issues/4')).toBeNull();
	});
});

describe('workflows', () => {
	const defs: WorkflowDef[] = [
		{ id: 'r1', name: 'Review', category: 'review', default: true, steps: [] },
		{ id: 'd2', name: 'Dev lite', category: 'dev', steps: [] },
		{ id: 'd1', name: 'Dev', category: 'dev', default: true, steps: [] }
	];

	it('groups by category with the default first', () => {
		const groups = workflowsByCategory(defs);
		expect(groups.map((g) => g.category)).toEqual(['review', 'dev']);
		expect(groups[1].workflows.map((w) => w.id)).toEqual(['d1', 'd2']);
	});

	it('defaults to the dev default, else the first', () => {
		expect(defaultWorkflow(defs)?.id).toBe('d1');
		expect(defaultWorkflow([defs[1]])?.id).toBe('d2');
		expect(defaultWorkflow([])).toBeUndefined();
	});
});

describe('graph', () => {
	it('walks the chain from the entry step and appends off-chain steps', () => {
		expect(chainOrder(DEV).map((p) => p.id)).toEqual(['implement', 'verify', 'review', 'pr', 'fix']);
	});

	it('survives a next cycle and an unknown next', () => {
		const looped = [phase('a', 'b'), phase('b', 'a'), phase('c', 'nowhere')];
		expect(chainOrder(looped).map((p) => p.id)).toEqual(['a', 'b', 'c']);
		expect(chainOrder([])).toEqual([]);
	});

	it('draws every onFail and every non-adjacent next', () => {
		const edges = graphEdges(chainOrder(DEV)).map((e) => `${e.from}->${e.to}:${e.kind}:${e.back ? 'back' : 'fwd'}`);
		expect(edges).toEqual(['verify->fix:fail:fwd', 'review->fix:fail:fwd', 'fix->verify:next:back']);
	});

	it('marks a direct loop-back as back, and ignores done and unknown targets', () => {
		const edges = graphEdges([phase('fix', 'review'), phase('review', 'done', { onFail: 'fix' }), phase('x', 'gone')]);
		expect(edges).toEqual([{ from: 'review', to: 'fix', kind: 'fail', fromIndex: 1, toIndex: 0, back: true }]);
	});

	it('badges visits against a cap, or repeats without one', () => {
		expect(visitBadge({ visits: 2, cap: 5 })).toBe('2/5');
		expect(visitBadge({ visits: 3 })).toBe('x3');
		expect(visitBadge({ visits: 1 })).toBeNull();
		expect(visitLabel({ cap: 5 }, 2)).toBe('Round 2');
		expect(visitLabel({}, 1)).toBe('Visit 1');
	});
});

describe('allowedControls', () => {
	it('allows nothing on a finished run', () => {
		expect(allowedControls('done').size).toBe(0);
		expect(allowedControls('cancelled').size).toBe(0);
	});

	it('only pauses a live run', () => {
		expect(allowedControls('running').has('pause')).toBe(true);
		expect(allowedControls('paused').has('pause')).toBe(false);
	});
});

describe('basename', () => {
	it('takes the last path segment', () => {
		expect(basename('/path/to/project/')).toBe('project');
		expect(basename('project')).toBe('project');
	});
});

describe('api', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('posts JSON and returns the body', async () => {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		expect(await api('/x', 'POST', { a: 1 })).toEqual({ ok: 1 });
		expect(fetchMock).toHaveBeenCalledWith('/x', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{"a":1}'
		});
	});

	it("throws the server's message", async () => {
		vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ message: 'cwd is required' }), { status: 400 }));
		await expect(api('/x')).rejects.toThrow('cwd is required');
		vi.stubGlobal('fetch', async () => new Response('nope', { status: 502 }));
		await expect(api('/x')).rejects.toThrow('request failed (502)');
	});
});

describe('pollWhileVisible', () => {
	afterEach(() => vi.useRealTimers());

	function fakeDoc() {
		const listeners = new Set<() => void>();
		return {
			hidden: false,
			addEventListener: (_: 'visibilitychange', fn: () => void) => listeners.add(fn),
			removeEventListener: (_: 'visibilitychange', fn: () => void) => listeners.delete(fn),
			fire() {
				for (const fn of listeners) fn();
			},
			listeners
		};
	}

	it('ticks now and on the interval, pauses while hidden, and cleans up', () => {
		vi.useFakeTimers();
		const doc = fakeDoc();
		const tick = vi.fn();
		const stop = pollWhileVisible(tick, 3000, doc);
		expect(tick).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(6000);
		expect(tick).toHaveBeenCalledTimes(3);
		doc.hidden = true;
		doc.fire();
		vi.advanceTimersByTime(9000);
		expect(tick).toHaveBeenCalledTimes(3);
		doc.hidden = false;
		doc.fire();
		expect(tick).toHaveBeenCalledTimes(4);
		stop();
		vi.advanceTimersByTime(9000);
		expect(tick).toHaveBeenCalledTimes(4);
		expect(doc.listeners.size).toBe(0);
	});
});
