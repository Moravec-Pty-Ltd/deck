// Claude model shortnames the CLI accepts, offered in the New Session modal and
// the mid-session model switcher (issue #88). pi/codex take free-text ids.
export const CLAUDE_MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const;

// Display name for a session's model wherever it surfaces (header chip, palette
// hint, transcript marker): an unset model means the CLI's default.
export function modelLabel(model: string | undefined): string {
	return model || 'default';
}

// Switch a session's model (shared by the header ModelMenu and the palette's
// model step). Empty string resets to the default. Throws with the server's
// message on failure so callers can show it inline.
export async function switchModel(id: string, model: string): Promise<void> {
	const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/model`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ model })
	});
	if (!res.ok) {
		const data = await res.json().catch(() => null);
		throw new Error(data?.message || 'model switch failed');
	}
}
