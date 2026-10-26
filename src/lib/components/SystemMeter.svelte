<script lang="ts">
	import { systemMonitor } from '$lib/system-stats.svelte';
	import { formatBytesShort, level, sparkArea, sparkPoints } from '$lib/system-stats-core';

	// CPU, memory and disk use of the machine deck runs on: each a number and a
	// sparkline of the last three minutes. Tiny by design, for a header corner.
	$effect(() => systemMonitor.use());

	const W = 36;
	const H = 12;
	const LEVEL_CLASS = { ok: '', warn: 'text-warning', high: 'text-error' };

	const rows = $derived.by(() => {
		const s = systemMonitor.latest;
		if (!s) return [];
		return [
			{ label: 'CPU', history: systemMonitor.cpu, title: `CPU ${Math.round(s.cpu)}%` },
			{
				label: 'RAM',
				history: systemMonitor.mem,
				title: `Memory ${formatBytesShort(s.mem.used)} of ${formatBytesShort(s.mem.total)}`
			},
			{
				label: 'SSD',
				history: systemMonitor.disk,
				title: `Disk ${formatBytesShort(s.disk.used)} of ${formatBytesShort(s.disk.total)}`
			}
		].map((r) => {
			const value = r.history.at(-1) ?? 0;
			return { ...r, value, cls: LEVEL_CLASS[level(value)] };
		});
	});
</script>

{#if rows.length}
	<div class="flex shrink-0 items-center gap-2 text-[0.625rem] leading-none" role="group" aria-label="Server load">
		{#each rows as r (r.label)}
			<div class="flex flex-col gap-0.5 {r.cls}" title={r.title} aria-label="{r.title}, {Math.round(r.value)}%">
				<span class="flex justify-between gap-1 tabular-nums">
					<span class="opacity-60">{r.label}</span>
					<span class="font-semibold">{Math.round(r.value)}%</span>
				</span>
				<svg width={W} height={H} viewBox="0 0 {W} {H}" class="overflow-visible" aria-hidden="true">
					<line x1="0" y1={H} x2={W} y2={H} stroke="currentColor" stroke-opacity="0.15" />
					<polygon points={sparkArea(r.history, W, H)} fill="currentColor" opacity="0.2" />
					<polyline
						points={sparkPoints(r.history, W, H)}
						fill="none"
						stroke="currentColor"
						stroke-width="1.25"
						stroke-linejoin="round"
						stroke-linecap="round"
						opacity="0.85"
					/>
				</svg>
			</div>
		{/each}
	</div>
{/if}
