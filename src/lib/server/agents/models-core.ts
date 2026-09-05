import type { ModelChoice } from '$lib/types';

// Pure parsers for the `pi --list-models` / `opencode models` output, split from
// the shell-out (models.ts) so they're unit-testable without spawning a CLI.
// Both fail soft: an unrecognised line is skipped, never thrown on, so a format
// drift degrades to a shorter list rather than a 500.

// `pi --list-models` prints a whitespace-column table whose header row starts
// with "provider"; the first two columns are provider and model id (model ids
// carry no spaces). Everything after is context/limits, ignored.
export function parsePiModels(stdout: string): ModelChoice[] {
	const out: ModelChoice[] = [];
	for (const line of stdout.split('\n')) {
		const cols = line.trim().split(/\s+/);
		const [provider, model] = cols;
		if (cols.length < 2 || !provider || !model || provider === 'provider') continue;
		out.push({ provider, model });
	}
	return out;
}

// codex has no non-interactive list command (`codex models` needs a TTY), but
// the CLI maintains ~/.codex/models_cache.json: { models: [{ slug, visibility,
// ... }] }, refreshed on every run. Offer the slugs codex itself would list
// (visibility "list"); "hide" entries are internal (auto-review etc).
export function parseCodexModels(raw: string): ModelChoice[] {
	try {
		const models = (JSON.parse(raw) as { models?: { slug?: string; visibility?: string }[] }).models;
		if (!Array.isArray(models)) return [];
		return models
			.filter((m) => m.visibility === 'list' && typeof m.slug === 'string' && m.slug)
			.map((m) => ({ model: m.slug! }));
	} catch {
		return [];
	}
}

// `opencode models` prints one `provider/model` id per line (no header). The id
// is passed whole to `--model`, so keep it combined; drop any decorative line
// (banner/blank) by requiring a single whitespace-free token.
export function parseOpencodeModels(stdout: string): ModelChoice[] {
	const out: ModelChoice[] = [];
	for (const line of stdout.split('\n')) {
		const model = line.trim();
		if (!model || /\s/.test(model) || !model.includes('/')) continue;
		out.push({ model });
	}
	return out;
}
