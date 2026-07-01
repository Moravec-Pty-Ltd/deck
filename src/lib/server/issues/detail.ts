// Server-side issue-detail fetch for the first prompt (issue #67): pull each
// attached issue's title/body/comments, download its embedded images into a
// git-excluded worktree scratch dir, and render the combined [issue_*] blocks.
// Every step is best-effort — a failure resolves to empty rather than blocking
// session creation. Pure parsing/rendering lives in detail-core.ts.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { SessionIssue } from '$lib/types';
import { gh } from './github';
import { graphql as linearGraphql } from './linear';
import { cu, seg } from './clickup';
import {
	imageUrls,
	isSafeImageUrl,
	parseClickupDetail,
	parseGithubDetail,
	parseLinearDetail,
	renderIssueBody,
	renderIssueComments,
	renderIssueTitle,
	type ClickupDetailJson,
	type IssueDetail,
	type LinearDetailJson,
	type ParsedDetail
} from './detail-core';

const exec = promisify(execFile);

// owner/repo, so a crafted issue id can't reshape the `gh -R` arg into a flag or
// a different repo. Mirrors the guard the sessions endpoint uses for PR repos.
const REPO_RE = /^[\w.][\w.-]*\/[\w.][\w.-]*$/;

// owner/repo#42 -> { repo, number }, or null when the id isn't that shape.
function parseGithubRef(id: string): { repo: string; number: string } | null {
	const m = /^(.+)#(\d+)$/.exec(id);
	if (!m || !REPO_RE.test(m[1])) return null;
	return { repo: m[1], number: m[2] };
}

function assemble(issue: SessionIssue, parsed: ParsedDetail): IssueDetail {
	const images = imageUrls(`${parsed.body}\n${parsed.comments.join('\n')}`).filter(isSafeImageUrl);
	return { ref: issue.id, source: issue.source, url: issue.url, ...parsed, images };
}

async function githubDetail(issue: SessionIssue): Promise<IssueDetail | null> {
	const ref = parseGithubRef(issue.id);
	if (!ref) return null;
	const out = await gh(['issue', 'view', ref.number, '-R', ref.repo, '--json', 'title,body,comments']);
	return assemble(issue, parseGithubDetail(JSON.parse(out)));
}

const LINEAR_DETAIL_QUERY = `query($id: String!) {
	issue(id: $id) { title description url comments(first: 50) { nodes { body } } }
}`;

async function linearDetail(issue: SessionIssue, apiKey: string): Promise<IssueDetail | null> {
	const data = await linearGraphql<{ issue: LinearDetailJson | null }>(apiKey, LINEAR_DETAIL_QUERY, {
		id: issue.id
	});
	if (!data.issue) return null;
	return assemble(issue, parseLinearDetail(data.issue));
}

async function clickupDetail(issue: SessionIssue, apiKey: string): Promise<IssueDetail | null> {
	// The stored id carries a leading `#` (see fetchClickupIssues); the API wants
	// the bare task id.
	const taskId = issue.id.replace(/^#/, '');
	const data = await cu<ClickupDetailJson>(
		apiKey,
		`/task/${seg(taskId)}?include_markdown_description=true`
	);
	return assemble(issue, parseClickupDetail(data));
}

// Pick the source fetcher; null when a keyed source has no key.
function routeDetail(issue: SessionIssue, apiKey?: string): Promise<IssueDetail | null> {
	if (issue.source === 'github') return githubDetail(issue);
	if (!apiKey) return Promise.resolve(null);
	if (issue.source === 'linear') return linearDetail(issue, apiKey);
	return clickupDetail(issue, apiKey);
}

// Best-effort per-source fetch. Never throws: any failure (missing key, dead
// network, unknown id shape) resolves to null so the first prompt still has
// [issue_id]/[issue_url] from the session.
function fetchIssueDetail(issue: SessionIssue, apiKey?: string): Promise<IssueDetail | null> {
	return routeDetail(issue, apiKey).catch(() => null);
}

// --- Image download into the worktree scratch dir ---

const ASSETS_DIR = '.deck/issue-assets';
const IMG_TIMEOUT_MS = 15_000;
const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);

