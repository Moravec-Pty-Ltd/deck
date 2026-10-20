import type { AgentSettingsPatch, AgentSettingsView } from '$lib/types';

// The settings page is a card per block of ~/.deck/settings.json. Each one
// saves by sending only its own block and the server merges it into the file
// as it is on disk, so two cards (or a card and an agent) can't clobber each
// other. Reads are the redacted agent view: no stored key reaches the browser.

export async function fetchSettings(): Promise<AgentSettingsView> {
	const res = await fetch('/api/agent/settings');
	if (!res.ok) throw new Error('failed to load settings');
	return (await res.json()) as AgentSettingsView;
}

export async function patchSettings(patch: AgentSettingsPatch): Promise<AgentSettingsView> {
	const res = await fetch('/api/agent/settings', {
		method: 'PATCH',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(patch)
	});
	if (!res.ok) throw new Error((await res.json().catch(() => null))?.message ?? 'save failed');
	return (await res.json()) as AgentSettingsView;
}
