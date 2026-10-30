import type { Project } from '$lib/types';
import { parseDevConfig } from './devservers-core';
import { parseAutomation } from './automation-core';

// Pure build of a stored project record from a register (POST) or config edit
// (PATCH) body, shared by project-record.ts. Every field carries the existing
// value when the body omits it, so a client only overwrites what it sends. A bad
// field throws, and the route turns that into a 400.

// A provided blank clears; a non-string is an error rather than a silent wipe.
function carryStr(v: unknown, existing: string | undefined, label: string): string | undefined {
	if (v === undefined) return existing;
	if (typeof v !== 'string') throw new Error(`${label} must be a string`);
	return v.trim() || undefined;
}

// The name falls back to the existing one, then to the directory's basename, so
// an edit that omits it no longer resets it.
function resolveName(v: unknown, existing: string | undefined, dir: string): string {
	if (v !== undefined && typeof v !== 'string') throw new Error('name must be a string');
	const name = typeof v === 'string' ? v.trim() : '';
	return name || existing || basename(dir);
}

function basename(dir: string): string {
	return dir.replace(/\/+$/, '').split('/').pop() || dir;
}

// Registering a directory makes everything under it readable through the
// project endpoints, so $HOME itself and anything under a dot-directory of it
// (~/.secrets, ~/.deck, ~/code/.hidden) stay off limits. Both paths canonical.
export function homeRegistrationRefusal(dir: string, home: string): string | null {
	if (dir === home) return 'cannot register the home directory itself';
	if (!dir.startsWith(home + '/')) return null;
	const hidden = dir
		.slice(home.length + 1)
		.split('/')
		.some((segment) => segment.startsWith('.'));
	return hidden ? 'cannot register a hidden (dot) directory under the home directory' : null;
}

export function buildProjectRecord(
	body: Record<string, unknown>,
	dir: string,
	existing: Partial<Project> = {}
): Project {
	return {
		name: resolveName(body.name, existing.name, dir),
		path: dir,
		group: carryStr(body.group, existing.group, 'group'),
		template: carryStr(body.template, existing.template, 'template'),
		account: carryStr(body.account, existing.account, 'account'),
		reviewPrompt: carryStr(body.reviewPrompt, existing.reviewPrompt, 'reviewPrompt'),
		lastBase: carryStr(body.lastBase, existing.lastBase, 'lastBase'),
		// Written only by other endpoints (projects/hidden, session creates,
		// projects/sources), and the record is replaced wholesale, so they always carry.
		hidden: existing.hidden,
		lastModels: existing.lastModels,
		lastEffort: existing.lastEffort,
		sources: existing.sources,
		dev: body.dev === undefined ? existing.dev : parseDevConfig(body.dev),
		automation:
			body.automation === undefined ? existing.automation : parseAutomation(body.automation, existing.automation)
	};
}
