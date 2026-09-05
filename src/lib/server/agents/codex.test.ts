import { describe, expect, it } from 'vitest';
import type { DeckSession } from '$lib/types';
import type { DeckEvent, TurnContext } from './types';
import { codexDriver } from './codex';

function session(overrides: Partial<DeckSession> = {}): DeckSession {
	return {
		id: 'x_test1234',
		kind: 'codex',
		title: 't',
		cwd: '/tmp',
		createdAt: 0,
		lastActiveAt: 0,
		status: 'idle',
		...overrides
	};
}

function ctx() {
	const appended: DeckEvent[] = [];
	const emitted: DeckEvent[] = [];
	let agentSessionId: string | undefined;
	const c: TurnContext = {
		append: (e) => appended.push(e),
		emit: (e) => emitted.push(e),
		setAgentSessionId: (id) => (agentSessionId = id)
	};
	return { c, appended, emitted, id: () => agentSessionId };
}

describe('codexDriver.buildTurn', () => {
	it('builds a fresh turn with the prompt after --', () => {
		const turn = codexDriver.buildTurn(session(), '-hello', undefined);
		expect(turn.cmd).toBe('codex');
		expect(turn.args).toEqual([
			'exec',
			'--json',
			'--sandbox',
			'workspace-write',
			'--skip-git-repo-check',
			'--',
			'-hello'
		]);
	});

	it('puts exec flags before the resume subcommand', () => {
		// `codex exec resume` rejects exec's flags after the subcommand (exit 2 on
		// 0.153.3), so a resumed turn must carry them between `exec` and `resume`.
		const turn = codexDriver.buildTurn(session(), 'hi', 'thread_abc');
		expect(turn.args).toEqual([
			'exec',
			'--json',
			'--sandbox',
			'workspace-write',
			'--skip-git-repo-check',
			'resume',
			'thread_abc',
			'--',
			'hi'
		]);
	});

	it('adds -m when the model is safe', () => {
		const turn = codexDriver.buildTurn(session({ model: 'gpt-5.3-codex' }), 'hi', 'thread_abc');
		expect(turn.args.indexOf('-m')).toBeGreaterThan(-1);
		expect(turn.args.indexOf('-m')).toBeLessThan(turn.args.indexOf('resume'));
		expect(turn.args[turn.args.indexOf('-m') + 1]).toBe('gpt-5.3-codex');
	});

	it('drops a flag-shaped model', () => {
		const turn = codexDriver.buildTurn(session({ model: '--evil' }), 'hi', undefined);
		expect(turn.args).not.toContain('-m');
	});
});

