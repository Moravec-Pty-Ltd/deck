import type { SanitizeAttributesFn } from '@humanspeak/svelte-markdown';

// What raw HTML inside Markdown may be. The text comes from agents and project
// files, so only tags that format it render; no other becomes an element.
export const INERT_TAGS: string[] = [
	'a', 'abbr', 'b', 'blockquote', 'br', 'cite', 'code', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em',
	'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 's', 'samp', 'small', 'span',
	'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'var'
];

const ANY_TAG = new Set(['title', 'align', 'dir', 'lang']);
// A Map: a tag may be called anything, `constructor` included.
const PER_TAG = new Map([
	['a', ['href']],
	['img', ['src', 'alt', 'width', 'height']],
	['details', ['open']],
	['ol', ['start']],
	['td', ['colspan', 'rowspan']],
	['th', ['colspan', 'rowspan']]
]);

// Keeps only attributes that carry content. `style`, `class` and `id` go: they
// could lay the text over the app or borrow its styling. A link opens like any
// other Markdown link (see MdLink).
export const inertAttributes: SanitizeAttributesFn = (attributes, context, sanitizeUrl) => {
	const tag = context.tag?.toLowerCase() ?? '';
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(attributes)) {
		const name = key.toLowerCase();
		if (!ANY_TAG.has(name) && !PER_TAG.get(tag)?.includes(name)) continue;
		const kept = name === 'href' || name === 'src' ? sanitizeUrl(value, context) : value;
		if (kept || !value) out[name] = kept;
	}
	return tag === 'a' ? { ...out, target: '_blank', rel: 'noopener noreferrer' } : out;
};
