import { describe, it, expect } from 'vitest';
import { issueChipText } from './issues';

describe('issueChipText', () => {
	it('reduces a GitHub owner/repo#n id to just #n', () => {
		expect(issueChipText('github', 'acme/web#1852')).toBe('#1852');
	});

	it('keeps a bare GitHub id with a hash unchanged', () => {
		expect(issueChipText('github', '#42')).toBe('#42');
	});

	it('passes a GitHub id through when it carries no hash', () => {
		expect(issueChipText('github', '1852')).toBe('1852');
	});

	it('leaves already-short Linear and ClickUp ids as-is', () => {
		expect(issueChipText('linear', 'ABC-123')).toBe('ABC-123');
		expect(issueChipText('clickup', '86abc123')).toBe('86abc123');
	});
});
