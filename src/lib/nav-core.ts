// The app's persistent nav: which destinations it lists, which one is current
// and where it shows. Node-free so the matching tests without a browser; the
// icons and markup live in NavLinks.svelte.

export type NavId = 'sessions' | 'inbox' | 'runs' | 'schedules' | 'projects' | 'settings';

export interface NavItem {
	id: NavId;
	label: string;
	href: string;
	// Path prefixes that make this item current. '/' matches only itself.
	matches: string[];
}

export const NAV_ITEMS: readonly NavItem[] = [
	{ id: 'sessions', label: 'Sessions', href: '/', matches: ['/', '/s/'] },
	{ id: 'inbox', label: 'Inbox', href: '/inbox', matches: ['/inbox'] },
	{ id: 'runs', label: 'Runs', href: '/runs', matches: ['/runs'] },
	{ id: 'schedules', label: 'Schedules', href: '/schedules', matches: ['/schedules'] },
	{ id: 'projects', label: 'Projects', href: '/projects', matches: ['/projects'] },
	// Lands on /projects until the settings page exists; only /settings makes it current.
	{ id: 'settings', label: 'Settings', href: '/projects', matches: ['/settings'] }
];

function matchesPath(prefix: string, pathname: string): boolean {
	if (prefix === '/') return pathname === '/';
	if (prefix.endsWith('/')) return pathname.startsWith(prefix);
	return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isCurrent(item: NavItem, pathname: string): boolean {
	return item.matches.some((m) => matchesPath(m, pathname));
}

// Sign-in pages carry no nav: nothing behind it is reachable yet.
const BARE_PATHS: ReadonlySet<string> = new Set(['/login', '/pair']);

export function showsNav(pathname: string): boolean {
	return !BARE_PATHS.has(pathname);
}

// The session page owns the bottom of a phone screen (its composer), so it gets
// the compact header menu there instead of the bottom bar.
export function isSessionPage(pathname: string): boolean {
	return pathname.startsWith('/s/');
}

// List pages share one max content width; the session page stays edge to edge.
const CONTAINED: readonly string[] = ['/', '/inbox', '/runs', '/schedules', '/projects'];

export function isContained(pathname: string): boolean {
	return CONTAINED.includes(pathname);
}

// The inbox badge: nothing at zero, a cap past nine so it stays one glyph wide.
export function badgeText(count: number): string {
	if (count <= 0) return '';
	return count > 9 ? '9+' : String(count);
}

export function navLabel(item: NavItem, count: number): string {
	if (item.id !== 'inbox' || count <= 0) return item.label;
	return `${item.label}, ${count} waiting`;
}
