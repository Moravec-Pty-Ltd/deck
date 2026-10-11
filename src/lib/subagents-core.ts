// What each subagent of a session is doing, folded from the `system` task
// events claude streams: task_started when an Agent call launches one (or a
// SendMessage resumes it), task_progress as it works, task_updated /
// task_notification when it ends, and background_tasks_changed with the full
// list of background work still running. Node-free: the server folds a whole
// transcript into this for the snapshot (so a card or the agents bar is right
// even when the launching call is far back in history), and the client keeps
// folding live events on top.

export type AgentStatus = 'running' | 'completed' | 'failed' | 'stopped';

export interface AgentState {
	taskId: string;
	// The Agent call that launched it. A resumed agent keeps its first call, which
	// is the card its steps are filed under.
	toolUseId: string;
	// Absolute transcript index of the event holding that call, when known, so the
	// agents bar can jump to the card even if it isn't loaded yet.
	callIndex: number | null;
	description: string;
	subagentType: string;
	background: boolean;
	status: AgentStatus;
	// What it is doing right now ("Reading BRIEF.md"), from the latest progress.
	activity: string;
	tokens: number;
	toolUses: number;
	durationMs: number;
	// Its final report, from task_notification. A background agent's call result
	// is only "launched", so this is the only place its answer lands.
	summary: string;
	// The report was left out of this copy to keep it small (see withoutOldReports).
	reportOmitted?: boolean;
	// Whether a background_tasks_changed list has named it, so its absence from a
	// later list means it ended (and not that the list predates it).
	listed: boolean;
}

export interface AgentsState {
	tasks: Record<string, AgentState>;
	// Launching call id -> task id.
	byCall: Record<string, string>;
	// Agent call id -> absolute index of its event, for calls whose task_started
	// has not arrived yet.
	callIndex: Record<string, number>;
}

type AnyEvent = Record<string, any>;

export function emptyAgents(): AgentsState {
	return { tasks: {}, byCall: {}, callIndex: {} };
}

// A report is shown in full on its card; past this it is cut so one runaway
// agent can't bloat every snapshot of the session.
const MAX_SUMMARY = 20_000;

const ENDED: Record<string, AgentStatus> = {
	completed: 'completed',
	failed: 'failed',
	killed: 'stopped',
	stopped: 'stopped',
	cancelled: 'stopped'
};

function isAgentTask(event: AnyEvent): boolean {
	return event.task_type === 'local_agent' || (!event.task_type && typeof event.subagent_type === 'string');
}

function str(v: unknown): string {
	return typeof v === 'string' ? v : '';
}

function onStarted(state: AgentsState, event: AnyEvent): void {
	if (!isAgentTask(event) || typeof event.task_id !== 'string') return;
	const call = str(event.tool_use_id);
	const prev = state.tasks[event.task_id];
	if (prev) {
		// Resumed (SendMessage): same agent, same card, running again.
		Object.assign(prev, { status: 'running', activity: '', summary: '' });
		if (event.description) prev.description = event.description;
		if (call && !state.byCall[call]) state.byCall[call] = prev.taskId;
		return;
	}
	state.tasks[event.task_id] = {
		taskId: event.task_id,
		toolUseId: call,
		callIndex: call in state.callIndex ? state.callIndex[call] : null,
		description: str(event.description),
		subagentType: str(event.subagent_type),
		background: event.is_backgrounded === true,
		status: 'running',
		activity: '',
		tokens: 0,
		toolUses: 0,
		durationMs: 0,
		summary: '',
		listed: false
	};
	if (call) state.byCall[call] = event.task_id;
}

function onProgress(task: AgentState, event: AnyEvent): void {
	if (event.description) task.activity = event.description;
	onUsage(task, event);
}

// Progress reports and the final notification both carry running totals.
function onUsage(task: AgentState, event: AnyEvent): void {
	const u = event.usage;
	if (u && typeof u === 'object') {
		if (typeof u.total_tokens === 'number') task.tokens = u.total_tokens;
		if (typeof u.tool_uses === 'number') task.toolUses = u.tool_uses;
		if (typeof u.duration_ms === 'number') task.durationMs = u.duration_ms;
	}
}

function onEnded(task: AgentState, status: unknown, summary?: unknown): void {
	const s = ENDED[str(status)];
	if (s) {
		task.status = s;
		task.activity = '';
	}
	if (typeof summary === 'string' && summary) task.summary = summary.slice(0, MAX_SUMMARY);
}

// background_tasks_changed carries every background task still running. An
// agent it named before and now leaves out has ended, even if the end event
// never came (the process was torn down mid-run).
function onBackgroundList(state: AgentsState, event: AnyEvent): void {
	if (!Array.isArray(event.tasks)) return;
	const running = new Set(event.tasks.map((t: AnyEvent) => t?.task_id));
	for (const task of Object.values(state.tasks)) {
		if (running.has(task.taskId)) task.listed = true;
		else if (task.listed && task.status === 'running') task.status = 'stopped';
	}
}

