<script lang="ts">
	import type { Project, DevConfig, ServerSpec, SetupStep, PortSpec } from '$lib/types';
	import { createProjectSaver, move } from './project-form.svelte';
	import { Plus, Trash2, ChevronUp, ChevronDown, Check, Server } from '@lucide/svelte';

	let { project, onchanged }: { project: Project; onchanged: () => void } = $props();

	// Editable working copies. Reassigned (not mutated) so Svelte tracks them.
	// Seeded on open, not at mount: the card outlives project reloads, so a
	// mount-time copy would go stale (and clobber on save) when the config
	// changes elsewhere. Collapsing the editor discards unsaved edits.
	let copyFromMain = $state<string[]>([]);
	let setup = $state<SetupStep[]>([]);
	let servers = $state<ServerSpec[]>([]);

	let open = $state(false);
	const saver = createProjectSaver(() => onchanged());

	function toggle() {
		if (!open) {
			copyFromMain = [...(project.dev?.copyFromMain ?? [])];
			setup = cloneSteps(project.dev?.setup);
			servers = cloneServers(project.dev?.servers);
		}
		open = !open;
	}

	function cloneSteps(steps: SetupStep[] | undefined): SetupStep[] {
		return (steps ?? []).map((s) => ({ label: s.label, run: s.run, cwd: s.cwd ?? '' }));
	}
	function clonePorts(ports: PortSpec[] | undefined): PortSpec[] {
		return (ports ?? []).map((p) => ({ port: p.port, label: p.label ?? '', primary: !!p.primary }));
	}
	function cloneServers(list: ServerSpec[] | undefined): ServerSpec[] {
		return (list ?? []).map((s) => ({
			name: s.name,
			run: s.run,
			cwd: s.cwd ?? '',
			readyPattern: s.readyPattern ?? '',
			ports: clonePorts(s.ports),
			setup: cloneSteps(s.setup)
		}));
	}

	const serverCount = $derived(open ? servers.length : (project.dev?.servers?.length ?? 0));

	// --- copyFromMain ---
	function addCopy() {
		copyFromMain = [...copyFromMain, ''];
	}
	function removeCopy(i: number) {
		copyFromMain = copyFromMain.filter((_, idx) => idx !== i);
	}

	// --- ordered step lists (shared setup, or a server's own setup) ---
	function addStep(list: SetupStep[]): SetupStep[] {
		return [...list, { label: '', run: '', cwd: '' }];
	}

	// --- servers ---
	function addServer() {
		servers = [...servers, { name: '', run: '', cwd: '', readyPattern: '', ports: [], setup: [] }];
	}
	function removeServer(i: number) {
		servers = servers.filter((_, idx) => idx !== i);
	}
	function addPort(s: ServerSpec) {
		s.ports = [...(s.ports ?? []), { port: 3000, label: '', primary: false }];
		servers = [...servers];
	}
	function removePort(s: ServerSpec, i: number) {
		s.ports = (s.ports ?? []).filter((_, idx) => idx !== i);
		servers = [...servers];
	}
	function setPrimary(s: ServerSpec, i: number) {
		s.ports = (s.ports ?? []).map((p, idx) => ({ ...p, primary: idx === i }));
		servers = [...servers];
	}

	// --- build + save ---
	function cleanSteps(steps: SetupStep[] | undefined): SetupStep[] {
		return (steps ?? [])
			.filter((s) => s.label.trim() && s.run.trim())
			.map((s) => ({ label: s.label.trim(), run: s.run.trim(), cwd: s.cwd?.trim() || undefined }));
	}
	function cleanPorts(ports: PortSpec[] | undefined): PortSpec[] {
		// Match the API's zod contract (int, 1..65535) so a bad port fails here with
		// inline feedback rather than as a server-side save error.
		return (ports ?? [])
			.filter((p) => {
				const n = Number(p.port);
				return Number.isInteger(n) && n >= 1 && n <= 65535;
			})
			.map((p) => ({ port: Number(p.port), label: p.label?.trim() || undefined, primary: p.primary || undefined }));
	}
	function cleanServers(): ServerSpec[] {
		return servers
			.filter((s) => s.name.trim() && s.run.trim())
			.map((s) => ({
				name: s.name.trim(),
				run: s.run.trim(),
				cwd: s.cwd?.trim() || undefined,
				readyPattern: s.readyPattern?.trim() || undefined,
				ports: cleanPorts(s.ports),
				setup: cleanSteps(s.setup)
			}));
	}
	function buildDev(): DevConfig {
		return {
			copyFromMain: copyFromMain.map((p) => p.trim()).filter(Boolean),
			setup: cleanSteps(setup),
			servers: cleanServers()
		};
	}

	function save() {
		// Only the fields this form owns: the API carries everything omitted.
		saver.save({ path: project.path, name: project.name, dev: buildDev() });
	}
</script>

