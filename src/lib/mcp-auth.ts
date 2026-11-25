import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';

// Who may use deck's loopback MCP endpoints: the server's (server/mcp.ts) and
// the remote agent's (src/agent). Each claude is given its own bearer secret in
// a private config file, so nothing about it shows on a command line.

const digest = (s: string) => createHash('sha256').update(s).digest();

// A request from the claude the secret was given to, addressed to loopback by
// name. The Host check turns away a page whose hostname resolves here.
export function mcpAllowed(headers: IncomingHttpHeaders, port: number, secret: string): boolean {
	if (headers.host !== `127.0.0.1:${port}` && headers.host !== `localhost:${port}`) return false;
	return timingSafeEqual(digest(headers.authorization ?? ''), digest(`Bearer ${secret}`));
}

// The `--mcp-config` file naming the endpoint. Removed first, because writing
// keeps an existing file's mode.
export function writeMcpConfig(file: string, url: string, secret: string): void {
	const config = { mcpServers: { deck: { type: 'http', url, headers: { Authorization: `Bearer ${secret}` } } } };
	fs.rmSync(file, { force: true });
	fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
}
