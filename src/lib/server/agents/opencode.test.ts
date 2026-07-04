import { describe, expect, it } from 'vitest';
import type { DeckSession } from '$lib/types';
import type { DeckEvent, TurnContext } from './types';
import { opencodeDriver } from './opencode';

function session(overrides: Partial<DeckSession> = {}): DeckSession {
	return {
		id: 'o_test1234',
		kind: 'opencode',
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

describe('opencodeDriver.buildTurn', () => {
	it('builds a fresh turn with the prompt after --', () => {
		const turn = opencodeDriver.buildTurn(session(), '-hello', undefined);
		expect(turn.cmd).toBe('opencode');
		expect(turn.args).toEqual([
			'run',
			'--format',
			'json',
			'--dangerously-skip-permissions',
			'--',
			'-hello'
		]);
	});

	it('adds --model and --session when safe', () => {
		const turn = opencodeDriver.buildTurn(session({ model: 'anthropic/claude-sonnet-4-5' }), 'hi', 'ses_abc');
		expect(turn.args).toContain('--model');
		expect(turn.args).toContain('anthropic/claude-sonnet-4-5');
		expect(turn.args.slice(-4)).toEqual(['--session', 'ses_abc', '--', 'hi']);
	});

	it('drops flag-shaped model and session values', () => {
		const turn = opencodeDriver.buildTurn(session({ model: '--evil' }), 'hi', '-x');
		expect(turn.args).not.toContain('--model');
		expect(turn.args).not.toContain('--session');
	});
});

// Fixtures captured from a real `opencode run --format json` (opencode 1.17.10).
const STEP_START = {
	type: 'step_start',
	timestamp: 1783170416206,
	sessionID: 'ses_0d2c2cba2ffetS2JDtC7ikqIiE',
	part: { id: 'prt_1', messageID: 'msg_1', sessionID: 'ses_0d2c2cba2ffetS2JDtC7ikqIiE', type: 'step-start' }
};
const TOOL_USE = {
	type: 'tool_use',
	sessionID: 'ses_0d2c2cba2ffetS2JDtC7ikqIiE',
	part: {
		type: 'tool',
		tool: 'bash',
		callID: 'call_00_yjia81',
		state: {
			status: 'completed',
			input: { command: 'echo hello-deck' },
			output: 'hello-deck\n',
			metadata: { output: 'hello-deck\n', exit: 0, truncated: false },
			title: 'echo hello-deck'
		},
		id: 'prt_2',
		sessionID: 'ses_0d2c2cba2ffetS2JDtC7ikqIiE',
		messageID: 'msg_1'
	}
};
const TEXT = {
	type: 'text',
	sessionID: 'ses_0d2c2cba2ffetS2JDtC7ikqIiE',
	part: { id: 'prt_3', messageID: 'msg_2', type: 'text', text: 'done' }
};
const FINISH_TOOL_CALLS = {
	type: 'step_finish',
	sessionID: 'ses_0d2c2cba2ffetS2JDtC7ikqIiE',
	part: { id: 'prt_4', reason: 'tool-calls', type: 'step-finish', tokens: { total: 24485 }, cost: 0 }
};
const FINISH_STOP = {
	type: 'step_finish',
	sessionID: 'ses_0d2c2cba2ffetS2JDtC7ikqIiE',
	part: { id: 'prt_5', reason: 'stop', type: 'step-finish', tokens: { total: 24524 }, cost: 0.0042 }
};

describe('opencodeDriver.handleLine', () => {
	it('records the session id from step_start', () => {
		const { c, id } = ctx();
		opencodeDriver.handleLine(STEP_START, c);
		expect(id()).toBe('ses_0d2c2cba2ffetS2JDtC7ikqIiE');
	});

	it('maps a full turn to normalised events', () => {
		const { c, appended } = ctx();
		for (const line of [STEP_START, TOOL_USE, FINISH_TOOL_CALLS, TEXT, FINISH_STOP]) {
			opencodeDriver.handleLine(line, c);
		}
		expect(appended.map((e) => e.type)).toEqual(['assistant', 'user', 'assistant', 'result']);

		const [toolUse, toolResult, text, result] = appended as any[];
		expect(toolUse.message.content[0]).toMatchObject({
			type: 'tool_use',
			id: 'call_00_yjia81',
			name: 'bash',
			input: { command: 'echo hello-deck' }
		});
		expect(toolResult.message.content[0]).toMatchObject({
			type: 'tool_result',
			tool_use_id: 'call_00_yjia81',
			content: 'hello-deck\n',
			is_error: false
		});
		expect(text.message.content[0]).toEqual({ type: 'text', text: 'done' });
		expect(result).toMatchObject({ type: 'result', subtype: 'success', total_cost_usd: 0.0042 });
	});

	it('does not emit a result for tool-calls step boundaries', () => {
		const { c, appended } = ctx();
		opencodeDriver.handleLine(FINISH_TOOL_CALLS, c);
		expect(appended).toEqual([]);
	});

	it('marks non-stop finish reasons as errors', () => {
		const { c, appended } = ctx();
		opencodeDriver.handleLine(
			{ ...FINISH_STOP, part: { ...FINISH_STOP.part, reason: 'length', cost: 0 } },
			c
		);
		expect(appended[0]).toMatchObject({ type: 'result', subtype: 'error' });
	});

	it('flags failed tool results as errors', () => {
		const { c, appended } = ctx();
		const failed = {
			...TOOL_USE,
			part: {
				...TOOL_USE.part,
				state: { status: 'error', input: { command: 'false' }, output: 'boom' }
			}
		};
		opencodeDriver.handleLine(failed, c);
		expect((appended[1] as any).message.content[0].is_error).toBe(true);
	});

	it('surfaces error events as deck errors', () => {
		const { c, appended } = ctx();
		opencodeDriver.handleLine({ type: 'error', error: { message: 'model not found' } }, c);
		expect(appended[0]).toMatchObject({ type: 'deck.error', text: 'model not found' });
	});
});
