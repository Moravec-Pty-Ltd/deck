import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { error } from '@sveltejs/kit';
import type { DeckSession, OperatorSettings } from '$lib/types';
import { isAgentKind } from '$lib/types';
import {
	OPERATOR_TOOLS,
	askAnnouncement,
	conversationWindow,
	matchSessions,
	parseSkillFrontmatter,
	pickOption,
	promptSessions,
	spokenText,
	statusAnnouncement,
	summaryMessages,
	systemPrompt,
	type OperatorSession,
	type OperatorTurn,
	type SkillInfo,
	type ToolCall
} from '$lib/operator-core';
import { dataDir } from './config';
import { listProjects, readSettings } from './store';
import { getSession, listSessions } from './sessions';
import { projectForPath } from './confine';
import { sessionLastResult } from './transcript';
import { sendAgentMessage } from './send-agent-message';
import { answerAsk } from './answer';
import { listPendingAsks } from './ask';
import { agentInterrupt } from './agents/dispatch';
import { createSessionFromRequest } from './create-session';
import { agentFeed, type AgentFeedEvent } from './agent-feed';

// The voice operator: a small model that holds a spoken conversation and
// drives sessions through deck's own functions. The model is any
// OpenAI-compatible chat endpoint named in settings.json (`operator`); the
// conversation is one shared thread for every device, appended to
// ~/.deck/operator.jsonl. While at least one client is listening (the events
// stream), the operator also speaks up on its own about questions, finished
// turns and errors from sessions active since it came on.

export interface OperatorAction {
	tool: string;
	args: Record<string, unknown>;
	result: string;
}

export interface OperatorReply {
	text: string;
	actions: OperatorAction[];
}

export interface Announcement {
	text: string;
	sessionId: string;
	kind: 'ask' | 'turn' | 'status';
	at: number;
}

const LOG_FILE = 'operator.jsonl';
const MAX_ROUNDS = 4;
const TOOL_RESULT_CHARS = 6000;

interface OperatorState {
	turns: OperatorTurn[] | null;
	// Agent sessions that ran a turn, or were acted on, since a client started
	// listening; the only ones announced. Reset when the last listener leaves.
	followed: Set<string>;
	listeners: EventEmitter;
	listenerCount: number;
	wired: boolean;
}

// On globalThis so a dev-server HMR reload keeps the one conversation and
// the one feed subscription (see morabot.ts for the same pattern).
const g = globalThis as { __deckOperator?: OperatorState };
const state: OperatorState = (g.__deckOperator ??= {
	turns: null,
	followed: new Set(),
	listeners: new EventEmitter(),
	listenerCount: 0,
	wired: false
});
state.listeners.setMaxListeners(50);

export function operatorConfig(): OperatorSettings {
	return readSettings().operator ?? {};
}

export function operatorConfigured(): boolean {
	const c = operatorConfig();
	return !!(c.url && c.model);
}

// ---- Conversation log ----

function logPath(): string {
	return path.join(dataDir, LOG_FILE);
}

function loadTurns(): OperatorTurn[] {
	if (state.turns) return state.turns;
	const turns: OperatorTurn[] = [];
	try {
		for (const line of fs.readFileSync(logPath(), 'utf8').split('\n')) {
			if (!line.trim()) continue;
			try {
				turns.push(JSON.parse(line));
			} catch {
				// A torn last line from a crash mid-write: skip it.
			}
		}
	} catch {
		// No log yet.
	}
	state.turns = turns.slice(-200);
	return state.turns;
}

function record(turn: OperatorTurn): void {
	loadTurns().push(turn);
	try {
		fs.appendFileSync(logPath(), JSON.stringify(turn) + '\n');
	} catch (err) {
		console.error('[deck] operator log write failed:', err);
	}
}

export function operatorHistory(limit = 50): OperatorTurn[] {
	return loadTurns().filter((t) => t.role !== 'tool').slice(-limit);
}

export function resetOperator(): void {
	state.turns = [];
	try {
		fs.writeFileSync(logPath(), '');
	} catch (err) {
		console.error('[deck] operator log reset failed:', err);
	}
}

// ---- What the model sees ----

function projectName(cwd: string | undefined): string | undefined {
	const p = cwd ? projectForPath(cwd) : null;
	return p ? listProjects().find((x) => x.path === p)?.name : undefined;
}

