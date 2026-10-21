#!/usr/bin/env node
// Stands in for APNs while the UI tests run: `node push-asks.mjs <deck-url> <udid>`,
// token in DECK_UITEST_TOKEN. Each new pending ask on the deck is pushed once
// to the simulator with `xcrun simctl push`, shaped as apns-core.ts shapes it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [url, udid] = process.argv.slice(2);
const token = process.env.DECK_UITEST_TOKEN;
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-push-')), 'push.json');
process.on('exit', () => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));
const pushed = new Set();

async function poll() {
	let asks = [];
	try {
		const res = await fetch(`${url}/api/agent/asks`, { headers: { authorization: `Bearer ${token}` } });
		if (res.ok) asks = await res.json();
	} catch {
		return;
	}
	for (const ask of asks) {
		if (ask.source !== 'mcp' || pushed.has(ask.askId)) continue;
		pushed.add(ask.askId);
		const first = ask.questions[0];
		const options = first.options.map((o) => o.label).slice(0, 3);
		const payload = {
			aps: {
				alert: { title: 'Needs your answer', body: `${first.question}\n${options.map((l, i) => `${i + 1} ${l}`).join(' · ')}` },
				category: 'DECK_ASK'
			},
			url: `/s/${ask.sessionId}`,
			ask: { sessionId: ask.sessionId, askId: ask.askId, header: first.header, options, questions: ask.questions.length }
		};
		fs.writeFileSync(file, JSON.stringify(payload));
		execFileSync('xcrun', ['simctl', 'push', udid, 'tech.moravec.deck', file], { stdio: 'ignore' });
	}
}

for (;;) {
	await poll();
	await new Promise((resolve) => setTimeout(resolve, 2_000));
}
