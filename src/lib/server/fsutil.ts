import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Expand a leading ~ / ~/ to the user's home directory. Everything else is
// returned untouched so absolute and relative paths pass straight through.
export function expandTilde(p: string): string {
	if (p === '~') return os.homedir();
	if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
	return p;
}

// Collapse the home directory back to ~ for compact display in path inputs.
export function collapseHome(p: string): string {
	const home = os.homedir();
	if (p === home) return '~';
	if (p.startsWith(home + path.sep)) return '~' + p.slice(home.length);
	return p;
}

// Directory completions for a partial path. Resolves ~, splits into a parent
// directory + prefix, and returns matching child directories (collapsed to ~).
export function completeDirs(query: string, limit = 40): string[] {
	const q = query.trim();
	const expanded = expandTilde(q || '~');

	let dir: string;
	let prefix: string;
	if (q === '') {
		dir = os.homedir();
		prefix = '';
	} else if (expanded.endsWith('/')) {
		dir = expanded;
		prefix = '';
	} else {
		dir = path.dirname(expanded);
		prefix = path.basename(expanded);
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const lower = prefix.toLowerCase();
	const showHidden = prefix.startsWith('.');
	return entries
		.filter((e) => e.isDirectory() || e.isSymbolicLink())
		.filter((e) => showHidden || !e.name.startsWith('.'))
		.filter((e) => e.name.toLowerCase().startsWith(lower))
		.map((e) => e.name)
		.sort((a, b) => a.localeCompare(b))
		.slice(0, limit)
		.map((name) => collapseHome(path.join(dir, name)));
}