function operatorSession(s: DeckSession): OperatorSession & { lastActiveAt?: number } {
	const ask = listPendingAsks().find((a) => a.sessionId === s.id)?.questions[0];
	const project = projectName(s.cwd);
	return {
		id: s.id,
		title: s.title || s.id,
		kind: s.kind,
		status: s.status,
		...(project ? { project } : {}),
		...(s.awaitingInput ? { awaitingInput: true } : {}),
		...(ask ? { ask: { question: ask.question, options: ask.options.map((o) => o.label) } } : {}),
		lastActiveAt: s.lastActiveAt
	};
}

async function currentSessions(): Promise<OperatorSession[]> {
	return promptSessions((await listSessions()).map(operatorSession), Date.now());
}

// Every SKILL.md under ~/.claude/skills and each registered project's
// .claude/skills, by name with its description.
function skillDirs(): { dir: string; scope: string }[] {
	const dirs = [{ dir: path.join(os.homedir(), '.claude', 'skills'), scope: 'global' }];
	for (const p of listProjects()) dirs.push({ dir: path.join(p.path, '.claude', 'skills'), scope: p.name });
	return dirs;
}

function readSkill(file: string, scope: string, fallbackName: string): SkillInfo | null {
	try {
		const meta = parseSkillFrontmatter(fs.readFileSync(file, 'utf8'));
		return { name: meta.name || fallbackName, description: meta.description || '', scope };
	} catch {
		return null;
	}
}

export function skillCatalogue(): SkillInfo[] {
	const skills: SkillInfo[] = [];
	for (const { dir, scope } of skillDirs()) {
		let entries: string[] = [];
		try {
			entries = fs.readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of entries) {
			const skill = readSkill(path.join(dir, name, 'SKILL.md'), scope, name);
			if (skill) skills.push(skill);
		}
	}
	return skills;
}

function skillBody(name: string): string | null {
	for (const { dir } of skillDirs()) {
		try {
			return fs.readFileSync(path.join(dir, name, 'SKILL.md'), 'utf8').slice(0, TOOL_RESULT_CHARS);
		} catch {
			// Not in this dir.
		}
	}
	return null;
}

async function buildSystemPrompt(): Promise<string> {
	return systemPrompt({
		sessions: await currentSessions(),
		skills: skillCatalogue(),
		projects: listProjects().map((p) => p.name),
		now: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
	});
}

// ---- Tools ----

async function agentSessionArg(args: Record<string, unknown>): Promise<DeckSession> {
	const ref = String(args.session_id ?? '');
	const sessions = await listSessions();
	const found = matchSessions(ref, sessions.map(operatorSession));
	if (found.length !== 1) {
		throw new Error(found.length ? `Several sessions match "${ref}": ${found.map((s) => `${s.title} (${s.id})`).join(', ')}. Ask the user which.` : `No session "${ref}". Use an id from list_sessions.`);
	}
	const session = sessions.find((s) => s.id === found[0].id)!;
	if (!isAgentKind(session.kind)) throw new Error(`${session.title} is a shell, not an agent session.`);
	state.followed.add(session.id);
	return session;
}

function answerBody(session: DeckSession, answer: string): Record<string, unknown> {
	const ask = listPendingAsks().find((a) => a.sessionId === session.id);
	const question = ask?.questions[0];
	if (!ask || !question) throw new Error(`${session.title} is not waiting on a question.`);
	const picked = pickOption(answer, question.options.map((o) => o.label));
	const text = picked ?? answer;
	const body: Record<string, unknown> = { text: `Answering your question:\n- ${question.header ?? 'Answer'}: ${text}` };
	if (ask.askId) body.askId = ask.askId;
	if (picked && ask.questions.length === 1) body.answers = [{ header: question.header ?? 'Answer', labels: [picked] }];
	return body;
}

