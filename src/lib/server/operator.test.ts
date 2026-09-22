import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DeckSession } from '$lib/types';

// A data dir of our own for the log, and a home of our own for a skill.
const scratch = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `deck-operator-${p}-`)));
const [dataDir, home, projDir] = ['data', 'home', 'proj'].map(scratch);
const prevDeckData = process.env.DECK_DATA;
process.env.DECK_DATA = dataDir;
vi.spyOn(os, 'homedir').mockReturnValue(home);
fs.mkdirSync(path.join(home, '.claude', 'skills', 'dev-workflow'), { recursive: true });
fs.writeFileSync(path.join(home, '.claude', 'skills', 'dev-workflow', 'SKILL.md'), '---\nname: dev-workflow\ndescription: Work an issue to a PR\n---\n# Steps\nDo the thing.');
fs.mkdirSync(path.join(projDir, '.claude', 'skills', 'release'), { recursive: true });
fs.writeFileSync(path.join(projDir, '.claude', 'skills', 'release', 'SKILL.md'), '---\nname: release\ndescription: Cut a release\n---\n');

const sessions: DeckSession[] = [
	{ id: 'c_auth', kind: 'claude', title: 'Auth token refresh', cwd: projDir, status: 'running', createdAt: 1, lastActiveAt: 2 } as DeckSession,
	{ id: 'c_fold', kind: 'claude', title: 'Foldable layout', cwd: projDir, status: 'idle', awaitingInput: true, createdAt: 1, lastActiveAt: 2 } as DeckSession,
	{ id: 's_dev', kind: 'shell', title: 'dev server', cwd: projDir, status: 'idle', createdAt: 1, lastActiveAt: 2 } as DeckSession
];

const sent = vi.fn();
const answered = vi.fn((..._args: unknown[]) => true);
const interrupted = vi.fn();
const created = vi.fn(async (body: Record<string, unknown>) => ({ id: 'c_new', title: body.title, kind: 'claude', cwd: projDir, status: 'running' }));

vi.mock('./store', () => ({
	listProjects: () => [{ name: 'deck', path: projDir }],
	readSettings: () => ({ operator: { url: 'http://model.test/v1', model: 'test-model' } })
}));
vi.mock('./sessions', () => ({
	listSessions: async () => sessions,
	getSession: async (id: string) => sessions.find((s) => s.id === id)
}));
vi.mock('./confine', () => ({ projectForPath: () => projDir }));
vi.mock('./transcript', () => ({ sessionLastResult: (id: string) => (id === 'c_auth' ? 'I rotated the key and all 12 tests pass.' : null) }));
vi.mock('./send-agent-message', () => ({ sendAgentMessage: (...a: unknown[]) => sent(...a) }));
vi.mock('./answer', () => ({ answerAsk: (...a: unknown[]) => answered(...a) }));
vi.mock('./ask', () => ({
	listPendingAsks: () => [
		{ sessionId: 'c_fold', source: 'mcp', askId: 'tu_1', askedAt: 1, questions: [{ header: 'Width', question: 'Which sidebar width?', options: [{ label: 'Half the screen' }, { label: 'Fixed 320' }] }] }
	]
}));
vi.mock('./agents/dispatch', () => ({ agentInterrupt: (...a: unknown[]) => interrupted(...a) }));
vi.mock('./create-session', () => ({ createSessionFromRequest: (body: Record<string, unknown>) => created(body) }));

const { agentFeed } = await import('./agent-feed');
const { operatorChat, operatorHistory, resetOperator, skillCatalogue, subscribeAnnouncements } = await import('./operator');

// The fake model: each call pops the next scripted message; the requests are
// kept so a test can check what the model was shown.
const requests: { messages: { role: string; content: string }[]; tools?: unknown }[] = [];
let script: { content?: string; tool_calls?: unknown[] }[] = [];
const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

