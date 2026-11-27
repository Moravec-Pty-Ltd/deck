import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { AUTH_COOKIE, headerToken } from '$lib/server/config';
import { addDevice, deviceForCredential, listDevices } from '$lib/server/devices';
import { optionalObjectBody } from '$lib/server/http';

// GET /api/agent/devices: the signed-in devices, marking the one asking.
export const GET: RequestHandler = async ({ request, cookies }) => {
	const current = deviceForCredential(headerToken(request.headers) ?? cookies.get(AUTH_COOKIE))?.id;
	return json({
		devices: listDevices().map(({ hash: _hash, ...d }) => ({ ...d, current: d.id === current }))
	});
};

// POST /api/agent/devices { name? }: a credential for a device about to sign in
// (the sign-in QR carries it). Shown once; deck keeps only its hash.
export const POST: RequestHandler = async ({ request }) => {
	const body = await optionalObjectBody(request);
	const name = typeof body.name === 'string' && body.name.trim() ? body.name : 'Signed in with a QR code';
	const { device, credential } = addDevice(name);
	return json({ id: device.id, credential }, { status: 201 });
};
