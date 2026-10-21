import { Sun, Moon, BookOpen } from '@lucide/svelte';
import { THEME_COLOR, nextTheme, parseTheme, type ThemeId } from './theme-core';

// The current theme, shared by the header control, the palette and the
// settings page. app.html applies the stored theme before first paint; sync()
// picks it up from there once the app is running.
export const THEME_ICONS: Record<ThemeId, typeof Sun> = { dark: Moon, light: Sun, eink: BookOpen };

class ThemeUi {
	current = $state<ThemeId>('dark');

	sync() {
		this.current = parseTheme(document.documentElement.dataset.theme);
	}

	set(next: ThemeId) {
		this.current = next;
		document.documentElement.dataset.theme = next;
		localStorage.setItem('deck-theme', next);
		document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[next]);
	}

	cycle() {
		this.set(nextTheme(this.current).id);
	}
}

export const themeUi = new ThemeUi();
