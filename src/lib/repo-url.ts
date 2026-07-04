// Pure helpers for clone urls, shared by the client add-project modal and the
// server clone route (so a node-free module, not under server/). The route
// re-derives everything server-side; the client uses these only for a live
// preview and the auto-filled project name.

// The directory name a `git clone` of `url` would produce: the last `/`- or
// `:`-delimited segment, with a trailing slash and a `.git` suffix stripped
// (mirrors parseOriginRepo's tail match). null when nothing can be derived (an
// empty url).
export function repoNameFromUrl(url: string): string | null {
	const m = url
		.trim()
		.replace(/\/+$/, '')
		.replace(/\.git$/i, '')
		.match(/[^/:]+$/);
	return m ? m[0] : null;
}

// Is `url` a clone url deck is willing to hand to `git clone`? Allows the network
// transports (https / ssh / git schemes) and scp-style `host:owner/repo`, and
// rejects everything else: option-like values (leading `-`), the `ext::`
// transport trick, `file://`, and bare/local paths.
export function isCloneUrlSafe(url: string): boolean {
	const u = url.trim();
	if (!u || u.startsWith('-')) return false;
	// scheme://host/… — https/ssh/git only, non-empty host (so every file:// is out).
	if (/^(?:https|ssh|git):\/\/[^/]/i.test(u)) return true;
	// scp-style host:path — host has no slash/colon, and the char after the single
	// colon is a path char (not `:`, which rules out `ext::…`, nor `/`, a drive path).
	if (!u.includes('://') && /^[^/:]+:[^/:]/.test(u)) return true;
	return false;
}
