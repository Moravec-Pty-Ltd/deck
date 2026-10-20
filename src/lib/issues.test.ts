import { describe, it, expect } from 'vitest';
import { shortIssueId, singleIssueTitle } from './issues';

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

describe('singleIssueTitle', () => {
	it('titles a one-issue session with its display id', () => {
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
