// Shared guarded-fetch for the issue/PR pickers. The list state lives in each
// component ($state), so runLoad drives it through callbacks; a response for a
// call that a newer one superseded (tracked via the caller's seq box) is dropped
// so a slow fetch for a previous project can't overwrite a newer one.
export interface LoadHandlers<T> {
	loading: (v: boolean) => void;
	error: (message: string) => void;
	ok: (data: T) => void;
}

type Settled<T> = { ok: true; data: T } | { ok: false; error: string };

async function errorMessage(res: Response): Promise<string> {
	const body = await res.json().catch(() => ({}));
	return body?.message ?? 'failed to load';
}

async function fetchList<T>(href: string): Promise<Settled<T>> {
	const res = await fetch(href);
	if (!res.ok) return { ok: false, error: await errorMessage(res) };
	return { ok: true, data: (await res.json()) as T };
}

async function settle<T>(href: string): Promise<Settled<T>> {
	try {
		return await fetchList<T>(href);
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : 'failed to load' };
	}
}

export async function runLoad<T>(
	href: string,
	seq: { n: number },
	on: LoadHandlers<T>
): Promise<void> {
	const mine = ++seq.n;
	on.loading(true);
	on.error('');
	const r = await settle<T>(href);
	if (mine !== seq.n) return;
	if (r.ok) on.ok(r.data);
	else on.error(r.error);
	on.loading(false);
}
