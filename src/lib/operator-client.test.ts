import { describe, expect, it } from 'vitest';
import { announcementEntry, errorEntry, failureText, fromHistory, replyEntry, userEntry } from './operator-client';

describe('operator log entries', () => {
	it('turns history into entries, skipping tool turns and silent tool-call turns', () => {
		const entries = fromHistory([
			{ role: 'user', content: 'Status?', at: 1 },
			{ role: 'assistant', content: '', at: 2 },
			{ role: 'tool', content: '[]', at: 3 },
			{ role: 'assistant', content: 'All quiet.', at: 4 }
		]);
		expect(entries.map((e) => [e.role, e.text])).toEqual([
			['user', 'Status?'],
			['operator', 'All quiet.']
		]);
		expect(new Set(entries.map((e) => e.id)).size).toBe(2);
	});

	it('summarises a reply’s actions on one line each', () => {
		const e = replyEntry({ text: 'Sent.', actions: [{ tool: 'send_message', args: {}, result: 'Sent to Auth.\nmore' }] }, 5);
		expect(e).toMatchObject({ role: 'operator', text: 'Sent.', actions: ['send_message: Sent to Auth.'] });
		expect(replyEntry({ text: 'Hi.', actions: [] }, 5).actions).toBeUndefined();
		expect(userEntry('hi', 1)).toMatchObject({ role: 'user', text: 'hi' });
		expect(announcementEntry('Auth finished.', 2).announcement).toBe(true);
		expect(errorEntry('down', 3).error).toBe(true);
	});

	it('explains failures by status', () => {
		expect(failureText(503, '')).toContain('settings.json');
		expect(failureText(502, 'connection refused')).toContain('connection refused');
		expect(failureText(500, '')).toBe('The operator failed (500).');
		expect(failureText(400, 'empty message')).toBe('empty message');
	});
});
