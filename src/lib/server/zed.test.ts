import { beforeEach, describe, expect, it, vi } from 'vitest';

const probePort = vi.fn(async () => false);
let cwd: string | undefined = '/srv/my app';
let zedSshTarget: string | undefined;

vi.mock('./devservers', () => ({ probePort }));
vi.mock('./store', () => ({
	getStoredSession: (id: string) => (id === 'known' ? { cwd } : undefined),
	readSettings: () => ({ zedSshTarget })
}));

const { zedCommandRoute } = await import('./zed');

const get = async (id = 'known') =>
	(await zedCommandRoute({ params: { id }, url: new URL('https://box.example.test/api') })).json();

describe('zedCommandRoute', () => {
	beforeEach(() => {
		probePort.mockClear();
		cwd = '/srv/my app';
		zedSshTarget = undefined;
	});

	it('reports whether this host accepts SSH on port 22', async () => {
		const body = await get();
		expect(probePort).toHaveBeenCalledWith(22);
		expect(body.sshReachable).toBe(false);
		expect(body.url).toMatch(/^zed:\/\/ssh\/.+@box\.example\.test\/srv\/my%20app$/);
	});

	it('skips the local check for a zedSshTarget, and honours it', async () => {
		zedSshTarget = 'deploy@ssh.example.com:2222';
		const body = await get();
		expect(probePort).not.toHaveBeenCalled();
		expect(body).toEqual({
			command: 'zed ssh://deploy@ssh.example.com:2222/srv/my%20app',
			url: 'zed://ssh/deploy@ssh.example.com:2222/srv/my%20app',
			sshReachable: null
		});
	});

	it('has nothing to open or check without a cwd', async () => {
		cwd = undefined;
		expect(await get()).toEqual({ command: null, url: null, sshReachable: null });
		expect(probePort).not.toHaveBeenCalled();
	});

	it('answers 404 for an unknown session', async () => {
		await expect(get('missing')).rejects.toMatchObject({ status: 404 });
	});
});
