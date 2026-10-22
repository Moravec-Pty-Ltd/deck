#!/usr/bin/env node
// Seeds a throwaway deck for the iOS UI tests: `node seed.mjs <root> <speech-url>`.
// <root>/data is DECK_DATA, <root>/files-proj a git project. Every session,
// transcript and file a test looks for by name is made here.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [root, speechUrl] = process.argv.slice(2);
if (!root || !speechUrl) {
	console.error('usage: seed.mjs <root> <speech-url>');
	process.exit(2);
}
const data = path.join(root, 'data');
const project = path.join(root, 'files-proj');
const out = path.join(project, '.deck', 'out');
fs.mkdirSync(path.join(data, 'transcripts'), { recursive: true });
fs.mkdirSync(out, { recursive: true });

const PIXEL_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64'
);
fs.writeFileSync(path.join(project, 'README.md'), '# files-proj\n');
fs.writeFileSync(path.join(project, '.gitignore'), '.deck/\n');
fs.writeFileSync(path.join(out, 'open-flat.png'), PIXEL_PNG);
fs.writeFileSync(path.join(out, 'tabletop.png'), PIXEL_PNG);
// PNG bytes under a .jpg name: deck picks the mime from the extension and the
// app's image decoder reads the bytes, so one pixel serves both.
fs.writeFileSync(path.join(out, 'tabletop-off.jpg'), PIXEL_PNG);
fs.writeFileSync(path.join(out, 'report.csv'), 'name,value\nalpha,1\nbeta,2\n');
const git = (...args) => execFileSync('git', args, { cwd: project, stdio: 'ignore' });
git('init', '-q', '-b', 'main');
git('add', '.');
git('-c', 'user.name=uitest', '-c', 'user.email=uitest@example.com', 'commit', '-q', '-m', 'init');

const user = (text) => ({ type: 'deck.user', text });
const say = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
let toolCount = 0;
const tool = (name, input, result) => {
	const id = `tu_${++toolCount}`;
	return [
		{ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } },
		{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: result }] } }
	];
};
const done = { type: 'result', subtype: 'success', duration_ms: 4_000, num_turns: 1, total_cost_usd: 0.01 };

const file = (name) => path.join(out, name);
// Rows of very different heights (code, wrapped prose, tool cards), as a real
// thread has: a lazy stack re-measures them while scrolling, which is what hid
// the scroll-up bug from a fixture of identical rows.
const long = [];
for (let i = 1; i <= 60; i++) {
	long.push(user(`Step ${i}?`));
	if (i % 5 === 2) long.push(...tool('Bash', { command: `ls step${i}` }, Array.from({ length: 4 + (i % 7) * 4 }, (_, k) => `file${k}.txt`).join('\n')));
	const body =
		i === 60
			? 'Reply 60, the latest message.'
			: i % 4 === 0
				? `Reply ${i}.\n\n\`\`\`ts\n${Array.from({ length: 10 + (i % 6) * 5 }, (_, k) => `const value${k} = compute(${k}, 'step ${i}');`).join('\n')}\n\`\`\``
				: i % 4 === 1
					? `Reply ${i}. ${'This paragraph is long so its height depends on wrapping. '.repeat(8 + (i % 5) * 6)}`
					: `Reply ${i}.`;
	long.push(say(body));
}
long.push(done);

const transcripts = {
	c_yolo: [
		user('Add a yolo badge to the session header when a session runs with bypassPermissions.'),
		say("Good call. I'll add a small badge next to the title, shown only in that mode."),
		...tool('Edit', { file_path: path.join(project, 'README.md'), old_string: '# files-proj', new_string: '# files-proj (yolo)' }, 'The file has been updated.'),
		...tool('Bash', { command: 'pnpm check', description: 'Type-check the change' }, 'svelte-check found 0 errors and 0 warnings'),
		say('Done. The yolo badge shows in the header whenever the session runs with bypassPermissions, and the type-check is clean.'),
		done
	],
	c_stream: [
		user('Stream the token diff into the renderer instead of re-rendering the whole message.'),
		say('Streaming it now: the renderer patches only the tokens that changed.'),
		done
	],
	c_long: long,
	c_files: [
		user('Take the screenshots and export the report.'),
		say(
			`Here they are: ${file('open-flat.png')} ${file('tabletop.png')} ${file('tabletop-off.jpg')} and the numbers in ${file('report.csv')}. ${file('missing.png')} never rendered.`
		),
		done
	],
	c_voice: [user('Pick a colour for me.'), say('You picked Blue, so the accent is blue now.'), done],
	c_ask: [user('Ready for a question.'), say('Ready.'), done]
};

const now = Date.now();
const minute = 60_000;
const claude = (id, title, ago, extra = {}) => ({
	id,
	kind: 'claude',
	title,
	cwd: project,
	createdAt: now - 36 * 60 * minute,
	lastActiveAt: now - ago * minute,
	status: 'idle',
	model: 'opus',
	...extra
});
// An open PR for the PR header and its actions; repo and number are placeholders.
const pr = (number) => ({ repo: 'acme/widgets', number, url: `https://github.com/acme/widgets/pull/${number}`, state: 'open', reviewDecision: 'REVIEW_REQUIRED' });
const sessions = [
	claude('c_yolo', 'Yolo badge in session header', 1, { permissionMode: 'bypassPermissions' }),
	claude('c_stream', 'Stream token diff renderer', 2, { pr: pr(41) }),
	{ id: 's_dev', kind: 'shell', title: 'dev server', cwd: project, createdAt: now - 36 * 60 * minute, lastActiveAt: now - 3 * minute, status: 'idle', tmuxName: 'deck-dev', managed: true },
	claude('c_long', 'long transcript', 4),
	claude('c_files', 'file previews', 5),
	claude('c_voice', 'voice smoke', 6),
	claude('c_ask', 'ask smoke', 7, { pr: pr(42) })
];

const jsonl = (events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
for (const [id, events] of Object.entries(transcripts)) {
	fs.writeFileSync(path.join(data, 'transcripts', `${id}.jsonl`), jsonl(events));
}
fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify(sessions, null, '\t'));
fs.writeFileSync(path.join(data, 'projects.json'), JSON.stringify([{ name: 'files-proj', path: project }]));
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ speech: { ttsUrl: speechUrl, sttUrl: speechUrl } }));
