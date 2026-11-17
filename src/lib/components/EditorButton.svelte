<script lang="ts">
	import { Code, Check, Copy } from '@lucide/svelte';
	import { createCopier } from '$lib/copy.svelte';
	import type { EditorLink } from '$lib/editors-core';
	import { editorAvailable, inShell, openEditor } from '$lib/shell';

	// Header control for the session's cwd: a link that opens it in the editor over
	// SSH, plus the CLI command, if the editor has one, for a machine the link cannot
	// reach (a browser cannot tell whether the editor is installed). A phone has no
	// editor to take the link, so an editor with no command stays off phone widths.
	// In the Linux shell a zed:// link may have no handler, so the shell runs the
	// command itself, and the item hides when Zed isn't installed.
	let { editor }: { editor: EditorLink } = $props();

	const viaShell = $derived(inShell && !!editor.command);
	let shellHasEditor = $state(false);

	$effect(() => {
		if (viaShell) void editorAvailable().then((ok) => (shellHasEditor = ok));
	});

	function launch(e: MouseEvent) {
		if (!viaShell || !editor.command) return;
		e.preventDefault();
		openEditor(editor.command);
	}

	const copier = createCopier();
	const copied = $derived(copier.copied);

	$effect(() => () => copier.stop());
</script>

{#if !viaShell || shellHasEditor}
	<div class="join shrink-0" class:max-sm:hidden={!editor.command}>
		<a class="btn btn-outline join-item btn-xs header-chip gap-1" href={editor.url} title="Open in {editor.name}" aria-label="Open in {editor.name}" onclick={launch}>
			<Code size={12} />
			<span class="hidden sm:inline">{editor.name}</span>
		</a>
		{#if editor.command}
			{@const command = editor.command}
			<button
				type="button"
				class="btn btn-outline join-item btn-xs header-chip"
				title={copied ? 'Copied' : `Copy: ${command}`}
				aria-label={copied ? 'Copied' : `Copy the ${editor.name} command`}
				onclick={() => copier.copy(command)}
			>
				{#if copied}
					<Check size={12} />
				{:else}
					<Copy size={12} />
				{/if}
			</button>
		{/if}
	</div>
{/if}
