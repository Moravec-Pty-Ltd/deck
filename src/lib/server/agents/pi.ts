import path from 'node:path';
import { agentSessionsDir } from '../config';
import { isFlagSafe } from './args';
import { AGENT_BINARIES } from './binaries';
import type { AgentDriver, TurnContext } from './types';
import {
	assistantBlocks,
	deckError,
	resultEvent,
	streamStart,
	textDelta,
	toolResultEvent,
	toolUseBlock
} from './events';

type AnyObj = Record<string, any>;

// pi runs per turn: `pi -p --mode json --session <file> -- <message>`. The session
// file (under the deck data dir) carries history across turns. Verified event
// shape: session / agent_start / turn_start / message_start|update|end /
// turn_end. Streaming deltas arrive on message_update.assistantMessageEvent.
export const piDriver: AgentDriver = {
	kind: 'pi',

	buildTurn(session, message) {
		const sessionFile = path.join(agentSessionsDir, `pi-${session.id}.jsonl`);
		const args = ['-p', '--mode', 'json', '--session', sessionFile];
		// Drop provider/model that could smuggle a leading-dash flag (pi has no `--`).
		if (isFlagSafe(session.provider)) args.push('--provider', session.provider!);
		if (isFlagSafe(session.model)) args.push('--model', session.model!);
		// The prompt goes via stdin so it can never be parsed as a pi flag.
		return { cmd: AGENT_BINARIES.pi, args, stdin: message };
	},

	handleLine(line: AnyObj, ctx: TurnContext) {
		switch (line.type) {
			case 'session':
				if (typeof line.id === 'string') ctx.setAgentSessionId(line.id);
				return;

			case 'message_start':
				if (line.message?.role === 'assistant') ctx.emit(streamStart());
				return;

			case 'message_update': {
				const ev = line.assistantMessageEvent as AnyObj | undefined;
				if (ev?.type === 'text_delta' && typeof ev.delta === 'string') ctx.emit(textDelta(ev.delta));
				return;
			}

			case 'message_end':
				if (line.message?.role === 'assistant') {
					const blocks = mapContent(line.message?.content ?? []);
					if (blocks.length) ctx.append(assistantBlocks(blocks));
				}
				return;

			case 'turn_end': {
				for (const tr of (line.toolResults as AnyObj[]) ?? []) {
					const id = tr.toolCallId ?? tr.id;
					if (id) ctx.append(toolResultEvent(String(id), tr.result ?? tr.content ?? tr.output ?? ''));
				}
				const cost = line.message?.usage?.cost?.total;
				ctx.append(resultEvent({ cost: typeof cost === 'number' ? cost : undefined }));
				return;
			}

			case 'error':
			case 'agent_error':
				ctx.append(deckError(String(line.message ?? line.error ?? 'pi error')));
				return;
		}
	}
};

// pi assistant content -> normalised blocks. Text and thinking are verified; tool
// calls are best-effort (any block carrying a name is treated as a tool use).
function mapContent(content: AnyObj[]): unknown[] {
	const out: unknown[] = [];
	for (const b of content) {
		if (b?.type === 'text' && b.text) out.push({ type: 'text', text: b.text });
		else if (b?.type === 'thinking' && b.thinking) out.push({ type: 'thinking', thinking: b.thinking });
		else if (b?.name) out.push(toolUseBlock(String(b.id ?? b.toolCallId ?? b.name), String(b.name), b.input ?? b.arguments));
	}
	return out;
}