function imageExt(url: string): string {
	const ext = /\.([a-zA-Z0-9]+)(?:[?#]|$)/.exec(url)?.[1]?.toLowerCase();
	return ext && IMG_EXT.has(ext) ? ext : 'png';
}

// Content-addressed by URL so a repeated image is one file; the per-issue dir
// keeps refs from different issues apart. `.` in the hash makes it path-safe.
function imageFile(url: string): string {
	return `${crypto.createHash('sha1').update(url).digest('hex').slice(0, 12)}.${imageExt(url)}`;
}

// Sanitise the issue ref into one safe path segment for its asset dir. Collapse
// a pure-dot result (`.`/`..`) too, so it can't climb out of the assets dir.
function safeSeg(ref: string): string {
	const s = ref.replace(/[^a-zA-Z0-9._-]/g, '_');
	return /^\.+$/.test(s) ? '_' : s;
}

// uploads.linear.app needs the same auth header as the API; GitHub/ClickUp
// attachment URLs download plain (private-repo GitHub assets may 403 — dropped).
function authHeaders(source: SessionIssue['source'], apiKey?: string): Record<string, string> {
	return source === 'linear' && apiKey ? { authorization: apiKey } : {};
}

async function downloadImage(
	url: string,
	dest: string,
	headers: Record<string, string>
): Promise<boolean> {
	const res = await fetch(url, { headers, signal: AbortSignal.timeout(IMG_TIMEOUT_MS) });
	if (!res.ok) return false;
	const buf = Buffer.from(await res.arrayBuffer());
	if (!buf.length) return false;
	fs.writeFileSync(dest, buf);
	return true;
}

// Download one image into `dir`; return its worktree-relative path, or null if
// it 403s / times out / comes back empty (best-effort, one bad image is dropped).
async function saveOne(
	url: string,
	dir: string,
	rel: string,
	headers: Record<string, string>
): Promise<string | null> {
	const file = imageFile(url);
	try {
		return (await downloadImage(url, path.join(dir, file), headers)) ? path.join(rel, file) : null;
	} catch {
		return null;
	}
}

// Download an issue's images (remote URLs on `detail.images`) into
// <worktree>/.deck/issue-assets/<ref>/ and return the worktree-relative paths
// that landed. Non-mutating: the caller rebuilds the detail with these paths.
async function saveImages(worktree: string, detail: IssueDetail, apiKey?: string): Promise<string[]> {
	if (!detail.images.length) return [];
	const rel = path.join(ASSETS_DIR, safeSeg(detail.ref));
	const dir = path.join(worktree, rel);
	fs.mkdirSync(dir, { recursive: true });
	const headers = authHeaders(detail.source, apiKey);
	const saved: string[] = [];
	for (const url of detail.images) {
		const p = await saveOne(url, dir, rel, headers);
		if (p) saved.push(p);
	}
	return saved;
}

// Add a line to a git exclude file if absent (idempotent), on its own line.
// Append-only, so an unrelated concurrent edit to the shared file isn't clobbered.
function appendExclude(file: string, line: string): void {
	const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
	if (existing.split('\n').includes(line)) return;
	const lead = /\n$|^$/.test(existing) ? '' : '\n';
	fs.appendFileSync(file, `${lead}${line}\n`);
}

// Keep the scratch dir out of git without touching a tracked .gitignore:
// info/exclude is local and worktree-aware via rev-parse. Best-effort.
async function excludeAssets(worktree: string): Promise<void> {
	try {
		const { stdout } = await exec('git', ['-C', worktree, 'rev-parse', '--git-path', 'info/exclude'], {
			timeout: 10_000
		});
		appendExclude(path.resolve(worktree, stdout.trim()), `${ASSETS_DIR}/`);
	} catch {
		// no git dir / permission — the assets just aren't excluded, non-fatal
	}
}

// --- First-prompt assembly ---

export interface IssueForFetch {
	issue: SessionIssue;
	apiKey?: string;
}

export interface IssuePromptContext {
	issueTitle: string;
	issueBody: string;
	issueComments: string;
}

const EMPTY: IssuePromptContext = { issueTitle: '', issueBody: '', issueComments: '' };
const hasImages = (d: IssueDetail) => d.images.length > 0;

// Fetch every attached issue's detail (best-effort; failures drop out).
async function fetchAll(items: IssueForFetch[]): Promise<{ detail: IssueDetail; apiKey?: string }[]> {
	const kept: { detail: IssueDetail; apiKey?: string }[] = [];
	for (const { issue, apiKey } of items) {
		const detail = await fetchIssueDetail(issue, apiKey);
		if (detail) kept.push({ detail, apiKey });
	}
	return kept;
}

// Fetch every attached issue's detail, download its images into the worktree
// scratch dir, and render the combined [issue_*] blocks. Best-effort as a whole:
// failed issues drop out; if all fail the blocks are empty and the caller falls
// back to the [issue_id]/[issue_url] tokens.
export async function buildIssuePrompt(
	worktree: string,
	items: IssueForFetch[]
): Promise<IssuePromptContext> {
	const kept = await fetchAll(items);
	if (!kept.length) return EMPTY;

	const details: IssueDetail[] = [];
	for (const { detail, apiKey } of kept) {
		details.push({ ...detail, images: await saveImages(worktree, detail, apiKey) });
	}
	if (details.some(hasImages)) await excludeAssets(worktree);

	return {
		issueTitle: renderIssueTitle(details),
		issueBody: renderIssueBody(details),
		issueComments: renderIssueComments(details)
	};
}
