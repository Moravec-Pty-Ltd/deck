<script lang="ts">
	import type { DeckSession } from '$lib/types';
	import AnsiText from './AnsiText.svelte';
	import { Send, RefreshCw } from '@lucide/svelte';

	let { session }: { session: DeckSession } = $props();

	let text = $state('');
	let dead = $state(false);
	let input = $state('');
	let autoRefresh = $state(true);
	let scroller: HTMLDivElement | undefined = $state();

	async function refresh() {
		const res = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/snapshot`);
		if (!res.ok) return;
		const data = await res.json();
		const atBottom =
			!scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
		text = data.text;
		dead = data.dead;
		if (atBottom) queueMicrotask(() => scroller?.scrollTo({ top: scroller.scrollHeight }));
	}

	$effect(() => {
		refresh();
		if (!autoRefresh) return;
		const interval = setInterval(refresh, 2500);
		return () => clearInterval(interval);
	});

	async function send(submit = true) {
		await fetch(`/api/sessions/${encodeURIComponent(session.id)}/send`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ text: input, submit })
		});
		input = '';
		setTimeout(refresh, 300);
	}

	async function sendKey(key: string) {
		await fetch(`/api/sessions/${encodeURIComponent(session.id)}/send`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ key })
		});
		setTimeout(refresh, 300);
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	}
</script>

<div class="flex h-full min-h-0 flex-col">
	<div
		bind:this={scroller}
		class="terminal-output min-h-0 flex-1 overflow-y-auto rounded-box border border-base-300 bg-base-100 p-3"
	><AnsiText text={text || '(empty)'} /></div>

	<div class="mt-3 space-y-2">
		<div class="flex items-center gap-2">
			<input
				class="input terminal-font flex-1 text-sm"
				placeholder={dead ? 'session is dead' : 'type a command, enter to send'}
				bind:value={input}
				onkeydown={onKeydown}
				disabled={dead}
			/>
			<button class="btn btn-primary" onclick={() => send()} disabled={dead} aria-label="Send">
				<Send size={16} />
			</button>
		</div>
		<div class="flex flex-wrap items-center gap-1.5">
			<button class="btn btn-outline btn-xs" onclick={() => sendKey('Enter')} disabled={dead}>enter</button>
			<button class="btn btn-outline btn-xs" onclick={() => sendKey('C-c')} disabled={dead}>ctrl-c</button>
			<button class="btn btn-outline btn-xs" onclick={() => sendKey('Escape')} disabled={dead}>esc</button>
			<button class="btn btn-outline btn-xs" onclick={() => sendKey('Up')} disabled={dead}>up</button>
			<button class="btn btn-outline btn-xs" onclick={() => sendKey('Down')} disabled={dead}>down</button>
			<button class="btn btn-outline btn-xs" onclick={() => sendKey('Tab')} disabled={dead}>tab</button>
			<div class="flex-1"></div>
			<label class="label cursor-pointer gap-2 text-xs">
				<input type="checkbox" class="toggle toggle-xs" bind:checked={autoRefresh} />
				auto-refresh
			</label>
			<button class="btn btn-ghost btn-xs" onclick={refresh} aria-label="Refresh">
				<RefreshCw size={14} />
			</button>
		</div>
	</div>
</div>
