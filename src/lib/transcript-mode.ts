// Which of the two transcript tabs you last read in (issue #216): the full
// Thread, or the condensed Chat. Device-local, not per session, so opening any
// session lands on the same one. No DOM here; the rune in
// transcript-mode.svelte.ts owns the storage handle.

export type TranscriptMode = 'thread' | 'chat';

export const TRANSCRIPT_MODE_KEY = 'deck:transcriptMode';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

// Anything unrecognised (absent, corrupt, a storage that throws in private mode)
// falls back to the full Thread.
export function loadTranscriptMode(store: Store | null): TranscriptMode {
	try {
		return store?.getItem(TRANSCRIPT_MODE_KEY) === 'chat' ? 'chat' : 'thread';
	} catch {
		return 'thread';
	}
}

// Best-effort: a write can throw in private mode or when the quota is exceeded,
// and that mustn't undo the click.
export function saveTranscriptMode(store: Store | null, mode: TranscriptMode): void {
	try {
		store?.setItem(TRANSCRIPT_MODE_KEY, mode);
	} catch {
		// Keep the in-memory choice; persistence is non-critical.
	}
}
