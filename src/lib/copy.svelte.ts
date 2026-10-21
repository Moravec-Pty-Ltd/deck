// Copy text to the clipboard and flash a confirmation for a moment. Shared by
// every copy affordance (message bubbles, fenced code blocks, the Zed command
// chip) so they agree on the timing, and on never showing the tick when the
// write actually failed.

const RESET_MS = 1000;

export function createCopier() {
	let copied = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	return {
		get copied(): boolean {
			return copied;
		},
		async copy(text: string): Promise<void> {
			if (!navigator.clipboard) return;
			try {
				await navigator.clipboard.writeText(text);
			} catch {
				return;
			}
			copied = true;
			clearTimeout(timer);
			timer = setTimeout(() => (copied = false), RESET_MS);
		},
		stop() {
			clearTimeout(timer);
		}
	};
}
