import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseSkillVersion, skillStatus } from './skills-core';

const SKILL = `---
name: deck
description: Drive deck.
version: 1.2.3
---

# deck
`;

describe('parseSkillVersion', () => {
	it('reads the frontmatter version', () => {
		expect(parseSkillVersion(SKILL)).toBe('1.2.3');
	});

	it('returns null without frontmatter or version', () => {
		expect(parseSkillVersion('# just a doc')).toBe(null);
		expect(parseSkillVersion('---\nname: deck\n---\n')).toBe(null);
	});

	it('does not read a version line outside the frontmatter', () => {
		expect(parseSkillVersion('---\nname: deck\n---\nversion: 9.9.9\n')).toBe(null);
	});

	it('tolerates CRLF line endings', () => {
		expect(parseSkillVersion(SKILL.replace(/\n/g, '\r\n'))).toBe('1.2.3');
	});

	it('parses the shipped skill (frontmatter must not drift)', () => {
		const shipped = fs.readFileSync(
			path.join(__dirname, '../../../.claude/skills/deck/SKILL.md'),
			'utf8'
		);
		expect(parseSkillVersion(shipped)).toMatch(/^\d+\.\d+\.\d+$/);
	});
});

describe('skillStatus', () => {
	const base = { kind: 'claude' as const, available: true, supported: true, shippedVersion: '1.2.3' };

	it('up to date when installed version matches shipped', () => {
		const s = skillStatus({ ...base, installedMd: SKILL });
		expect(s).toMatchObject({ installed: true, installedVersion: '1.2.3', upToDate: true });
	});

	it('installed but stale when versions differ', () => {
		const s = skillStatus({ ...base, installedMd: SKILL.replace('1.2.3', '1.0.0') });
		expect(s).toMatchObject({ installed: true, installedVersion: '1.0.0', upToDate: false });
	});

	it('not installed when there is no file', () => {
		const s = skillStatus({ ...base, installedMd: null });
		expect(s).toMatchObject({ installed: false, installedVersion: null, upToDate: false });
	});

	it('an installed file without a version is never up to date', () => {
		const s = skillStatus({ ...base, installedMd: '# no frontmatter' });
		expect(s).toMatchObject({ installed: true, installedVersion: null, upToDate: false });
	});

	it('unsupported harness reads as not installed even if a file exists', () => {
		const s = skillStatus({ ...base, supported: false, installedMd: SKILL });
		expect(s).toMatchObject({ supported: false, installed: false, upToDate: false });
	});
});
