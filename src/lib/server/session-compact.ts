import { json } from '@sveltejs/kit';
import { idleClaudeSession } from './session-guards';
import { compactSession } from './auto-compact';

// Compact a session's context on demand, the same command the automatic
// threshold sends (see auto-compact.ts). Shared verbatim by
// /api/sessions/[id]/compact (browser) and /api/agent/sessions/[id]/compact
// (agent API), the way session-model.ts and session-effort.ts are.
//
// Idle-only: a compaction is a turn of its own, so it would queue behind the
// running one and land somewhere you didn't ask for. claude-only, since it is
// claude's `/compact` command doing the work.
export async function compactSessionRoute(event: {
	params: Partial<Record<string, string>>;
}): Promise<Response> {
	const session = idleClaudeSession(event.params.id, 'only claude sessions can be compacted');
	await compactSession(session);
	return json({ ok: true });
}