async function startSession(args: Record<string, unknown>): Promise<string> {
	if (args.confirmed !== true) {
		return 'Not started: tell the user the project and the prompt and wait for their yes, then call start_session again with confirmed=true.';
	}
	const name = String(args.project ?? '').toLowerCase();
	const project = listProjects().find((p) => p.name.toLowerCase() === name);
	if (!project) throw new Error(`No project named "${args.project}". Projects: ${listProjects().map((p) => p.name).join(', ')}.`);
	const prompt = String(args.prompt ?? '').trim();
	if (!prompt) throw new Error('A first prompt is required.');
	const title = String(args.title ?? '').trim() || prompt.split(/\s+/).slice(0, 6).join(' ');
	const session = await createSessionFromRequest({
		kind: 'claude',
		cwd: project.path,
		prompt,
		title,
		worktree: { branch: title, newBranch: true }
	});
	state.followed.add(session.id);
	return `Started "${session.title}" (${session.id}) in ${project.name}.`;
}

type ToolHandler = (args: Record<string, unknown>) => Promise<string>;

async function latestReply(args: Record<string, unknown>): Promise<string> {
	const session = await agentSessionArg(args);
	const reply = sessionLastResult(session.id);
	return reply ? reply.slice(0, TOOL_RESULT_CHARS) : `${session.title} has not replied yet.`;
}

async function sendMessage(args: Record<string, unknown>): Promise<string> {
	const session = await agentSessionArg(args);
	await sendAgentMessage(session, { text: String(args.text ?? '') });
	return `Sent to ${session.title}.`;
}

async function answerQuestion(args: Record<string, unknown>): Promise<string> {
	const session = await agentSessionArg(args);
	const body = answerBody(session, String(args.answer ?? ''));
	return answerAsk(session, body) ? `Answered ${session.title}.` : `${session.title} was no longer waiting.`;
}

async function stopSession(args: Record<string, unknown>): Promise<string> {
	const session = await agentSessionArg(args);
	agentInterrupt(session.id);
	return `Stopped ${session.title}.`;
}

const TOOL_HANDLERS: Record<string, ToolHandler> = {
	list_sessions: async () => JSON.stringify((await listSessions()).map(operatorSession).map(({ lastActiveAt: _drop, ...rest }) => rest)),
	latest_reply: latestReply,
	send_message: sendMessage,
	answer_ask: answerQuestion,
	stop_session: stopSession,
	start_session: startSession,
	skill_details: async (args) => skillBody(String(args.name ?? '')) ?? `No skill named "${args.name}".`
};

async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
	const handler = TOOL_HANDLERS[name];
	if (!handler) throw new Error(`Unknown tool ${name}.`);
	return handler(args);
}

// ---- The model ----

interface ModelMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	tool_calls?: ToolCall[];
	tool_call_id?: string;
	name?: string;
}

interface ModelChoice {
	message: { content?: string | null; tool_calls?: ToolCall[] };
}

