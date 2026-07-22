// In-flight guard + error state for a header setting-chip menu's async switch.
// Serializes overlapping calls so a rapid re-pick can't land out of order, and
// exposes `busy` to disable the options while a switch is pending. Extracted so a
// chip keeps this guard without inlining the same scaffolding the sibling menus
// already carry.
export function menuAction() {
	let busy = $state(false);
	let err = $state('');
	async function run(action: () => Promise<void>, onSuccess: () => void, fallback: string) {
		if (busy) return;
		busy = true;
		err = '';
		try {
			await action();
			onSuccess();
		} catch (e) {
			err = e instanceof Error ? e.message : fallback;
		} finally {
			busy = false;
		}
	}
	return {
		get busy() {
			return busy;
		},
		get err() {
			return err;
		},
		clearErr() {
			err = '';
		},
		run
	};
}
