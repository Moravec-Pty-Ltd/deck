import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { registerAsk, type AskQuestion } from './ask';
import { WatchError, describeMaxDelay } from './watch-core';
import { watchMaxDelayMs } from './config';
import { activeWatches, cancelWatch, createWatch, getWatch } from './watch-store';
import type { Watch } from '$lib/watches';

// Deck hosts a tiny Streamable-HTTP MCP server on localhost and points each
// spawned `claude` at /mcp/<sessionId>. Its main tool, `ask`, mirrors
// the built-in AskUserQuestion but *blocks* until the user answers in the deck
// UI — which the headless `-p` CLI can't do for the native tool. The deck
// session id is taken from the URL path and bound into each tool handler. The
// watch tools (issue #277) let the agent set a timer that wakes it later.

const ASK_INPUT = {
	questions: z
		.array(
			z.object({
				question: z.string().describe('The question to ask the user'),
				header: z.string().optional().describe('Short label for the question (<= 12 chars)'),
				multiSelect: z.boolean().optional().describe('Allow selecting more than one option'),
				options: z
					.array(
						z.object({
							label: z.string(),
							description: z.string().optional()
						})
					)
					.describe('Choices to offer; the user can also type their own answer')
			})
		)
		.describe('One or more questions to put to the user')
};

const WATCH_INPUT = {
	title: z.string().describe('Short name for what you are waiting for, e.g. "CI on #42"'),
	prompt: z.string().describe('What to do when it fires; sent back to you with the check result'),
	in: z.string().optional().describe('Delay such as "30s", "10m", "2h" or "1h30m" (give this or `at`)'),
	at: z.union([z.string(), z.number()]).optional().describe('ISO time or epoch ms to fire at (give this or `in`)'),
	command: z
		.string()
		.optional()
		.describe('Optional quick shell check run once in your working directory when it fires (60s limit), e.g. `gh pr checks 42`. Only accepted when this session skips permission prompts')
};

function text(t: string, isError = false) {
	return { content: [{ type: 'text' as const, text: t }], ...(isError ? { isError: true } : {}) };
}

function describeWatch(w: Watch): string {
	const secs = Math.max(0, Math.round((w.dueAt - Date.now()) / 1000));
	const left = secs < 120 ? `${secs}s` : `${Math.round(secs / 60)} min`;
	return `${w.id}: "${w.title}" fires at ${new Date(w.dueAt).toISOString()} (in about ${left})${w.command ? `, check \`${w.command}\`` : ''}`;
}

function registerWatchTools(server: McpServer, deckId: string): void {
	server.registerTool(
		'watch',
		{
			title: 'Set a watch',
			description:
				`Wake this session later: deck sends \`prompt\` back to you at the time, with the exit code and output tail of \`command\` if you gave one. Returns at once; end your turn after calling it instead of sleeping or polling in the shell. Fires once; set another if what you wait for is not ready yet. At most 5 active, at most ${describeMaxDelay(watchMaxDelayMs)} ahead.`,
			inputSchema: WATCH_INPUT
		},
		async (args) => {
			try {
				return text(`Watch set. ${describeWatch(createWatch(deckId, args))}. End your turn now; deck will message you.`);
			} catch (e) {
				if (e instanceof WatchError) return text(e.message, true);
				throw e;
			}
		}
	);
	server.registerTool(
		'watches',
		{ title: 'List watches', description: "This session's active watches.", inputSchema: {} },
		async () => {
			const watches = activeWatches(deckId);
			return text(watches.length ? watches.map(describeWatch).join('\n') : 'No active watches.');
		}
	);
	server.registerTool(
		'unwatch',
		{
			title: 'Cancel a watch',
			description: 'Cancel one of this session\'s watches by id.',
			inputSchema: { id: z.string().describe('The watch id, e.g. wat_abc12345') }
		},
		async ({ id }) => {
			const watch = getWatch(id);
			if (watch?.sessionId !== deckId) return text(`No watch ${id} in this session.`, true);
			if (watch.state !== 'active') return text(`${id} already ${watch.state}.`);
			cancelWatch(id);
			return text(`Cancelled ${id}.`);
		}
	);
}

function buildServer(deckId: string): McpServer {
	const server = new McpServer({ name: 'deck', version: '1.0.0' });
	server.registerTool(
		'ask',
		{
			title: 'Ask the user',
			description:
				'Ask the user one or more multiple-choice questions and block until they answer in the deck UI. Use this whenever you would otherwise use AskUserQuestion (which is disabled in this environment).',
			inputSchema: ASK_INPUT
		},
		async (args, extra) => {
			const text = await registerAsk(deckId, args.questions as AskQuestion[], extra.signal);
			return { content: [{ type: 'text' as const, text }] };
		}
	);
	registerWatchTools(server, deckId);
	return server;
}

const transports = new Map<string, StreamableHTTPServerTransport>();

function deckIdFromUrl(url: string | undefined): string | null {
	const m = (url ?? '').match(/^\/mcp\/([^/?]+)/);
	return m ? decodeURIComponent(m[1]) : null;
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const c of req) chunks.push(c as Buffer);
	if (!chunks.length) return undefined;
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8'));
	} catch {
		return undefined;
	}
}

interface McpState {
	port: number;
	ready: Promise<number>;
}

const g = globalThis as { __deckMcp?: McpState };

function startServer(): McpState {
	const state: McpState = { port: 0, ready: Promise.resolve(0) };

	const httpServer = http.createServer(async (req, res) => {
		const deckId = deckIdFromUrl(req.url);
		if (!deckId) {
			res.writeHead(404).end();
			return;
		}
		try {
			const sid = req.headers['mcp-session-id'] as string | undefined;
			const body = req.method === 'POST' ? await readBody(req) : undefined;
			let transport = sid ? transports.get(sid) : undefined;

			if (!transport) {
				if (req.method !== 'POST' || !isInitializeRequest(body)) {
					res
						.writeHead(400, { 'content-type': 'application/json' })
						.end(
							JSON.stringify({
								jsonrpc: '2.0',
								error: { code: -32000, message: 'No valid MCP session' },
								id: null
							})
						);
					return;
				}
				const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
					sessionIdGenerator: () => randomUUID(),
					onsessioninitialized: (id: string) => {
						transports.set(id, created);
					}
				});
				created.onclose = () => {
					if (created.sessionId) transports.delete(created.sessionId);
				};
				await buildServer(deckId).connect(created);
				transport = created;
			}
			await transport!.handleRequest(req, res, body);
		} catch {
			if (!res.headersSent) res.writeHead(500).end();
			else res.end();
		}
	});

	state.ready = new Promise<number>((resolve) => {
		httpServer.listen(0, '127.0.0.1', () => {
			const addr = httpServer.address();
			state.port = typeof addr === 'object' && addr ? addr.port : 0;
			resolve(state.port);
		});
	});
	httpServer.unref();
	return state;
}

// Start (once) the localhost MCP server and resolve when it's listening.
export function ensureMcp(): Promise<number> {
	if (!g.__deckMcp) g.__deckMcp = startServer();
	return g.__deckMcp.ready;
}

export function mcpUrl(deckId: string): string {
	const port = g.__deckMcp?.port ?? 0;
	return `http://127.0.0.1:${port}/mcp/${encodeURIComponent(deckId)}`;
}
