import { describe, it, expect } from 'vitest';
import {
	DETAIL_CAP,
	imageUrls,
	isSafeImageUrl,
	parseClickupDetail,
	parseGithubDetail,
	parseLinearDetail,
	renderIssueBody,
	renderIssueComments,
	renderIssueTitle,
	truncate,
	type IssueDetail
} from './detail-core';

describe('per-source parsing', () => {
	it('parses a GitHub issue view', () => {
		expect(
			parseGithubDetail({
				title: 'Fix login',
				body: 'It breaks.',
				comments: [{ body: 'me too' }, { body: '' }, {}]
			})
		).toEqual({ title: 'Fix login', body: 'It breaks.', comments: ['me too'] });
	});

	it('parses a Linear issue node', () => {
		expect(
			parseLinearDetail({
				title: 'Ship it',
				description: 'Do the thing.',
				comments: { nodes: [{ body: 'ok' }, {}] }
			})
		).toEqual({ title: 'Ship it', body: 'Do the thing.', comments: ['ok'] });
	});

	it('prefers ClickUp markdown_description and has no comments', () => {
		expect(
			parseClickupDetail({ name: 'Task', markdown_description: ' **md** ', description: 'plain' })
		).toEqual({ title: 'Task', body: '**md**', comments: [] });
		expect(parseClickupDetail({ name: 'Task', description: 'plain' }).body).toBe('plain');
	});

	it('tolerates missing fields across sources', () => {
		expect(parseGithubDetail({})).toEqual({ title: '', body: '', comments: [] });
		expect(parseLinearDetail({})).toEqual({ title: '', body: '', comments: [] });
		expect(parseClickupDetail({})).toEqual({ title: '', body: '', comments: [] });
	});
});

describe('imageUrls', () => {
	it('extracts and dedupes markdown image urls', () => {
		const md = '![a](https://x/1.png) text ![b](https://x/2.jpg "t") ![c](https://x/1.png)';
		expect(imageUrls(md)).toEqual(['https://x/1.png', 'https://x/2.jpg']);
	});

	it('returns nothing when there are no images', () => {
		expect(imageUrls('just text [a link](https://x)')).toEqual([]);
	});
});

describe('isSafeImageUrl', () => {
	it('allows public http(s) hosts', () => {
		expect(isSafeImageUrl('https://uploads.linear.app/a/b.png')).toBe(true);
		expect(isSafeImageUrl('https://user-images.githubusercontent.com/1/x.png')).toBe(true);
	});

	it('allows public hostnames that merely look internal', () => {
		// Range checks apply only to real IP literals, so these DNS names are fine.
		expect(isSafeImageUrl('https://fc.example.com/x.png')).toBe(true);
		expect(isSafeImageUrl('https://fe80.example.com/x.png')).toBe(true);
		expect(isSafeImageUrl('https://127.example.com/x.png')).toBe(true);
		expect(isSafeImageUrl('https://10.example.org/x.png')).toBe(true);
	});

	it('rejects non-http(s) schemes', () => {
		expect(isSafeImageUrl('file:///etc/passwd')).toBe(false);
		expect(isSafeImageUrl('data:image/png;base64,AAAA')).toBe(false);
		expect(isSafeImageUrl('not a url')).toBe(false);
	});

	it('rejects loopback / link-local / private / localhost targets', () => {
		expect(isSafeImageUrl('http://169.254.169.254/latest/meta-data/')).toBe(false);
		expect(isSafeImageUrl('http://127.0.0.1/x.png')).toBe(false);
		expect(isSafeImageUrl('http://localhost:3000/x.png')).toBe(false);
		expect(isSafeImageUrl('http://10.0.0.5/x.png')).toBe(false);
		expect(isSafeImageUrl('http://192.168.1.9/x.png')).toBe(false);
		expect(isSafeImageUrl('http://172.16.0.1/x.png')).toBe(false);
		expect(isSafeImageUrl('http://[::1]/x.png')).toBe(false);
	});

	it('rejects IPv4-mapped IPv6 and the unspecified address', () => {
		expect(isSafeImageUrl('http://[::ffff:127.0.0.1]/x.png')).toBe(false);
		expect(isSafeImageUrl('http://[::]/x.png')).toBe(false);
	});

	it('folds a trailing-dot fqdn before matching', () => {
		expect(isSafeImageUrl('http://localhost./x.png')).toBe(false);
	});
});

describe('truncate', () => {
	it('leaves short text untouched and marks cut text', () => {
		expect(truncate('short')).toBe('short');
		const long = 'a'.repeat(DETAIL_CAP + 10);
		const out = truncate(long);
		expect(out.startsWith('a'.repeat(DETAIL_CAP))).toBe(true);
		expect(out.endsWith('…[truncated]')).toBe(true);
	});
});

const detail = (over: Partial<IssueDetail>): IssueDetail => ({
	ref: 'acme/app#1',
	source: 'github',
	url: 'https://example.com/1',
	title: 'One',
	body: 'first body',
	comments: [],
	images: [],
	...over
});

describe('render single issue', () => {
	it('body is just the body, no delimiter or url', () => {
		expect(renderIssueBody([detail({})])).toBe('first body');
	});

	it('appends image refs and one read-only note', () => {
		const out = renderIssueBody([detail({ images: ['.deck/issue-assets/acme_app_1/a.png'] })]);
		expect(out).toContain('Images:\n- .deck/issue-assets/acme_app_1/a.png');
		expect(out).toContain('Do not modify, move, or commit');
	});

	it('falls back when the body is empty', () => {
		expect(renderIssueBody([detail({ body: '' })])).toBe('(no description)');
	});

	it('title is the issue title', () => {
		expect(renderIssueTitle([detail({})])).toBe('One');
	});

	it('comments render only when present', () => {
		expect(renderIssueComments([detail({})])).toBe('');
		expect(renderIssueComments([detail({ comments: ['hi', 'there'] })])).toBe('hi\n\nthere');
	});
});

describe('render multiple issues', () => {
	const a = detail({ ref: 'acme/app#1', title: 'One', body: 'body one' });
	const b = detail({
		ref: 'acme/app#2',
		title: 'Two',
		url: 'https://example.com/2',
		body: 'body two',
		comments: ['second comment']
	});

	it('title joins each issue', () => {
		expect(renderIssueTitle([a, b])).toBe('One + Two');
	});

	it('body delimits a section per issue with its url', () => {
		const out = renderIssueBody([a, b]);
		expect(out).toContain('----- acme/app#1: One -----');
		expect(out).toContain('URL: https://example.com/2');
		expect(out).toContain('body one');
		expect(out).toContain('body two');
	});

	it('comments delimit only issues that have them', () => {
		const out = renderIssueComments([a, b]);
		expect(out).toContain('----- acme/app#2 comments -----');
		expect(out).not.toContain('acme/app#1 comments');
		expect(out).toContain('second comment');
	});

	it('empty details render empty', () => {
		expect(renderIssueBody([])).toBe('');
		expect(renderIssueTitle([])).toBe('');
		expect(renderIssueComments([])).toBe('');
	});
});
