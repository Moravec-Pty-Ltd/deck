import { describe, expect, it } from 'vitest';
import { serveFailure } from './tailscale-serve-core';

const off = ['serve', '--https=4818', 'off'];
const bg = ['serve', '--bg', '--https=4818', 'http://localhost:4818'];

describe('serveFailure', () => {
	it('stays silent when tailscale is not installed', () => {
		expect(serveFailure(off, { code: 'ENOENT' }, '', 4818)).toBeNull();
		expect(serveFailure(bg, { code: 'ENOENT' }, '', 4818)).toBeNull();
	});

	it('stays silent when off finds nothing to remove', () => {
		const stderr = 'error: failed to remove web serve: handler does not exist\n';
		expect(serveFailure(off, { status: 1 }, stderr, 4818)).toBeNull();
	});

	it('names the failed command, its exit status, stderr and the recovery command', () => {
		const msg = serveFailure(off, { status: 1 }, 'Logged out.\n', 4818);
		expect(msg).toContain('tailscale serve --https=4818 off failed (exit 1): Logged out.');
		expect(msg).toContain('clear it with: tailscale serve --https=4818 off');
	});

	it('reports a failed --bg, with the exit code execFile puts on err.code', () => {
		const msg = serveFailure(bg, { code: 1 }, 'Logged out.', 4819);
		expect(msg).toContain('tailscale serve --bg --https=4818 http://localhost:4818 failed (exit 1)');
		expect(msg).toContain('tailscale serve --https=4819 off');
	});
});