<div class="mt-3">
	<button class="flex items-center gap-2 text-xs font-medium opacity-60" onclick={toggle}>
		<Server size={13} />
		Dev servers{#if serverCount}<span class="badge badge-ghost badge-xs">{serverCount}</span>{/if}
		<ChevronDown size={13} class={open ? '' : '-rotate-90'} />
	</button>

	{#if open}
		<div class="mt-2 space-y-4 rounded-box border border-dashed border-base-300 p-3">
			{#if saver.errorMsg}
				<div class="alert alert-error py-1 text-xs">{saver.errorMsg}</div>
			{/if}

			<p class="text-[11px] opacity-50">
				Steps and the run command can use
				<code class="font-mono">$DECK_WORKTREE</code> (session worktree) and
				<code class="font-mono">$DECK_MAIN</code> (project main checkout).
			</p>

			<!-- copyFromMain -->
			<div>
				<div class="mb-1 text-xs font-medium opacity-70">Copy from main worktree</div>
				<div class="space-y-1">
					{#each copyFromMain as _, i (i)}
						<div class="flex items-center gap-2">
							<input
								class="input input-xs flex-1 font-mono"
								placeholder="apps/api/.env.local"
								bind:value={copyFromMain[i]}
							/>
							<button class="btn btn-ghost btn-xs" onclick={() => removeCopy(i)} aria-label="Remove">
								<Trash2 size={12} />
							</button>
						</div>
					{/each}
				</div>
				<button class="btn btn-ghost btn-xs mt-1" onclick={addCopy}><Plus size={12} /> file</button>
			</div>

			<!-- shared setup -->
			<div>
				<div class="mb-1 text-xs font-medium opacity-70">Shared setup steps</div>
				<div class="space-y-2">
					{#each setup as _, i (i)}
						<div class="rounded border border-base-300 p-2">
							<div class="flex items-center gap-2">
								<input class="input input-xs flex-1" placeholder="label" bind:value={setup[i].label} />
								<input class="input input-xs w-28 font-mono" placeholder="cwd (.)" bind:value={setup[i].cwd} />
								<button class="btn btn-ghost btn-xs" onclick={() => (setup = move(setup, i, -1))} aria-label="Up"><ChevronUp size={12} /></button>
								<button class="btn btn-ghost btn-xs" onclick={() => (setup = move(setup, i, 1))} aria-label="Down"><ChevronDown size={12} /></button>
								<button class="btn btn-ghost btn-xs" onclick={() => (setup = setup.filter((_, idx) => idx !== i))} aria-label="Remove"><Trash2 size={12} /></button>
							</div>
							<input class="input input-xs mt-1 w-full font-mono" placeholder="run (e.g. pnpm install)" bind:value={setup[i].run} />
						</div>
					{/each}
				</div>
				<button class="btn btn-ghost btn-xs mt-1" onclick={() => (setup = addStep(setup))}><Plus size={12} /> step</button>
			</div>

			<!-- servers -->
			<div>
				<div class="mb-1 text-xs font-medium opacity-70">Servers</div>
				<div class="space-y-3">
					{#each servers as s, si (si)}
						<div class="rounded-box border border-base-300 bg-base-200/40 p-2">
							<div class="flex items-center gap-2">
								<input class="input input-xs flex-1" placeholder="name (web)" bind:value={s.name} />
								<input class="input input-xs w-28 font-mono" placeholder="cwd (.)" bind:value={s.cwd} />
								<button class="btn btn-ghost btn-xs" onclick={() => removeServer(si)} aria-label="Remove server"><Trash2 size={13} /></button>
							</div>
							<input class="input input-xs mt-1 w-full font-mono" placeholder="run (pnpm dev)" bind:value={s.run} />
							<input class="input input-xs mt-1 w-full font-mono" placeholder={'readyPattern (Local:\\s+(http\\S+))'} bind:value={s.readyPattern} />

							<!-- ports -->
							<div class="mt-2">
								<div class="mb-1 text-[11px] font-medium opacity-60">Ports</div>
								<div class="space-y-1">
									{#each s.ports ?? [] as p, pi (pi)}
										<div class="flex items-center gap-2">
											<input class="input input-xs w-20" type="number" placeholder="port" bind:value={p.port} />
											<input class="input input-xs flex-1" placeholder="label" bind:value={p.label} />
											<label class="label cursor-pointer gap-1 text-[11px]">
												<input type="radio" class="radio radio-xs" checked={p.primary} onchange={() => setPrimary(s, pi)} />
												primary
											</label>
											<button class="btn btn-ghost btn-xs" onclick={() => removePort(s, pi)} aria-label="Remove port"><Trash2 size={11} /></button>
										</div>
									{/each}
								</div>
								<button class="btn btn-ghost btn-xs mt-1" onclick={() => addPort(s)}><Plus size={11} /> port</button>
							</div>

							<!-- per-server setup -->
							<div class="mt-2">
								<div class="mb-1 text-[11px] font-medium opacity-60">Per-server setup (after shared)</div>
								<div class="space-y-1">
									{#each s.setup ?? [] as _, ssi (ssi)}
										<div class="rounded border border-base-300 p-1.5">
											<div class="flex items-center gap-2">
												<input class="input input-xs flex-1" placeholder="label" bind:value={s.setup![ssi].label} />
												<input class="input input-xs w-24 font-mono" placeholder="cwd" bind:value={s.setup![ssi].cwd} />
												<button class="btn btn-ghost btn-xs" onclick={() => { s.setup = (s.setup ?? []).filter((_, idx) => idx !== ssi); servers = [...servers]; }} aria-label="Remove step"><Trash2 size={11} /></button>
											</div>
											<input class="input input-xs mt-1 w-full font-mono" placeholder="run" bind:value={s.setup![ssi].run} />
										</div>
									{/each}
								</div>
								<button class="btn btn-ghost btn-xs mt-1" onclick={() => { s.setup = addStep(s.setup ?? []); servers = [...servers]; }}><Plus size={11} /> step</button>
							</div>
						</div>
					{/each}
				</div>
				<button class="btn btn-ghost btn-xs mt-1" onclick={addServer}><Plus size={12} /> server</button>
			</div>

			<div class="flex items-center justify-end gap-2">
				{#if saver.saved}<span class="flex items-center gap-1 text-xs text-success"><Check size={13} /> saved</span>{/if}
				<button class="btn btn-sm btn-primary" disabled={saver.busy} onclick={save}>Save dev config</button>
			</div>
		</div>
	{/if}
</div>
