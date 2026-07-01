<script lang="ts">
	import type { DeckSession, ServerRuntime, ServerState, SetupStepProgress } from '$lib/types';
	import { canStart, canStop, isInFlight } from '$lib/servers-client';
	import ShellView from './ShellView.svelte';
	import ServerChip from './ServerChip.svelte';
	import {
		Play,
		Square,
		RotateCw,
		ListRestart,
		RefreshCw,
		ExternalLink,
		ChevronDown,
		ChevronRight,
		Check,
		X,
		Loader
	} from '@lucide/svelte';

	let {
		session,
		onStates
	}: {
		session: DeckSession;
		onStates?: (states: ServerState[]) => void;
	} = $props();

	let servers = $state<ServerRuntime[]>([]);
	let loaded = $state(false);
	let errMsg = $state<string | null>(null);
	let busy = $state<Record<string, boolean>>({});
	let openLogs = $state<Record<string, boolean>>({});
	let token = 0;

	function fail(my: number, msg: string) {
		if (my !== token) return;
		errMsg = msg;
		loaded = true;
	}

	async function load() {
		const my = ++token;
		const url = `/api/sessions/${encodeURIComponent(session.id)}/servers`;
		let res: Response;
		try {
			res = await fetch(url);
		} catch (e) {
			return fail(my, e instanceof Error ? e.message : 'failed to load servers');
		}
		if (my !== token) return;
		if (!res.ok) return fail(my, `request failed (${res.status})`);
		const data = await res.json();
		if (my !== token) return;
		servers = data.servers ?? [];
		errMsg = null;
		loaded = true;
		onStates?.(servers.map((s) => s.state));
	}

	$effect(() => {
		load();
		const interval = setInterval(load, 3000);
		return () => clearInterval(interval);
	});

	async function post(name: string, body: Record<string, unknown>) {
		busy = { ...busy, [name]: true };
		try {
			const res = await fetch(
				`/api/sessions/${encodeURIComponent(session.id)}/servers/${encodeURIComponent(name)}`,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body)
				}
			);
			if (!res.ok) {
				errMsg = (await res.json().catch(() => ({})))?.message ?? 'action failed';
			} else {
				errMsg = null;
			}
		} finally {
			busy = { ...busy, [name]: false };
			await load();
		}
	}

	function act(name: string, action: 'start' | 'stop' | 'restart' | 'resetup') {
		return post(name, { action });
	}

	function runStep(name: string, step: number, label: string) {
		return post(name, { action: 'step', step, label });
	}

	function toggleLogs(name: string) {
		openLogs = { ...openLogs, [name]: !openLogs[name] };
	}

	function logsPath(name: string) {
		return `/api/sessions/${encodeURIComponent(session.id)}/servers/${encodeURIComponent(name)}/logs`;
	}

	function stepIcon(step: SetupStepProgress) {
		return step.state;
	}
</script>

