<script lang="ts">
	// The pi kind has no lucide icon, so render its own π mark as styled text
	// (currentColor, boxed and centred to size like a lucide icon) for the
	// modal's uniform <k.icon size={16} /> slot.
	let { size = 16 }: { size?: number } = $props();
</script>

<span
	class="inline-flex shrink-0 items-center justify-center leading-none"
	style="width: {size}px; height: {size}px; font-size: {size}px"
	aria-hidden="true">π</span>