beforeEach(() => {
	resetOperator();
	requests.length = 0;
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: string, init: RequestInit) => {
			requests.push(JSON.parse(String(init.body)));
			const message = script.shift() ?? { content: 'Done.' };
			return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
		})
	);
});

afterEach(() => vi.unstubAllGlobals());

afterAll(() => {
	vi.restoreAllMocks();
	if (prevDeckData === undefined) delete process.env.DECK_DATA;
	else process.env.DECK_DATA = prevDeckData;
	for (const d of [dataDir, home, projDir]) fs.rmSync(d, { recursive: true, force: true });
});

describe('skillCatalogue', () => {
	it('lists global and project skills with their scope', () => {
		expect(skillCatalogue()).toEqual([
			{ name: 'dev-workflow', description: 'Work an issue to a PR', scope: 'global' },
			{ name: 'release', description: 'Cut a release', scope: 'deck' }
		]);
	});
});

describe('operatorChat', () => {
	it('shows the model the sessions and skills, runs its tool calls, and speaks the final text', async () => {
		script = [
			{ content: '', tool_calls: [toolCall('1', 'latest_reply', { session_id: 'c_auth' })] },
			{ content: '<think>ok</think>Auth token refresh rotated the key and all tests pass.' }
		];
		const reply = await operatorChat('Read me the latest from auth.');
		expect(reply.text).toBe('Auth token refresh rotated the key and all tests pass.');
		expect(reply.actions).toEqual([{ tool: 'latest_reply', args: { session_id: 'c_auth' }, result: 'I rotated the key and all 12 tests pass.' }]);
		expect(requests[0].messages[0].content).toContain('"title":"Auth token refresh"');
		expect(requests[0].messages[0].content).toContain('dev-workflow (global)');
		expect(requests[0].tools).toBeDefined();
		// The second call sees the tool result.
		expect(requests[1].messages.at(-1)).toMatchObject({ role: 'tool', content: 'I rotated the key and all 12 tests pass.' });
		expect(operatorHistory().map((t) => t.role)).toEqual(['user', 'assistant', 'assistant']);
	});

	it('sends, answers with a matched option, stops, and refuses a shell', async () => {
		script = [
			{
				tool_calls: [
					toolCall('1', 'send_message', { session_id: 'auth', text: 'Rerun the suite.' }),
					toolCall('2', 'answer_ask', { session_id: 'c_fold', answer: 'the second one' }),
					toolCall('3', 'stop_session', { session_id: 'c_auth' }),
					toolCall('4', 'send_message', { session_id: 's_dev', text: 'ls' })
				]
			},
			{ content: 'All done.' }
		];
		const reply = await operatorChat('Do the things.');
		expect(sent).toHaveBeenCalledWith(sessions[0], { text: 'Rerun the suite.' });
		expect(answered).toHaveBeenCalledWith(sessions[1], {
			text: 'Answering your question:\n- Width: Fixed 320',
			askId: 'tu_1',
			answers: [{ header: 'Width', labels: ['Fixed 320'] }]
		});
		expect(interrupted).toHaveBeenCalledWith('c_auth');
		expect(reply.actions.map((a) => a.result)).toEqual([
			'Sent to Auth token refresh: Rerun the suite.',
			'Answered Foldable layout.',
			'Stopped Auth token refresh.',
			'Error: dev server is a shell, not an agent session.'
		]);
	});

	it('will not start a session until the user has answered the proposal, then starts it on a new branch', async () => {
		// Even a model that claims confirmation on the first ask gets a no.
		script = [
			{ tool_calls: [toolCall('1', 'start_session', { project: 'deck', prompt: '/dev-workflow ENG-1', confirmed: true })] },
			{ content: 'I would start a deck session running dev workflow on ENG-1. Shall I?' }
		];
		let reply = await operatorChat('Run dev workflow on ENG-1 in deck.');
		expect(created).not.toHaveBeenCalled();
		expect(reply.actions[0].result).toContain('Not started');
		expect(reply.text).toContain('Shall I?');

		// The go-ahead comes reworded and in the user's words; the skill still
		// runs as its slash command.
		script = [
			{ tool_calls: [toolCall('2', 'start_session', { project: 'Deck', prompt: 'run dev-workflow on ENG-1', title: 'dev workflow ENG-1', confirmed: true })] },
			{ content: 'Started.' }
		];
		reply = await operatorChat('Yes.');
		expect(created).toHaveBeenCalledWith({ kind: 'claude', cwd: projDir, prompt: '/dev-workflow ENG-1', title: 'dev workflow ENG-1', worktree: { branch: 'dev workflow ENG-1', newBranch: true } });
		expect(reply.actions[0].result).toBe('Started "dev workflow ENG-1" (c_new) in deck.');
	});

	it('reports an ambiguous or unknown session back to the model and reads a skill on demand', async () => {
		script = [
			{ tool_calls: [toolCall('1', 'stop_session', { session_id: 'nothing' }), toolCall('2', 'skill_details', { name: 'dev-workflow' })] },
			{ content: 'Which one?' }
		];
		const reply = await operatorChat('Stop it.');
		expect(reply.actions[0].result).toBe('Error: No session "nothing". Use an id from list_sessions.');
		expect(reply.actions[1].result).toContain('# Steps');
	});

	it('gives up after a few rounds of tool calls', async () => {
		script = Array.from({ length: 6 }, () => ({ tool_calls: [toolCall('x', 'list_sessions', {})] }));
		const reply = await operatorChat('Loop.');
		expect(reply.actions).toHaveLength(4);
		expect(reply.text).toContain('kept going');
	});
});

