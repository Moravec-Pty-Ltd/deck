export interface ConfirmOptions {
	title: string;
	body?: string;
	confirmLabel?: string;
	cancelLabel?: string;
	danger?: boolean;
}

// One confirm at a time. A new request settles the open one as cancelled, so a
// caller awaiting it never hangs, and a stale answer can't land on the new one.
export class ConfirmQueue {
	current: ConfirmOptions | null = null;
	#resolve: ((ok: boolean) => void) | null = null;

	constructor(private onChange: (current: ConfirmOptions | null) => void = () => {}) {}

	ask(options: ConfirmOptions): Promise<boolean> {
		this.settle(false);
		return new Promise((resolve) => {
			this.#resolve = resolve;
			this.current = options;
			this.onChange(options);
		});
	}

	settle(ok: boolean): void {
		const resolve = this.#resolve;
		if (!resolve) return;
		this.#resolve = null;
		this.current = null;
		this.onChange(null);
		resolve(ok);
	}
}
