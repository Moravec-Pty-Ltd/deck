import { isFlagSafe } from './args';
import { AGENT_BINARIES } from './binaries';
import type { AgentDriver, TurnContext } from './types';
import { assistantBlocks, assistantText, deckError, resultEvent, toolResultEvent, toolUseBlock } from './events';

type AnyObj = Record<string, any>;

// codex runs per turn: `codex exec --json ... <message>`, resumed across turns
// with `codex exec resume <thread_id> --json ... <message>`. Verified top-level
// events: thread.started (thread_id) / turn.started / turn.completed / turn.failed
// / error. The item.* mapping below follows codex's documented item model but is
// UNTESTED against a live codex (no subscription here); refine once exercised.
export const codexDriver: AgentDriver = {
	kind: 'codex',

	buildTurn(session, message, resumeId) {
		const flags = ['--json', '--sandbox', 'workspace-write', '--skip-git-repo-check'];
		if (isFlagSafe(session.model)) flags.push('-m', session.model!);
		// `--` stops codex parsing the prompt as a flag.
		const args = resumeId
			? ['exec', 'resume', resumeId, ...flags, '--', message]
			: ['exec', ...flags, '--', message];
		return { cmd: AGENT_BINARIES.codex, args };
	},

	handleLine(line: AnyObj, ctx: TurnContext) {
		switch (line.type) {
			case 'thread.started':
				if (typeof line.thread_id === 'string') ctx.setAgentSessionId(line.thread_id);
				return;

			case 'item.completed':
				mapItem(line.item as AnyObj, ctx);
				return;

			case 'turn.completed':
				ctx.append(resultEvent({ cost: (line.usage as AnyObj)?.total_cost_usd }));
				return;

			case 'turn.failed':
				ctx.append(deckError(String((line.error as AnyObj)?.message ?? 'codex turn failed')));
				ctx.append(resultEvent({ subtype: 'error' }));
				return;

			case 'error':
				ctx.append(deckError(String(line.message ?? 'codex error')));
				return;
		}
	}
};

function mapItem(item: AnyObj | undefined, ctx: TurnContext) {
	if (!item) return;
	switch (item.type) {
		case 'assistant_message':
		case 'agent_message':
			if (item.text) ctx.append(assistantText(String(item.text)));
			return;

		case 'reasoning':
			if (item.text) ctx.append(assistantBlocks([{ type: 'thinking', thinking: String(item.text) }]));
			return;

		case 'command_execution': {
			const id = String(item.id ?? item.call_id ?? 'cmd');
			ctx.append(assistantBlocks([toolUseBlock(id, 'Bash', { command: item.command })]));
			if (item.aggregated_output ?? item.output) {
				ctx.append(toolResultEvent(id, item.aggregated_output ?? item.output, item.exit_code != null && item.exit_code !== 0));
			}
			return;
		}

		case 'file_change':
		case 'patch': {
			const id = String(item.id ?? 'patch');
			ctx.append(assistantBlocks([toolUseBlock(id, 'Edit', item.changes ?? item)]));
			return;
		}

		default:
			// Unknown item types still surface as a generic tool use so nothing is lost.
			if (item.type) {
				ctx.append(assistantBlocks([toolUseBlock(String(item.id ?? item.type), String(item.type), item)]));
			}
	}
}
