// Generic single-flight TTL cache keyed by string. Each slot caches the fetch
// *promise* (not just its resolved value), so concurrent misses share the one
// in-flight fetch instead of each fanning out. `at` is the fetch-START time, so
// the TTL is measured from when work began and a slow fetch can't extend its own
// lifetime. A rejected fetch is dropped so the next caller retries rather than
// being pinned to a failed promise. Backs both the issue and PR aggregators (see
// issues/cache.ts, prs/index.ts).
export interface TtlCache<T> {
	getOrFetch(key: string, refresh: boolean, compute: () => Promise<T>): Promise<T>;
	invalidate(key: string): void;
}

interface Slot<T> {
	at: number;
	promise: Promise<T>;
	settled: boolean;
}

export function createTtlCache<T>(ttlMs: number): TtlCache<T> {
	const cache = new Map<string, Slot<T>>();

	// An in-flight fetch is always joined (single-flight, even under refresh — it's
	// already the freshest data possible). A settled one is reused only while fresh
	// and not force-refreshed.
	function reusable(slot: Slot<T>, refresh: boolean): boolean {
		if (!slot.settled) return true;
		return !refresh && Date.now() - slot.at < ttlMs;
	}

	function startFetch(key: string, compute: () => Promise<T>): Promise<T> {
		const slot: Slot<T> = { at: Date.now(), promise: compute(), settled: false };
		cache.set(key, slot);
		slot.promise.then(
			() => {
				// Only flips the slot's own flag, never writes the result back to the map,
				// so a slot evicted mid-flight stays evicted and the next call refetches.
				slot.settled = true;
			},
			() => {
				slot.settled = true;
				// Don't pin a failed fetch for the window; let the next call retry.
				if (cache.get(key) === slot) cache.delete(key);
			}
		);
		return slot.promise;
	}

	return {
		getOrFetch(key, refresh, compute) {
			const hit = cache.get(key);
			if (hit && reusable(hit, refresh)) return hit.promise;
			return startFetch(key, compute);
		},
		invalidate(key) {
			cache.delete(key);
		}
	};
}
