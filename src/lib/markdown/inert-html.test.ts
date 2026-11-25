import { describe, expect, it } from 'vitest';
import type { SanitizeContext } from '@humanspeak/svelte-markdown';
import { INERT_TAGS, inertAttributes } from './inert-html';

const keep = (tag: string, attributes: Record<string, string>) =>
	inertAttributes(attributes, { type: 'html', tag } as SanitizeContext, (url) => (url.startsWith('https:') ? url : ''));

describe('inertAttributes', () => {
	it('drops styling, handlers, names and anything else a tag has no use for', () => {
		expect(keep('div', { style: 'position:fixed', class: 'modal', id: 'x', name: 'x', onclick: 'x()', title: 't', align: 'center' })).toEqual({ title: 't', align: 'center' });
		expect(keep('div', { href: 'https://example.com', src: 'https://example.com' })).toEqual({});
		expect(keep('constructor', { x: 'y', title: 't' })).toEqual({ title: 't' });
		expect(keep('details', { open: '' })).toEqual({ open: '' });
		expect(keep('td', { colspan: '2', STYLE: 'x' })).toEqual({ colspan: '2' });
	});

	it('opens a link in a new tab, through the URL sanitizer', () => {
		const tab = { target: '_blank', rel: 'noopener noreferrer' };
		expect(keep('a', { href: 'https://example.com', target: '_top' })).toEqual({ href: 'https://example.com', ...tab });
		expect(keep('a', { HREF: 'javascript:x' })).toEqual(tab);
		expect(keep('img', { src: 'data:x', alt: 'a' })).toEqual({ alt: 'a' });
	});
});

it('lists no tag that submits, embeds, plays or scripts', () => {
	for (const tag of ['form', 'input', 'button', 'select', 'textarea', 'iframe', 'embed', 'object', 'video', 'audio', 'script', 'style', 'dialog', 'canvas']) {
		expect(INERT_TAGS).not.toContain(tag);
	}
});
