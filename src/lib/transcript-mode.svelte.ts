import { browser } from '$app/environment';
import { loadTranscriptMode, saveTranscriptMode, type TranscriptMode } from './transcript-mode';

// One module-level rune shared by every session page, so the tab you pick carries
// to the next session you open on this device.
let mode = $state<TranscriptMode>(browser ? loadTranscriptMode(localStorage) : 'thread');

export const transcriptMode = {
	get current(): TranscriptMode {
		return mode;
	},
	set(next: TranscriptMode) {
		mode = next;
		if (browser) saveTranscriptMode(localStorage, next);
	}
};
