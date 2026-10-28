import { describe, it, expect } from 'vitest';
import { sessionRefs, shortIssueId, singleIssueTitle, trimIssueTitle } from './issues';

describe('shortIssueId', () => {
	it('reduces a GitHub owner/repo#n id to just #n', () => {
		expect(shortIssueId('github', 'acme/web#1852')).toBe('#1852');
	});

	it('keeps a bare GitHub id with a hash unchanged', () => {
		expect(shortIssueId('github', '#42')).toBe('#42');
	});

	it('passes a GitHub id through when it carries no hash', () => {
		expect(shortIssueId('github', '1852')).toBe('1852');
	});

	it('leaves already-short Linear and ClickUp ids as-is', () => {
		expect(shortIssueId('linear', 'ABC-123')).toBe('ABC-123');
		expect(shortIssueId('clickup', '86abc123')).toBe('86abc123');
	});
});

describe('trimIssueTitle', () => {
	it('passes a short title through, with its whitespace tidied', () => {
		expect(trimIssueTitle('  Fix   the\nlogin page ')).toBe('Fix the login page');
	});

	it('cuts a long title at a word boundary with an ellipsis', () => {
		const long = 'Name sessions started on an issue after the issue title and show the number separately '.repeat(2);
		const out = trimIssueTitle(long);
		expect(out).toBe('Name sessions started on an issue after the issue title and…');
		expect(out.length).toBeLessThanOrEqual(60);
	});

	it('never splits an emoji at the cut', () => {
		const out = trimIssueTitle(`Fix ${'x'.repeat(54)}🔥🔥 more words`);
		expect(out).toBe(`Fix ${'x'.repeat(54)}🔥…`);
		expect(out.isWellFormed()).toBe(true);
	});

	it('hard-cuts one long word rather than leaving a stub', () => {
		expect(trimIssueTitle(`Fix ${'x'.repeat(80)}`)).toBe(`Fix ${'x'.repeat(55)}…`);
	});
});

describe('singleIssueTitle', () => {
	it("titles a one-issue session with the issue's title", () => {
		expect(singleIssueTitle([{ source: 'github', id: 'acme/web#7', title: 'Fix the login page' }])).toBe('Fix the login page');
	});

	it('falls back to the display id without a title', () => {
		expect(singleIssueTitle([{ source: 'github', id: 'acme/web#7', title: '  ' }])).toBe('#7');
		expect(singleIssueTitle([{ source: 'github', id: 'acme/web#7' }])).toBe('#7');
		expect(singleIssueTitle([{ source: 'linear', id: 'ABC-1' }])).toBe('ABC-1');
	});

	it('leaves zero or several issues to the branch fallback', () => {
		expect(singleIssueTitle([])).toBe('');
		expect(
			singleIssueTitle([
				{ source: 'linear', id: 'ABC-1' },
				{ source: 'linear', id: 'ABC-2' }
			])
		).toBe('');
	});
});

describe('sessionRefs', () => {
	it("lists an issue's and a PR's references in every short form", () => {
		expect(
			sessionRefs({ issues: [{ id: 'acme/web#315' }, { id: 'ENG-123' }], pr: { repo: 'acme/api', number: 42 } }).sort()
		).toEqual(['#315', '#42', '315', '42', 'acme/api#42', 'acme/web#315', 'api#42', 'eng-123', 'web#315'].sort());
	});

	it('reads the legacy single issue and copes with none', () => {
		expect(sessionRefs({ issue: { id: '#9' } }).sort()).toEqual(['#9', '9']);
		expect(sessionRefs({})).toEqual([]);
	});
});
