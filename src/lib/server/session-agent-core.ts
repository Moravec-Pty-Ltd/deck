import { AGENT_KINDS, type AgentKind, type DeckSession } from '$lib/types';
import type { TranscriptMessage } from '$lib/agent-transcript-core';

export function parseAgent(value: unknown): AgentKind | null {
	return AGENT_KINDS.find((kind) => kind === value) ?? null;
}

export function agentSwitchPatch(kind: AgentKind, runtimeId: string, context: string): Partial<DeckSession> {
	return {
		kind,
		model: undefined,
		provider: undefined,
		effort: undefined,
		claudeSessionId: undefined,
		agentSessionId: undefined,
		agentRuntimeId: runtimeId,
		pendingHandoff: context,
		status: 'idle'
	};
}

export function handoffContext(messages: TranscriptMessage[]): string {
	const history = messages.map((message) => `${message.role}: ${message.text}`).join('\n\n');
	return [
		'You are continuing an existing deck conversation with a different coding agent.',
		'The working directory and files are unchanged. The following is recent conversation context, not a new request.',
		'Older messages, tool output, and image contents may be omitted. Inspect the workspace and ask if needed.',
		'<previous_conversation>',
		history.slice(-24000),
		'</previous_conversation>'
	].join('\n');
}

// A message spoken in voice mode asks for a reply that reads well aloud, since
// only the opening of a long one is read. A slash command keeps its arguments.
export const VOICE_INSTRUCTION =
	'(Sent by voice; your reply is read aloud. Answer in two or three plain sentences first, with no tables, lists or code unless asked, then put any detail after.)';

export function spokenPrompt(text: string): string {
	return text.trim() && !text.trimStart().startsWith('/') ? `${text}\n\n${VOICE_INSTRUCTION}` : text;
}

export function handoffPrompt(context: string | undefined, text: string): string {
	return context ? `${context}\n\nCurrent user request:\n${text}` : text;
}
