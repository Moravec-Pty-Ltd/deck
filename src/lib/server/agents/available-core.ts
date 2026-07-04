import type { AgentKind } from '$lib/types';
import { AGENT_BINARIES } from './binaries';

export type AgentAvailability = Record<AgentKind, boolean>;

// Build the installed-or-not record by probing each kind's binary through the
// injected `onPath` resolver. A probe that rejects (or returns false) is read as
// "not installed" so one missing/wedged CLI can't fail the whole check. Keeping
// the probe injected keeps this node-free and unit-testable; available.ts wires
// in the real `which` shell-out.
export async function resolveAvailability(
	onPath: (cmd: string) => Promise<boolean>
): Promise<AgentAvailability> {
	const kinds = Object.keys(AGENT_BINARIES) as AgentKind[];
	const entries = await Promise.all(
		kinds.map(async (kind) => {
			try {
				return [kind, await onPath(AGENT_BINARIES[kind])] as const;
			} catch {
				return [kind, false] as const;
			}
		})
	);
	return Object.fromEntries(entries) as AgentAvailability;
}
