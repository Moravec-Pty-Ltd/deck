import type { IssueSourceType } from './types';

// Source badge label + DaisyUI colour, shared by the picker, the source-config
// UI, and the session header so the GH/LIN/CU styling lives in one place.
export const ISSUE_BADGE: Record<IssueSourceType, { label: string; cls: string }> = {
	github: { label: 'GH', cls: 'badge-neutral' },
	linear: { label: 'LIN', cls: 'badge-primary' },
	clickup: { label: 'CU', cls: 'badge-secondary' }
};

// Compact chip text for the session header. A GitHub issue id is the full
// `owner/repo#n`, which crowds the row and squeezes the title, so show just
// `#n` and lean on the chip's title tooltip for the full ref. Linear/ClickUp
// ids (`ABC-123`) are already short and pass through unchanged.
export function issueChipText(source: IssueSourceType, id: string): string {
	if (source !== 'github') return id;
	const hash = id.lastIndexOf('#');
	return hash === -1 ? id : id.slice(hash);
}
