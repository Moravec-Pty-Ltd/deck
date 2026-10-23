import { describe, expect, it } from 'vitest';
import { briefSpokenText, REST_ON_SCREEN, looksFinished, settledTake, matchSpokenAnswer, questionSpeech, segmentSpeech, spokenText } from './speech-core';

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

describe('endpointing', () => {
	it('treats a sentence with closing punctuation as finished', () => {
		for (const t of ['Open the pull request.', 'Is it done?', 'Stop!', 'He said "go."', ' Run the tests. ']) expect(looksFinished(t), t).toBe(true);
	});
	it('keeps listening through a trailing word, an ellipsis or no punctuation', () => {
		for (const t of ['', 'Open the pull request', 'Open the pull request and.', 'and...', 'Run the tests…', 'I want to.', 'Fix it, um.'])
			expect(looksFinished(t), t).toBe(false);
	});
	it('ends a take on a finished sentence once a second of silence was heard', () => {
		expect(settledTake('Open the pull request.', 1000)).toBe(true);
		expect(settledTake('Open the pull request.', 600)).toBe(false);
		expect(settledTake('Open the pull request and', 3000)).toBe(false);
	});
});

describe('briefSpokenText', () => {
	const detail = ' The detail runs on for a while so that the reply is long enough to need cutting short.'.repeat(4);

	it('reads a short reply whole, structure and all', () => {
		expect(briefSpokenText('All tests pass.')).toBe('All tests pass.');
		expect(briefSpokenText('Two changes:\n- one\n- two')).toBe('Two changes:\none\ntwo');
		expect(briefSpokenText('Result is 3.\r\n\r\nMore detail.')).toBe('Result is 3.\n\nMore detail.');
	});

	it('stops a long reply at the first heading, list, table or code block after the opening', () => {
		const opening = 'The build failed on a type error.';
		expect(briefSpokenText(`${opening}\n\n## Details\n\n${detail}`)).toBe(`${opening} ${REST_ON_SCREEN}`);
		expect(briefSpokenText(`${opening}\n- one\n- two\n${detail}`)).toBe(`${opening} ${REST_ON_SCREEN}`);
		expect(briefSpokenText(`${opening}\n\`\`\`ts\nconst a = 1;\n\`\`\`\n${detail}`)).toBe(`${opening} ${REST_ON_SCREEN}`);
		expect(briefSpokenText(`${opening}\n| a | b |\n|---|---|\n${detail}`)).toBe(`${opening} ${REST_ON_SCREEN}`);
	});

	it('reads past a short lead-in paragraph to the answer', () => {
		const spoken = briefSpokenText(`Sure.\n\nThe build failed because of a type error.${detail}`);
		expect(spoken.startsWith('Sure.\n\nThe build failed')).toBe(true);
		expect(spoken.endsWith(REST_ON_SCREEN)).toBe(true);
	});

	it('keeps a leading heading or code block and cuts at the next structure', () => {
		expect(briefSpokenText(`## Summary\nIt works.\n- ${detail}`)).toBe(`Summary\nIt works. ${REST_ON_SCREEN}`);
		expect(briefSpokenText(`\`\`\`\n- not a list\n\`\`\`\nDone.\n## More\n${detail}`)).toBe(`Code omitted.\n\nDone. ${REST_ON_SCREEN}`);
	});

	it('caps long prose at a sentence end within 300 characters, about 20 seconds aloud', () => {
		const reply = 'It failed on a type error. The fix is one line. Tests pass now.\n\n' + detail + '\n\n' + detail;
		const spoken = briefSpokenText(reply);
		const opening = spoken.slice(0, -REST_ON_SCREEN.length - 1);
		expect(spoken.endsWith(` ${REST_ON_SCREEN}`)).toBe(true);
		expect(opening.length).toBeLessThanOrEqual(300);
		expect(opening.endsWith('.')).toBe(true);
		expect(briefSpokenText('word '.repeat(200)).length).toBeLessThanOrEqual(300 + REST_ON_SCREEN.length + 1);
		const edge = 'x'.repeat(298) + '. more words follow here and keep going for a while longer than the cap';
		expect(briefSpokenText(edge)).toBe(`${'x'.repeat(298)}. ${REST_ON_SCREEN}`);
		const leadIn = briefSpokenText('Sure. ' + 'words without a stop '.repeat(30));
		expect(leadIn.length).toBeGreaterThan(200);
	});
});
