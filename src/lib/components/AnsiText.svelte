<script lang="ts">
	import Linked from './Linked.svelte';
	import { parseAnsi, type AnsiSegment } from '$lib/ansi';

	let { text }: { text: string } = $props();

	const segments = $derived(parseAnsi(text));

	function styleFor(s: AnsiSegment): string {
		const fg = s.inverse ? (s.bg ?? 'var(--color-base-100)') : s.fg;
		const bg = s.inverse ? (s.fg ?? 'currentColor') : s.bg;
		const parts: string[] = [];
		if (fg) parts.push(`color:${fg}`);
		if (bg) parts.push(`background-color:${bg}`);
		if (s.bold) parts.push('font-weight:600');
		if (s.dim) parts.push('opacity:0.65');
		if (s.italic) parts.push('font-style:italic');
		if (s.underline) parts.push('text-decoration:underline');
		return parts.join(';');
	}
</script>
{#each segments as s, i (i)}<span class="ansi-seg" style={styleFor(s)}><Linked text={s.text} /></span>{/each}
