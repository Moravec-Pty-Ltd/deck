import { describe, expect, it } from 'vitest';
import {
	HISTORY_TURNS,
	IDLE_RESET_MS,
	OPERATOR_TOOLS,
	askAnnouncement,
	conversationWindow,
	matchSessions,
	parseSkillFrontmatter,
	pickOption,
	promptSessions,
	shortDescription,
	skillInvocation,
	spokenText,
	statusAnnouncement,
	summaryMessages,
	systemPrompt,
	type OperatorSession,
	type OperatorTurn
} from './operator-core';

const sessions: OperatorSession[] = [
	{ id: 'c_auth', title: 'Auth token refresh', kind: 'claude', status: 'running', project: 'deck' },
	{ id: 'c_fold', title: 'Foldable layout', kind: 'claude', status: 'idle', project: 'deck', awaitingInput: true },
	{ id: 's_dev', title: 'dev server', kind: 'shell', status: 'idle' }
];

const turn = (role: OperatorTurn['role'], at: number, content = role): OperatorTurn => ({ role, content, at });

describe('systemPrompt', () => {
	it('carries the sessions, projects and skills', () => {
		const text = systemPrompt({
			sessions,
			skills: [{ name: 'dev-workflow', description: 'Work an issue to a PR', scope: 'global' }],
			projects: ['deck', 'skorre'],
			now: '2026-09-22T10:00:00Z'
		});
		expect(text).toContain('"id":"c_auth"');
		expect(text).toContain('Projects: deck, skorre.');
		expect(text).toContain('dev-workflow (global): Work an issue to a PR');
		expect(text).toContain('no markdown');
		// Changing parts last, so a cached prompt prefix survives between turns.
		expect(text.indexOf('Skills the user')).toBeLessThan(text.indexOf('Sessions:'));
		expect(text.indexOf('Sessions:')).toBeLessThan(text.indexOf('Time:'));
	});

	it('cuts a skill description to its first sentence', () => {
		expect(shortDescription('Work an issue to a PR. Then more detail. And more.')).toBe('Work an issue to a PR.');
		expect(shortDescription('x'.repeat(200))).toHaveLength(120);
		expect(shortDescription('Short')).toBe('Short');
	});

	it('offers every tool with a schema', () => {
		expect(OPERATOR_TOOLS.map((t) => t.function.name)).toEqual([
			'list_sessions',
			'latest_reply',
			'send_message',
			'answer_ask',
			'stop_session',
			'start_session',
			'skill_details'
		]);
		const start = OPERATOR_TOOLS.find((t) => t.function.name === 'start_session')!;
		expect(start.function.parameters.required).toContain('confirmed');
	});
});

describe('promptSessions', () => {
	it('keeps live and recent sessions, live first then newest, capped, without the timestamp', () => {
		const now = 10_000_000_000;
		const many = Array.from({ length: 30 }, (_, i) => ({ id: `c_${i}`, title: `S${i}`, kind: 'claude', status: 'idle', lastActiveAt: now - i * 60_000 }));
		const stale = { id: 'old', title: 'Old', kind: 'shell', status: 'idle', lastActiveAt: now - 2 * 24 * 60 * 60 * 1000 };
		const waiting = { id: 'w', title: 'Waiting', kind: 'claude', status: 'idle', awaitingInput: true, lastActiveAt: now - 3 * 24 * 60 * 60 * 1000 };
		const picked = promptSessions([stale, ...many, waiting], now);
		expect(picked).toHaveLength(20);
		expect(picked[0].id).toBe('w');
		expect(picked[1].id).toBe('c_0');
		expect(picked.some((s) => s.id === 'old')).toBe(false);
		expect('lastActiveAt' in picked[0]).toBe(false);
	});
});

describe('conversationWindow', () => {
	it('drops everything before a long silence and after one at the end', () => {
		const t0 = 1_000_000;
		const turns = [turn('user', t0), turn('assistant', t0 + 1000), turn('user', t0 + IDLE_RESET_MS + 5000), turn('assistant', t0 + IDLE_RESET_MS + 6000)];
		expect(conversationWindow(turns, t0 + IDLE_RESET_MS + 7000).map((t) => t.at)).toEqual([t0 + IDLE_RESET_MS + 5000, t0 + IDLE_RESET_MS + 6000]);
		expect(conversationWindow(turns, t0 + 3 * IDLE_RESET_MS)).toEqual([]);
	});

	it('keeps the newest turns and starts on a user turn', () => {
		const turns: OperatorTurn[] = [];
		for (let i = 0; i < 30; i++) turns.push(turn(i % 3 === 0 ? 'user' : i % 3 === 1 ? 'assistant' : 'tool', 1000 + i));
		const window = conversationWindow(turns, 2000);
		expect(window.length).toBeLessThanOrEqual(HISTORY_TURNS);
		expect(window[0].role).toBe('user');
		expect(window[window.length - 1]).toBe(turns[turns.length - 1]);
	});
});

