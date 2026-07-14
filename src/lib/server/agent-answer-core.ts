// Pure classification of why an /answer failed (issue #144), so a caller can tell
// "nothing was waiting" from "wrong askId" instead of a bare { ok: false } (which
// conflated no-pending-ask, an already-answered race, and a mismatched askId).

export type AnswerFailureReason = 'no-pending-ask' | 'askid-required' | 'askid-mismatch';

// Called only when resolution already failed (resolveAsk/resolveWorkflowAsk both
// returned false), so the inputs reflect what is still pending.
export function classifyAnswerFailure(input: {
	mcpPending: boolean;
	wfPending: boolean;
	providedAskId: string;
	wfAskId: string | null;
}): AnswerFailureReason {
	// An MCP ask resolves by text alone, so if one were pending resolution would
	// have succeeded; reaching here with a workflow checkpoint pending means the
	// answer lacked, or misaddressed, the required askId.
	if (input.wfPending && !input.mcpPending) {
		if (!input.providedAskId) return 'askid-required';
		if (input.providedAskId !== input.wfAskId) return 'askid-mismatch';
	}
	// Otherwise nothing matching was waiting: already answered, wrong session, or a
	// race where the ask resolved first.
	return 'no-pending-ask';
}
