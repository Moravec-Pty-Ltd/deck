import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { GET } from './+server';

// The contract test: every agent API route on disk must be named in llms.txt,
// so a route can't ship undocumented. Directory params ([id]) read as the doc
// writes them ({id}).
const AGENT_ROOT = path.resolve('src/routes/api/agent');

function routeFiles(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return routeFiles(full);
		return entry.name === '+server.ts' ? [full] : [];
	});
}

function routePath(file: string): string {
	const rel = path.relative(AGENT_ROOT, path.dirname(file)).split(path.sep).filter(Boolean);
	return ['/api/agent', ...rel.map((part) => part.replace(/^\[(.+)\]$/, '{$1}'))].join('/');
}

function escape(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

it('documents every agent route in llms.txt', async () => {
	const doc = await (await GET({} as Parameters<typeof GET>[0])).text();
	const routes = routeFiles(AGENT_ROOT).map(routePath);
	expect(routes.length).toBeGreaterThan(30);
	// A path counts only as a whole path: /sessions/{id} must not be satisfied by
	// /sessions/{id}/stop.
	const missing = routes.filter((r) => !new RegExp(`${escape(r)}(?![\\w/{}-])`).test(doc));
	expect(missing).toEqual([]);
});
