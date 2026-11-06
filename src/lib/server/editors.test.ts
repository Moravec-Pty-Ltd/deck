import { beforeEach, describe, expect, it, vi } from 'vitest';

const probePort = vi.fn(async () => false);
let cwd: string | undefined = '/srv/my app';
let zedSshTarget: string | undefined;

vi.mock('./devservers', () => ({ probePort }));
vi.mock('./store', () => ({
	getStoredSession: (id: string) => (id === 'known' ? { cwd } : undefined),
	readSettings: () => ({ zedSshTarget })
}));

const { editorsRoute, zedCommandRoute } = await import('./editors');

const event = (id = 'known') => ({ params: { id }, url: new URL('https://box.example.test/api') });
const get = async (id?: string) => (await editorsRoute(event(id))).json();
const getZed = async (id?: string) => (await zedCommandRoute(event(id))).json();

beforeEach(() => {
	probePort.mockClear();
	cwd = '/srv/my app';
	zedSshTarget = undefined;
});

describe('editorsRoute', () => {
	it('lists every editor and reports whether this host accepts SSH on port 22', async () => {
		const body = await get();
		expect(probePort).toHaveBeenCalledWith(22);
		expect(probePort).toHaveBeenCalledTimes(1);
		expect(body.sshReachable).toBe(false);
		expect(body.editors.map((e: { scheme: string }) => e.scheme)).toEqual(['zed', 'vscode']);
		expect(body.editors[1].url).toMatch(/^vscode:\/\/vscode-remote\/ssh-remote\+.+@box\.example\.test\/srv\/my%20app\?windowId=_blank$/);
	});

	it('skips the local check for a zedSshTarget, and every editor honours it', async () => {
		zedSshTarget = 'deploy@ssh.example.com:2222';
		const body = await get();
		expect(probePort).not.toHaveBeenCalled();
		expect(body.sshReachable).toBeNull();
		expect(body.editors.map((e: { url: string }) => e.url)).toEqual([
			'zed://ssh/deploy@ssh.example.com:2222/srv/my%20app',
			'vscode://vscode-remote/ssh-remote+deploy@ssh.example.com:2222/srv/my%20app?windowId=_blank'
		]);
	});

	it('has nothing to open or check without a cwd', async () => {
		cwd = undefined;
		expect(await get()).toEqual({ editors: [], sshReachable: null });
		expect(probePort).not.toHaveBeenCalled();
	});

	it('answers 404 for an unknown session', async () => {
		await expect(get('missing')).rejects.toMatchObject({ status: 404 });
	});
});

describe('zedCommandRoute', () => {
	it('keeps the shape apps from before the editor list decode', async () => {
		zedSshTarget = 'deploy@ssh.example.com:2222';
		expect(await getZed()).toEqual({
			command: 'zed ssh://deploy@ssh.example.com:2222/srv/my%20app',
			url: 'zed://ssh/deploy@ssh.example.com:2222/srv/my%20app',
			sshReachable: null
		});
	});

	it('has nothing to open without a cwd', async () => {
		cwd = undefined;
		expect(await getZed()).toEqual({ command: null, url: null, sshReachable: null });
	});
});
