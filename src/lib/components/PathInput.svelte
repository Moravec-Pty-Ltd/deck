<script lang="ts">
	// Text input with directory autocomplete. Suggestions come from the server,
	// which resolves ~ to the home directory and lists matching subdirectories.
	interface Props {
		value?: string;
		placeholder?: string;
		class?: string;
		id?: string;
		onenter?: () => void;
	}
	let {
		value = $bindable(''),
		placeholder = '',
		class: klass = 'input w-full',
		id,
		onenter
	}: Props = $props();

	let suggestions = $state<string[]>([]);
	let open = $state(false);
	let active = $state(-1);
	let inputEl = $state<HTMLInputElement | null>(null);
	let token = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;

	async function fetchFor(q: string) {
		const mine = ++token;
		try {
			const res = await fetch(`/api/fs/complete?q=${encodeURIComponent(q)}`);
			const list: string[] = res.ok ? await res.json() : [];
			if (mine !== token) return; // a newer request superseded this one
			suggestions = list;
			active = -1;
			open = list.length > 0;
		} catch {
			if (mine === token) open = false;
		}
	}

	function schedule(q: string) {
		clearTimeout(timer);
		timer = setTimeout(() => fetchFor(q), 110);
	}

	function onInput() {
		schedule(value);
	}

	function choose(s: string) {
		value = s;
		// Drill into the chosen directory by listing its children immediately.
		fetchFor(s.endsWith('/') ? s : s + '/');
		inputEl?.focus();
	}

	function onKeydown(e: KeyboardEvent) {
		if (!open || suggestions.length === 0) {
			if (e.key === 'Enter') onenter?.();
			return;
		}
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			active = (active + 1) % suggestions.length;
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			active = active <= 0 ? suggestions.length - 1 : active - 1;
		} else if (e.key === 'Enter') {
			if (active >= 0) {
				e.preventDefault();
				choose(suggestions[active]);
			} else {
				onenter?.();
			}
		} else if (e.key === 'Escape') {
			open = false;
		} else if (e.key === 'Tab' && active >= 0) {
			e.preventDefault();
			choose(suggestions[active]);
		}
	}
</script>

<div class="relative">
	<input
		bind:this={inputEl}
		{id}
		class={klass}
		{placeholder}
		bind:value
		oninput={onInput}
		onkeydown={onKeydown}
		onfocus={() => value && schedule(value)}
		onblur={() => setTimeout(() => (open = false), 120)}
		autocomplete="off"
		autocapitalize="off"
		autocorrect="off"
		spellcheck="false"
	/>
	{#if open && suggestions.length}
		<ul
			class="absolute z-30 mt-1 max-h-60 w-full overflow-auto rounded-box border border-base-300 bg-base-100 py-1 shadow-lg"
		>
			{#each suggestions as s, i (s)}
				<li>
					<button
						type="button"
						class="block w-full truncate px-3 py-1.5 text-left font-mono text-xs hover:bg-base-200 {i ===
						active
							? 'bg-base-200'
							: ''}"
						onmousedown={(e) => {
							e.preventDefault();
							choose(s);
						}}
					>
						{s}
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</div>