// Event lines below are verbatim captures from codex 0.153.3 `exec --json`.
describe('codexDriver.handleLine', () => {
	it('records the thread id from thread.started', () => {
		const { c, id } = ctx();
		codexDriver.handleLine(
			{ type: 'thread.started', thread_id: '01a06f17-5b04-75e2-b6ca-315e914adff8' },
			c
		);
		expect(id()).toBe('01a06f17-5b04-75e2-b6ca-315e914adff8');
	});

	it('maps agent_message to assistant text', () => {
		const { c, appended } = ctx();
		codexDriver.handleLine(
			{ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'done' } },
			c
		);
		expect(appended).toEqual([
			{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }
		]);
	});

	it('announces a command at item.started and attaches only the result at item.completed', () => {
		const { c, appended } = ctx();
		codexDriver.handleLine(
			{
				type: 'item.started',
				item: {
					id: 'item_1',
					type: 'command_execution',
					command: "/bin/zsh -lc 'echo hello-deck'",
					aggregated_output: '',
					exit_code: null,
					status: 'in_progress'
				}
			},
			c
		);
		codexDriver.handleLine(
			{
				type: 'item.completed',
				item: {
					id: 'item_1',
					type: 'command_execution',
					command: "/bin/zsh -lc 'echo hello-deck'",
					aggregated_output: 'hello-deck\n',
					exit_code: 0,
					status: 'completed'
				}
			},
			c
		);
		expect(appended).toEqual([
			{
				type: 'assistant',
				message: {
					role: 'assistant',
					content: [
						{ type: 'tool_use', id: 'item_1', name: 'Bash', input: { command: "/bin/zsh -lc 'echo hello-deck'" } }
					]
				}
			},
			{
				type: 'user',
				message: {
					role: 'user',
					content: [
						{ type: 'tool_result', tool_use_id: 'item_1', content: 'hello-deck\n', is_error: false }
					]
				}
			}
		]);
	});

	it('still emits the tool_use when a command completes without a started event', () => {
		const { c, appended } = ctx();
		codexDriver.handleLine(
			{
				type: 'item.completed',
				item: { id: 'item_1', type: 'command_execution', command: 'ls', aggregated_output: 'a\n', exit_code: 0 }
			},
			c
		);
		expect(appended).toHaveLength(2);
		expect((appended[0].message as any).content[0].type).toBe('tool_use');
		expect((appended[1].message as any).content[0].type).toBe('tool_result');
	});

	it('flags a non-zero exit as an error result', () => {
		const { c, appended } = ctx();
		codexDriver.handleLine(
			{
				type: 'item.completed',
				item: { id: 'item_1', type: 'command_execution', command: 'false', aggregated_output: 'boom', exit_code: 1 }
			},
			c
		);
		expect((appended[1].message as any).content[0].is_error).toBe(true);
	});

	it('maps file_change to a single Edit tool_use across started and completed', () => {
		const { c, appended } = ctx();
		const changes = [{ path: '/tmp/note.txt', kind: 'add' }];
		codexDriver.handleLine(
			{ type: 'item.started', item: { id: 'item_2', type: 'file_change', changes, status: 'in_progress' } },
			c
		);
		codexDriver.handleLine(
			{ type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes, status: 'completed' } },
			c
		);
		expect(appended).toEqual([
			{
				type: 'assistant',
				message: {
					role: 'assistant',
					content: [{ type: 'tool_use', id: 'item_2', name: 'Edit', input: changes }]
				}
			}
		]);
	});

	it('maps reasoning to a thinking block', () => {
		const { c, appended } = ctx();
		codexDriver.handleLine(
			{ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'hmm' } },
			c
		);
		expect(appended).toEqual([
			{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] } }
		]);
	});

	it('surfaces an error item as a deck error, not a tool block', () => {
		const { c, appended } = ctx();
		codexDriver.handleLine(
			{ type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Code Mode is unavailable' } },
			c
		);
		expect(appended).toHaveLength(1);
		expect(appended[0].type).toBe('deck.error');
		expect(appended[0].text).toBe('Code Mode is unavailable');
	});

	it('emits a success result footer on turn.completed (usage carries no cost)', () => {
		const { c, appended } = ctx();
		codexDriver.handleLine(
			{ type: 'turn.completed', usage: { input_tokens: 37155, cached_input_tokens: 30464, output_tokens: 87 } },
			c
		);
		expect(appended).toHaveLength(1);
		expect(appended[0].type).toBe('result');
		expect(appended[0].subtype).toBe('success');
		expect(appended[0].total_cost_usd).toBeUndefined();
	});

	it('emits an error footer on turn.failed', () => {
		const { c, appended } = ctx();
		codexDriver.handleLine({ type: 'turn.failed', error: { message: 'token expired' } }, c);
		expect(appended).toEqual([
			expect.objectContaining({ type: 'deck.error', text: 'token expired' }),
			expect.objectContaining({ type: 'result', subtype: 'error' })
		]);
	});

	it('surfaces unknown tool item types as generic tool uses', () => {
		const { c, appended } = ctx();
		codexDriver.handleLine(
			{ type: 'item.completed', item: { id: 'item_9', type: 'web_search', query: 'svelte runes' } },
			c
		);
		expect((appended[0].message as any).content[0]).toMatchObject({ type: 'tool_use', name: 'web_search' });
	});
});
