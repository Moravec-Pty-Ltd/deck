// Pure helpers for clone urls, shared by the client add-project modal and the
// server clone route (so a node-free module, not under server/). The route
// re-derives everything server-side; the client uses these only for a live
// preview and the auto-filled project name.

// The directory name a `git clone` of `url` would produce: the last `/`- or
// `:`-delimited segment, with a trailing slash and a `.git` suffix stripped
// (mirrors parseOriginRepo's tail match). null when no usable name can be derived:
// an empty url, or a `.`/`..` tail that isn't a real folder name (so the client
// preview and the server agree it's uncloneable).
export function repoNameFromUrl(url: string): string | null {
	const m = url
		.trim()
		.replace(/\/+$/, '')
		.replace(/\.git$/i, '')
		.match(/[^/:]+$/);
	if (!m || m[0] === '.' || m[0] === '..') return null;
	return m[0];
}

// Is `url` a clone url deck is willing to hand to `git clone`? Allows the network
// transports (https / ssh / git schemes) and scp-style `host:owner/repo`, and
// rejects everything else: option-like values (leading `-`), the `ext::`
// transport trick, `file://`, and bare/local paths.
export function isCloneUrlSafe(url: string): boolean {
	const u = url.trim();
	// Out: empty, whitespace/backslash-bearing (a Windows local path / `..\`
	// traversal), option-like (leading `-`), or a Windows drive (C:repo).
	if (!u || /[\s\\]/.test(u) || u.startsWith('-') || /^[A-Za-z]:/.test(u)) return false;
	// scheme://authority path, https/ssh/git only, with a safe host.
	const scheme = u.match(/^(?:https|ssh|git):\/\/([^/]+)/i);
	if (scheme) return isSafeHost(scheme[1]);
	// scp-style host:path, host before the single colon, path char after (not `:`,
	// ruling out `ext::…`, nor `/`). Any other `scheme://` fell through above and
	// fails here (its `//` after the colon isn't a path char).
	const scp = u.match(/^([^/:]+):[^/:]/);
	return scp ? isSafeHost(scp[1]) : false;
}

// The host of an authority (the last `@`-separated segment) must be non-empty and
// not start with `-`, or ssh reads it as an option (the ProxyCommand injection
// vector behind `ssh://-oProxyCommand=…` and `git@-evil:path`).
function isSafeHost(authority: string): boolean {
	const host = authority.slice(authority.lastIndexOf('@') + 1);
	return host.length > 0 && !host.startsWith('-');
}
