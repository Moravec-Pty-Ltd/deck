<script lang="ts">
	import { tick, untrack, type Snippet } from 'svelte';
	import { MediaQuery, SvelteMap, SvelteSet } from 'svelte/reactivity';
	import type { DeckSession, Project } from '$lib/types';
	import { indexForward, indexOlderBatch, type Answer } from '$lib/transcript-index';
	import {
		emptyCostSummary,
		foldResult,
		formatCostSummary,
		type CostSummary
	} from '$lib/session-cost-core';
	import { emptyContext, foldContext, type ContextUsage } from '$lib/context-core';
	import ContextMeter from './ContextMeter.svelte';
	import { modelLabel } from '$lib/models';
	import { effortLabel } from '$lib/effort';
	import MessageBubble from './MessageBubble.svelte';
	import Markdown from './Markdown.svelte';
	import ToolCall from './ToolCall.svelte';
	import ToolRun from './ToolRun.svelte';
	import AskQuestion from './AskQuestion.svelte';
	import QuickMessages from './QuickMessages.svelte';
	import { sessionProjectId } from '$lib/quick-messages-core';
	import Modal from './Modal.svelte';
	import SkillPicker from './SkillPicker.svelte';
	import VoiceBar from './VoiceBar.svelte';
	import { VoiceSession } from '$lib/voice.svelte';
	import { agentGet, agentPost, sessionPath } from '$lib/agent-api';
	import { Send, Square, ChevronDown, ArrowDown, Paperclip, X, ArrowLeftRight, AudioLines, FileText } from '@lucide/svelte';
	import { admitUploads, formatBytes, isInlineImage } from '$lib/upload-core';
	import {
		isCrossSession,
		isEmptyDraft,
		nextOrigin,
		parseDraft,
		serializeDraft,
		type Draft
	} from '$lib/composer-draft-core';
	import { haptic } from '$lib/haptics';
	import {
		chunkKeyFor,
		flattenTranscript,
		groupRuns,
		isAskTool,
		launchersOf,
		nestSubagents,
		windowStart,
		parentOf,
		ungrouped,
		type Chunk,
		type Row
	} from '$lib/transcript-groups';
	import ActivityList from './ActivityList.svelte';
	import type { SessionView } from '$lib/session-view';
	import {
		agentForCall,
		emptyAgents,
		foldAgents,
		hasOmittedReports,
		mergeReports,
		runningAgents,
		stopAll,
		type AgentState,
		type AgentsState
	} from '$lib/subagents-core';

	// `visible` is false while the transcript sits behind the Changes/Servers tabs
	// (the page keeps it mounted but display:none). A hidden scroller has no layout,
	// so we pause scroll bookkeeping and re-pin once it's shown again.
	// `condensed` is the Chat tab: the same transcript with each run of tool calls
	// collapsed to one line. Thread passes false and renders every row.
	// `focusIndex` is an absolute event index to open at (a search hit): older
	// history is pulled in until it is loaded, then it is scrolled to once.
	let {
		session,
		sessions = [],
		projects = [],
		visible = true,
		condensed = false,
		controls,
		flatActions,
		focusIndex = null,
		persistDraft: persist = true
	}: {
		session: DeckSession;
		sessions?: (DeckSession & Pick<SessionView, 'watches'>)[];
		projects?: Project[];
		visible?: boolean;
		condensed?: boolean;
		controls?: Snippet;
		// Shown above the composer on the flat half of a tabletop fold (the PR actions).
		flatActions?: Snippet;
		focusIndex?: number | null;
		// False for a second pane on screen: its draft stays in memory so it never
		// reads or fights over the one global localStorage draft.
		persistDraft?: boolean;
	} = $props();

	// A single global composer draft, persisted so a cold reload / iOS PWA relaunch
	// restores it. Restored once at init (this component isn't remounted on session
	// switch, so the draft carries across switches — see the session $effect below).
	const DRAFT_KEY = 'deck:composer:draft';
	const restored =
		persist && typeof localStorage !== 'undefined' ? parseDraft(localStorage.getItem(DRAFT_KEY)) : null;

	type AnyEvent = Record<string, any>;

	let events = $state<AnyEvent[]>([]);

	// Half open on a table (Chromium's Viewport Segments API): the transcript
	// stands on the top segment and the open question moves down to the flat one
	// with the composer, as the iPhone app does. Never matches elsewhere.
	const tabletop = new MediaQuery('(vertical-viewport-segments: 2)', false);
	// The open question: the latest top-level ask, unanswered, with no turn end
	// after it, while the server still holds it open (an aborted ask leaves
	// neither an answer nor always a result behind).
	const pendingAsk = $derived.by(() => {
		if (!tabletop.current || !sessions.find((s) => s.id === session.id)?.awaitingInput) return null;
		for (let i = events.length - 1; i >= 0; i--) {
			const ev = events[i];
			if (ev.type === 'result') return null;
			if (ev.type !== 'assistant' || parentOf(ev)) continue;
			const ask = (ev.message?.content ?? []).findLast(
				(b: Record<string, any>) => b.type === 'tool_use' && isAskTool(b)
			);
			if (ask) return answeredQuestions.has(ask.id) ? null : ask;
		}
		return null;
	});
	// Session-level cost/turns/duration total. Seeded from the snapshot's
	// server-computed base (the recent-history window can't hold every result of a
	// long session), then extended as live results stream in.
	let cost = $state<CostSummary>(emptyCostSummary());
	// How full the context window is, seeded and extended the same way as `cost`:
	// a server-computed base from the snapshot, then live events folded on top.
	let context = $state<ContextUsage>(emptyContext());
	let status = $state<string>(session.status);
	let liveText = $state('');
	// Identity of the current live stream, bumped each assistant message so the
	// streaming Markdown renderer resets its buffer between turns (the live bubble
	// is one recycled instance, not a per-message node).
	let liveTurn = $state(0);
	let input = $state(restored?.text ?? '');
	let scroller: HTMLDivElement | undefined = $state();
	let fileInput: HTMLInputElement | undefined = $state();
	let atBottom = $state(true);
	// Last scrollTop recorded while the pane was visible. The browser clamps a
	// hidden scroller's scrollTop to 0 and doesn't restore it, so we replay this
	// for a reader who had scrolled up when the Chat tab comes back into view.
	let savedScrollTop = 0;
	let dragging = $state(false);
	let connected = $state(true);
	let loaded = $state(false);

	type Attachment = { media_type: string; data: string; url: string };
	let attachments = $state<Attachment[]>(restored?.attachments ?? []);
	// Everything the model can't be handed inline goes through the upload route
	// and is read from disk. Held as File, not base64, and never persisted with
	// the draft: these can be 25 MB each.
	let uploads = $state<File[]>([]);
	let uploadError = $state('');
	// The session the draft was started in (null when empty); drives the "from:"
	// chip and the confirm-on-send guard when it differs from the viewed session.
	let originSessionId = $state<string | null>(restored?.originSessionId ?? null);
	let pendingSend = $state(false);

	// Render only the tail at first, then widen the window in the background so
	// opening a long session paints immediately instead of mounting thousands of
	// nodes up front. `start` is the absolute index of the first rendered event,
	// which we also use as the keyed-each key so widening reuses existing nodes.
	const INITIAL_WINDOW = 60;
	const HYDRATE_CHUNK = 250;
	let limit = $state(INITIAL_WINDOW);
	// Absolute index of events[0]. The snapshot only carries recent history;
	// `baseIndex > 0` means older events live on the server and can be lazily
	// pulled in via /transcript. Keyed-each uses baseIndex+start+i (an event's
	// stable absolute index) so prepending older rows still reuses nodes.
	let baseIndex = $state(0);
	// Every subagent of the session: seeded from the snapshot (folded over the
	// whole transcript on the server) and kept current from live events.
	let agents = $state<AgentsState>(emptyAgents());
	// When each agent last reported, and when one just finished, by task id: the
	// agents bar counts elapsed time from the first and lingers on the second.
	let agentSeen = $state<Record<string, number>>({});
	let agentDone = $state<Record<string, number>>({});
	const AGENT_LINGER_MS = 6000;
	// Ticks while any agent runs, so elapsed times count up between reports.
	let agentClock = $state(Date.now());
	$effect(() => {
		if (!runningAgents(agents).length) return;
		const t = setInterval(() => (agentClock = Date.now()), 1000);
		return () => clearInterval(t);
	});
	function agentElapsed(a: AgentState): number {
		const since = agentSeen[a.taskId];
		return a.durationMs + (a.status === 'running' && since ? Math.max(0, agentClock - since) : 0);
	}
	const barAgents = $derived([
		...runningAgents(agents),
		...Object.values(agents.tasks).filter((t) => t.status !== 'running' && agentDone[t.taskId])
	]);
	const start = $derived(Math.max(0, events.length - limit));
	const visibleEvents = $derived(events.slice(start));

	// What the window actually paints, flattened across events so a run of tool
	// calls can be grouped even though each call arrives as its own event. A
	// subagent's rows sit inside the card of the call that launched it.
	const thread = $derived(nestSubagents(flattenTranscript(visibleEvents, baseIndex + start)));
	const layout = (rows: Row[]): Chunk[] => (condensed ? groupRuns(rows) : ungrouped(rows));
	const chunks = $derived(layout(thread.rows));
	// Runs and subagent cards the reader has opened, by run key or the launching
	// call's id. Only for as long as the session view is open.
	const openRuns = new SvelteSet<string>();

	// Size the window by what's actually on screen, not by raw event count:
	// condensing a window of 60 events can leave two lines, and in Thread a busy
	// session's recent history can be all subagent steps held back until their
	// card loads, so either would otherwise open near-empty with nothing to scroll
	// and so no way to ask for more. While
	// the transcript is shorter than its scroller, keep widening over loaded events
	// and then pulling older history. Capped: a turn that condenses to almost
	// nothing shouldn't drag a whole session's history in behind one tab click.
	const MAX_FILL_PULLS = 4;
	let fillPulls = 0;
	$effect(() => {
		chunks; // re-check whenever what's rendered changes
		if (!loaded || !visible || fillPulls >= MAX_FILL_PULLS) return;
		tick().then(() => {
			if (!scroller || scroller.scrollHeight > scroller.clientHeight + 1) return;
			if (limit < events.length) void growWindow(HYDRATE_CHUNK);
			else if (!loadingOlder && baseIndex > 0) {
				// Count the pull only when one actually starts: a fetch in flight would
				// otherwise burn the budget on re-entries that loadOlder drops.
				fillPulls += 1;
				void loadOlder();
			}
		});
	});

	// Two lookups the template needs while rendering the visible window:
	//   resultsById       — tool_use_id → its tool_result block (ToolCall)
	//   answeredQuestions  — ask tool_use id → the chosen answers (AskQuestion)
	// Questions go through deck's blocking MCP `ask` tool; the pick is posted to
	// /answer, which resolves the still-open tool call (continuing the same turn)
	// and records a deck.answer marker so the chosen options persist on reload.
	//
	// Maintained incrementally as events arrive rather than re-derived over the
	// whole transcript on every event: a long, hydrated session would otherwise
	// re-scan thousands of events twice per streamed event. `$lib/transcript-index`
	// holds what each event contributes; we fold those into reactive maps here.
	const resultsById = new SvelteMap<string, AnyEvent>();
	const answeredQuestions = new SvelteMap<string, Answer[]>();
	const index = { results: resultsById, answered: answeredQuestions };

	function clearIndex() {
		resultsById.clear();
		answeredQuestions.clear();
	}

	// Rebuild both maps from a full list (a fresh snapshot replaces the transcript).
	function reindex(list: AnyEvent[]) {
		clearIndex();
		for (const ev of list) indexForward(index, ev);
	}

	async function answerQuestion(
		id: string,
		text: string,
		answers: { header: string; labels: string[] }[]
	) {
		atBottom = true;
		await agentPost(sessionPath(session.id, 'answer'), { text, askId: id, answers }).catch(() => {});
	}

	// Voice mode: reads new replies and questions aloud and sends what you say,
	// through deck's speech proxies. One controller per mounted view; it follows
	// the session switch below (a reply from the previous session must not be
	// read into this one) and hides itself when no speech server is configured.
	const voice = new VoiceSession({
		send: async (text) => {
			atBottom = true;
			await agentPost(sessionPath(session.id, 'message'), { text, voice: true }).catch(() => {});
		},
		answer: answerQuestion,
		interrupt: () => interrupt()
	});
	$effect(() => {
		void voice.loadCapabilities();
		return () => voice.destroy();
	});
	const voiceAvailable = $derived(!!voice.capabilities?.tts);
	$effect(() => {
		voice.turnRunning = status === 'running';
	});

	function toggleVoice() {
		if (voice.enabled) voice.disable();
		else void voice.enable();
	}

	// What a live event means for the reader: each assistant text block (or the
	// question it asks), the turn's end, and an answer that closes a question.
	function voiceHear(ev: AnyEvent) {
		if (!voice.enabled || parentOf(ev)) return;
		if (ev.type === 'assistant') {
			for (const block of ev.message?.content ?? []) {
				if (block.type === 'text' && block.text?.trim()) voice.onAssistantText(block.text);
				else if (block.type === 'tool_use' && isAskTool(block)) voice.onAsk(block.id, block.input?.questions ?? []);
			}
		} else if (ev.type === 'result') {
			voice.onTurnFinished();
		} else if (ev.answersFor) {
			voice.onAskAnswered(ev.answersFor);
		}
	}

	// One subscription per session. The body depends only on session.id, so it
	// re-runs exactly when the viewed session changes — never on its own writes.
	$effect(() => {
		const id = session.id;

		// Clear the previous session synchronously so its history and live stream
		// can't bleed into this one while the new snapshot is in flight.
		untrack(() => voice.disable());
		events = [];
		cost = emptyCostSummary();
		context = emptyContext();
		clearIndex();
		openRuns.clear();
		fillPulls = 0;
		baseIndex = 0;
		limit = INITIAL_WINDOW;
		agents = emptyAgents();
		agentSeen = {};
		agentDone = {};
		liveText = '';
		loaded = false;
		status = session.status;

		let source: EventSource | null = null;
		let retry: ReturnType<typeof setTimeout> | undefined;
		let stopped = false;

		const connect = () => {
			clearTimeout(retry);
			source?.close();
			const es = new EventSource(sessionPath(id, 'stream'));
			source = es;
			// Recent history arrives as several small frames (the server can't push
			// one big frame reliably). Reassemble the serialized payload by `seq`,
			// then parse once. `seq === 0` resets the buffer, so a reconnect replaces
			// the array rather than re-appending the whole transcript.
			let snapBuf = '';
			es.addEventListener('snapshot', async (e) => {
				connected = true;
				let frame: { seq: number; n: number; data: string };
				try {
					frame = JSON.parse((e as MessageEvent).data);
				} catch {
					return;
				}
				if (stopped) return;
				if (frame.seq === 0) snapBuf = '';
				snapBuf += frame.data;
				if (frame.seq + 1 < frame.n) return; // wait for the rest
				let snap: {
					start: number;
					events: AnyEvent[];
					cost?: CostSummary;
					context?: ContextUsage;
					agents?: AgentsState;
				};
				try {
					snap = JSON.parse(snapBuf);
				} catch {
					return;
				}
				snapBuf = '';
				events = snap.events;
				cost = snap.cost ?? emptyCostSummary();
				context = snap.context ?? emptyContext();
				reindex(snap.events);
				baseIndex = snap.start;
				limit = snap.events.length - windowStart(snap.events, INITIAL_WINDOW);
				agents = snap.agents ?? emptyAgents();
				const seen = Date.now();
				agentSeen = Object.fromEntries(runningAgents(agents).map((a) => [a.taskId, seen]));
				liveText = '';
				loaded = true;
				await tick();
				// Behind another tab the scroller has no layout, so forcing scroll here
				// would only flip atBottom and lose a scrolled-up reader's place on a
				// background reconnect. Defer to the visibility effect; hydrateRest
				// self-defers while hidden.
				if (visible) forceScroll();
				hydrateRest();
				if (focusIndex !== null && !focused) void focusEvent(focusIndex);
			});
			es.addEventListener('transcript', (e) => {
				const ev = JSON.parse((e as MessageEvent).data);
				if (ev.type === 'stream_event') {
					handleStream(ev);
					return;
				}
				if (ev.type === 'assistant' && !parentOf(ev)) liveText = '';
				if (ev.type === 'result') cost = foldResult(cost, ev);
				context = foldContext(context, ev);
				trackAgents(ev, baseIndex + events.length);
				events.push(ev); // in-place: a full re-spread is O(n) on every event
				indexForward(index, ev);
				limit += 1; // keep the new event in view without dropping a tail row
				voiceHear(ev);
				maybeScroll();
			});
			es.addEventListener('status', (e) => {
				status = JSON.parse((e as MessageEvent).data);
				if (status !== 'running') liveText = '';
			});
			// The claude process exited, taking any subagent still running with it.
			es.addEventListener('exit', () => trackAgents(null, null));
			es.addEventListener('ping', () => (connected = true));
			es.onopen = () => (connected = true);
			es.onerror = () => {
				connected = false;
				// EventSource retries on its own while CONNECTING; only step in once
				// it has actually given up (CLOSED), e.g. a hard network drop.
				if (!stopped && es.readyState === EventSource.CLOSED) retry = setTimeout(connect, 2000);
			};
		};

		// A backgrounded tab (mobile/PWA) often loses its socket without firing an
		// error, so the stream silently stalls and nothing comes back. Re-open when
		// the tab is shown again or the network returns, if the socket isn't open.
		const wake = () => {
			if (document.visibilityState === 'visible' && source?.readyState !== EventSource.OPEN) {
				connect();
			}
		};
		document.addEventListener('visibilitychange', wake);
		window.addEventListener('online', wake);

		connect();

		return () => {
			stopped = true;
			clearTimeout(retry);
			document.removeEventListener('visibilitychange', wake);
			window.removeEventListener('online', wake);
			source?.close();
		};
	});

	// Fold an event into the agents (null: the process exited), noting which
	// agents just reported and which just finished.
	function trackAgents(ev: AnyEvent | null, index: number | null) {
		const before = runningAgents(agents).map((a) => a.taskId);
		if (ev) foldAgents(agents, ev, index);
		else stopAll(agents);
		const now = Date.now();
		if (ev?.type === 'system' && typeof ev.task_id === 'string' && agents.tasks[ev.task_id]) agentSeen[ev.task_id] = now;
		for (const id of before) {
			if (agents.tasks[id]?.status === 'running') continue;
			agentDone[id] = now;
			setTimeout(() => {
				if (agentDone[id] === now) delete agentDone[id];
			}, AGENT_LINGER_MS);
		}
	}

	// Older cards come into view: fetch the reports the snapshot left out, once.
	let reportsFetch: Promise<void> | null = null;
	function fetchOmittedReports() {
		if (reportsFetch || !hasOmittedReports(agents)) return;
		const id = session.id;
		reportsFetch = fetch(`/api/sessions/${encodeURIComponent(id)}/agents`)
			.then((res) => (res.ok ? res.json() : null))
			.then((full: AgentsState | null) => {
				if (full && id === session.id) mergeReports(agents, full);
			})
			.catch(() => {})
			.finally(() => (reportsFetch = null));
	}

	// Open an agent's card and bring it into view, loading older history if the
	// call that launched it is further back than what's loaded.
	async function jumpToAgent(agent: AgentState) {
		openRuns.add(agent.toolUseId);
		if (agent.callIndex !== null) await focusEvent(agent.callIndex);
	}

	function handleStream(ev: AnyEvent) {
		if (parentOf(ev)) return; // the live bubble is the main thread's
		const t = ev.event?.type;
		if (t === 'message_start') {
			liveText = '';
			liveTurn += 1;
		} else if (t === 'content_block_delta' && ev.event.delta?.type === 'text_delta') {
			liveText += ev.event.delta.text;
			maybeScroll();
		}
	}

	function onScroll() {
		// While hidden the scroller has no layout and scrollTop clamps to 0; ignore
		// those events so atBottom can't flip and no history is fetched behind a tab.
		if (!scroller || !visible) return;
		savedScrollTop = scroller.scrollTop;
		measureBottom();
		// Scrolling toward the top: widen the window over loaded rows, then pull
		// older history from the server once the loaded slice is exhausted.
		if (scroller.scrollTop < 400) {
			if (limit < events.length) hydrateRest();
			else loadOlder();
		}
	}

	function measureBottom() {
		if (!scroller) return;
		atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
	}

	function maybeScroll() {
		if (atBottom) queueMicrotask(() => scroller?.scrollTo({ top: scroller.scrollHeight }));
	}

	function forceScroll() {
		scroller?.scrollTo({ top: scroller.scrollHeight });
		atBottom = true;
	}

	// When the transcript is shown again, the scroller regains layout but the browser
	// left scrollTop at 0. Wait a tick for that layout, then restore the reader's
	// place: re-pin to the bottom if they were there, else back to where they were.
	$effect(() => {
		if (!visible) return;
		tick().then(() => {
			if (!scroller) return;
			if (atBottom) forceScroll();
			else scroller.scrollTop = savedScrollTop;
			hydrateRest(); // resume any hydration deferred while hidden
		});
	});

	// Switching Thread <-> Chat changes how much is on screen dramatically, so hold
	// the reader's place across the swap: note the topmost row before the DOM
	// updates, then line the chunk it ended up in back up afterwards. Both effects
	// track `condensed` only; everything else they read is untracked so scrolling
	// can't retrigger them.
	let anchor: { key: string; offset: number } | null = null;
	let wasVisible = false;

	// The row covering the top of the view (a tall one can start well above it),
	// or the first one below when nothing covers it.
	function topRow(): { key: string; offset: number } | null {
		if (!scroller) return null;
		const top = scroller.getBoundingClientRect().top;
		let covering: { key: string; offset: number } | null = null;
		for (const el of scroller.querySelectorAll<HTMLElement>('[data-k]')) {
			const row = { key: el.dataset.k as string, offset: el.getBoundingClientRect().top - top };
			if (row.offset > 0) return covering ?? row;
			covering = row;
		}
		return covering;
	}

	$effect.pre(() => {
		const shown = visible;
		condensed;
		untrack(() => {
			// Only measurable while the pane has layout: a hidden scroller's scrollTop
			// is clamped to 0, so topRow() would read the wrong row. Capturing on the
			// way out too means a mode picked from behind Changes/Servers still has an
			// anchor to come back to, where the raw saved scrollTop would be a pixel
			// offset into the other mode's layout.
			if (wasVisible) anchor = atBottom ? null : topRow();
			wasVisible = shown;
			fillPulls = 0; // a fresh fill budget each time Chat is opened
		});
	});

	$effect(() => {
		condensed;
		untrack(() => {
			const held = anchor;
			anchor = null;
			if (!visible) return;
			tick().then(() => {
				if (!scroller) return;
				if (atBottom) {
					forceScroll();
					return;
				}
				if (!held) return;
				// The exact row when it's still rendered (an expanded run keeps its
				// rows), else whichever chunk swallowed it.
				const key = chunkKeyFor(chunks, held.key) ?? held.key;
				const el =
					scroller.querySelector<HTMLElement>(`[data-k="${held.key}"]`) ??
					scroller.querySelector<HTMLElement>(`[data-k="${key}"]`);
				if (!el) return;
				const rect = el.getBoundingClientRect();
				// A tall row that straddled the fold can now be a one-line summary, so
				// don't push it further above the view than its own height.
				const want = Math.max(held.offset, -rect.height);
				scroller.scrollTop += rect.top - scroller.getBoundingClientRect().top - want;
				savedScrollTop = scroller.scrollTop;
				measureBottom(); // the other mode may be short enough that this lands at the bottom
			});
		});
	});

	const idle: (cb: () => void) => void =
		typeof requestIdleCallback === 'function'
			? (cb) => requestIdleCallback(() => cb(), { timeout: 200 })
			: (cb) => setTimeout(cb, 16);

	// Widen the window by `by` older rows. They mount above the viewport, so re-pin
	// by the distance to the bottom: a bottom-anchored view stays pinned, and a
	// scrolled-up reader keeps the same messages in place instead of jumping.
	async function growWindow(by: number) {
		if (limit >= events.length) return;
		const gap = scroller ? scroller.scrollHeight - scroller.scrollTop : 0;
		limit = Math.min(events.length, limit + by);
		await tick();
		if (scroller) scroller.scrollTop = scroller.scrollHeight - gap;
	}

	let hydrating = false;
	function hydrateRest() {
		// Don't widen the window behind another tab: growWindow's scroll compensation
		// is a no-op without layout, so it would desync a scrolled-up reader. The
		// visibility effect resumes hydration on re-show.
		if (hydrating || limit >= events.length || !visible) return;
		hydrating = true;
		const step = () => {
			if (limit >= events.length || !visible) {
				hydrating = false;
				return;
			}
			growWindow(HYDRATE_CHUNK).then(() => idle(step));
		};
		idle(step);
	}

	// Bring a deep-linked event into view: load older history until it is
	// present, widen the window over it, then scroll it to the top and flash it.
	// Bounded so a bad index can't loop forever.
	let focused = false;
	async function focusEvent(index: number) {
		focused = true;
		for (let pulls = 0; baseIndex > index && pulls < 40; pulls++) {
			const before = baseIndex;
			await loadOlder();
			if (baseIndex === before) break;
		}
		if (index < baseIndex || index >= baseIndex + events.length) return;
		limit = Math.max(limit, events.length - (index - baseIndex));
		await tick();
		for (const id of launchersOf(thread, events[index - baseIndex])) openRuns.add(id);
		await tick();
		const el =
			scroller?.querySelector<HTMLElement>(`[data-k="${index}"]`) ??
			scroller?.querySelector<HTMLElement>(`[data-k^="${index}:"]`);
		if (!el || !scroller) return;
		atBottom = false;
		scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12;
		el.classList.add('deck-focus');
		setTimeout(() => el.classList.remove('deck-focus'), 2500);
	}

	// Fetch the slice of history just before what's loaded and prepend it,
	// holding scroll position (same gap trick as growWindow). `baseIndex` walks
	// back toward 0; at 0 there's nothing older to load.
	let loadingOlder = $state(false);
	async function loadOlder() {
		if (loadingOlder || baseIndex <= 0) return;
		loadingOlder = true;
		try {
			const slice = await agentGet<{ start: number; events: AnyEvent[] }>(
				`${sessionPath(session.id, 'history')}?before=${baseIndex}&limit=${HYDRATE_CHUNK}`
			).catch(() => null);
			if (!slice) return;
			const added = baseIndex - slice.start;
			if (added <= 0) {
				baseIndex = slice.start;
				return;
			}
			const gap = scroller ? scroller.scrollHeight - scroller.scrollTop : 0;
			events.unshift(...slice.events);
			indexOlderBatch(index, slice.events);
			baseIndex = slice.start;
			fetchOmittedReports();
			limit += added; // keep the just-loaded rows inside the render window
			await tick();
			if (scroller) scroller.scrollTop = scroller.scrollHeight - gap;
		} finally {
			loadingOlder = false;
		}
	}

	function toBase64(buf: ArrayBuffer): string {
		let bin = '';
		const bytes = new Uint8Array(buf);
		const chunk = 0x8000;
		for (let i = 0; i < bytes.length; i += chunk) {
			bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
		}
		return btoa(bin);
	}

	async function addImage(file: File) {
		const data = toBase64(await file.arrayBuffer());
		attachments = [...attachments, { media_type: file.type, data, url: `data:${file.type};base64,${data}` }];
	}

	function addFiles(files: Iterable<File>) {
		const others: File[] = [];
		for (const f of files) {
			if (isInlineImage(f.type)) addImage(f);
			else others.push(f);
		}
		const { admitted, errors } = admitUploads(uploads.length, others);
		uploads = [...uploads, ...admitted];
		uploadError = errors.join('. ');
	}

	function onPaste(e: ClipboardEvent) {
		const items = e.clipboardData?.items;
		if (!items) return;
		const files: File[] = [];
		for (const it of items) {
			const f = it.kind === 'file' ? it.getAsFile() : null;
			if (f) files.push(f);
		}
		if (files.length) addFiles(files);
	}

	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragging = false;
		const files = e.dataTransfer?.files;
		if (files) addFiles(files);
	}

	function onPick(e: Event) {
		const files = (e.target as HTMLInputElement).files;
		if (files) addFiles(files);
		(e.target as HTMLInputElement).value = '';
	}

	function removeAttachment(i: number) {
		attachments = attachments.filter((_, k) => k !== i);
	}

	function removeUpload(i: number) {
		uploads = uploads.filter((_, k) => k !== i);
		uploadError = '';
	}

	const canSend = $derived(!!input.trim() || attachments.length > 0 || uploads.length > 0);
	const attachedCount = $derived(attachments.length + uploads.length);

	// The draft was started in a different session than the one being viewed.
	const crossSession = $derived(isCrossSession(originSessionId, session.id));
	const originTitle = $derived(
		sessions.find((s) => s.id === originSessionId)?.title ?? 'another session'
	);

	// Persist the single draft (debounced) so a cold reload restores it; an empty
	// draft clears the key. The attachment budget is applied in serializeDraft.
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	function persistDraft(draft: Draft) {
		if (!persist || typeof localStorage === 'undefined') return;
		try {
			const raw = serializeDraft(draft);
			if (raw) localStorage.setItem(DRAFT_KEY, raw);
			else localStorage.removeItem(DRAFT_KEY);
		} catch {
			// quota / private mode: keep the in-memory draft, just skip persistence
		}
	}
	$effect(() => {
		const draft: Draft = { text: input, attachments, originSessionId };
		// The cleanup below clears the pending timer before each re-run and on
		// destroy, so this debounces to 300ms after the last edit.
		saveTimer = setTimeout(() => persistDraft(draft), 300);
		return () => clearTimeout(saveTimer);
	});

	// Track the origin session: adopt the current one when the draft first becomes
	// non-empty, hold it across switches, clear it when the draft is emptied.
	$effect(() => {
		const empty = isEmptyDraft({ text: input, attachments }) && uploads.length === 0;
		originSessionId = nextOrigin(originSessionId, empty, session.id);
	});

	function clearDraft() {
		input = '';
		attachments = [];
		uploads = [];
		uploadError = '';
		originSessionId = null;
		if (persist && typeof localStorage !== 'undefined') {
			try {
				localStorage.removeItem(DRAFT_KEY);
			} catch {
				// ignore
			}
		}
	}

	let skillPicker = $state<SkillPicker>();
	let composerInput = $state<HTMLTextAreaElement>();
	// Set when the message's leading /command came from the skill list, so the
	// send asks the server to resolve it against this machine's skills.
	let skillChosen = $state(false);
	$effect(() => {
		if (!input.startsWith('/')) skillChosen = false;
	});

	async function send() {
		if (!canSend) return;
		// Only guard the cross-session case; same-session sends are unaffected.
		if (crossSession) {
			haptic([15, 30, 15]);
			pendingSend = true;
			return;
		}
		await doSend();
	}

	async function confirmSend() {
		pendingSend = false;
		await doSend();
	}

	async function doSend() {
		if (!canSend) return;
		const text = input.trim();
		const images = attachments.map((a) => ({ media_type: a.media_type, data: a.data }));
		// Clear optimistically, but snapshot so a failed send restores the draft
		// (the draft should only clear on a *successful* send).
		const prev = { input, attachments, uploads, originSessionId };
		clearDraft();
		atBottom = true;
		try {
			await postMessage(text, images, prev.uploads, skillChosen);
		} catch (err) {
			input = prev.input;
			attachments = prev.attachments;
			uploads = prev.uploads;
			originSessionId = prev.originSessionId;
			if (prev.uploads.length) uploadError = err instanceof Error ? err.message : 'Upload failed';
		}
	}

	// With files, the upload route sends the turn itself, naming where each file
	// landed under the text (the share extension's message), images still inline.
	async function postMessage(
		text: string,
		images: { media_type: string; data: string }[],
		files: File[],
		skills: boolean
	) {
		const inline = images.length ? images : undefined;
		if (!files.length)
			return agentPost(sessionPath(session.id, 'message'), { text, images: inline, skills: skills || undefined });
		const encoded = await Promise.all(
			files.map(async (f) => ({ name: f.name, data: toBase64(await f.arrayBuffer()) }))
		);
		return agentPost(sessionPath(session.id, 'upload'), { files: encoded, text, images: inline });
	}

	// Fire a quick message immediately; `expand: true` opts it into server-side
	// [token] expansion (the popover sends canned text, not the typed input). If
	// the send fails (e.g. a message that expands to empty against a session with
	// no PR hits the empty-prompt 400), drop the text into an empty composer so the
	// click isn't silently lost; never clobber what the user is already typing.
	async function sendQuickMessage(text: string) {
		atBottom = true;
		try {
			await agentPost(sessionPath(session.id, 'message'), { text, expand: true });
			return;
		} catch {
			// fall through to restore the text below
		}
		if (!input.trim()) input = text;
	}

	async function interrupt() {
		await agentPost(sessionPath(session.id, 'stop')).catch(() => {});
	}

	function onKeydown(e: KeyboardEvent) {
		if (skillPicker?.handleKey(e)) return;
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			send();
		}
	}

	function toggleRun(key: string) {
		if (openRuns.has(key)) openRuns.delete(key);
		else openRuns.add(key);
		// Expanding grows the content below the fold without firing a scroll event,
		// so re-read whether we're still pinned. Otherwise the next streamed event
		// yanks a reader who just opened a run down to the bottom.
		tick().then(measureBottom);
	}

	function fmtCost(event: AnyEvent): string {
		const parts: string[] = [];
		if (typeof event.duration_ms === 'number') parts.push(`${(event.duration_ms / 1000).toFixed(1)}s`);
		if (typeof event.num_turns === 'number') parts.push(`${event.num_turns} turns`);
		if (typeof event.total_cost_usd === 'number') parts.push(`$${event.total_cost_usd.toFixed(4)}`);
		if (event.subtype && event.subtype !== 'success') parts.push(event.subtype);
		return parts.join(' · ');
	}
