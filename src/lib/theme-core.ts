// The app's three themes: their order (the header control cycles through it),
// labels, and the browser UI bar colour for each. Node-free so it tests without
// a DOM; applying a theme lives in theme.svelte.ts.

export type ThemeId = 'dark' | 'light' | 'eink';

export interface ThemeOption {
	id: ThemeId;
	label: string;
	description: string;
}

export const THEMES: readonly ThemeOption[] = [
	{ id: 'dark', label: 'Dark', description: 'Dark surfaces, the default' },
	{ id: 'light', label: 'Light', description: 'Light surfaces for bright rooms' },
	{ id: 'eink', label: 'E-ink', description: 'Black on white, no colour or motion' }
];

// Matches each theme's header (base-100), so the browser bar runs into it.
export const THEME_COLOR: Record<ThemeId, string> = {
	light: '#fbfcfd',
	dark: '#1a1f24',
	eink: '#ffffff'
};

export function parseTheme(value: string | null | undefined): ThemeId {
	return THEMES.some((t) => t.id === value) ? (value as ThemeId) : 'dark';
}

export function themeOption(id: ThemeId): ThemeOption {
	return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

export function nextTheme(id: ThemeId): ThemeOption {
	const i = THEMES.findIndex((t) => t.id === id);
	return THEMES[(i + 1) % THEMES.length];
}