describe('parseSkillFrontmatter', () => {
	it('reads name and description, with or without quotes', () => {
		expect(parseSkillFrontmatter('---\nname: dev-workflow\ndescription: "Work an issue: ticket to PR"\nother: x\n---\n# Body')).toEqual({
			name: 'dev-workflow',
			description: 'Work an issue: ticket to PR'
		});
		expect(parseSkillFrontmatter('# No frontmatter')).toEqual({});
	});
});

describe('matchSessions', () => {
	it('matches an id exactly or a title by its words', () => {
		expect(matchSessions('c_auth', sessions).map((s) => s.id)).toEqual(['c_auth']);
		expect(matchSessions('auth', sessions).map((s) => s.id)).toEqual(['c_auth']);
		expect(matchSessions('Foldable Layout', sessions).map((s) => s.id)).toEqual(['c_fold']);
		expect(matchSessions('nothing here', sessions)).toEqual([]);
		expect(matchSessions('  ', sessions)).toEqual([]);
	});
});

describe('announcements', () => {
	it('reads a question with numbered options', () => {
		expect(askAnnouncement(sessions[1], 'Which sidebar width?', ['Half', 'Fixed 320'])).toBe(
			'Foldable layout is asking: Which sidebar width? Options: 1, Half. 2, Fixed 320.'
		);
		expect(askAnnouncement(sessions[1], 'Continue?', [])).toBe('Foldable layout is asking: Continue?');
	});

	it('speaks only errors and deaths', () => {
		expect(statusAnnouncement(sessions[0], 'error')).toBe('Auth token refresh hit an error.');
		expect(statusAnnouncement(sessions[0], 'dead')).toBe('Auth token refresh has died.');
		expect(statusAnnouncement(sessions[0], 'idle')).toBeNull();
	});

	it('asks for a one-sentence summary that names the session', () => {
		const messages = summaryMessages(sessions[0], 'x'.repeat(10_000));
		expect(messages[0].content).toContain('one short spoken sentence');
		expect(messages[1].content).toContain('The session "Auth token refresh" replied:');
		expect(messages[1].content.length).toBeLessThan(6200);
	});
});

describe('skillInvocation', () => {
	const skills = [
		{ name: 'dev-workflow', description: '', scope: 'global' },
		{ name: 'release', description: '', scope: 'deck' },
		{ name: 'dev', description: '', scope: 'global' }
	];
	it('turns a spoken skill request into its slash command', () => {
		expect(skillInvocation('run dev-workflow SKO-136', skills)).toBe('/dev-workflow SKO-136');
		expect(skillInvocation('Please kick off the dev-workflow skill on SKO-136', skills)).toBe('/dev-workflow SKO-136');
		expect(skillInvocation('release', skills)).toBe('/release');
		expect(skillInvocation('/dev-workflow ENG-1', skills)).toBe('/dev-workflow ENG-1');
	});
	it('leaves other prompts alone and prefers the longest skill name', () => {
		expect(skillInvocation('Fix the flaky test and report back', skills)).toBe('Fix the flaky test and report back');
		expect(skillInvocation('development is slow', skills)).toBe('development is slow');
		expect(skillInvocation('dev-workflow ENG-2', skills)).toBe('/dev-workflow ENG-2');
	});
});

describe('spokenText', () => {
	it('strips leaked thinking', () => {
		expect(spokenText('<think>hmm</think>\n\nDone.')).toBe('Done.');
		expect(spokenText(null)).toBe('');
	});
});

describe('pickOption', () => {
	const options = ['Half the screen', 'Fixed 320', 'Leave as is'];
	it('finds an option by label, number or ordinal, else nothing', () => {
		expect(pickOption('half the screen', options)).toBe('Half the screen');
		expect(pickOption("let's go with fixed 320", options)).toBe('Fixed 320');
		expect(pickOption('option 3', options)).toBe('Leave as is');
		expect(pickOption('two', options)).toBe('Fixed 320');
		expect(pickOption('the second one', options)).toBe('Fixed 320');
		expect(pickOption('something else entirely', options)).toBeNull();
		expect(pickOption('9', options)).toBeNull();
	});
});