</script>

<!-- One rendered row of the transcript. Both tabs render rows through here; Chat
     only differs in which of them sit behind a run summary. Unhandled event types
     (including deck.* markers from removed features, e.g. old workflow
     transcripts) never reach this: they are dropped when the window is flattened. -->
{#snippet transcriptRow(row: Row)}
	{@const event = row.event}
	{@const block = row.block}
	{#if block}
		{#if block.type === 'text'}
			<MessageBubble
				side="start"
				text={block.text}
				markdown
				bubbleClass="bg-base-100 text-base-content"
				sessionId={session.id}
				onread={voiceAvailable ? (t) => void voice.readAloud(t) : undefined}
			/>
		{:else if block.type === 'thinking'}
			<details class="px-2 text-xs opacity-50">
				<summary class="cursor-pointer select-none">
					<ChevronDown size={12} class="inline" /> Thinking
				</summary>
				<div class="pt-1"><Markdown source={block.thinking} /></div>
			</details>
		{:else if isAskTool(block)}
			{#if block.id !== pendingAsk?.id}
				<AskQuestion
					{block}
					answered={answeredQuestions.has(block.id)}
					answer={answeredQuestions.get(block.id)}
					onanswer={(text, answers) => answerQuestion(block.id, text, answers)}
				/>
			{/if}
		{:else}
			{@const steps = thread.nested.get(block.id)}
			<ToolCall
				{block}
				result={resultsById.get(block.id)}
				agent={agentForCall(agents, block.id)}
				{agentElapsed}
				steps={steps?.length ?? 0}
				open={openRuns.has(block.id)}
				ontoggle={() => toggleRun(block.id)}
			>
				{#if steps}{@render chunkList(layout(steps))}{/if}
			</ToolCall>
		{/if}
	{:else if event.type === 'deck.user'}
		<MessageBubble side="end" text={event.text ?? ''} bubbleClass="bg-base-300 text-base-content" sessionId={session.id}>
			{#if event.images?.length}
				<div class="mb-2 flex flex-wrap gap-2">
					{#each event.images as img, k (k)}
						<img
							src={img.file ? sessionPath(session.id, 'images', img.file) : `data:${img.media_type};base64,${img.data}`}
							loading="lazy"
							alt="attachment"
							class="max-h-40 rounded-box border border-base-300"
						/>
					{/each}
				</div>
			{/if}
		</MessageBubble>
	{:else if event.type === 'deck.error'}
		<div class="alert alert-error py-2 text-sm whitespace-pre-wrap wrap-anywhere">{event.text}</div>
	{:else if event.type === 'deck.warning'}
		<div class="alert alert-warning py-2 text-sm whitespace-pre-wrap wrap-anywhere">{event.text}</div>
	{:else if event.type === 'deck.model'}
		<div class="px-2 text-center text-xs opacity-50">model → {modelLabel(event.model)}</div>
	{:else if event.type === 'deck.agent'}
		<div class="px-2 text-center text-xs opacity-50">agent {event.from} → {event.kind} · recent conversation handed off</div>
	{:else if event.type === 'deck.effort'}
		<div class="px-2 text-center text-xs opacity-50">effort → {effortLabel(event.effort)}</div>
	{:else if event.type === 'deck.restart'}
		<div class="px-2 text-center text-xs opacity-50">restart → fresh Claude config from the next message</div>
	{:else if event.type === 'result'}
		<div class="px-2 text-center text-xs opacity-50">{fmtCost(event)}</div>
	{/if}
{/snippet}

<!-- The thread and each subagent's card lay their rows out the same way. -->
{#snippet chunkList(list: Chunk[])}
	{#each list as chunk (chunk.key)}
		{#if chunk.kind === 'run'}
			<div data-k={openRuns.has(chunk.key) ? undefined : chunk.key} class="space-y-3">
				<ToolRun
					count={chunk.count}
					tools={chunk.tools}
					open={openRuns.has(chunk.key)}
					ontoggle={() => toggleRun(chunk.key)}
				/>
				{#if openRuns.has(chunk.key)}
					{#each chunk.rows as row (row.key)}
						<div data-k={row.key}>{@render transcriptRow(row)}</div>
					{/each}
				{/if}
			</div>
		{:else}
			<div data-k={chunk.key}>{@render transcriptRow(chunk.row)}</div>
		{/if}
	{/each}
{/snippet}

<div
	class="relative flex h-full min-h-0 flex-col"
	role="group"
	ondragover={(e) => {
		e.preventDefault();
		dragging = true;
	}}
	ondragleave={() => (dragging = false)}
	ondrop={onDrop}
>
	{#if !connected}
		<div
			class="pointer-events-none absolute top-2 left-1/2 z-10 -translate-x-1/2 rounded-full bg-warning px-3 py-1 text-xs font-medium text-warning-content"
		>
			Reconnecting…
		</div>
	{/if}

	<div
		bind:this={scroller}
		onscroll={onScroll}
		class="@container min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto py-3"
	>
		{#if !loaded}
			<div class="flex h-full items-center justify-center">
				<span class="loading loading-spinner loading-md opacity-50"></span>
			</div>
		{/if}
		{#if loadingOlder}
			<div class="flex justify-center py-1">
				<span class="loading loading-spinner loading-xs opacity-60"></span>
			</div>
		{/if}
		{@render chunkList(chunks)}

		{#if loaded && liveText.trim()}
			<MessageBubble
				side="start"
				text={liveText}
				markdown
				streaming
				streamId={liveTurn}
				bubbleClass="bg-base-100 text-base-content"
			/>
		{/if}

		{#if loaded}
			<ActivityList
				watches={sessions.find((s) => s.id === session.id)?.watches ?? []}
				agents={barAgents}
				elapsed={agentElapsed}
				onjump={(a) => void jumpToAgent(a)}
			/>
		{/if}
	</div>

	{#if dragging}
		<div class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-box border-2 border-dashed border-primary bg-base-100/70 text-sm font-medium">
			Drop files to attach
		</div>
	{/if}

	{#if !atBottom}
		<button
			class="fold-jump btn btn-circle btn-sm absolute bottom-28 left-1/2 -translate-x-1/2 border border-base-300"
			onclick={forceScroll}
			aria-label="Jump to latest"
		>
			<ArrowDown size={16} />
		</button>
	{/if}

	<!-- Everything below the transcript; on a tabletop fold it fills the flat
	     segment (.fold-flat in layout.css). -->
	<div class="fold-flat">
	{#if pendingAsk}
		{@const ask = pendingAsk}
		<div class="py-2">
			{#key ask.id}
				<AskQuestion
					block={ask}
					onanswer={(text, answers) => answerQuestion(ask.id, text, answers)}
				/>
			{/key}
		</div>
	{/if}
	{#if tabletop.current && flatActions}
		<div class="flex justify-end py-1">{@render flatActions()}</div>
	{/if}

	{#if cost.results > 0 || context.used > 0}
		<!-- Running session total and how full the context window is, pinned above
		     the composer so they stay in view regardless of scroll (per-turn footers
		     still render inline above). -->
		<div class="-mx-2 flex items-center justify-center gap-3 border-t border-base-300 px-3 py-1 text-xs opacity-60">
			{#if cost.results > 0}
				<span class="truncate">{formatCostSummary(cost)}</span>
			{/if}
			{#if context.used > 0 && context.window > 0}
				<ContextMeter
					id={session.id}
					{context}
					running={status === 'running'}
					compactable={session.kind === 'claude'}
				/>
			{/if}
		</div>
	{/if}

	{#if voice.enabled}
		<VoiceBar {voice} />
	{/if}

	<!-- An always-present live region, so "Working…" is announced when it appears. -->
	<div role="status">
		{#if status === 'running'}
			<div class="-mx-2 flex items-center gap-2 border-t border-base-300 px-3 py-1 text-sm">
				<span class="opacity-60">Working…</span>
				<button class="btn btn-error btn-xs ml-auto" onclick={interrupt}>
					<Square size={12} /> Stop
				</button>
			</div>
		{/if}
	</div>

	<!-- -mx-2 cancels the session pane's side padding so the composer and its
	     top border run edge to edge. -->
	<div class="relative -mx-2 border-t border-base-300 bg-base-100 p-2 sm:p-3">
		{#if crossSession}
			<div class="mb-2 flex items-center gap-1 text-xs opacity-70">
				<ArrowLeftRight size={12} />
				<span>from: {originTitle}</span>
			</div>
		{/if}
		{#if attachments.length}
			<div class="mb-2 flex flex-wrap gap-2">
				{#each attachments as a, i (i)}
					<div class="relative">
						<img src={a.url} alt="attachment" class="h-16 w-16 rounded-box border border-base-300 object-cover" />
						<button
							class="btn btn-circle btn-xs absolute -top-2 -right-2"
							onclick={() => removeAttachment(i)}
							aria-label="Remove attachment"
						>
							<X size={12} />
						</button>
					</div>
				{/each}
			</div>
		{/if}
		{#if uploads.length}
			<div class="mb-2 flex flex-wrap gap-2">
				{#each uploads as f, i (i)}
					<span class="badge badge-lg max-w-full gap-1.5 border-base-300 pr-1" title={f.name}>
						<FileText size={14} class="shrink-0 opacity-70" />
						<span class="truncate">{f.name}</span>
						<span class="shrink-0 opacity-60">{formatBytes(f.size)}</span>
						<button
							class="btn btn-ghost btn-circle btn-xs shrink-0"
							onclick={() => removeUpload(i)}
							aria-label="Remove {f.name}"
						>
							<X size={12} />
						</button>
					</span>
				{/each}
			</div>
		{/if}
		{#if uploadError}
			<p class="mb-2 text-xs text-error" role="alert">{uploadError}</p>
		{/if}
		<div class="rounded-box border border-base-300 bg-base-100 focus-within:border-primary focus-within:outline-2 focus-within:outline-primary/40">
		<textarea
			bind:this={composerInput}
			class="textarea block min-h-18 w-full border-0 bg-transparent outline-none focus:outline-none"
			rows="3"
			style="height: calc(4.5em + 1.5rem + 3px)"
			placeholder={status === 'running'
				? 'Queue a follow-up (Ctrl/Cmd+Enter)'
				: 'Message (Ctrl/Cmd+Enter to send; paste or drop files)'}
			bind:value={input}
			onkeydown={onKeydown}
			onpaste={onPaste}
		></textarea>
		<div class="flex flex-wrap items-center gap-1.5 p-1.5 sm:gap-2">
			{@render controls?.()}
			{#if voiceAvailable}
				<button
					class="btn btn-square btn-sm {voice.enabled ? 'btn-primary' : 'btn-ghost'}"
					onclick={toggleVoice}
					aria-pressed={voice.enabled}
					aria-label={voice.enabled ? 'Turn voice mode off' : 'Turn voice mode on'}
					title="Voice mode: read replies aloud, talk back"
				>
					<AudioLines size={16} />
				</button>
			{/if}
			<div class="ml-auto flex items-center gap-1.5 sm:gap-2">
				<input
					bind:this={fileInput}
					type="file"
					multiple
					class="hidden"
					onchange={onPick}
				/>
				<button
					class="btn btn-ghost btn-square"
					onclick={() => fileInput?.click()}
					aria-label="Attach files"
					title="Attach files"
				>
					<Paperclip size={16} />
				</button>

				<SkillPicker
					bind:this={skillPicker}
					bind:text={input}
					cwd={session.cwd}
					textarea={composerInput}
					onpick={() => (skillChosen = true)}
				/>

				<QuickMessages
					onpick={sendQuickMessage}
					projectId={sessionProjectId(session, projects)}
					{projects}
				/>
				<button class="btn btn-primary" onclick={send} disabled={!canSend} aria-label="Send">
					<Send size={16} /> <span class="hidden sm:inline">Send</span>
				</button>
			</div>
		</div>
		</div>
	</div>
	</div>

	<Modal
		open={pendingSend}
		onclose={() => (pendingSend = false)}
		title="Send to a different session?"
		icon={ArrowLeftRight}
		iconClass="text-warning"
	>
		<p class="mb-3 text-sm opacity-70">
			This draft was started in <span class="font-semibold">{originTitle}</span>. Send it to
			<span class="font-semibold">{session.title}</span>?{#if attachedCount}
				(with {attachedCount} attachment{attachedCount > 1 ? 's' : ''}){/if}
		</p>
		{#snippet footer()}
			<button class="btn" onclick={() => (pendingSend = false)}>Cancel</button>
			<button class="btn btn-primary" onclick={confirmSend}>Send</button>
		{/snippet}
	</Modal>
</div>

<style>
	/* A deep-linked row (search hit) flashes so the eye lands on it. */
	:global(.deck-focus) {
		outline: 2px solid var(--color-primary);
		outline-offset: 4px;
		border-radius: var(--radius-box, 0.5rem);
	}
</style>
