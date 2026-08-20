<script lang="ts">
	// A count whose digits roll when it changes, for the tail run of a turn in
	// flight: each slot is a clipped window over a 0-9 column, so the only animated
	// property is a transform and the digit stays legible on the way.
	let { value }: { value: number } = $props();

	// Slots are keyed by place value, not position, so gaining a digit rolls the
	// ones column 9 -> 0 and adds a slot rather than re-rolling every position.
	const digits = $derived(
		[...String(value)].map((d, i, all) => ({ place: all.length - i, digit: Number(d) }))
	);
	const ten = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
</script>

<span class="rolling" aria-label={String(value)}>
	{#each digits as { place, digit } (place)}
		<span class="slot" aria-hidden="true">
			<span class="column" style="transform: translateY({-digit * 10}%)">
				{#each ten as n (n)}<span class="digit">{n}</span>{/each}
			</span>
		</span>
	{/each}
</span>

<style>
	.rolling {
		/* Three slots reserved so a growing count doesn't shift the rest of the row. */
		display: inline-flex;
		justify-content: flex-end;
		min-width: 3ch;
		font-variant-numeric: tabular-nums;
	}
	.slot {
		display: block;
		height: 1em;
		overflow: hidden;
		line-height: 1;
	}
	.column {
		display: block;
		transition: transform 380ms cubic-bezier(0.16, 1, 0.3, 1);
	}
	.digit {
		display: block;
		height: 1em;
		line-height: 1;
	}
</style>
