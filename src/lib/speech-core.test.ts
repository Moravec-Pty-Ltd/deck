import { describe, expect, it } from 'vitest';
import { matchSpokenAnswer, questionSpeech, segmentSpeech, spokenText } from './speech-core';

describe('spokenText', () => {
	it('drops code blocks and tables to a marker and strips syntax', () => {
		const md = [
			'## Done',
			'',
			'I changed `src/app.ts` and **two** tests, see [the diff](https://example.com/pr/1).',
			'',
			'```ts',
			'const x = 1;',
			'```',
			'',
			'| a | b |',
			'| - | - |',
			'| 1 | 2 |',
			'',
			'- first point',
			'2. second point',
			'> quoted',
			'More at https://docs.example.com/guide?x=1 now.'
		].join('\n');
		expect(spokenText(md)).toBe(
			[
				'Done',
				'',
				'I changed src/app.ts and two tests, see the diff.',
				'',
				'Code omitted.',
				'',
				'Table omitted.',
				'',
				'first point',
				'second point',
				'quoted',
				'More at docs.example.com now.'
			].join('\n')
		);
	});

	it('keeps an unterminated code fence from swallowing nothing else', () => {
		expect(spokenText('Look:\n```\nunfinished')).toBe('Look:\n\nCode omitted.');
	});

	it('leaves plain prose and underscores in identifiers alone', () => {
		expect(spokenText('Rename issue_id to issueId, then 3 * 4.')).toBe('Rename issue_id to issueId, then 3 * 4.');
	});
});

describe('segmentSpeech', () => {
	it('cuts the first segment short, then packs a few sentences per segment', () => {
		const text = 'First. ' + 'A short sentence follows. '.repeat(12);
		const segments = segmentSpeech(text);
		expect(segments[0]).toBe('First. A short sentence follows. A short sentence follows.');
		expect(segmentSpeech('One long opening sentence that already carries enough words to start with. Second.')[0]).toBe(
			'One long opening sentence that already carries enough words to start with.'
		);
		expect(segments.length).toBeGreaterThan(1);
		expect(segments.every((s) => s.length <= 320)).toBe(true);
		expect(segments.slice(1).some((s) => s.split('. ').length > 1)).toBe(true);
	});

	it('splits a very long sentence at clause boundaries and respects paragraphs', () => {
		const long = Array.from({ length: 40 }, (_, i) => `clause ${i}`).join(', ') + '.';
		const segments = segmentSpeech(`${long}\n\nNext paragraph.`);
		expect(segments.every((s) => s.length <= 320)).toBe(true);
		expect(segments.at(-1)).toBe('Next paragraph.');
	});

	it('does not split on decimals or abbreviations without a following space', () => {
		expect(segmentSpeech('Version 2.5 shipped. Done!')).toEqual(['Version 2.5 shipped. Done!']);
		expect(segmentSpeech('Version 2.5 shipped')).toEqual(['Version 2.5 shipped']);
		expect(segmentSpeech('')).toEqual([]);
	});
});

describe('questions', () => {
	const options = [{ label: 'Rewrite' }, { label: 'Patch it' }, { label: 'Leave as is' }];

	it('reads the question with numbered options', () => {
		expect(questionSpeech({ question: 'How should I fix it?', options }, 0, 2)).toBe(
			'Question 1 of 2. How should I fix it? Options: one, Rewrite. two, Patch it. three, Leave as is.'
		);
		expect(questionSpeech({ question: 'Continue?', options: [{ label: 'Yes' }] })).toBe('Continue? Options: one, Yes.');
	});

	it('matches labels, numbers, and ordinals', () => {
		expect(matchSpokenAnswer('Patch it.', options)).toBe('Patch it');
		expect(matchSpokenAnswer('two', options)).toBe('Patch it');
		expect(matchSpokenAnswer('Option 3', options)).toBe('Leave as is');
		expect(matchSpokenAnswer('the second one', options)).toBe('Patch it');
		expect(matchSpokenAnswer('rewrite please', options)).toBe('Rewrite');
		expect(matchSpokenAnswer("Let's leave as is for now", options)).toBe('Leave as is');
	});

	it('falls back to free text when nothing matches or several do', () => {
		expect(matchSpokenAnswer('Actually, do something else entirely', options)).toBeNull();
		expect(matchSpokenAnswer('rewrite and then patch it', options)).toBeNull();
		expect(matchSpokenAnswer('', options)).toBeNull();
		expect(matchSpokenAnswer('two', [])).toBeNull();
	});
});