<div class="flex h-full min-h-0 flex-col">
	{#if errMsg}
		<div class="alert alert-error mb-2 py-2 text-sm break-words">{errMsg}</div>
	{/if}

	<div class="min-h-0 flex-1 space-y-3 overflow-y-auto">
		{#if !loaded}
			<div class="flex h-24 items-center justify-center">
				<span class="loading loading-spinner loading-md opacity-50"></span>
			</div>
		{:else if servers.length === 0}
			<div class="rounded-box border border-dashed border-base-300 p-6 text-center text-sm opacity-60">
				No dev servers configured. Add them in the project's settings.
			</div>
		{/if}

		{#each servers as s (s.name)}
			<div class="rounded-box border border-base-300 bg-base-100 p-3">
				<div class="flex flex-wrap items-center gap-2">
					<span class="font-medium">{s.name}</span>
					<ServerChip state={s.state} />
					{#if s.previewUrl && (s.state === 'running' || s.state === 'stalled')}
						<a
							href={s.previewUrl}
							target="_blank"
							rel="noopener noreferrer"
							class="link link-hover inline-flex items-center gap-1 text-xs text-primary"
						>
							<ExternalLink size={12} /> {s.previewUrl}
						</a>
					{/if}
					<div class="flex-1"></div>
					<div class="join shrink-0">
						<button
							class="btn join-item btn-sm"
							onclick={() => act(s.name, 'start')}
							disabled={busy[s.name] || !canStart(s.state)}
							title="Start"
							aria-label="Start"
						>
							<Play size={14} />
						</button>
						<button
							class="btn join-item btn-sm"
							onclick={() => act(s.name, 'restart')}
							disabled={busy[s.name] || s.state === 'setup'}
							title="Restart"
							aria-label="Restart"
						>
							<RotateCw size={14} />
						</button>
						<button
							class="btn join-item btn-sm"
							onclick={() => act(s.name, 'stop')}
							disabled={busy[s.name] || !canStop(s.state)}
							title="Stop"
							aria-label="Stop"
						>
							<Square size={14} />
						</button>
						<button
							class="btn join-item btn-sm"
							onclick={() => act(s.name, 'resetup')}
							disabled={busy[s.name] || isInFlight(s.state)}
							title="Re-run setup (full re-standup)"
							aria-label="Re-run setup"
						>
							<ListRestart size={14} />
						</button>
					</div>
				</div>

				{#if s.error}
					<div class="alert alert-error mt-2 py-1.5 text-xs break-words">{s.error}</div>
				{/if}
				{#if s.warning}
					<div class="alert alert-warning mt-2 py-1.5 text-xs break-words">{s.warning}</div>
				{/if}

				{#if s.ports.length}
					<div class="mt-2 flex flex-wrap gap-1.5">
						{#each s.ports as p (p.port)}
							<span class="badge badge-outline badge-sm gap-1">
								<span class="size-1.5 rounded-full {p.listening ? 'bg-success' : 'bg-base-content/30'}"></span>
								{p.label ? `${p.label} ` : ''}:{p.port}{p.primary ? '*' : ''}
							</span>
						{/each}
					</div>
				{/if}

				{#if s.setup.length}
					<div class="mt-2 space-y-1">
						{#each s.setup as step, i (i)}
							<div class="flex items-start gap-2 text-xs">
								<span class="mt-0.5 shrink-0">
									{#if stepIcon(step) === 'ok'}
										<Check size={13} class="text-success" />
									{:else if stepIcon(step) === 'failed'}
										<X size={13} class="text-error" />
									{:else if stepIcon(step) === 'running'}
										<Loader size={13} class="animate-spin text-info" />
									{:else}
										<span class="inline-block size-3 rounded-full border border-base-content/30"></span>
									{/if}
								</span>
								<div class="min-w-0 flex-1">
									<span class={step.state === 'failed' ? 'text-error' : ''}>{step.label}</span>
									{#if step.state === 'failed' && step.output}
										<pre class="terminal-font mt-1 max-h-32 overflow-auto rounded bg-base-200 p-2 text-[11px] whitespace-pre-wrap">{step.output}</pre>
									{/if}
								</div>
								<button
									class="btn btn-ghost btn-xs shrink-0"
									onclick={() => runStep(s.name, i, step.label)}
									disabled={busy[s.name] || isInFlight(s.state)}
									title="Run this step"
									aria-label={`Run setup step: ${step.label}`}
								>
									<RefreshCw size={12} />
								</button>
							</div>
						{/each}
					</div>
				{/if}

				<div class="mt-2">
					<button class="btn btn-ghost btn-xs gap-1" onclick={() => toggleLogs(s.name)}>
						{#if openLogs[s.name]}<ChevronDown size={13} />{:else}<ChevronRight size={13} />{/if}
						logs
					</button>
					{#if openLogs[s.name]}
						<div class="mt-1 h-72">
							<ShellView {session} snapshotPath={logsPath(s.name)} readonly />
						</div>
					{/if}
				</div>
			</div>
		{/each}
	</div>
</div>
