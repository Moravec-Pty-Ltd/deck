// Browser client for the agent API (/api/agent/*), the routes the native apps and
// orchestrators use, so the web reads and acts through the same contract (see
// routes/llms.txt). Every error there is a JSON `{ message }`; this surfaces it as
// the thrown Error's message so callers can show it inline.

const BASE = '/api/agent';

export class AgentApiError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
		this.name = 'AgentApiError';
	}
}

// `/api/agent/sessions/<id>/<...rest>`, each segment URL-encoded.
export function sessionPath(id: string, ...rest: string[]): string {
	return [`${BASE}/sessions`, id, ...rest].map((s, i) => (i === 0 ? s : encodeURIComponent(s))).join('/');
}

export function agentPath(path: string): string {
	return `${BASE}/${path.replace(/^\/+/, '')}`;
}

export type AgentRequest = {
	method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	body?: unknown;
	// SvelteKit's load-scoped fetch, or a stub in tests.
	fetch?: typeof fetch;
};

async function errorMessage(res: Response): Promise<string> {
	const data = (await res.json().catch(() => null)) as { message?: unknown } | null;
	const message = typeof data?.message === 'string' ? data.message.trim() : '';
	return message || `request failed (${res.status})`;
}

// One request against an absolute /api/agent path. Resolves with the parsed JSON
// body (undefined when there is none); rejects with AgentApiError on a non-2xx.
export async function agentRequest<T = unknown>(url: string, opts: AgentRequest = {}): Promise<T> {
	const init: RequestInit = { method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST') };
	if (opts.body !== undefined) {
		init.headers = { 'content-type': 'application/json' };
		init.body = JSON.stringify(opts.body);
	}
	const res = await (opts.fetch ?? fetch)(url, init);
	if (!res.ok) throw new AgentApiError(await errorMessage(res), res.status);
	const text = await res.text();
	return (text ? JSON.parse(text) : undefined) as T;
}

export const agentGet = <T = unknown>(url: string, f?: typeof fetch) => agentRequest<T>(url, { fetch: f });

export const agentPost = <T = unknown>(url: string, body: unknown = {}) =>
	agentRequest<T>(url, { method: 'POST', body });

export const agentDelete = <T = unknown>(url: string, body?: unknown) =>
	agentRequest<T>(url, { method: 'DELETE', body });
