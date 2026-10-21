import { defineConfig, devices } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// deck runs against a throwaway root (its HOME, DECK_DATA and a git project),
// with the fake claude and an isolated tmux first on PATH. See e2e/README.md.
const PORT = 4840;
const e2e = path.resolve('e2e');
const PIXEL_PNG =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// The config loads in every worker too; only the first load makes the root.
if (!process.env.DECK_E2E_ROOT) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-e2e-')));
	const project = path.join(root, 'acme');
	const data = path.join(root, 'data');
	fs.mkdirSync(path.join(project, '.deck', 'out'), { recursive: true });
	fs.mkdirSync(path.join(project, 'src'));
	fs.mkdirSync(path.join(root, 'example'));
	fs.mkdirSync(data);
	fs.writeFileSync(path.join(project, 'README.md'), '# acme\n');
	fs.writeFileSync(path.join(project, '.gitignore'), '.deck/\n');
	fs.writeFileSync(path.join(project, 'src', 'answer.ts'), 'export const answer = 42;\n');
	fs.writeFileSync(path.join(project, '.deck', 'out', 'shot.png'), Buffer.from(PIXEL_PNG, 'base64'));
	// Never played, only served: deck picks the player from the extension.
	fs.writeFileSync(path.join(project, '.deck', 'out', 'clip.mp4'), Buffer.alloc(4096, 1));
	const git = (...args: string[]) => execFileSync('git', args, { cwd: project, stdio: 'ignore' });
	git('init', '-q', '-b', 'main');
	git('add', '.');
	git('-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', 'commit', '-q', '-m', 'init');
	fs.writeFileSync(path.join(data, 'projects.json'), JSON.stringify([{ name: 'acme', path: project }]));
	fs.writeFileSync(path.join(data, 'sessions.json'), '[]');
	process.env.DECK_E2E_ROOT = root;
	// Runs in the runner's own process, after the web server has been stopped.
	process.on('exit', () => {
		try {
			execFileSync(realTmux() || 'tmux', ['-L', 'deck-e2e', 'kill-server'], { stdio: 'ignore' });
		} catch {
			// no tmux server was started
		}
		fs.rmSync(root, { recursive: true, force: true });
	});
}
const root = process.env.DECK_E2E_ROOT;

function realTmux(): string {
	try {
		return execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim();
	} catch {
		return '';
	}
}

export default defineConfig({
	testDir: 'e2e',
	timeout: 30_000,
	expect: { timeout: 10_000 },
	fullyParallel: false,
	workers: 1,
	reporter: 'list',
	use: {
		baseURL: `http://localhost:${PORT}`,
		trace: 'retain-on-failure'
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: {
		command: `node node_modules/vite/bin/vite.js dev --port ${PORT} --strictPort`,
		url: `http://localhost:${PORT}/login`,
		reuseExistingServer: false,
		timeout: 60_000,
		env: {
			// Blank any DECK_* the shell carries (a live server's URL, an agent's session id).
			...Object.fromEntries(Object.keys(process.env).filter((k) => k.startsWith('DECK_')).map((k) => [k, ''])),
			HOME: root,
			DECK_DATA: path.join(root, 'data'),
			DECK_TOKEN: 'e2e',
			// The keychain lives under the real HOME; the fixture has no secrets to keep.
			DECK_SECRETS_FILE: '1',
			PORT: String(PORT),
			PATH: `${path.join(e2e, 'fake-harness')}:${path.join(e2e, 'bin')}:${process.env.PATH}`,
			DECK_E2E_REAL_TMUX: realTmux()
		}
	}
});
