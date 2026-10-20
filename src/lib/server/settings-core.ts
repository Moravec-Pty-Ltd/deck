import type { AgentSettingsView, DeckSettings } from '$lib/types';
import { clampCompactPercent } from '$lib/context-core';

// Built field by field rather than by spreading the file, so a secret added
// to settings later stays out of the agent view until someone decides how to
// show it.
export function redactSettings(s: DeckSettings): AgentSettingsView {
	const view: AgentSettingsView = {};
	if (s.speech) view.speech = { ...s.speech };
	if (s.operator) {
		const { apiKey, ...rest } = s.operator;
		view.operator = { ...rest, hasApiKey: !!apiKey };
	}
	if (s.modelProfiles) {
		view.modelProfiles = s.modelProfiles.map(({ id, label, model, env }) => ({
			id,
			...(label !== undefined && { label }),
			...(model !== undefined && { model }),
			envKeys: Object.keys(env ?? {})
		}));
	}
	if (s.lastModels) view.lastModels = s.lastModels;
	if (s.lastEffort) view.lastEffort = s.lastEffort;
	if (s.zedSshTarget) view.zedSshTarget = s.zedSshTarget;
	if (s.autoCompact) {
		view.autoCompact = { enabled: !!s.autoCompact.enabled, percent: clampCompactPercent(s.autoCompact.percent) };
	}
	return view;
}

type FieldType = 'string' | 'url' | 'boolean' | 'number' | readonly string[];

// The blocks an agent may PATCH and the fields each holds. Everything else in
// the file (model profiles, remembered picks) is the web's to manage.
const BLOCKS = {
	speech: { ttsUrl: 'string', sttUrl: 'string', voice: 'string' },
	operator: {
		url: 'url',
		model: 'string',
		provider: ['openai', 'anthropic'],
		apiKey: 'string',
		apiKeyFile: 'string'
	},
	autoCompact: { enabled: 'boolean', percent: 'number' }
} as const satisfies Record<string, Record<string, FieldType>>;

type BlockName = keyof typeof BLOCKS;
type FieldPatch = Record<string, string | boolean | number | null>;

export interface SettingsPatch {
	blocks: Partial<Record<BlockName, FieldPatch | null>>;
	// undefined: leave it; null: clear it.
	zedSshTarget?: string | null;
}

export type ParsedPatch = { ok: true; patch: SettingsPatch } | { ok: false; message: string };

function isObject(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === 'object' && !Array.isArray(v);
}

function fieldOk(type: FieldType, v: unknown): boolean {
	if (Array.isArray(type)) return typeof v === 'string' && type.includes(v);
	if (type === 'number') return typeof v === 'number' && Number.isFinite(v);
	if (type === 'url') return typeof v === 'string' && (!v.trim() || URL.canParse(v.trim()));
	return typeof v === type;
}

function parseBlock(name: BlockName, raw: unknown): FieldPatch | string {
	if (!isObject(raw)) return `${name} must be an object or null`;
	const spec: Record<string, FieldType> = BLOCKS[name];
	const out: FieldPatch = {};
	for (const [key, value] of Object.entries(raw)) {
		if (!Object.hasOwn(spec, key)) return `unknown field ${name}.${key}`;
		if (value !== null && !fieldOk(spec[key], value)) return `invalid ${name}.${key}`;
		// A blank string clears the field like null does.
		out[key] = typeof value === 'string' ? value.trim() || null : (value as FieldPatch[string]);
	}
	return out;
}

function parseZed(v: unknown): string | null | undefined {
	if (v === null) return null;
	if (typeof v !== 'string') return undefined;
	return v.trim() || null;
}

export function parseSettingsPatch(body: Record<string, unknown>): ParsedPatch {
	const patch: SettingsPatch = { blocks: {} };
	for (const [key, value] of Object.entries(body)) {
		if (key === 'zedSshTarget') {
			const zed = parseZed(value);
			if (zed === undefined) return { ok: false, message: 'invalid zedSshTarget' };
			patch.zedSshTarget = zed;
		} else if (Object.hasOwn(BLOCKS, key)) {
			const name = key as BlockName;
			const block = value === null ? null : parseBlock(name, value);
			if (typeof block === 'string') return { ok: false, message: block };
			patch.blocks[name] = block;
		} else {
			return { ok: false, message: `unknown setting ${key}` };
		}
	}
	return { ok: true, patch };
}

// Omitted fields keep their stored value (so a PATCH without apiKey keeps the
// key), null fields are dropped, and a block left empty is removed.
function mergeBlock(current: object | undefined, patch: FieldPatch | null): object | undefined {
	if (patch === null) return undefined;
	const next: Record<string, unknown> = { ...current };
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) delete next[key];
		else next[key] = value;
	}
	return Object.keys(next).length ? next : undefined;
}

function setOrDelete(target: Record<string, unknown>, key: string, value: unknown): void {
	if (value === undefined) delete target[key];
	else target[key] = value;
}

function originOf(url: unknown): string | undefined {
	if (typeof url !== 'string') return undefined;
	try {
		return new URL(url).origin;
	} catch {
		return undefined;
	}
}

// Moving the operator to another origin must not carry the stored credential
// along, or anyone who can PATCH could point the key at a host they control.
// A credential the same patch supplies is the caller's own and stays.
function guardOperatorPatch(current: DeckSettings['operator'], patch: FieldPatch): FieldPatch {
	if (typeof patch.url !== 'string' || !current) return patch;
	const before = originOf(current.url);
	if (before !== undefined && before === originOf(patch.url)) return patch;
	const out = { ...patch };
	for (const key of ['apiKey', 'apiKeyFile'] as const) {
		if (current[key] && !Object.hasOwn(patch, key)) out[key] = null;
	}
	return out;
}

export function mergeSettings(current: DeckSettings, patch: SettingsPatch): DeckSettings {
	const next: Record<string, unknown> = { ...current };
	const blocks = { ...patch.blocks };
	if (blocks.operator) blocks.operator = guardOperatorPatch(current.operator, blocks.operator);
	for (const [name, blockPatch] of Object.entries(blocks)) {
		const key = name as BlockName;
		setOrDelete(next, key, mergeBlock(current[key], blockPatch ?? null));
	}
	const compact = next.autoCompact as DeckSettings['autoCompact'];
	if (patch.blocks.autoCompact && compact?.percent !== undefined) {
		next.autoCompact = { ...compact, percent: clampCompactPercent(compact.percent) };
	}
	if (patch.zedSshTarget !== undefined) setOrDelete(next, 'zedSshTarget', patch.zedSshTarget ?? undefined);
	return next as DeckSettings;
}
