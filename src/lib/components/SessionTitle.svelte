<script lang="ts">
	// The session header's title, which doubles as its rename control: clicking
	// the title is where you already are when you want to change it, so there is
	// no separate menu item to find. Enter or blur saves, Escape puts the old
	// title back. Validated with the same rules the API applies
	// ($lib/session-title), so a bad title is refused before the round trip.
	import { MAX_TITLE_LENGTH, parseTitle } from '$lib/session-title';

	interface Props {
		id: string;
		title: string;
		// Called with the id the session now has. Renaming an unregistered tmux
		// terminal renames the tmux session, so its derived id moves with it and
		// the page has to follow.
		onRenamed: (id: string) => void;
	}
	let { id, title, onRenamed }: Props = $props();

	let editing = $state(false);
	let draft = $state('');
	let saving = $state(false);
	let errorMsg = $state('');
	let field = $state<HTMLInputElement | null>(null);
	// Escape blurs the field, and blur saves, so the cancel has to disarm the
	// save on its way out.
	let cancelled = false;

	function begin() {
		draft = title;
		errorMsg = '';
		cancelled = false;
		editing = true;
	}

	function cancel() {
		cancelled = true;
		editing = false;
		errorMsg = '';
	}

	async function save() {
		if (cancelled || saving) return;
		const parsed = parseTitle(draft);
		if (!parsed.ok) {
			errorMsg = parsed.reason;
			field?.focus();
			return;
		}
		if (parsed.title === title) {
			editing = false;
			return;
		}
		saving = true;
		try {
			const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/title`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ title: parsed.title })
			});
			const body = await res.json().catch(() => null);
			if (!res.ok) {
				errorMsg = body?.message ?? 'rename failed';
				return;
			}
			editing = false;
			onRenamed(body?.id ?? id);
		} catch {
			errorMsg = 'rename failed';
		} finally {
			saving = false;
		}
	}

	function onKey(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			event.preventDefault();
			void save();
		} else if (event.key === 'Escape') {
			event.preventDefault();
			cancel();
		}
	}
</script>

{#if editing}
	<!-- svelte-ignore a11y_autofocus -->
	<input
		bind:this={field}
		bind:value={draft}
		autofocus
		class="input input-sm input-bordered min-w-0 max-w-md flex-1 font-medium"
		class:input-error={!!errorMsg}
		maxlength={MAX_TITLE_LENGTH}
		disabled={saving}
		aria-label="Session name"
		aria-invalid={!!errorMsg}
		aria-errormessage={errorMsg ? 'session-title-error' : undefined}
		onkeydown={onKey}
		onblur={() => void save()}
	/>
	{#if errorMsg}
		<span id="session-title-error" class="text-xs text-error">{errorMsg}</span>
	{/if}
{:else}
	<button
		type="button"
		class="min-w-0 truncate rounded-btn px-1 text-left font-medium hover:bg-base-200"
		title="Rename session"
		onclick={begin}
	>
		{title}
	</button>
{/if}
