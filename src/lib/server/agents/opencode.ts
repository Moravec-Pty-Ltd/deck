import { isFlagSafe } from './args';
import type { AgentDriver, TurnContext } from './types';
import { assistantBlocks, assistantText, deckError, resultEvent, toolResultEvent, toolUseBlock } from './events';

type AnyObj = Record<string, any>;

// opencode runs per turn: `opencode run --format json ... -- <message>`, resumed
// across turns with `--session <id>`. Verified shape (opencode 1.17): every line
// is { type, timestamp, sessionID, part }; observed types: step_start / tool_use
// / text / step_finish. `text` parts arrive complete (no streaming deltas).
// step_finish reason 'tool-calls' means the turn continues; anything else ends it.
// reasoning and error events are also handled, mapped by analogy with the
// observed shape rather than captured live.
export const opencodeDriver: AgentDriver = {
	kind: 'opencode',

	buildTurn(session, message, resumeId) {
		// Auto-approve permissions: a per-turn run that paused on a permission prompt
		// would hang the turn with no way to answer (deck's `ask` is Claude-only).
		// Explicit denies in the user's opencode config are still honoured.
		const args = ['run', '--format', 'json', '--dangerously-skip-permissions'];
		if (isFlagSafe(session.model)) args.push('--model', session.model!);
		if (isFlagSafe(resumeId)) args.push('--session', resumeId!);
		// `--` stops opencode parsing the prompt as a flag.
		args.push('--', message);
		return { cmd: 'opencode', args };
	},

	handleLine(line: AnyObj, ctx: TurnContext) {
		const part = line.part as AnyObj | undefined;
		switch (line.type) {
			case 'step_start':
				// Every event carries sessionID; recording it once per step keeps
				// store writes bounded.
				if (typeof line.sessionID === 'string') ctx.setAgentSessionId(line.sessionID);
				return;

			case 'text':
				if (part?.text) ctx.append(assistantText(String(part.text)));
				return;

			case 'reasoning':
				if (part?.text) ctx.append(assistantBlocks([{ type: 'thinking', thinking: String(part.text) }]));
				return;

			case 'tool_use': {
				const id = String(part?.callID ?? part?.id ?? 'tool');
				const state = part?.state as AnyObj | undefined;
				ctx.append(assistantBlocks([toolUseBlock(id, String(part?.tool ?? 'tool'), state?.input)]));
				if (state?.output != null) {
					ctx.append(toolResultEvent(id, state.output, state.status === 'error'));
				}
				return;
			}

			case 'step_finish':
				// 'tool-calls' is a step boundary mid-turn; 'stop' ends the turn cleanly.
				// Other finish reasons (length, error, ...) weren't captured live, so
				// they're conservatively surfaced as an error footer.
				if (part?.reason !== 'tool-calls') {
					ctx.append(
						resultEvent({
							subtype: part?.reason === 'stop' ? undefined : 'error',
							cost: typeof part?.cost === 'number' ? part.cost : undefined
						})
					);
				}
				return;

			case 'error':
				ctx.append(deckError(String((line.error as AnyObj)?.message ?? line.message ?? 'opencode error')));
				return;
		}
	}
};
