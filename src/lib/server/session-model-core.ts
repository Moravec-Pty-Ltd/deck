import { isFlagSafe } from './agents/args';

// Pure parse of a model-change request body's `model` field (issue #88), shared
// by the browser and agent model routes via session-model.ts.

export type ParsedModel = { ok: true; model: string | undefined } | { ok: false };

// Absent resets to the CLI default; anything else must be a string. Empty
// (after trim) also resets; a leading dash would be read as a flag by the
// spawned agent (same guard the spawn sites apply, see agents/args.ts).
export function parseModel(raw: unknown): ParsedModel {
	if (raw === undefined) return { ok: true, model: undefined };
	if (typeof raw !== 'string') return { ok: false };
	const model = raw.trim();
	if (!model) return { ok: true, model: undefined };
	if (!isFlagSafe(model)) return { ok: false };
	return { ok: true, model };
}
