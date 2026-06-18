export function relativeTime(ts: number): string {
	const diff = Date.now() - ts;
	const minutes = Math.floor(diff / 60000);
	if (minutes < 1) return 'now';
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 14) return `${days}d`;
	return new Date(ts).toLocaleDateString();
}

// Collapse a home prefix to ~ for display. Runs in the browser, so it can't
// read the real homedir; instead it matches the common roots: macOS
// (/Users/<name>), Linux (/home/<name>), root (/root), and Windows
// (C:\Users\<name>). The two branches are mutually exclusive by separator.
export function shortPath(p: string): string {
	return p
		.replace(/^(\/Users\/[^/]+|\/home\/[^/]+|\/root)(?=\/|$)/, '~')
		.replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, '~');
}

import type { Project } from '$lib/types';

// Map a session cwd to a group: worktrees fold back under their repo, then we
// match the longest registered project path; otherwise the repo/cwd itself.
export function deriveGroup(
	cwd: string,
	projects: Project[]
): { key: string; label: string } {
	const wt = cwd.indexOf('-worktrees/');
	const base = wt >= 0 ? cwd.slice(0, wt) : cwd;

	let best: Project | undefined;
	for (const p of projects) {
		const matches = base === p.path || base.startsWith(p.path + '/') || cwd.startsWith(p.path + '/');
		if (matches && (!best || p.path.length > best.path.length)) best = p;
	}
	if (best) return { key: best.path, label: best.name };
	return { key: base, label: shortPath(base) };
}
