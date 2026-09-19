import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileUrl, statFile, statFiles } from './file-stat';

const info = (path: string) => ({ path, name: path.slice(1), size: 1, mime: 'image/png', image: true });

function stubFetch(handler: (paths: string[]) => unknown) {
	const calls: string[][] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: string, init: RequestInit) => {
			const { paths } = JSON.parse(String(init.body)) as { paths: string[] };
			calls.push(paths);
			const result = handler(paths);
			if (result instanceof Error) throw result;
			return new Response(JSON.stringify({ files: result }), { status: 200 });
		})
	);
	return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('statFiles', () => {
	it('batches the asks of one tick and answers each path from the reply', async () => {
		const calls = stubFetch((paths) => paths.filter((p) => p.endsWith('.png')).map(info));
		const [a, b] = await Promise.all([
			statFiles('s1', ['/a.png', '/b.pdf']),
			statFiles('s1', ['/c.png', '/a.png'])
		]);
		expect(calls).toEqual([['/a.png', '/b.pdf', '/c.png']]);
		expect(a.map((f) => f.path)).toEqual(['/a.png']);
		expect(b.map((f) => f.path)).toEqual(['/c.png', '/a.png']);
	});

	it('remembers answers per session and asks again after a failure', async () => {
		let fail = true;
		const calls = stubFetch((paths) => (fail ? new Error('down') : paths.map(info)));
		expect(await statFile('s2', '/x.png')).toBeNull();
		fail = false;
		expect(await statFile('s2', '/x.png')).toMatchObject({ path: '/x.png' });
		expect(await statFile('s2', '/x.png')).toMatchObject({ path: '/x.png' });
		expect(await statFile('s3', '/x.png')).toMatchObject({ path: '/x.png' });
		expect(calls).toHaveLength(3);
	});

	it('splits a large batch to the server cap', async () => {
		const calls = stubFetch((paths) => paths.map(info));
		const paths = Array.from({ length: 25 }, (_, i) => `/big${i}.png`);
		expect(await statFiles('s4', paths)).toHaveLength(25);
		expect(calls.map((c) => c.length)).toEqual([20, 5]);
	});
});

describe('fileUrl', () => {
	it('encodes the path and marks downloads', () => {
		expect(fileUrl('c 1', '/a b.png')).toBe('/api/sessions/c%201/files?path=%2Fa%20b.png');
		expect(fileUrl('c1', '/a.png', true)).toBe('/api/sessions/c1/files?path=%2Fa.png&download=1');
	});
});
