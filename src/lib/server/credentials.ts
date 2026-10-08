// The HTTP boundary for saved issue-source keys (issue #237): turning the
// `apiKey` or `credentialId` a request carries into the key to query a provider
// with, or into the credential a new source will be stored against.
//
// Shared by /api/issues/meta and /api/projects/sources so the two cannot
// disagree about what a credentialId means. The pure grouping lives in
// credentials-core.ts; this is the part that reaches the store.
import { error } from '@sveltejs/kit';
import crypto from 'node:crypto';
import { listProjects, readSecret } from './store';
import { listCredentials } from './credentials-core';

type Body = Record<string, unknown>;

const str = (v: unknown) => String(v ?? '').trim();

// A credentialId is checked against the saved set rather than trusted. A stale
// one from an old tab then fails here, instead of saving a source whose every
// lookup 401s with nothing to say why, or reading an arbitrary entry out of the
// secret store.
function assertSaved(credentialId: string): void {
	if (!listCredentials(listProjects()).some((c) => c.id === credentialId)) {
		error(400, 'that saved key no longer exists');
	}
}

// The key to query a provider with: one being entered now, or a saved one named
// by id. Reusing a saved key means the add-source cascade runs without that key
// ever reaching the browser, which is strictly better than the paste path.
export function resolveApiKey(body: Body): string {
	const apiKey = str(body.apiKey);
	if (apiKey) return apiKey;
	const credentialId = str(body.credentialId);
	if (!credentialId) error(400, 'apiKey or credentialId required');
	assertSaved(credentialId);
	const stored = readSecret(credentialId);
	// Saved according to the projects, but missing from the keyring: the entry
	// was removed behind deck's back. Worth saying plainly, because re-entering
	// the key is the fix.
	if (!stored) error(400, 'that saved key could not be read from the keyring');
	return stored;
}

// Which credential a new keyed source will authenticate with: a saved one, or a
// fresh id for a key supplied here. `apiKey` is set only in the second case,
// because reusing a credential has nothing to store.
export function credentialForSource(body: Body): { credentialId: string; apiKey?: string } {
	const credentialId = str(body.credentialId);
	const apiKey = str(body.apiKey);
	if (credentialId) {
		assertSaved(credentialId);
		return { credentialId };
	}
	if (!apiKey) error(400, 'apiKey or credentialId is required');
	return { credentialId: crypto.randomUUID(), apiKey };
}
