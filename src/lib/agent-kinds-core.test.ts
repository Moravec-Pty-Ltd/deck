import { expect, it } from 'vitest';
import { AGENT_KINDS, type SessionKind } from './types';
import { kindShown } from './agent-kinds-core';

const shown = (availability: Parameters<typeof kindShown>[1], current?: SessionKind) =>
	AGENT_KINDS.filter((k) => kindShown(k, availability, current));

it('hides a kind only when availability says it is absent', () => {
	expect(shown({ claude: true, pi: false, codex: true, opencode: false })).toEqual(['claude', 'codex']);
	expect(shown({ claude: true })).toEqual(AGENT_KINDS);
});

it('shows every kind when availability is unknown', () => {
	expect(shown(null)).toEqual(AGENT_KINDS);
});

it('keeps the current kind even when it is absent', () => {
	expect(shown({ claude: true, pi: false, codex: false, opencode: false }, 'opencode')).toEqual(['claude', 'opencode']);
});

it('always shows shell, which availability never lists', () => {
	expect(kindShown('shell', { claude: false })).toBe(true);
});