async function callModel(messages: ModelMessage[], tools: boolean): Promise<ModelChoice['message']> {
	const c = operatorConfig();
	if (!c.url || !c.model) error(503, 'operator model not configured');
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (c.apiKey) headers.authorization = `Bearer ${c.apiKey}`;
	const body: Record<string, unknown> = { model: c.model, messages, temperature: 0.2, max_tokens: 900 };
	if (tools) {
		body.tools = OPERATOR_TOOLS;
		body.tool_choice = 'auto';
	}
	const res = await fetch(`${c.url.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) }).catch((err) => {
		error(502, `operator model unreachable: ${err instanceof Error ? err.message : String(err)}`);
	});
	if (!res.ok) error(502, `operator model replied ${res.status}`);
	const data = (await res.json()) as { choices?: ModelChoice[] };
	return data.choices?.[0]?.message ?? { content: '' };
}

function toModelMessage(turn: OperatorTurn): ModelMessage {
	const m: ModelMessage = { role: turn.role, content: turn.content };
	if (turn.tool_calls) m.tool_calls = turn.tool_calls;
	if (turn.tool_call_id) m.tool_call_id = turn.tool_call_id;
	if (turn.name) m.name = turn.name;
	return m;
}

function parseArgs(call: ToolCall): Record<string, unknown> {
	try {
		const parsed = JSON.parse(call.function.arguments || '{}');
		return parsed && typeof parsed === 'object' ? parsed : {};
	} catch {
		return {};
	}
}

async function executeCalls(calls: ToolCall[], actions: OperatorAction[]): Promise<void> {
	for (const call of calls) {
		const args = parseArgs(call);
		let result: string;
		try {
			result = await runTool(call.function.name, args);
		} catch (err) {
			result = `Error: ${err instanceof Error ? err.message : String(err)}`;
		}
		actions.push({ tool: call.function.name, args, result });
		record({ role: 'tool', content: result, at: Date.now(), tool_call_id: call.id, name: call.function.name });
	}
}

// One user utterance in, one spoken reply out, with whatever tool calls the
// model made in between (bounded so a confused model cannot loop).
export async function operatorChat(text: string, source = 'voice'): Promise<OperatorReply> {
	const trimmed = text.trim();
	if (!trimmed) error(400, 'empty message');
	record({ role: 'user', content: trimmed, at: Date.now(), source });
	const system: ModelMessage = { role: 'system', content: await buildSystemPrompt() };
	const actions: OperatorAction[] = [];
	for (let round = 0; round < MAX_ROUNDS; round++) {
		const messages = [system, ...conversationWindow(loadTurns(), Date.now()).map(toModelMessage)];
		const message = await callModel(messages, true);
		const said = spokenText(message.content);
		const calls = message.tool_calls ?? [];
		if (calls.length === 0) {
			const reply = said || "I didn't catch that.";
			record({ role: 'assistant', content: reply, at: Date.now() });
			return { text: reply, actions };
		}
		record({ role: 'assistant', content: said, at: Date.now(), tool_calls: calls });
		await executeCalls(calls, actions);
	}
	const reply = 'I did what I could, but the model kept going; check the log.';
	record({ role: 'assistant', content: reply, at: Date.now() });
	return { text: reply, actions };
}

// ---- Speaking up on its own ----

export function subscribeAnnouncements(listener: (a: Announcement) => void): () => void {
	state.listeners.on('announcement', listener);
	state.listenerCount++;
	return () => {
		state.listeners.off('announcement', listener);
		state.listenerCount--;
		if (state.listenerCount <= 0) {
			state.listenerCount = 0;
			state.followed.clear();
		}
	};
}

export function operatorListening(): boolean {
	return state.listenerCount > 0;
}

function announce(a: Announcement): void {
	record({ role: 'assistant', content: a.text, at: a.at });
	state.listeners.emit('announcement', a);
}

async function announceTurn(session: DeckSession): Promise<void> {
	const reply = sessionLastResult(session.id);
	if (!reply) return;
	const op = operatorSession(session);
	let text: string;
	try {
		text = spokenText((await callModel(summaryMessages(op, reply), false)).content) || `${op.title} finished a turn.`;
	} catch {
		text = `${op.title} finished a turn.`;
	}
	announce({ text, sessionId: session.id, kind: 'turn', at: Date.now() });
}

function onAwaitingInput(session: DeckSession, event: AgentFeedEvent): void {
	const questions = event.questions as { question: string; options?: { label: string }[] }[] | undefined;
	const q = event.awaitingInput === true ? questions?.[0] : undefined;
	if (!q) return;
	state.followed.add(session.id);
	const text = askAnnouncement(operatorSession(session), q.question, (q.options ?? []).map((o) => o.label));
	announce({ text, sessionId: session.id, kind: 'ask', at: Date.now() });
}

function onStatus(session: DeckSession, event: AgentFeedEvent): void {
	if (!state.followed.has(session.id)) return;
	const text = statusAnnouncement(operatorSession(session), String(event.status));
	if (text) announce({ text, sessionId: session.id, kind: 'status', at: Date.now() });
}

async function onTurnFinished(session: DeckSession): Promise<void> {
	state.followed.add(session.id);
	await announceTurn(session);
}

async function onFeedEvent(event: AgentFeedEvent): Promise<void> {
	if (!operatorListening()) return;
	const session = await getSession(event.sessionId);
	if (!session || !isAgentKind(session.kind)) return;
	if (event.type === 'turn-finished') await onTurnFinished(session);
	else if (event.type === 'awaiting-input') onAwaitingInput(session, event);
	else if (event.type === 'status') onStatus(session, event);
}

if (!state.wired) {
	state.wired = true;
	agentFeed.on('event', (event: AgentFeedEvent) => {
		onFeedEvent(event).catch((err) => console.error('[deck] operator feed handler failed:', err));
	});
}
