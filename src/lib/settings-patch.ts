import type { DeckSettings } from '$lib/types';

// The settings page is a card per block of ~/.deck/settings.json, and each one
// saves by reading the whole file, replacing its own key, and writing it back:
// a PUT carries the entire object, so a card that sent only its own block would
// wipe the others. That read-merge-write is the same three lines everywhere, so
// it lives here rather than once per card.

export async function fetchSettings(): Promise<DeckSettings> {
	const res = await fetch('/api/settings');
	return res.ok ? ((await res.json()) as DeckSettings) : {};
}

// Replace one block, keeping the rest of the file as it is on disk right now
// (not as the card last saw it, so two cards saved in a row don't clobber).
export async function patchSettings<K extends keyof DeckSettings>(
	key: K,
	value: DeckSettings[K]
): Promise<void> {
	const current = await fetchSettings();
	const res = await fetch('/api/settings', {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ ...current, [key]: value })
	});
	if (!res.ok) throw new Error('save failed');
}
