import { describe, expect, it } from 'vitest';
import { COLLAPSE_LINES, estimateHeight, startsCollapsed } from './diff-view-core';

describe('startsCollapsed', () => {
	it('collapses files over the line threshold', () => {
		expect(startsCollapsed('src/app.ts', COLLAPSE_LINES)).toBe(false);
		expect(startsCollapsed('src/app.ts', COLLAPSE_LINES + 1)).toBe(true);
	});

	it.each([
		'pnpm-lock.yaml',
		'apps/web/package-lock.json',
		'yarn.lock',
		'Cargo.lock',
		'go.sum',
		'static/vendor.min.js',
		'dist/app.min.css',
		'build/app.js.map',
		'src/api.generated.ts',
		'src/generated/schema.ts'
	])('collapses %s', (path) => {
		expect(startsCollapsed(path, 3)).toBe(true);
	});

	it.each(['src/lib/lockscreen.ts', 'src/minify.ts', 'src/regenerated-at.ts', 'README.md'])(
		'draws %s normally',
		(path) => {
			expect(startsCollapsed(path, 3)).toBe(false);
		}
	);
});

describe('estimateHeight', () => {
	it('grows with line count', () => {
		expect(estimateHeight(10)).toBeGreaterThan(estimateHeight(1));
	});
});
