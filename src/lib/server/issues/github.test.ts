import { beforeEach, describe, expect, it, vi } from 'vitest';

const out = vi.hoisted(() => ({ next: '' as string | Error }));
vi.mock('node:child_process', () => ({
	execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, r?: { stdout: string }) => void) =>
		out.next instanceof Error ? cb(out.next) : cb(null, { stdout: out.next })
}));

const { prAuthorTrusted, prFromFork } = await import('./github');

const association = (a: string) => JSON.stringify({ data: { repository: { pullRequest: { authorAssociation: a } } } });

beforeEach(() => {
	out.next = '';
});

describe('pull request trust', () => {
	it('reads a fork from gh, and counts an unknown answer as one', async () => {
		out.next = '{"isCrossRepository":false}';
		expect(await prFromFork('acme/web', 7)).toBe(false);
		out.next = '{"isCrossRepository":true}';
		expect(await prFromFork('acme/web', 7)).toBe(true);
		out.next = new Error('gh: HTTP 404');
		expect(await prFromFork('acme/web', 7)).toBe(true);
	});

	it('trusts only authors with a role in the repository', async () => {
		for (const a of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
			out.next = association(a);
			expect(await prAuthorTrusted('acme/web', 7)).toBe(true);
		}
		for (const a of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE']) {
			out.next = association(a);
			expect(await prAuthorTrusted('acme/web', 7)).toBe(false);
		}
		out.next = JSON.stringify({ data: { repository: { pullRequest: null } } });
		await expect(prAuthorTrusted('acme/web', 7)).rejects.toThrow('no author association');
		// gh unable to say is not an answer: the caller asks again.
		out.next = new Error('gh: rate limited');
		await expect(prAuthorTrusted('acme/web', 7)).rejects.toThrow('rate limited');
	});
});
