import { describe, expect, it } from 'vitest';
import { resolveAvailability } from './available-core';
import { AGENT_BINARIES } from './binaries';

describe('resolveAvailability', () => {
	it('probes each kind by its mapped binary and reflects the result', async () => {
		const asked: string[] = [];
		const installed = new Set(['claude', 'pi']);
		const result = await resolveAvailability(async (cmd) => {
			asked.push(cmd);
			return installed.has(cmd);
		});
		expect(new Set(asked)).toEqual(new Set(Object.values(AGENT_BINARIES)));
		expect(result).toEqual({ claude: true, pi: true, codex: false, opencode: false });
	});

	it('covers exactly the agent kinds — no shell, no extras', async () => {
		const result = await resolveAvailability(async () => true);
		expect(Object.keys(result).sort()).toEqual(['claude', 'codex', 'opencode', 'pi']);
	});

	it('treats a rejecting probe as not installed (fail-soft)', async () => {
		const result = await resolveAvailability(async (cmd) => {
			if (cmd === 'codex') throw new Error('which exploded');
			return true;
		});
		expect(result).toEqual({ claude: true, pi: true, codex: false, opencode: true });
	});
});