describe('announcements', () => {
	it('speaks questions, summarised turns and errors only while someone listens', async () => {
		const heard: string[] = [];
		agentFeed.emit('event', { seq: 1, sessionId: 'c_fold', type: 'awaiting-input', at: 1, awaitingInput: true, questions: [{ question: 'Which sidebar width?', options: [{ label: 'Half' }, { label: 'Fixed' }] }] });
		await new Promise((r) => setTimeout(r, 5));
		expect(heard).toEqual([]);

		const stop = subscribeAnnouncements((a) => heard.push(`${a.kind}: ${a.text}`));
		script = [{ content: 'Auth token refresh rotated the key; all tests pass.' }];
		agentFeed.emit('event', { seq: 2, sessionId: 'c_fold', type: 'awaiting-input', at: 2, awaitingInput: true, questions: [{ question: 'Which sidebar width?', options: [{ label: 'Half' }, { label: 'Fixed' }] }] });
		agentFeed.emit('event', { seq: 3, sessionId: 'c_auth', type: 'turn-finished', at: 3, subtype: 'success' });
		agentFeed.emit('event', { seq: 4, sessionId: 's_dev', type: 'turn-finished', at: 4 });
		await new Promise((r) => setTimeout(r, 20));
		agentFeed.emit('event', { seq: 5, sessionId: 'c_auth', type: 'status', at: 5, status: 'error' });
		agentFeed.emit('event', { seq: 6, sessionId: 'c_fold', type: 'status', at: 6, status: 'idle' });
		await new Promise((r) => setTimeout(r, 20));
		stop();
		expect(heard).toEqual([
			'ask: Foldable layout is asking: Which sidebar width? Options: 1, Half. 2, Fixed.',
			'turn: Auth token refresh rotated the key; all tests pass.',
			'status: Auth token refresh hit an error.'
		]);
		expect(requests.at(-1)?.tools).toBeUndefined();
		expect((requests.at(-1) as { chat_template_kwargs?: unknown }).chat_template_kwargs).toEqual({ enable_thinking: false });
		// What it said is part of the conversation, so "yes, the first one" can follow.
		expect(operatorHistory().map((t) => t.content)).toContain('Foldable layout is asking: Which sidebar width? Options: 1, Half. 2, Fixed.');
	});
});
