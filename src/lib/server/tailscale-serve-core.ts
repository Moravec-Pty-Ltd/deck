// What a failed `tailscale serve` call means for the dev console. Two failures
// are normal and stay silent: tailscale isn't installed (ENOENT), and `off`
// found nothing to remove. Anything else (logged out, daemon stopped) leaves a
// mapping that outlives vite and holds the port's tailnet addresses, so say so.
export type ServeError = { code?: unknown; status?: number | null; signal?: unknown; stderr?: unknown };

export function serveFailure(
	args: string[],
	err: ServeError,
	stderr: string,
	port: number
): string | null {
	if (err.code === 'ENOENT') return null;
	const reason = stderr.trim();
	if (args.includes('off') && reason.includes('handler does not exist')) return null;
	return (
		`tailscale ${args.join(' ')} failed (exit ${err.status ?? err.code ?? err.signal}): ${reason || 'no output'}\n` +
		`A mapping from an earlier run may still hold port ${port} on the tailnet. ` +
		`Once tailscale is logged in, clear it with: tailscale serve --https=${port} off`
	);
}
