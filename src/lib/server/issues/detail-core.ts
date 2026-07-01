// Pure, node-free logic for turning each source's raw issue-detail response into
// a normalised shape, and rendering the combined first-prompt blocks. The API
// calls, image downloads, and git-exclude live in the sibling detail.ts.
import type { IssueSourceType } from '$lib/types';

// A normalised issue's detail, source-agnostic. `images` starts as the remote
// URLs pulled from the markdown, then detail.ts rewrites it to the worktree-
// relative paths of the copies it managed to download before rendering.
export interface IssueDetail {
	ref: string; // the SessionIssue id (owner/repo#42, LIN-123, #abc123)
	source: IssueSourceType;
	url: string;
	title: string;
	body: string;
	comments: string[];
	images: string[];
}

// title/body/comments parsed out of one source's response, before ref/source/
// url/images are attached (detail.ts assemble()).
export interface ParsedDetail {
	title: string;
	body: string;
	comments: string[];
}

// Cap body/comment length so a giant ticket can't blow up the first prompt
// (issue #67: "cap body/comment length"). Generous enough to keep normal tickets
// whole; the marker shows where a long one was cut.
export const DETAIL_CAP = 8000;
export function truncate(s: string, cap = DETAIL_CAP): string {
	return s.length <= cap ? s : `${s.slice(0, cap)}\n…[truncated]`;
}

// GitHub: `gh issue view <n> -R owner/repo --json title,body,comments`.
export interface GithubDetailJson {
	title?: string;
	body?: string;
	comments?: { body?: string }[];
}
export function parseGithubDetail(j: GithubDetailJson): ParsedDetail {
	return {
		title: j.title ?? '',
		body: j.body ?? '',
		comments: (j.comments ?? []).map((c) => c.body ?? '').filter(Boolean)
	};
}

// Linear: `issue { title description comments { nodes { body } } }`.
export interface LinearDetailJson {
	title?: string;
	description?: string;
	comments?: { nodes?: { body?: string }[] };
}
export function parseLinearDetail(j: LinearDetailJson): ParsedDetail {
	return {
		title: j.title ?? '',
		body: j.description ?? '',
		comments: (j.comments?.nodes ?? []).map((c) => c.body ?? '').filter(Boolean)
	};
}

// ClickUp: `GET /task/{id}?include_markdown_description=true`. Prefer the
// markdown body; comments need a separate call, so they stay opt-out here.
export interface ClickupDetailJson {
	name?: string;
	markdown_description?: string;
	description?: string;
}
export function parseClickupDetail(j: ClickupDetailJson): ParsedDetail {
	return {
		title: j.name ?? '',
		body: (j.markdown_description ?? j.description ?? '').trim(),
		comments: []
	};
}

// Image URLs embedded in a markdown body/comment: `![alt](url)`. Every source
// hands us markdown-ish text, so one extractor covers all three.
const MD_IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
export function imageUrls(markdown: string): string[] {
	const urls: string[] = [];
	for (const m of markdown.matchAll(MD_IMAGE_RE)) urls.push(m[1]);
	return [...new Set(urls)];
}

// SSRF guard for image URLs pulled from issue bodies: http(s) only, and refuse
// loopback / link-local / private literals + localhost. deck is single-user and
// the URLs come from the user's own sources, so this isn't a full allowlist —
// just closes the cloud-metadata / internal-service vector before a blind fetch.
// It screens the literal host only; the download also refuses redirects
// (redirect: 'manual', see detail.ts), so DNS-rebinding is the accepted residual.
const BLOCKED_HOST =
	/^(localhost$|.*\.localhost$|127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cde])/i;
export function isSafeImageUrl(raw: string): boolean {
	let host: string;
	try {
		const u = new URL(raw);
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
		// Fold a fully-qualified trailing dot ("localhost.") so it can't slip past.
		host = u.hostname.replace(/\.$/, '');
	} catch {
		return false;
	}
	return !BLOCKED_HOST.test(host);
}

const IMAGE_NOTE =
	'Reference images from the issue(s) were saved under .deck/issue-assets/. They are read-only reference material pulled from the issue. Do not modify, move, or commit that directory.';

// One issue's section of the [issue_body] block. A multi-issue block delimits
// each with a header + url; a lone issue is just its body (its url is the
// separate [issue_url] token).
function bodySection(d: IssueDetail, multi: boolean): string {
	const lines: string[] = [];
	if (multi) {
		lines.push(`----- ${d.ref}: ${d.title} -----`);
		if (d.url) lines.push(`URL: ${d.url}`);
	}
	lines.push(truncate(d.body) || '(no description)');
	if (d.images.length) {
		lines.push('Images:');
		for (const p of d.images) lines.push(`- ${p}`);
	}
	return lines.join('\n');
}

// [issue_title]: the human titles joined, so a single-issue prompt reads
// naturally and a multi-issue one still names each ticket.
export function renderIssueTitle(details: IssueDetail[]): string {
	return details
		.map((d) => d.title)
		.filter(Boolean)
		.join(' + ');
}

// [issue_body]: every issue's body (with its image refs), one delimited section
// each when there's more than one, plus a single trailing read-only note when
// any images landed.
export function renderIssueBody(details: IssueDetail[]): string {
	if (!details.length) return '';
	const multi = details.length > 1;
	const body = details.map((d) => bodySection(d, multi)).join('\n\n');
	const hasImages = details.some((d) => d.images.length);
	return (hasImages ? `${body}\n\n${IMAGE_NOTE}` : body).trim();
}

// [issue_comments]: opt-in, so the body stays lean by default. One delimited
// block per issue that actually has comments.
export function renderIssueComments(details: IssueDetail[]): string {
	const multi = details.length > 1;
	return details
		.filter((d) => d.comments.length)
		.map((d) => {
			const header = multi ? `----- ${d.ref} comments -----\n` : '';
			return header + d.comments.map((c) => truncate(c)).join('\n\n');
		})
		.join('\n\n')
		.trim();
}