const SYSTEM_HANDLERS: Record<string, (state: AgentsState, event: AnyEvent, task: AgentState | undefined) => void> = {
	task_started: (state, event) => onStarted(state, event),
	task_progress: (_s, event, task) => task && onProgress(task, event),
	task_updated: (_s, event, task) => task && onEnded(task, event.patch?.status),
	task_notification: (_s, event, task) => {
		if (!task) return;
		onEnded(task, event.status, event.summary);
		onUsage(task, event);
	},
	background_tasks_changed: (state, event) => onBackgroundList(state, event)
};

function onSystem(state: AgentsState, event: AnyEvent): void {
	const handler = SYSTEM_HANDLERS[event.subtype];
	if (handler) handler(state, event, typeof event.task_id === 'string' ? state.tasks[event.task_id] : undefined);
}

// Remember where Agent calls sit, so the agents bar can jump to a card that
// hasn't been loaded yet.
function isAgentCall(block: AnyEvent): boolean {
	return block?.type === 'tool_use' && (block.name === 'Agent' || block.name === 'Task') && typeof block.id === 'string';
}

function onAssistant(state: AgentsState, event: AnyEvent, index: number | null): void {
	const content = event.message?.content;
	if (index === null || !Array.isArray(content)) return;
	for (const block of content.filter(isAgentCall)) {
		state.callIndex[block.id] = index;
		const task = agentForCall(state, block.id);
		if (task && task.callIndex === null) task.callIndex = index;
	}
}

// A foreground agent finishes inside its turn, so one still running when the
// main thread's turn ends was cut off.
function onTurnEnd(state: AgentsState): void {
	for (const task of Object.values(state.tasks)) {
		if (!task.background && task.status === 'running') task.status = 'stopped';
	}
}

// Fold one transcript event in place. `index` is its absolute transcript index
// when the caller knows it.
export function foldAgents(state: AgentsState, event: AnyEvent, index: number | null = null): AgentsState {
	if (!event || typeof event !== 'object') return state;
	if (event.type === 'system') onSystem(state, event);
	else if (event.type === 'assistant' && !event.parent_tool_use_id) onAssistant(state, event, index);
	else if (event.type === 'result' && !event.parent_tool_use_id) onTurnEnd(state);
	else if (event.type === 'deck.restart') stopAll(state);
	return state;
}

// Every running agent ended without telling us: deck restarted claude, or the
// process exited while they ran.
export function stopAll(state: AgentsState): void {
	for (const task of Object.values(state.tasks)) if (task.status === 'running') task.status = 'stopped';
}

export function agentForCall(state: AgentsState, toolUseId: string): AgentState | undefined {
	const taskId = state.byCall[toolUseId];
	return taskId ? state.tasks[taskId] : undefined;
}

// Running agents, oldest first (insertion order of their first start).
export function runningAgents(state: AgentsState): AgentState[] {
	return Object.values(state.tasks).filter((t) => t.status === 'running');
}

// A background agent's call result is a launch receipt, not an answer.
export function isLaunchReceipt(text: string): boolean {
	return /^Async agent launched/.test(text.trimStart());
}

// Lines worth parsing when folding a raw transcript file: cheap substring tests
// that every event foldAgents reads passes.
export function mayAffectAgents(line: string): boolean {
	return (
		line.includes('"task_') ||
		line.includes('"background_tasks_changed"') ||
		line.includes('"deck.restart"') ||
		line.includes('"type":"result"') ||
		(line.includes('"tool_use"') && (line.includes('"Agent"') || line.includes('"Task"')))
	);
}

// A copy without the reports of finished agents launched before `start`: their
// cards aren't loaded yet, and in a long session the reports add up to more
// than the recent history itself. The client fetches them if it scrolls back.
export function withoutOldReports(state: AgentsState, start: number): AgentsState {
	const tasks: Record<string, AgentState> = {};
	for (const [id, t] of Object.entries(state.tasks)) {
		const old = t.status !== 'running' && (t.callIndex === null || t.callIndex < start);
		tasks[id] = old && t.summary ? { ...t, summary: '', reportOmitted: true } : { ...t };
	}
	return { tasks, byCall: { ...state.byCall }, callIndex: { ...state.callIndex } };
}

// Fill in reports a slim copy left out, from a full copy.
export function mergeReports(state: AgentsState, full: AgentsState): void {
	for (const [id, t] of Object.entries(state.tasks)) {
		const f = full.tasks[id];
		if (t.reportOmitted && f) {
			t.summary = f.summary;
			t.reportOmitted = false;
		}
	}
}

export function hasOmittedReports(state: AgentsState): boolean {
	return Object.values(state.tasks).some((t) => t.reportOmitted);
}

export function formatDuration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}
