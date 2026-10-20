<script lang="ts">
	import { Check } from '@lucide/svelte';
	import { THEMES } from '$lib/theme-core';
	import { THEME_ICONS, themeUi } from '$lib/theme.svelte';
</script>

<fieldset class="grid gap-2 sm:grid-cols-3">
	<legend class="sr-only">Theme</legend>
	{#each THEMES as t (t.id)}
		{@const Icon = THEME_ICONS[t.id]}
		{@const selected = themeUi.current === t.id}
		<label
			class="theme-option flex cursor-pointer items-start gap-3 rounded-box border bg-base-100 p-3 {selected
				? 'border-primary'
				: 'border-base-300'}"
		>
			<input
				type="radio"
				name="theme"
				class="sr-only"
				value={t.id}
				checked={selected}
				onchange={() => themeUi.set(t.id)}
			/>
			<Icon size={16} class="mt-0.5 shrink-0" />
			<span class="min-w-0 flex-1">
				<span class="block text-sm {selected ? 'font-semibold' : 'font-medium'}">{t.label}</span>
				<span class="block text-xs opacity-70">{t.description}</span>
			</span>
			{#if selected}<Check size={16} class="mt-0.5 shrink-0 text-primary" aria-hidden="true" />{/if}
		</label>
	{/each}
</fieldset>

<style>
	.theme-option:has(:focus-visible) {
		outline: 2px solid var(--color-primary);
		outline-offset: 2px;
	}
</style>
