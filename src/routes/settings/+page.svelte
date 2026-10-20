<script lang="ts">
	import { QrCode } from '@lucide/svelte';
	import SettingsSection from '$lib/components/SettingsSection.svelte';
	import ThemeSettings from '$lib/components/ThemeSettings.svelte';
	import SpeechSettings from '$lib/components/SpeechSettings.svelte';
	import OperatorSettings from '$lib/components/OperatorSettings.svelte';
	import CompactSettings from '$lib/components/CompactSettings.svelte';
	import AgentSkills from '$lib/components/AgentSkills.svelte';
	import PairApprovals from '$lib/components/PairApprovals.svelte';
	import QrModal from '$lib/components/QrModal.svelte';
	import ZedSettings from '$lib/components/ZedSettings.svelte';

	const SECTIONS = {
		theme: { title: 'Theme', description: 'How deck looks on this device. Saved in this browser only.' },
		voice: {
			title: 'Voice',
			description: 'The speech servers that read replies aloud and turn what you say into messages.'
		},
		operator: {
			title: 'Watch operator',
			description:
				'The model behind the hands-free operator on Apple Watch, which cannot run one on the device.'
		},
		compact: {
			title: 'Auto-compact',
			description: 'Compact a Claude session before its context window fills, at a point you pick.'
		},
		skills: { title: 'Agent skills', description: 'Teach each installed coding agent to drive deck.' },
		devices: {
			title: 'Devices',
			description: 'Sign in another phone or browser, and approve devices that ask for access.'
		},
		editor: { title: 'Editor', description: 'Where "Open in Zed" connects over SSH.' }
	} as const;

	type SectionId = keyof typeof SECTIONS;
	const ORDER = Object.keys(SECTIONS) as SectionId[];

	let qrOpen = $state(false);
	let active = $state<SectionId>('theme');
	// A jump near the end of the page can't bring its section to the top, so the
	// observer would mark one above it; hold the clicked section while it lands.
	let heldUntil = 0;

	function jumpTo(id: SectionId) {
		active = id;
		heldUntil = performance.now() + 600;
	}

	// Mark the section nearest the top of the scroll area in the side nav.
	$effect(() => {
		const visible = new Set<string>();
		const observer = new IntersectionObserver(
			(entries) => {
				for (const e of entries) {
					if (e.isIntersecting) visible.add(e.target.id);
					else visible.delete(e.target.id);
				}
				const first = ORDER.find((id) => visible.has(id));
				if (first && performance.now() > heldUntil) active = first;
			},
			{ rootMargin: '0px 0px -60% 0px' }
		);
		for (const id of ORDER) {
			const el = document.getElementById(id);
			if (el) observer.observe(el);
		}
		return () => observer.disconnect();
	});
</script>

<svelte:head><title>Settings · deck</title></svelte:head>

<div class="mb-4 flex items-center gap-2">
	<h1 class="text-lg font-semibold">Settings</h1>
</div>

<div class="md:grid md:grid-cols-[10rem_minmax(0,1fr)] md:gap-8">
	<nav aria-label="Settings sections" class="hidden md:block">
		<ul class="sticky top-0 m-0 list-none space-y-0.5 p-0">
			{#each ORDER as id (id)}
				<li>
					<a
						href="#{id}"
						class="block border-l-2 px-3 py-1.5 text-sm {active === id
							? 'border-primary font-semibold'
							: 'border-base-300 opacity-70 hover:opacity-100'}"
						aria-current={active === id ? 'location' : undefined}
						onclick={() => jumpTo(id)}
					>
						{SECTIONS[id].title}
					</a>
				</li>
			{/each}
		</ul>
	</nav>

	<div class="min-w-0 max-w-3xl space-y-8 pb-8">
		<SettingsSection id="theme" {...SECTIONS.theme}>
			<ThemeSettings />
		</SettingsSection>

		<SettingsSection id="voice" {...SECTIONS.voice}>
			<SpeechSettings />
		</SettingsSection>

		<SettingsSection id="operator" {...SECTIONS.operator}>
			<OperatorSettings />
		</SettingsSection>

		<SettingsSection id="compact" {...SECTIONS.compact}>
			<CompactSettings />
		</SettingsSection>

		<SettingsSection id="skills" {...SECTIONS.skills}>
			<AgentSkills />
		</SettingsSection>

		<SettingsSection id="devices" {...SECTIONS.devices}>
			<div class="divide-y divide-base-300 rounded-box border border-base-300 bg-base-100">
				<div class="flex flex-wrap items-center gap-3 p-4">
					<div class="min-w-0 flex-1 basis-56">
						<div class="text-sm font-medium">Sign-in QR code</div>
						<p class="m-0 text-xs opacity-70">
							Scan it from a phone or tablet on the same network to sign it in. It grants full,
							long-lived access.
						</p>
					</div>
					<button class="btn btn-sm" onclick={() => (qrOpen = true)}>
						<QrCode size={15} /> Show QR code
					</button>
				</div>
				<div class="p-4">
					<div class="text-sm font-medium">Access requests</div>
					<p class="mt-0 mb-3 text-xs opacity-70">
						A device that asks to pair shows a code. Approve it here only if the codes match.
					</p>
					<PairApprovals empty="No device is waiting for approval." />
				</div>
			</div>
		</SettingsSection>

		<SettingsSection id="editor" {...SECTIONS.editor}>
			<ZedSettings />
		</SettingsSection>
	</div>
</div>

<QrModal bind:open={qrOpen} />
