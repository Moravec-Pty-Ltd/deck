// Running subagents per claude session (issue #374). claude.ts recounts as task
// events land, so a digest reads it without folding the transcript. On
// globalThis so a dev reload keeps it alongside the processes it describes.
const counts = ((globalThis as { __deckSubagents?: Map<string, number> }).__deckSubagents ??= new Map<string, number>());

export function subagentCount(id: string): number {
	return counts.get(id) ?? 0;
}

// True when the count changed.
export function setSubagentCount(id: string, n: number): boolean {
	if (subagentCount(id) === n) return false;
	if (n) counts.set(id, n);
	else counts.delete(id);
	return true;
}
