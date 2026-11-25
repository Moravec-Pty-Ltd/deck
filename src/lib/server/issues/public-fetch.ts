import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

// A GET for a URL someone else wrote (an image in an issue). It connects only to
// a public address: the host is resolved here, every address it has must be
// public, and the connection goes to the one that was checked. Redirects are not
// followed.

const internal = new net.BlockList();
for (const [address, prefix] of [
	['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
	['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]
] as const) internal.addSubnet(address, prefix, 'ipv4');

// Global unicast, less the ranges that carry an IPv4 address inside (Teredo, 6to4).
const global6 = new net.BlockList();
global6.addSubnet('2000::', 3, 'ipv6');
const embedded4 = new net.BlockList();
embedded4.addSubnet('2001::', 32, 'ipv6');
embedded4.addSubnet('2002::', 16, 'ipv6');

export function isPublicAddress(address: string): boolean {
	if (net.isIPv4(address)) return !internal.check(address, 'ipv4');
	return net.isIPv6(address) && global6.check(address, 'ipv6') && !embedded4.check(address, 'ipv6');
}

type Lookup = (host: string, options: { all: true }) => Promise<dns.LookupAddress[]>;

export async function publicAddresses(host: string, lookup: Lookup = dns.promises.lookup): Promise<dns.LookupAddress[]> {
	const found = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await lookup(host, { all: true });
	if (!found.length || !found.every((f) => isPublicAddress(f.address))) throw new Error(`${host} is not a public address`);
	return found;
}

export interface PublicResponse {
	status: number;
	type: string;
	body: Buffer;
}

interface GetOptions {
	headers: Record<string, string>;
	timeoutMs: number;
	maxBytes: number;
}

function read(url: URL, pinned: dns.LookupAddress[], opts: GetOptions, signal: AbortSignal): Promise<PublicResponse> {
	const lookup: net.LookupFunction = (_host, options, done) =>
		options.all ? done(null, pinned) : done(null, pinned[0].address, pinned[0].family);
	const get = url.protocol === 'https:' ? https.get : http.get;
	// Identity: the body is kept as it arrives. `agent: false`: no shared socket
	// or proxy setting stands between the check and the connection.
	const headers = { 'user-agent': 'node', 'accept-encoding': 'identity', ...opts.headers };
	return new Promise((ok, fail) => {
		const req = get(url, { headers, lookup, signal, agent: false }, (res) => {
			const chunks: Buffer[] = [];
			let size = 0;
			res.on('data', (chunk: Buffer) => {
				size += chunk.length;
				if (size > opts.maxBytes) res.destroy(new Error('response too large'));
				else chunks.push(chunk);
			});
			res.on('error', fail);
			res.on('end', () => ok({ status: res.statusCode ?? 0, type: res.headers['content-type'] ?? '', body: Buffer.concat(chunks) }));
		});
		req.on('error', fail);
		// No 'response' comes for an upgrade, only this.
		req.on('close', () => fail(new Error('connection closed')));
	});
}

// The whole response, or an error past `maxBytes` or the deadline, which covers
// the name lookup too.
export async function publicGet(raw: string, opts: GetOptions, resolve = publicAddresses): Promise<PublicResponse> {
	const url = new URL(raw);
	const signal = AbortSignal.timeout(opts.timeoutMs);
	const late = new Promise<never>((_ok, fail) => signal.addEventListener('abort', () => fail(signal.reason), { once: true }));
	const found = resolve(url.hostname.replace(/^\[|\]$/g, ''));
	return Promise.race([late, found.then((pinned) => read(url, pinned, opts, signal))]);
}
