<script lang="ts">
	import { ArrowDown, ArrowUp } from '@lucide/svelte';
	import { systemMonitor } from '$lib/system-stats.svelte';
	import { formatBytesShort, formatRate, level, scaleRates, sparkArea, sparkPoints } from '$lib/system-stats-core';

	// CPU, memory, disk and network use of the machine deck runs on: each a
	// number and a sparkline of the last three minutes. Tiny by design, for a
	// header corner.
	$effect(() => systemMonitor.use());

	// Points are drawn in a W x H box and stretched to the cell's CSS width, which
	// is narrower on a phone; the strokes keep their weight either way.
	const W = 36;
	const H = 12;
	const SVG_CLASS = 'h-3 w-9 overflow-visible compact:w-6';
	const LEVEL_CLASS = { ok: '', warn: 'text-warning', high: 'text-error' };

	const rows = $derived.by(() => {
		const s = systemMonitor.latest;
		if (!s) return [];
		return [
			{ label: 'CPU', short: 'C', history: systemMonitor.cpu, title: `CPU ${Math.round(s.cpu)}%` },
			{
				label: 'RAM',
				short: 'R',
				history: systemMonitor.mem,
				title: `Memory ${formatBytesShort(s.mem.used)} of ${formatBytesShort(s.mem.total)}`
			},
			{
				label: 'SSD',
				short: 'D',
				history: systemMonitor.disk,
				title: `Disk ${formatBytesShort(s.disk.used)} of ${formatBytesShort(s.disk.total)}`
			}
		].map((r) => {
			const value = r.history.at(-1) ?? 0;
			return { ...r, value, cls: LEVEL_CLASS[level(value)] };
		});
	});

	// Download as the filled area, upload as a fainter line, both against the
	// busiest moment shown.
	const net = $derived.by(() => {
		const s = systemMonitor.latest;
		if (!s?.net) return null;
		const peak = Math.max(0, ...systemMonitor.down, ...systemMonitor.up);
		return {
			down: s.net.down,
			up: s.net.up,
			downLine: scaleRates(systemMonitor.down, peak),
			upLine: scaleRates(systemMonitor.up, peak),
			title: `Network: down ${formatRate(s.net.down)}B/s, up ${formatRate(s.net.up)}B/s`
		};
	});
</script>

{#if rows.length}
	<div class="flex shrink-0 items-center gap-2 text-[0.625rem] leading-none compact:gap-1.5" role="group" aria-label="Server load">
		{#each rows as r (r.label)}
			<div class="flex flex-col gap-0.5 {r.cls}" title={r.title} aria-label="{r.title}, {Math.round(r.value)}%">
				<span class="flex justify-between gap-1 tabular-nums">
					<span class="opacity-60"><span class="compact:hidden">{r.label}</span><span class="roomy:hidden">{r.short}</span></span>
					<span class="font-semibold">{Math.round(r.value)}%</span>
				</span>
				<svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" class={SVG_CLASS} aria-hidden="true">
					<line x1="0" y1={H} x2={W} y2={H} stroke="currentColor" stroke-opacity="0.15" vector-effect="non-scaling-stroke" />
					<polygon points={sparkArea(r.history, W, H)} fill="currentColor" opacity="0.2" />
					<polyline
						points={sparkPoints(r.history, W, H)}
						fill="none"
						stroke="currentColor"
						stroke-width="1.25"
						vector-effect="non-scaling-stroke"
						stroke-linejoin="round"
						stroke-linecap="round"
						opacity="0.85"
					/>
				</svg>
			</div>
		{/each}
		{#if net}
			<div class="flex flex-col gap-0.5" title={net.title} aria-label={net.title}>
				<span class="flex items-center gap-0.5 font-semibold tabular-nums">
					<ArrowDown size={9} class="opacity-60" />{formatRate(net.down)}
					<ArrowUp size={9} class="ml-0.5 opacity-60" />{formatRate(net.up)}
				</span>
				<svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" class={SVG_CLASS} aria-hidden="true">
					<line x1="0" y1={H} x2={W} y2={H} stroke="currentColor" stroke-opacity="0.15" vector-effect="non-scaling-stroke" />
					<polygon points={sparkArea(net.downLine, W, H)} fill="currentColor" opacity="0.2" />
					<polyline
						points={sparkPoints(net.downLine, W, H)}
						fill="none"
						stroke="currentColor"
						stroke-width="1.25"
						vector-effect="non-scaling-stroke"
						stroke-linejoin="round"
						opacity="0.85"
					/>
					<polyline
						points={sparkPoints(net.upLine, W, H)}
						fill="none"
						stroke="currentColor"
						stroke-width="1"
						vector-effect="non-scaling-stroke"
						stroke-dasharray="2 1.5"
						opacity="0.5"
					/>
				</svg>
			</div>
		{/if}
	</div>
{/if}
