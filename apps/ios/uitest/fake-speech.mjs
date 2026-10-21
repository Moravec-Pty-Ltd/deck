#!/usr/bin/env node
// A stand-in speech server for the UI tests: `node fake-speech.mjs <port>`.
// Speaks the OpenAI audio shapes deck's speech.ts calls. Every sentence reads
// as two seconds of silence, long enough for a UI test to see the bar reading,
// and every take transcribes to nothing.
import http from 'node:http';

const port = Number(process.argv[2]);

function silence(seconds, rate = 16_000) {
	const bytes = Math.round(seconds * rate) * 2;
	const wav = Buffer.alloc(44 + bytes);
	wav.write('RIFF', 0);
	wav.writeUInt32LE(36 + bytes, 4);
	wav.write('WAVEfmt ', 8);
	wav.writeUInt32LE(16, 16);
	wav.writeUInt16LE(1, 20); // PCM
	wav.writeUInt16LE(1, 22); // mono
	wav.writeUInt32LE(rate, 24);
	wav.writeUInt32LE(rate * 2, 28);
	wav.writeUInt16LE(2, 32);
	wav.writeUInt16LE(16, 34);
	wav.write('data', 36);
	wav.writeUInt32LE(bytes, 40);
	return wav;
}
const WAV = silence(2);

http
	.createServer((req, res) => {
		req.resume();
		req.on('end', () => {
			if (req.url === '/health') {
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ voices: ['fake'], default_voice: 'fake', stt: 'fake' }));
			} else if (req.url === '/v1/audio/speech') {
				res.writeHead(200, { 'content-type': 'audio/wav' });
				res.end(WAV);
			} else if (req.url === '/v1/audio/transcriptions') {
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ text: '', seconds: 0 }));
			} else {
				res.writeHead(404).end();
			}
		});
	})
	.listen(port, '127.0.0.1');
