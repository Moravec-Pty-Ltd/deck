// The voice operator's pure parts: the tools it may call, the prompt that
// tells the model what deck looks like right now, the conversation window,
// and the wording of what it says on its own. Node-free; server/operator.ts
// wires these to deck's session functions and the model endpoint.

export interface OperatorSession {
	id: string;
	title: string;
	kind: string;
	status: string;
	project?: string;
	awaitingInput?: boolean;
	ask?: { question: string; options: string[] };
}

export interface SkillInfo {
	name: string;
	description: string;
	// 'global' for ~/.claude/skills, else the project the skill belongs to.
	scope: string;
}

// One line of the operator's conversation, in the shape the model API wants
// plus a timestamp for the idle reset and the log. Announcements the operator
// made on its own are assistant turns, so a "yes, the first one" that follows
// has something to refer to.
export interface OperatorTurn {
	role: 'user' | 'assistant' | 'tool';
	content: string;
	at: number;
	tool_calls?: ToolCall[];
	tool_call_id?: string;
	name?: string;
	// Where a user turn came from, for the log.
	source?: string;
}

export interface ToolCall {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

export const HISTORY_TURNS = 20;
export const IDLE_RESET_MS = 30 * 60 * 1000;
// Sessions the prompt carries every turn: the ones needing attention or
// touched in the last day, newest first, capped. The rest are one
// list_sessions call away; a long list of stale shells in every prompt cost
// more time per turn than the reply.
const PROMPT_SESSIONS = 20;
const RECENT_MS = 24 * 60 * 60 * 1000;

export function promptSessions(sessions: (OperatorSession & { lastActiveAt?: number })[], now: number): OperatorSession[] {
	const live = (s: OperatorSession) => s.status === 'running' || s.awaitingInput === true;
	return sessions
		.filter((s) => live(s) || (s.lastActiveAt ?? 0) > now - RECENT_MS)
		.sort((a, b) => Number(live(b)) - Number(live(a)) || (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))
		.slice(0, PROMPT_SESSIONS)
		.map(({ lastActiveAt: _drop, ...rest }) => rest);
}

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({
	type: 'function' as const,
	function: { name, description, parameters: { type: 'object', properties, required } }
});

const sessionId = { type: 'string', description: 'The session id from the sessions list' };

export const OPERATOR_TOOLS = [
	fn('list_sessions', 'The current sessions with status, project, and any question waiting for an answer.', {}),
	fn('latest_reply', "A session's newest reply in full. Summarise it unless the user asked to hear all of it.", { session_id: sessionId }, ['session_id']),
	fn('send_message', "Send an instruction to a session's agent. A skill runs as '/skill-name arguments'.", { session_id: sessionId, text: { type: 'string' } }, ['session_id', 'text']),
	fn('answer_ask', "Answer the question a session is waiting on, with an option's label or free text.", { session_id: sessionId, answer: { type: 'string' } }, ['session_id', 'answer']),
	fn('stop_session', "Interrupt a session's current turn.", { session_id: sessionId }, ['session_id']),
	fn(
		'start_session',
		"Start a new claude session in a project on its own branch. Creates a worktree, so first tell the user the project and prompt and wait for a yes; only then call with confirmed=true. A skill runs as '/skill-name arguments' in the prompt.",
		{
			project: { type: 'string', description: 'A registered project name' },
			prompt: { type: 'string', description: 'The first message to the agent' },
			title: { type: 'string', description: 'A short title, a few words' },
			confirmed: { type: 'boolean', description: 'True only after the user agreed to this exact session' }
		},
		['project', 'prompt', 'confirmed']
	),
	fn('skill_details', 'What a skill does, from its SKILL.md, when the user asks about it.', { name: { type: 'string' } }, ['name'])
];

// Stable parts first (rules, skills) and the parts that change every turn
// (sessions, time) last, so a model server that caches a prompt's common
// prefix skips re-reading the catalogue each time. Descriptions are cut to
// their first sentence: with a hundred skills the full texts would cost more
// prompt time per turn than the reply.
export function systemPrompt(ctx: { sessions: OperatorSession[]; skills: SkillInfo[]; projects: string[]; now: string }): string {
	return [
		"You are deck's voice operator. deck runs coding agents (claude and others) in sessions on the user's machine; the user is hands-free and hears you through text to speech.",
		'Rules: reply in one or two short spoken sentences, plain text, no markdown, no lists. Act with the tools rather than describing what you would do. Refer to sessions by their titles when speaking and by id when calling tools; never invent an id. If more than one session could be meant, ask which. Never say ids or field names aloud. Read a reply in full only when asked to hear all of it; otherwise give its gist in a sentence. Before start_session, say what you would start and wait for agreement.',
		`Skills the user can run (say "run <skill> ..." to use one): ${ctx.skills.map((s) => `${s.name} (${s.scope}): ${shortDescription(s.description)}`).join(' | ') || 'none'}`,
		`Projects: ${ctx.projects.join(', ') || 'none'}.`,
		`Sessions: ${JSON.stringify(ctx.sessions)}`,
		`Time: ${ctx.now}.`
	].join('\n');
}

const DESCRIPTION_CHARS = 120;

export function shortDescription(description: string): string {
	const first = description.split(/(?<=[.!?])\s/)[0].trim();
	return first.length > DESCRIPTION_CHARS ? `${first.slice(0, DESCRIPTION_CHARS - 1).trimEnd()}…` : first;
}

// The conversation the model sees: nothing from before a silence longer than
// the idle reset, and at most the newest HISTORY_TURNS turns, cut on a user
// turn so no tool result arrives without its call.
export function conversationWindow(turns: OperatorTurn[], now: number): OperatorTurn[] {
	let start = 0;
	for (let i = 1; i < turns.length; i++) {
		if (turns[i].at - turns[i - 1].at > IDLE_RESET_MS) start = i;
	}
	if (turns.length && now - turns[turns.length - 1].at > IDLE_RESET_MS) return [];
	let window = turns.slice(start);
	if (window.length > HISTORY_TURNS) {
		window = window.slice(-HISTORY_TURNS);
		const firstUser = window.findIndex((t) => t.role === 'user');
		window = firstUser > 0 ? window.slice(firstUser) : window;
	}
	return window;
}

// `name` and `description` from a SKILL.md's frontmatter.
export function parseSkillFrontmatter(markdown: string): { name?: string; description?: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
	if (!match) return {};
	const out: { name?: string; description?: string } = {};
	for (const line of match[1].split(/\r?\n/)) {
		const m = /^(name|description):\s*(.*)$/.exec(line);
		if (m) out[m[1] as 'name' | 'description'] = m[2].trim().replace(/^["']|["']$/g, '');
	}
	return out;
}

// Sessions a spoken reference could mean: an exact id, else every session
// whose title contains all the words said.
export function matchSessions(reference: string, sessions: OperatorSession[]): OperatorSession[] {
	const exact = sessions.find((s) => s.id === reference);
	if (exact) return [exact];
	const words = reference.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return [];
	return sessions.filter((s) => {
		const title = s.title.toLowerCase();
		return words.every((w) => title.includes(w));
	});
}

// Numbered so a spoken answer can name an option by its number.
export function askAnnouncement(session: OperatorSession, question: string, options: string[]): string {
	const listed = options.map((o, i) => `${i + 1}, ${o}`).join('. ');
	return `${session.title} is asking: ${question}${listed ? ` Options: ${listed}.` : ''}`;
}

export function statusAnnouncement(session: OperatorSession, status: string): string | null {
	if (status === 'error') return `${session.title} hit an error.`;
	if (status === 'dead') return `${session.title} has died.`;
	return null;
}

// The message asking the model for the one-sentence summary of a finished turn.
export function summaryMessages(session: OperatorSession, reply: string): { role: 'system' | 'user'; content: string }[] {
	return [
		{ role: 'system', content: "Summarise the coding agent's reply below in one short spoken sentence for a hands-free user, naming the session. Plain text, no markdown, no preamble." },
		{ role: 'user', content: `The session "${session.title}" replied:\n${reply.slice(0, 6000)}` }
	];
}

// Qwen-style thinking that a server did not strip, and a reply that is empty
// once it is gone.
export function spokenText(content: string | null | undefined): string {
	return (content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// A spoken option pick: the option whose label the answer names, or whose
// number it says ("two", "option 2", "the second one"); else the free text.
const ORDINALS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const POSITIONS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth'];

export function pickOption(answer: string, options: string[]): string | null {
	const said = answer.trim().toLowerCase();
	const exact = options.find((o) => o.toLowerCase() === said);
	if (exact) return exact;
	const contained = options.filter((o) => said.includes(o.toLowerCase()));
	if (contained.length === 1) return contained[0];
	const digit = /\b(\d)\b/.exec(said);
	const index = digit
		? Number(digit[1]) - 1
		: Math.max(ORDINALS.findIndex((w) => new RegExp(`\\b${w}\\b`).test(said)), POSITIONS.findIndex((w) => said.includes(w)));
	return index >= 0 && index < options.length ? options[index] : null;
}
