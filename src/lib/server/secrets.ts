import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { Entry } from '@napi-rs/keyring';
import { dataDir, readJson, writeJson } from './config';
import { DEMO } from './demo';
import * as core from './secrets-core';

// Issue-source API keys (Linear/ClickUp), keyed by source id. They live in the
// OS keyring by default - macOS Keychain, Windows Credential Manager, the
// secret service on Linux - so nothing running as the user can just read them
// out of a file. deck's only native dependency (@napi-rs/keyring, prebuilt
// N-API) is confined to this module and required lazily, so secrets-core.ts and
// the unit tests never load the binding.
//
// No silent fallback: if the keyring can't be used, deck fails to start rather
// than quietly writing plaintext. DECK_SECRETS_FILE=1 opts in to the old 0600
// secrets.json (see the README; Linux without a keyring daemon needs it).

export interface SecretBackend {
	read(sourceId: string): string | undefined;
	write(sourceId: string, apiKey: string): void;
	remove(sourceId: string): void;
}

const secretsPath = path.join(dataDir, core.SECRETS_FILE);

function readSecretsFile(): core.SecretsFile {
	return readJson<core.SecretsFile>(core.SECRETS_FILE, {});
}

function writeSecretsFile(secrets: core.SecretsFile) {
	// 0o600 - API keys must not be world/group readable (cf. the auth token).
	writeJson(core.SECRETS_FILE, secrets, 0o600);
}

const fileBackend: SecretBackend = {
	read: (sourceId) => core.readSecretFrom(readSecretsFile(), sourceId),
	write: (sourceId, apiKey) => writeSecretsFile(core.withSecret(readSecretsFile(), sourceId, apiKey)),
	remove: (sourceId) => {
		const next = core.withoutSecret(readSecretsFile(), sourceId);
		if (next) writeSecretsFile(next);
	}
};

type KeyringModule = { Entry: new (service: string, account: string) => Entry };

let keyring: KeyringModule | null = null;

function keyringEntry(account: string): Entry {
	keyring ??= createRequire(import.meta.url)('@napi-rs/keyring') as KeyringModule;
	return new keyring.Entry(core.KEYRING_SERVICE, account);
}

function sourceEntry(sourceId: string): Entry {
	return keyringEntry(core.keyringAccount(sourceId));
}

const keyringBackend: SecretBackend = {
	read: (sourceId) => sourceEntry(sourceId).getPassword() ?? undefined,
	write: (sourceId, apiKey) => sourceEntry(sourceId).setPassword(apiKey),
	// false means there was nothing stored, which is the same outcome we want.
	remove: (sourceId) => void sourceEntry(sourceId).deleteCredential()
};

function reason(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// A round-trip, not just a constructor call: on some platforms building an entry
// touches nothing, so a lighter check would let a broken store through and only
// fail once someone opened the issues panel.
function verifyKeyring() {
	try {
		// Not a `source:` account, so the probe's write and delete can never land on
		// a real source's entry.
		const probe = keyringEntry('startup-probe');
		probe.setPassword('probe');
		const got = probe.getPassword();
		probe.deleteCredential();
		if (got !== 'probe') throw new Error('a probe entry did not read back');
	} catch (err) {
		throw new Error(core.keyringUnavailableMessage(reason(err)));
	}
}

// One-way import of an existing plaintext secrets.json into `target`. Every key
// is written and read back before the file goes, so a failure anywhere leaves
// the file exactly as it was rather than stranding deck half-migrated. Entries
// are keyed by source id, so re-running after a partial import just overwrites.
// Takes the backend rather than reaching for the keyring directly, so this
// unit-tests against a fake without the native binding.
export function migrateFileSecrets(target: SecretBackend) {
	if (!fs.existsSync(secretsPath)) return;
	let entries: { sourceId: string; apiKey: string }[];
	try {
		// Parsed here rather than through readJson, which falls back to {} on a bad
		// file - that would read as "nothing to migrate" and delete the only copy.
		entries = core.secretEntries(JSON.parse(fs.readFileSync(secretsPath, 'utf8')));
	} catch (err) {
		throw new Error(core.migrationFailureMessage(core.SECRETS_FILE, reason(err)));
	}
	for (const { sourceId, apiKey } of entries) {
		try {
			target.write(sourceId, apiKey);
			if (target.read(sourceId) !== apiKey) throw new Error('the stored key did not read back');
		} catch (err) {
			throw new Error(core.migrationFailureMessage(`the key for source ${sourceId}`, reason(err)));
		}
	}
	fs.rmSync(secretsPath);
	console.log(core.migrationNotice(entries.length));
}

let backend: SecretBackend | null = null;

function resolveBackend(): SecretBackend {
	if (backend) return backend;
	if (core.resolveBackendKind(process.env) === 'file') {
		console.log(core.fileBackendNotice(secretsPath));
		return (backend = fileBackend);
	}
	verifyKeyring();
	migrateFileSecrets(keyringBackend);
	return (backend = keyringBackend);
}

// Called at boot (hooks.server.ts) so an unusable keyring stops deck starting
// and any existing secrets.json migrates before the first read, rather than
// both surfacing whenever someone first opens the issues panel. Skipped in demo
// mode, whose canned dataset has no issue sources and must boot anywhere.
export function initSecrets() {
	if (!DEMO) resolveBackend();
}

export function readSecret(sourceId: string): string | undefined {
	return resolveBackend().read(sourceId);
}

export function setSecret(sourceId: string, apiKey: string) {
	resolveBackend().write(sourceId, apiKey);
}

export function deleteSecret(sourceId: string) {
	resolveBackend().remove(sourceId);
}
