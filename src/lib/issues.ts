import type { IssueSourceType } from './types';

// Source badge label + DaisyUI colour, shared by the picker, the source-config
// UI, and the session header so the GH/LIN/CU styling lives in one place.
export const ISSUE_BADGE: Record<IssueSourceType, { label: string; cls: string }> = {
	github: { label: 'GH', cls: 'badge-neutral' },
	linear: { label: 'LIN', cls: 'badge-primary' },
	clickup: { label: 'CU', cls: 'badge-secondary' }
};
