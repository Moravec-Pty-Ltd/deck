// Pure secret-store logic: backend selection, how a source id maps to a keyring
// entry, the secrets.json shape, and the boot messages. No node imports and no
// native binding, so this unit-tests on its own; the sibling secrets.ts binds it
// to @napi-rs/keyring and the file store. Mirrors the apns-core.ts / apns.ts split.

// One keyring service for all of deck's stored keys; the account is per source.
export const KEYRING_SERVICE = 'deck';

export const SECRETS_FILE = 'secrets.json';

// Opt-in flag for the plaintext 0600 file backend (the DECK_* convention in config.ts).
export const FILE_BACKEND_FLAG = 'DECK_SECRETS_FILE';

export type SecretsFile = Record<string, { apiKey: string }>;

export type BackendKind = 'keyring' | 'file';

// Prefixed so deck's entries stay distinguishable if this service ever holds
// anything but issue-source keys.
export function keyringAccount(sourceId: string): string {
	return `source:${sourceId}`;
}

export function resolveBackendKind(env: Record<string, string | undefined>): BackendKind {
	const flag = env[FILE_BACKEND_FLAG];
	return flag === '1' || flag === 'true' ? 'file' : 'keyring';
}

export function readSecretFrom(secrets: SecretsFile, sourceId: string): string | undefined {
	return secrets[sourceId]?.apiKey;
}

export function withSecret(secrets: SecretsFile, sourceId: string, apiKey: string): SecretsFile {
	return { ...secrets, [sourceId]: { apiKey } };
}

// null when there's nothing to remove, so the caller skips the write entirely.
export function withoutSecret(secrets: SecretsFile, sourceId: string): SecretsFile | null {
	if (!(sourceId in secrets)) return null;
	const next = { ...secrets };
	delete next[sourceId];
	return next;
}

export function secretEntries(secrets: SecretsFile): { sourceId: string; apiKey: string }[] {
	return Object.entries(secrets).map(([sourceId, { apiKey }]) => ({ sourceId, apiKey }));
}

// --- Boot messages ---
// deck never falls back to plaintext on its own, so each of these has to name
// both the cause and the flag that opts in to the file backend.

export function keyringUnavailableMessage(cause: string): string {
	return `[deck] the OS keyring is unavailable, so issue-source API keys cannot be stored: ${cause}. deck will not silently write them to a plaintext file. Set ${FILE_BACKEND_FLAG}=1 to use ${SECRETS_FILE} instead (plaintext, mode 0600). On Linux this is expected on a box with no secret-service keyring daemon.`;
}

export function fileBackendNotice(file: string): string {
	return `[deck] ${FILE_BACKEND_FLAG} is set: issue-source API keys are stored in plaintext at ${file} (mode 0600), not the OS keyring.`;
}

export function migrationNotice(count: number): string {
	return `[deck] moved ${count} issue-source API key${count === 1 ? '' : 's'} from ${SECRETS_FILE} into the OS keyring and deleted the file.`;
}

export function migrationFailureMessage(what: string, cause: string): string {
	return `[deck] could not move ${what} into the OS keyring: ${cause}. ${SECRETS_FILE} was left in place, so no key was lost; fix the keyring, or set ${FILE_BACKEND_FLAG}=1 to keep using the plaintext file.`;
}
