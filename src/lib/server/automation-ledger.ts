// The durable automation ledger (~/.deck/automation.json), read and written
// whole: single-user, low volume. Cached behind the file's mtime the way
// sessions.json is (store.ts, issue #109). The boot lock (instance-lock.ts)
// makes a second writer unlikely, but if one does appear, re-reading on a moved
// mtime keeps this process from writing its stale view back over the other's
// claims. A null mtime (a stat blip) is not a staleness signal, so a failed stat
// can't evict a warm cache.
import { fileMtimeMs, readJson, writeJson } from './config';
import type { ProcessedKeys } from './automation-core';

const FILE = 'automation.json';

interface AutomationStore {
	processed: ProcessedKeys;
}

let ledger: ProcessedKeys | null = null;
let ledgerMtime: number | null = null;

export function loadProcessed(): ProcessedKeys {
	const mtime = fileMtimeMs(FILE);
	if (!ledger || (mtime !== null && mtime !== ledgerMtime)) {
		ledger = readJson<AutomationStore>(FILE, { processed: {} }).processed ?? {};
		ledgerMtime = mtime;
	}
	return ledger;
}

export function persist(processed: ProcessedKeys): void {
	writeJson(FILE, { processed });
	ledger = processed;
	ledgerMtime = fileMtimeMs(FILE);
}
