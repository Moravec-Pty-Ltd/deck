<script lang="ts">
	import type { Snippet } from 'svelte';
	import { dismissOnOutside, keepInView } from '$lib/dismiss';

	// The one trigger + panel primitive behind every menu (model, PR, servers,
	// quick messages, combo suggestions). On desktop it is a daisyUI
	// <details> dropdown anchored to its trigger; below the sm breakpoint the
	// panel becomes a bottom drawer (see .popover-* in layout.css) so actions
	// land in thumb reach instead of a cramped popover at the top of the screen.
	// The backdrop only exists in drawer mode; on desktop dismissOnOutside does
	// the closing.
	//
	// `drawer={false}` keeps the plain dropdown at every size. Needed inside a
	// daisyUI modal: .modal-box carries scale/translate, which makes it the
	// containing block for position: fixed, so a drawer there would pin to (and
	// clip inside) the modal box instead of the viewport.
	let {
		open = $bindable(false),
		direction = 'bottom',
		drawer = true,
		summaryClass = '',
		summaryTitle,
		summaryLabel,
		summaryStyle,
		panelClass = '',
		trigger,
		children
	}: {
		open?: boolean;
		direction?: 'bottom' | 'top';
		drawer?: boolean;
		summaryClass?: string;
		summaryTitle?: string;
		summaryLabel?: string;
		summaryStyle?: string;
		// Panel sizing (width, padding). In drawer mode the mobile sheet CSS
		// overrides width/margins below sm, so widths here are desktop sizing.
		panelClass?: string;
		trigger: Snippet;
		children: Snippet;
	} = $props();
</script>

<details
	class="dropdown dropdown-end shrink-0 {direction === 'top' ? 'dropdown-top' : ''} {drawer
		? 'popover-host'
		: ''}"
	bind:open
	use:dismissOnOutside={() => (open = false)}
>
	<summary
		class="cursor-pointer list-none [&::-webkit-details-marker]:hidden {summaryClass}"
		title={summaryTitle}
		aria-label={summaryLabel}
		style={summaryStyle}
	>
		{@render trigger()}
	</summary>
	{#if drawer}
		<button
			class="popover-backdrop"
			tabindex="-1"
			aria-label="Close menu"
			onclick={() => (open = false)}
		></button>
	{/if}
	<div
		class="dropdown-content z-20 rounded-box border border-base-300 bg-base-100 text-sm {direction ===
		'top'
			? 'mb-1'
			: 'mt-1'} {drawer ? 'popover-panel' : ''} {panelClass}"
		use:keepInView
	>
		{#if drawer}
			<div class="popover-grip" aria-hidden="true"></div>
		{/if}
		{@render children()}
	</div>
</details>
