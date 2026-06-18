<script lang="ts">
	// Render text with http(s) URLs turned into links, without using {@html}.
	let { text }: { text: string } = $props();

	const URL_RE = /(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

	const parts = $derived.by(() => {
		const out: { url: boolean; value: string }[] = [];
		let last = 0;
		let m: RegExpExecArray | null;
		URL_RE.lastIndex = 0;
		while ((m = URL_RE.exec(text)) !== null) {
			if (m.index > last) out.push({ url: false, value: text.slice(last, m.index) });
			out.push({ url: true, value: m[0] });
			last = m.index + m[0].length;
		}
		if (last < text.length) out.push({ url: false, value: text.slice(last) });
		return out;
	});
</script>
{#each parts as p, i (i)}{#if p.url}<a
			href={p.value}
			target="_blank"
			rel="noopener noreferrer"
			class="link link-primary break-all">{p.value}</a>{:else}{p.value}{/if}{/each}
