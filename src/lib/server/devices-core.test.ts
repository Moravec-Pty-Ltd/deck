import { describe, expect, it } from 'vitest';
import { deviceFor, deviceName, mintDevice, upgradesCookie } from './devices-core';

describe('device credentials', () => {
	it('matches only the device it was minted for, and stores no secret', () => {
		const a = mintDevice('Phone', 1);
		const b = mintDevice('Laptop', 2);
		expect(a.credential).not.toContain(a.device.hash);
		expect(deviceFor([a.device, b.device], a.credential)?.name).toBe('Phone');
		expect(deviceFor([a.device, b.device], b.credential)?.name).toBe('Laptop');
		// Another device's secret under this id, a revoked device, junk: no match.
		const swapped = a.credential.replace(/\.[^.]+$/, '.' + b.credential.split('.').at(-1));
		expect(deviceFor([a.device, b.device], swapped)).toBeNull();
		expect(deviceFor([b.device], a.credential)).toBeNull();
		expect(deviceFor([a.device], 'not-a-credential')).toBeNull();
		expect(deviceFor([a.device], null)).toBeNull();
	});

	it('upgrades an old cookie only on a page load', () => {
		expect(upgradesCookie('GET', 'navigate')).toBe(true);
		expect(upgradesCookie('GET', 'cors')).toBe(false);
		expect(upgradesCookie('GET', null)).toBe(false);
		expect(upgradesCookie('POST', 'navigate')).toBe(false);
	});

	it('names a device from its user agent', () => {
		expect(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit Version/18.0 Mobile Safari/604.1')).toBe('Safari on iPhone');
		expect(deviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130.0 Safari/537.36')).toBe('Chrome on Mac');
		expect(deviceName('deck/1.0 CFNetwork')).toBe('deck/1.0 CFNetwork');
		expect(deviceName('')).toBe('Device');
	});
});
