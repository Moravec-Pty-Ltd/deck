// The session Files tab: which entries a folder listing shows and in what
// order, and how a picked file is viewed. Node-free so the client and the
// server share one reading; the server alone decides what may be listed or
// served (see server/file-browser.ts and server/files.ts).

import { extensionOf } from './files-core';

export interface DirEntry {
	name: string;
	dir: boolean;
	size: number;
	mtimeMs: number;
}

export interface DirListing {
	// Path of the listed folder relative to the session's folder ('' for the root).
	path: string;
	// Absolute, canonical session folder, so the client can build a file's path.
	root: string;
	entries: DirEntry[];
	// More entries than MAX_DIR_ENTRIES; the rest were left out.
	truncated: boolean;
}

export const MAX_DIR_ENTRIES = 2000;

// A text file larger than this is offered as a download rather than read into
// the page.
export const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;

// Generated or vendored folders a listing tucks away with the dotfiles.
const NOISE_DIRS = new Set([
	'node_modules',
	'__pycache__',
	'.venv',
	'venv',
	'dist',
	'build',
	'target',
	'coverage'
]);

// Dotfiles and generated folders: listed only when "show hidden" is on.
export function isTucked(entry: Pick<DirEntry, 'name' | 'dir'>): boolean {
	return entry.name.startsWith('.') || (entry.dir && NOISE_DIRS.has(entry.name));
}

// Folders first, then names in natural order (a2 before a10), case-insensitive.
export function sortEntries(entries: DirEntry[]): DirEntry[] {
	const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
	return [...entries].sort((a, b) => (a.dir === b.dir ? collator.compare(a.name, b.name) : a.dir ? -1 : 1));
}

const SECRET_TEMPLATE = /\.(example|sample|template|dist)$/i;

// Files whose contents are likely credentials. The viewer keeps them covered
// until asked, so a key isn't put on screen by tapping the wrong row. Templates
// like `.env.example` are left alone.
export function isSecretName(name: string): boolean {
	const n = name.toLowerCase();
	if (SECRET_TEMPLATE.test(n)) return false;
	if (n === '.env' || n.startsWith('.env.') || n.endsWith('.env')) return true;
	if (/\.(pem|key|p12|pfx|keystore|jks)$/.test(n)) return true;
	if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(n)) return true;
	return /^(credentials|secrets?)(\..+)?$/.test(n) || n === '.netrc' || n === '.npmrc' || n === '.pypirc';
}

export type Viewer = 'markdown' | 'image' | 'pdf' | 'video' | 'audio' | 'text' | 'binary';

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico']);
const VIDEO = new Set(['mp4', 'webm', 'mov', 'm4v']);
const AUDIO = new Set(['mp3', 'wav', 'm4a', 'ogg', 'oga', 'flac', 'aac', 'opus']);
const BINARY = new Set([
	'zip', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', 'tar', 'jar', 'war',
	'exe', 'dll', 'so', 'dylib', 'o', 'a', 'class', 'pyc', 'wasm', 'bin', 'dat',
	'sqlite', 'sqlite3', 'db', 'woff', 'woff2', 'ttf', 'otf', 'eot',
	'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'key', 'numbers', 'pages',
	'psd', 'ai', 'sketch', 'fig', 'heic', 'heif', 'tif', 'tiff', 'raw', 'cr2', 'nef',
	'avi', 'mkv', 'flv', 'wmv', 'iso', 'dmg', 'apk', 'ipa', 'deb', 'rpm', 'lock.bin'
]);

// How a file opens. Anything not known to be binary is tried as text; the
// client falls back to a download if the bytes turn out not to be text.
export function viewerFor(name: string): Viewer {
	const ext = extensionOf(name);
	if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'markdown';
	if (IMAGE.has(ext)) return 'image';
	if (ext === 'pdf') return 'pdf';
	if (VIDEO.has(ext)) return 'video';
	if (AUDIO.has(ext)) return 'audio';
	if (BINARY.has(ext)) return 'binary';
	return 'text';
}

// Highlighter language per extension or well-known file name; '' leaves the
// text plain. Only languages the bundled highlighter loads are named here (see
// markdown/build-highlighter.ts).
const LANG_BY_EXT: Record<string, string> = {
	sh: 'bash', bash: 'bash', zsh: 'bash', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp',
	cs: 'csharp', css: 'css', diff: 'diff', patch: 'diff', go: 'go', graphql: 'graphql', gql: 'graphql',
	html: 'html', htm: 'html', ini: 'ini', cfg: 'ini', conf: 'ini', java: 'java',
	js: 'javascript', mjs: 'javascript', cjs: 'javascript', json: 'json', jsonc: 'json', jsonl: 'json',
	jsx: 'jsx', kt: 'kotlin', kts: 'kotlin', md: 'markdown', markdown: 'markdown', php: 'php',
	py: 'python', rb: 'ruby', rs: 'rust', scss: 'scss', sql: 'sql', svelte: 'svelte', swift: 'swift',
	toml: 'toml', tsx: 'tsx', ts: 'typescript', mts: 'typescript', cts: 'typescript', vue: 'vue',
	xml: 'xml', svg: 'xml', yml: 'yaml', yaml: 'yaml'
};
const LANG_BY_NAME: Record<string, string> = {
	dockerfile: 'docker', containerfile: 'docker', makefile: 'bash', '.bashrc': 'bash', '.profile': 'bash',
	'.zshrc': 'bash', '.gitconfig': 'ini', '.editorconfig': 'ini'
};

export function langFor(name: string): string {
	const lower = name.toLowerCase();
	if (LANG_BY_NAME[lower]) return LANG_BY_NAME[lower];
	if (lower.startsWith('dockerfile.')) return 'docker';
	if (lower === '.env' || lower.startsWith('.env.')) return 'ini';
	return LANG_BY_EXT[extensionOf(name)] ?? '';
}

// A decoded file that is probably not text: NUL bytes, or many replacement
// characters from invalid UTF-8.
export function looksBinary(text: string): boolean {
	const sample = text.slice(0, 8192);
	if (sample.includes('\0')) return true;
	let bad = 0;
	for (const ch of sample) if (ch === '�') bad++;
	return sample.length > 0 && bad / sample.length > 0.05;
}

// Normalise a request-supplied relative path: forward slashes, no empty, '.'
// or '..' segments. Returns null for anything that tries to climb out.
export function cleanRelPath(rel: string): string | null {
	const parts: string[] = [];
	for (const seg of rel.split('/')) {
		if (seg === '' || seg === '.') continue;
		if (seg === '..' || seg.includes('\0') || seg.includes('\\')) return null;
		parts.push(seg);
	}
	return parts.join('/');
}

export function joinRel(dir: string, name: string): string {
	return dir ? `${dir}/${name}` : name;
}

export function parentRel(rel: string): string {
	const i = rel.lastIndexOf('/');
	return i < 0 ? '' : rel.slice(0, i);
}

export interface Crumb {
	label: string;
	path: string;
}

// The session folder's own name, then each folder down to `rel`.
export function crumbs(root: string, rel: string): Crumb[] {
	const rootName = root.slice(root.lastIndexOf('/') + 1) || '/';
	const out: Crumb[] = [{ label: rootName, path: '' }];
	let acc = '';
	for (const seg of rel ? rel.split('/') : []) {
		acc = joinRel(acc, seg);
		out.push({ label: seg, path: acc });
	}
	return out;
}
