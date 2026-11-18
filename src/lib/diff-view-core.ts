// Pure rules for the Changes tab's lazy diff rendering (DiffView.svelte).

// A file with more changed lines than this waits for a "Show diff" click.
export const COLLAPSE_LINES = 2000;

// Lockfiles, minified bundles, source maps and generated code: rarely worth
// reading, often huge.
const NOISY =
	/(^|\/)(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|go\.sum|[^/]+\.lock)$|\.min\.[a-z0-9]+$|\.map$|(^|[/._-])generated([/._-]|$)/i;

export function startsCollapsed(path: string, changedLines: number): boolean {
	return changedLines > COLLAPSE_LINES || NOISY.test(path);
}

// Placeholder height for a file that hasn't been drawn yet, so the scrollbar and
// summary jumps land close to where the drawn file will be.
const HEADER_PX = 40;
const LINE_PX = 20;
export function estimateHeight(lines: number): number {
	return HEADER_PX + lines * LINE_PX;
}
