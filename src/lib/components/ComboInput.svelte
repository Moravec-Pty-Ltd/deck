<script lang="ts">
	import { dismissOnOutside } from '$lib/dismiss';
	import { ChevronDown, Check } from '@lucide/svelte';

	// A free-text input paired with a visible dropdown of detected suggestions
	// (issue #102). Unlike a <datalist>, the chevron is always visible, the list
	// opens on click, and it renders identically on desktop and the iOS PWA. Typing
	// an arbitrary id still works; an empty options list degrades to a plain input.
	let {
		value = $bindable(''),
		options,
		placeholder = '',
		oninput
	}: {
		value?: string;
		options: string[];
		placeholder?: string;
		oninput?: () => void;
	} = $props();

	let open = $state(false);

	// Detection can repeat a bare model id across providers (e.g. pi's list before a
	// provider narrows it), so de-dupe: keyed {#each} would otherwise crash on the
	// collision, and duplicate rows are pointless anyway.
	const items = $derived([...new Set(options)]);

	function pick(v: string) {
		value = v;
		open = false;
		oninput?.();
	}
</script>

{#if items.length}
	<div class="join w-full">
		<input class="input join-item w-full" {placeholder} bind:value oninput={() => oninput?.()} />
		<details class="dropdown dropdown-end" bind:open use:dismissOnOutside={() => (open = false)}>
			<summary
				class="btn btn-square join-item list-none [&::-webkit-details-marker]:hidden"
				aria-label="Show detected options"
			>
				<ChevronDown size={16} />
			</summary>
			<ul
				class="dropdown-content menu menu-sm z-20 mt-1 max-h-64 w-64 flex-nowrap overflow-y-auto rounded-box border border-base-300 bg-base-100 p-1 shadow-lg"
			>
				{#each items as opt (opt)}
					<li>
						<button type="button" onclick={() => pick(opt)}>
							<span class="truncate">{opt}</span>
							{#if value === opt}<Check size={14} class="ml-auto shrink-0" />{/if}
						</button>
					</li>
				{/each}
			</ul>
		</details>
	</div>
{:else}
	<input class="input w-full" {placeholder} bind:value oninput={() => oninput?.()} />
{/if}
