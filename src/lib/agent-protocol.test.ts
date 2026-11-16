import { describe, expect, it } from 'vitest';
import { AGENT_PROTOCOL, agentBinaryArch, detectFromVersion, parseAgentLine, persistsCursor, versionLine } from './agent-protocol';

describe('detectFromVersion', () => {
	it('uses the agent only when its protocol matches', () => {
		expect(detectFromVersion(versionLine())).toEqual({ mode: 'agent' });
		expect(detectFromVersion(`motd noise\n${versionLine()}\n`)).toEqual({ mode: 'agent' });
		expect(detectFromVersion(null)).toEqual({ mode: 'bare' });
	});

	it('falls back to bare with a note to update on a mismatch', () => {
		const older = detectFromVersion(JSON.stringify({ name: 'deck-agent', protocol: AGENT_PROTOCOL + 1 }));
		expect(older.mode).toBe('bare');
		expect(older.mode === 'bare' && older.note).toMatch(new RegExp(`protocol ${AGENT_PROTOCOL + 1}.*Update`));
		const garbled = detectFromVersion('deck-agent 0.1');
		expect(garbled.mode === 'bare' && garbled.note).toMatch(/unknown protocol/);
	});
});

describe('parseAgentLine', () => {
	it('reads entries and ready, and drops anything else', () => {
		expect(parseAgentLine('{"t":"ready","got":3}')).toEqual({ t: 'ready', got: 3 });
		expect(parseAgentLine('{"t":"ready"}')).toEqual({ t: 'ready', got: 0 });
		expect(parseAgentLine('{"run":"r","seq":2,"t":"out","line":"{}"}')).toEqual({ run: 'r', seq: 2, t: 'out', line: '{}' });
		expect(parseAgentLine('{"run":"r","seq":2,"t":"bogus"}')).toBeNull();
		expect(parseAgentLine('{"t":"out","line":"{}"}')).toBeNull();
		expect(parseAgentLine('Welcome to the host')).toBeNull();
		expect(parseAgentLine('{not json')).toBeNull();
	});
});

it('saves the cursor for everything but streaming deltas', () => {
	expect(persistsCursor({ run: 'r', seq: 1, t: 'out', line: '{"type":"stream_event","event":{}}' })).toBe(false);
	expect(persistsCursor({ run: 'r', seq: 1, t: 'out', line: '{"type":"assistant"}' })).toBe(true);
	expect(persistsCursor({ run: 'r', seq: 1, t: 'mcp', msg: {} })).toBe(true);
});

it('picks the agent build for the host', () => {
	expect(agentBinaryArch('Linux x86_64\n')).toBe('x64');
	expect(agentBinaryArch('Linux aarch64')).toBe('arm64');
	expect(agentBinaryArch('Darwin arm64')).toBeNull();
	expect(agentBinaryArch('Linux riscv64')).toBeNull();
});
