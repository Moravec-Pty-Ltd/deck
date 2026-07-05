// Shared machinery for the per-project config forms (dev servers, workflows):
// the ordered-list move helper and the busy/saved/error state around the
// /api/projects POST (which carries every field the form doesn't send).

// Swap list[i] with its neighbour at i+delta, bounds-checked.
export function move<T>(list: T[], i: number, delta: number): T[] {
	const j = i + delta;
	if (j < 0 || j >= list.length) return list;
	const next = [...list];
	[next[i], next[j]] = [next[j], next[i]];
	return next;
}

async function saveError(res: Response): Promise<string> {
	return (await res.json().catch(() => ({})))?.message ?? 'failed to save';
}

// Save-state for a config form: `save(body)` POSTs the project patch, tracks
// busy/saved/errorMsg, and reports success back through `onsaved`.
export function createProjectSaver(onsaved: () => void) {
	let busy = $state(false);
	let saved = $state(false);
	let errorMsg = $state('');

	async function save(body: Record<string, unknown>) {
		busy = true;
		errorMsg = '';
		saved = false;
		try {
			const res = await fetch('/api/projects', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!res.ok) {
				errorMsg = await saveError(res);
				return;
			}
			saved = true;
			setTimeout(() => (saved = false), 1500);
			onsaved();
		} catch {
			// a rejected fetch (offline, network drop) must surface, not become an
			// unhandled rejection with no feedback
			errorMsg = 'failed to save';
		} finally {
			busy = false;
		}
	}

	return {
		get busy() {
			return busy;
		},
		get saved() {
			return saved;
		},
		get errorMsg() {
			return errorMsg;
		},
		save
	};
}
