import { inboxGroups, type InboxAsk } from '$lib/inbox-core';
import type { SessionView } from '$lib/session-view';

// The bridge to the Linux desktop shell (apps/linux), which injects Tauri's IPC
// into the deck page. In a normal browser there is no IPC and every call here
// does nothing.

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

const ipc =
	typeof window === 'undefined'
		? undefined
		: (window as { __TAURI_INTERNALS__?: { invoke: Invoke } }).__TAURI_INTERNALS__;

export const inShell = !!ipc;

export function editorAvailable(): Promise<boolean> {
	return ipc ? ipc.invoke<boolean>('editor_available').catch(() => false) : Promise.resolve(false);
}

export function openEditor(command: string): void {
	void ipc?.invoke('open_editor', { command }).catch(() => {});
}

// The shell's dev browser on a session's dev servers (on its host, for a remote
// session), with a tab on a loopback url when given. A shell from before the dev
// browser refuses the call, and one from before urls ignores the url.
export function openDevBrowser(session: string, url?: string): void {
	void ipc?.invoke('open_dev_browser', { session, url }).catch(() => {});
}

// Hands the shell what the nav's inbox badge counts: the tray shows the count
// and lists the rows, and a new ask raises a notification tagged with its
// session or run, so the shell replaces rather than stacks them. The first load
// notifies nothing: those asks were waiting before the shell started.
export function shellSync(invoke: Invoke): (asks: InboxAsk[], sessions: SessionView[]) => void {
	let seen: Set<string> | null = null;
	return (asks, sessions) => {
		const rows = inboxGroups(asks, sessions).flatMap((g) => g.rows);
		void invoke('set_attention', { items: rows.map(({ title, href }) => ({ title, href })) }).catch(() => {});
		for (const row of seen ? rows.filter((r) => !seen?.has(r.key)) : []) {
			const body = row.ask.questions[0]?.question ?? '';
			void invoke('notify', { tag: row.href, title: row.title, body, href: row.href }).catch(() => {});
		}
		seen = new Set(rows.map((r) => r.key));
	};
}

export const syncShell = ipc ? shellSync(ipc.invoke) : () => {};

// The shell opens a path (a notification, a tray row, a deck:// link) through
// the router rather than reloading the page.
export function onShellOpen(open: (href: string) => void): () => void {
	const listener = (e: Event) => {
		const href = (e as CustomEvent<unknown>).detail;
		if (typeof href === 'string' && href.startsWith('/') && !href.startsWith('//')) open(href);
	};
	window.addEventListener('deck:open', listener);
	return () => window.removeEventListener('deck:open', listener);
}
