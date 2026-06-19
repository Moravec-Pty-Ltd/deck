// Screenshot / demo mode. With DECK_DEMO=1 the server serves a fixed, sanitized
// dataset instead of reading ~/.deck and instead of merging the host's live tmux
// sessions, so the README screenshots are reproducible and never leak a real
// name, path, host, or unrelated project. Auth is also bypassed (see config.ts).
//
// The data layer short-circuits to these values at a few chokepoints
// (store.listProjects, sessions.listSessions/getSession) and the agent/terminal
// endpoints return the canned transcript / capture below.
import type { DeckSession, Project } from '$lib/types';

export const DEMO = process.env.DECK_DEMO === '1' || process.env.DECK_DEMO === 'true';

const ROOT = '/Users/deck/code/deck';

export function demoProjects(): Project[] {
	return [{ name: 'deck', path: ROOT }];
}

// Recomputed each call so relative times ("4m", "1h") stay believable.
export function demoSessions(): DeckSession[] {
	const now = Date.now();
	const m = 60_000,
		h = 3_600_000;
	const base = { cwd: ROOT, createdAt: now - 36 * h };
	return [
		{
			...base,
			id: 'c_stream',
			kind: 'claude',
			title: 'Stream token diff renderer',
			status: 'running',
			lastActiveAt: now - 40_000,
			model: 'opus',
			provider: 'anthropic',
			cwd: `${ROOT}-worktrees/stream-diff`,
			worktree: { repo: ROOT, branch: 'stream-diff', createdBranch: true }
		},
		{
			...base,
			id: 's_dev',
			kind: 'shell',
			title: 'dev server',
			status: 'idle',
			lastActiveAt: now - 3 * m,
			tmuxName: 'deck-dev',
			managed: true
		},
		{
			...base,
			id: 'c_yolo',
			kind: 'claude',
			title: 'Yolo badge in session header',
			status: 'idle',
			lastActiveAt: now - 12 * m,
			model: 'opus',
			provider: 'anthropic',
			permissionMode: 'bypassPermissions'
		},
		{
			...base,
			id: 'x_tmux',
			kind: 'codex',
			title: 'Tighten tmux capture-pane race',
			status: 'idle',
			lastActiveAt: now - 24 * m,
			agentSessionId: 'demo'
		},
		{
			...base,
			id: 'c_sse',
			kind: 'claude',
			title: 'Flaky SSE reconnect under load',
			status: 'error',
			lastActiveAt: now - 1 * h
		},
		{
			...base,
			id: 'p_push',
			kind: 'pi',
			title: 'Push notifications for ask-tool',
			status: 'idle',
			lastActiveAt: now - 3 * h
		}
	];
}

export function demoSession(id: string): DeckSession | undefined {
	return demoSessions().find((s) => s.id === id);
}

// Canned claude transcript for the chat screenshot (the c_yolo session). Shapes
// match what ClaudeView expects off the /events snapshot: deck.user bubbles,
// assistant content blocks (text / tool_use), paired user tool_result blocks,
// and a final result line.
export function demoTranscript(id: string): Record<string, unknown>[] {
	if (id !== 'c_yolo') return [];
	return [
		{
			type: 'deck.user',
			text: 'Add a yolo badge to the session header when a session runs with bypassPermissions.'
		},
		{
			type: 'assistant',
			message: {
				content: [
					{
						type: 'text',
						text: "Good call. I'll add a small badge next to the title, shown only in that mode."
					}
				]
			}
		},
		{
			type: 'assistant',
			message: {
				content: [
					{
						type: 'tool_use',
						id: 'tu_todo',
						name: 'TodoWrite',
						input: {
							todos: [
								{ content: 'Add yolo badge to the session header', status: 'completed' },
								{ content: 'Type-check the change', status: 'in_progress' },
								{ content: 'Refresh the README screenshots', status: 'pending' }
							]
						}
					}
				]
			}
		},
		{
			type: 'assistant',
			message: {
				content: [
					{
						type: 'tool_use',
						id: 'tu_edit',
						name: 'Edit',
						input: {
							file_path: `${ROOT}/src/routes/s/[id]/+page.svelte`,
							old_string: '\t\t\t\t<span class="truncate font-medium">{session.title}</span>',
							new_string:
								'\t\t\t\t<span class="truncate font-medium">{session.title}</span>\n\t\t\t\t{#if session.permissionMode === \'bypassPermissions\'}\n\t\t\t\t\t<span class="badge badge-outline badge-sm shrink-0">yolo</span>\n\t\t\t\t{/if}'
						}
					}
				]
			}
		},
		{
			type: 'user',
			message: {
				content: [{ type: 'tool_result', tool_use_id: 'tu_edit', content: 'The file has been updated.' }]
			}
		},
		{
			type: 'assistant',
			message: {
				content: [
					{
						type: 'tool_use',
						id: 'tu_check',
						name: 'Bash',
						input: { command: 'pnpm check', description: 'Type-check the change' }
					}
				]
			}
		},
		{
			type: 'user',
			message: {
				content: [
					{
						type: 'tool_result',
						tool_use_id: 'tu_check',
						content:
							'svelte-check found 0 errors and 0 warnings\nDone in 4.1s'
					}
				]
			}
		},
		{
			type: 'assistant',
			message: {
				content: [
					{
						type: 'text',
						text: 'Done. The yolo badge shows in the header whenever the session runs with bypassPermissions, and the type-check is clean.'
					}
				]
			}
		},
		{ type: 'result', subtype: 'success', duration_ms: 18_400, num_turns: 3, total_cost_usd: 0.0123 }
	];
}

// Canned tmux capture for the terminal screenshot (the s_dev session). Carries
// ANSI SGR codes so the colour parser and the Nerd Font prompt glyph both show.
export function demoTerminalText(id: string): string {
	if (id !== 's_dev') return '(no output)';
	const E = '\x1b';
	return [
		`${E}[36m❯${E}[0m pnpm dev`,
		'',
		`${E}[2m> deck@0.0.1 dev${E}[0m`,
		`${E}[2m> vite dev${E}[0m`,
		'',
		`${E}[32m[deck]${E}[0m tailscale serve: ${E}[36mhttps://deck.tailnet.ts.net:4818${E}[0m`,
		'',
		`  ${E}[1m${E}[32mVITE${E}[0m ${E}[2mv8.0.7${E}[0m  ready in 386 ms`,
		'',
		`  ${E}[32m➜${E}[0m  ${E}[1mLocal${E}[0m:   ${E}[36mhttp://localhost:4818/${E}[0m`,
		`  ${E}[32m➜${E}[0m  ${E}[1mNetwork${E}[0m: ${E}[36mhttp://100.100.0.12:4818/${E}[0m`,
		`  ${E}[2m➜  press h + enter to show help${E}[0m`,
		'',
		`${E}[90m12:04:51${E}[0m ${E}[2m[vite]${E}[0m ${E}[36mpage reload${E}[0m src/routes/layout.css`,
		`${E}[90m12:05:03${E}[0m ${E}[2m[vite]${E}[0m hmr update ${E}[36m/src/routes/+layout.svelte${E}[0m`,
		`${E}[90m12:05:09${E}[0m ${E}[2m[vite]${E}[0m hmr update ${E}[36m/src/lib/components/Sidebar.svelte${E}[0m`,
		''
	].join('\n');
}
