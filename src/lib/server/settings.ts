import { error, json } from '@sveltejs/kit';
import type { AgentKind } from '$lib/types';
import { readSettings, saveSettings } from './store';
import { objectBody } from './http';
import { mergeSettings, parseSettingsPatch, redactSettings } from './settings-core';
import { detectLocalSpeechServer } from './speech';
import { AGENT_BINARIES } from './agents/binaries';
import { agentAvailability } from './agents/available';
import { installSkill, listSkillStatuses } from './skills';
import { decidePairing, listPending } from './pairing';
import { resolveSecretsFile, SECRETS_FILE_RULE } from './secrets-file';

// Settings-page handlers. The agent API's settings PATCH names only the blocks
// it changes and the server merges it into the file as it is on disk, so two
// writers can't clobber each other's blocks (a whole-object write could).
// Reads and writes are synchronous, so the merge can't interleave.

export function agentSettingsRoute(): Response {
	return json(redactSettings(readSettings()));
}

export async function patchSettingsRoute({ request }: { request: Request }): Promise<Response> {
	const parsed = parseSettingsPatch(await objectBody(request));
	if (!parsed.ok) error(400, parsed.message);
	const keyFile = parsed.patch.blocks.operator?.apiKeyFile;
	if (typeof keyFile === 'string' && !resolveSecretsFile(keyFile)) error(400, SECRETS_FILE_RULE);
	return json(redactSettings(saveSettings(mergeSettings(readSettings(), parsed.patch))));
}

// Probe the local chatterbox server so a settings form can fill the speech
// fields in one click. { found: false } when nothing answers.
export async function speechDetectRoute(): Promise<Response> {
	const found = await detectLocalSpeechServer();
	return json(found ? { found: true, ...found } : { found: false });
}

// Install/version status of the shipped deck skill per harness (issue #127).
export async function skillStatusRoute(): Promise<Response> {
	return json(await listSkillStatuses());
}

function kindParam(v: unknown): AgentKind {
	if (typeof v !== 'string' || !Object.hasOwn(AGENT_BINARIES, v)) error(400, 'invalid kind');
	return v as AgentKind;
}

// Install or update the skill for one harness (same write either way).
export async function installSkillRoute({ request }: { request: Request }): Promise<Response> {
	const kind = kindParam((await objectBody(request)).kind);
	const available = (await agentAvailability())[kind];
	try {
		return json(installSkill(kind, available));
	} catch (e) {
		error(400, e instanceof Error ? e.message : 'failed to install skill');
	}
}

// The live access requests a signed-in client may approve: id and code only,
// never the requester's secret.
export function pendingPairingsRoute(): Response {
	return json({ pending: listPending() });
}

// `ok` is false when the request expired or was already decided.
export async function decidePairingRoute({
	params,
	request
}: {
	params: Partial<Record<string, string>>;
	request: Request;
}): Promise<Response> {
	const { approve } = await objectBody(request);
	if (typeof approve !== 'boolean') error(400, 'approve must be a boolean');
	return json({ ok: decidePairing(params.id!, approve) });
}
