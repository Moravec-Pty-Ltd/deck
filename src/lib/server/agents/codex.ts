import { isFlagSafe } from './args';
import { AGENT_BINARIES } from './binaries';
import type { AgentDriver, TurnContext } from './types';
import { assistantBlocks, assistantText, deckError, resultEvent, toolResultEvent, toolUseBlock } from './events';

type AnyObj = Record<string, any>;

// codex runs per turn: `codex exec --json ... <message>`, resumed across turns
// with `codex exec ... resume <thread_id> -- <message>`. Verified live on codex
// 0.153.3: thread.started (thread_id) / turn.started / item.started /
// item.completed / turn.completed (usage carries tokens, no cost) / turn.failed
// / error. command_execution and file_change items arrive as item.started then
// item.completed; agent_message and reasoning arrive complete (no deltas).

// Tool items already announced at item.started, so item.completed appends only
// the result. Keyed per turn (ctx identity): a completed whose started was never
// seen still gets its tool_use emitted.
const started = new WeakMap<TurnContext, Set<string>>();

export const codexDriver: AgentDriver = {
	kind: 'codex',

	buildTurn(session, message, resumeId) {
		const flags = ['--json', '--sandbox', 'workspace-write', '--skip-git-repo-check'];
		if (isFlagSafe(session.model)) flags.push('-m', session.model!);
		// exec's flags must precede the `resume` subcommand: `codex exec resume`
		// rejects them after it (exit 2). `--` stops codex parsing the prompt as
		// a flag.
		const args = resumeId
			? ['exec', ...flags, 'resume', resumeId, '--', message]
			: ['exec', ...flags, '--', message];
		return { cmd: AGENT_BINARIES.codex, args };
	},

	handleLine(line: AnyObj, ctx: TurnContext) {
		switch (line.type) {
			case 'thread.started':
				if (typeof line.thread_id === 'string') ctx.setAgentSessionId(line.thread_id);
				return;

			case 'item.started':
				openItem(line.item as AnyObj, ctx);
				return;

			case 'item.completed':
				completeItem(line.item as AnyObj, ctx);
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

// Emit the tool_use block for a tool-shaped item, once per item id per turn.
// Returns the id so completeItem can attach the result.
function openTool(item: AnyObj, ctx: TurnContext): string {
	const id = String(item.id ?? item.type ?? 'tool');
	const seen = started.get(ctx) ?? new Set<string>();
	started.set(ctx, seen);
	if (seen.has(id)) return id;
	seen.add(id);
	switch (item.type) {
		case 'command_execution':
			ctx.append(assistantBlocks([toolUseBlock(id, 'Bash', { command: item.command })]));
			break;
		case 'file_change':
		case 'patch':
			ctx.append(assistantBlocks([toolUseBlock(id, 'Edit', item.changes ?? item)]));
			break;
		default:
			// Unknown item types still surface as a generic tool use so nothing is lost.
			ctx.append(assistantBlocks([toolUseBlock(id, String(item.type), item)]));
	}
	return id;
}

function isToolItem(item: AnyObj): boolean {
	return (
		item.type !== 'agent_message' &&
		item.type !== 'assistant_message' &&
		item.type !== 'reasoning' &&
		item.type !== 'error'
	);
}

function openItem(item: AnyObj | undefined, ctx: TurnContext) {
	// Messages and reasoning stream no deltas; only tool items announce early.
	if (item?.type && isToolItem(item)) openTool(item, ctx);
}

function completeItem(item: AnyObj | undefined, ctx: TurnContext) {
	if (!item?.type) return;
	switch (item.type) {
		case 'assistant_message':
		case 'agent_message':
			if (item.text) ctx.append(assistantText(String(item.text)));
			return;

		case 'reasoning':
			if (item.text) ctx.append(assistantBlocks([{ type: 'thinking', thinking: String(item.text) }]));
			return;

		// e.g. { type: 'error', message: 'Code Mode is unavailable ...' } when a
		// tool subsystem fails mid-turn (observed live on 0.153.3).
		case 'error':
			ctx.append(deckError(String(item.message ?? 'codex error')));
			return;

		case 'command_execution': {
			const id = openTool(item, ctx);
			if (item.aggregated_output ?? item.output) {
				ctx.append(toolResultEvent(id, item.aggregated_output ?? item.output, item.exit_code != null && item.exit_code !== 0));
			}
			return;
		}

		default:
			openTool(item, ctx);
	}
}
