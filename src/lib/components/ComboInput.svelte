<script lang="ts">
	import { ChevronDown, Check } from '@lucide/svelte';
	import Popover from './Popover.svelte';

	// A free-text input paired with a visible dropdown of detected suggestions
	// (issue #102). Unlike a <datalist>, the chevron is always visible, the list
	// opens on click, and it renders identically on desktop and the iOS PWA. Typing
	// an arbitrary id still works; an empty options list degrades to a plain input.
	let {
		value = $bindable(''),
		options,
		placeholder = '',
		ariaLabel,
		compact = false,
		oninput
	}: {
		value?: string;
		options: string[];
		placeholder?: string;
		ariaLabel: string;
		compact?: boolean;
		oninput?: () => void;
	} = $props();

	let open = $state(false);

	// Detection can repeat a bare model id across providers (e.g. pi's list before a
	// provider narrows it), so de-dupe: keyed {#each} would otherwise crash on the
	// collision, and duplicate rows are pointless anyway.
	const items = $derived([...new Set(options)]);

	// Typing can narrow the list to nothing (a provider with no models), which
	// unmounts the dropdown; drop `open` with it so it doesn't spring back open
	// when the list refills.
	$effect(() => {
		if (!items.length) open = false;
	});

	function pick(v: string) {
		value = v;
		open = false;
		oninput?.();
	}
</script>

<!-- One input either way: a listing that lands while the field is being typed in
must not swap the element out from under the caret (or the iOS keyboard). Only
the chevron half appears once there is something to show. -->
<div class="join w-full">
	<input
		class="input join-item w-full{compact ? ' input-xs' : ''}"
		{placeholder}
		aria-label={ariaLabel}
		bind:value
		oninput={() => oninput?.()}
	/>
	{#if items.length}
		<Popover
			bind:open
			drawer={false}
			summaryClass="btn btn-square join-item{compact ? ' btn-xs' : ''}"
			summaryLabel="Show detected {ariaLabel}"
			panelClass="w-64 p-1"
		>
			{#snippet trigger()}
				<ChevronDown size={16} />
			{/snippet}
			<ul class="menu menu-sm w-full max-h-64 flex-nowrap overflow-y-auto p-0">
				{#each items as opt (opt)}
					<li>
						<button type="button" onclick={() => pick(opt)}>
							<span class="truncate">{opt}</span>
							{#if value === opt}<Check size={14} class="ml-auto shrink-0" />{/if}
						</button>
					</li>
				{/each}
			</ul>
		</Popover>
	{/if}
</div>
