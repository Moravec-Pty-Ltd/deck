import { expect, test, type Locator, type Page } from '@playwright/test';
import path from 'node:path';

const root = process.env.DECK_E2E_ROOT!;
const project = path.join(root, 'acme');
const headers = { 'x-deck-token': 'e2e' };

async function signIn(page: Page) {
	await page.goto('/?token=e2e');
	await expect(page).not.toHaveURL(/token=|\/login/);
}

// A fresh claude session in the project, made through the API so each test starts clean.
async function openSession(page: Page, title: string) {
	const res = await page.request.post('/api/agent/sessions', { headers, data: { mode: 'work', kind: 'claude', cwd: project, title } });
	expect(res.ok(), await res.text()).toBe(true);
	const { id } = await res.json();
	await signIn(page);
	await page.goto(`/s/${id}`);
	return id as string;
}

// Clicks until `shows` appears: a click that lands before hydration does nothing.
async function open(trigger: Locator, shows: Locator) {
	await expect(async () => {
		if (!(await shows.isVisible())) await trigger.click();
		await expect(shows).toBeVisible({ timeout: 1000 });
	}).toPass();
}

async function send(page: Page, text: string) {
	await page.getByPlaceholder(/^Message/).fill(text);
	await page.getByRole('button', { name: 'Send' }).click();
}

test('signs in with the token', async ({ page }) => {
	await page.goto('/');
	await expect(page).toHaveURL(/\/login/);
	// Retried because a click that lands before hydration only reloads the form.
	await expect(async () => {
		await page.getByPlaceholder('Access token').fill('e2e');
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page).not.toHaveURL(/\/login/, { timeout: 1000 });
	}).toPass();
	await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
});

test('starts a claude session in the project and gets a reply', async ({ page }) => {
	await signIn(page);
	await page.goto('/?new=1');
	const modal = page.getByRole('dialog');
	await expect(modal.getByRole('combobox').first()).toHaveValue(project);
	await modal.getByPlaceholder('Required').fill('first');
	await modal.getByRole('button', { name: 'Create' }).click();
	await expect(page).toHaveURL(/\/s\//);
	await send(page, 'hello there');
	await expect(page.getByText('Fake reply to: hello there')).toBeVisible();
});

test('shows a tool card', async ({ page }) => {
	await openSession(page, 'tool');
	await send(page, '[tool] run it');
	await expect(page.getByText('Fake reply to: run it')).toBeVisible();
	await expect(page.getByText('Echo a fake line')).toBeVisible();
});

test("folds a subagent's steps into its Agent card", async ({ page }) => {
	await openSession(page, 'agent');
	await send(page, '[agent] fan out');
	await expect(page.getByText('Fake reply to: fan out')).toBeVisible();
	await expect(page.getByText('Survey the fake repo')).toBeVisible();
	const steps = page.getByRole('button', { name: /steps/ });
	await expect(steps).toHaveAttribute('aria-expanded', 'false');
	await expect(page.getByText('Subagent looking around')).toBeHidden();
	await open(steps, page.getByText('Subagent looking around'));
	await expect(page.getByText('List the fake repo')).toBeVisible();
});

test('tracks a background subagent live and shows its report', async ({ page }) => {
	await openSession(page, 'bg-agent');
	await send(page, '[background] watch it');
	await expect(page.getByText('Fake reply to: watch it')).toBeVisible();
	const bar = page.getByRole('button', { name: '1 agent running' });
	await expect(bar).toBeVisible();
	await expect(page.getByText('Reading the fake log').first()).toBeVisible();
	await expect(page.getByLabel('done')).toBeVisible({ timeout: 10_000 });
	await expect(bar).toBeHidden();
	await open(page.getByRole('button', { name: 'result' }), page.getByText('Background report: build is green'));
	await expect(page.getByText('Async agent launched')).toBeHidden();
});

test('shows Working while a turn runs and stops it', async ({ page }) => {
	await openSession(page, 'slow');
	await send(page, '[slow] take your time');
	await expect(page.getByText('Working…')).toBeVisible();
	await page.getByRole('button', { name: 'Interrupt' }).click();
	await expect(page.getByRole('button', { name: 'Interrupt' })).toBeHidden();
	await expect(page.getByText('Working…')).toBeHidden();
});

test('answers an ask', async ({ page }) => {
	await openSession(page, 'ask');
	await send(page, '[ask] pick one');
	await expect(page.getByText('Which colour?')).toBeVisible();
	await page.getByRole('button', { name: 'Blue' }).click();
	await page.getByRole('button', { name: 'Send answer' }).click();
	await expect(page.getByText(/You answered: .*Blue/)).toBeVisible();
});

test('previews a mentioned image and video', async ({ page }) => {
	const id = await openSession(page, 'files');
	const png = path.join(project, '.deck/out/shot.png');
	const mp4 = path.join(project, '.deck/out/clip.mp4');
	await send(page, `[file:${png}] [file:${mp4}]`);
	await expect(page.getByRole('img', { name: 'shot.png' })).toBeVisible();
	const video = page.locator('video[title="clip.mp4"]');
	await expect(video).toBeVisible();
	const src = await video.getAttribute('src');
	expect(src).toContain(`/sessions/${id}/files`);
	const res = await page.request.get(src!, { headers: { range: 'bytes=0-99' } });
	expect(res.status()).toBe(206);
	expect((await res.body()).length).toBe(100);
});

test('quick messages list the project ones before the global ones', async ({ page }) => {
	await page.request.put('/api/agent/quick-messages', { headers, data: [] });
	await openSession(page, 'quick');
	const picker = page.locator('summary[aria-label="Quick messages"]');
	await open(picker, page.getByRole('button', { name: 'Add messages' }));
	await page.getByRole('button', { name: 'Add messages' }).click();
	const modal = page.getByRole('dialog', { name: 'Quick messages' });
	const addTo = modal.getByLabel('Add to');
	await addTo.selectOption({ label: 'Global' });
	await modal.getByRole('button', { name: 'Add message to' }).click();
	await modal.getByPlaceholder('Label (optional)').last().fill('global one');
	await modal.getByPlaceholder('Message text').last().fill('sent from global');
	await addTo.selectOption({ label: 'acme' });
	await modal.getByRole('button', { name: 'Add message to' }).click();
	await modal.getByPlaceholder('Label (optional)').last().fill('project one');
	await modal.getByPlaceholder('Message text').last().fill('sent from project');
	await modal.getByRole('button', { name: 'Save' }).click();
	await expect(modal).toBeHidden();

	await picker.click();
	const items = page.getByRole('listitem').filter({ hasText: / one$/ });
	await expect(items).toHaveText(['project one', 'global one']);
	await items.first().click();
	await expect(page.getByText('Fake reply to: sent from project')).toBeVisible();
});

test('adds a project', async ({ page }) => {
	const dir = path.join(root, 'example');
	await signIn(page);
	await page.goto('/projects');
	const modal = page.getByRole('dialog', { name: 'Add a project' });
	await open(page.getByRole('button', { name: 'Add project', exact: true }), modal);
	await modal.getByPlaceholder('/absolute/path or ~/path').fill(dir);
	await modal.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(modal).toBeHidden();
	const res = await page.request.get('/api/projects', { headers });
	expect((await res.json()).map((p: { path: string }) => p.path)).toContain(dir);
	await expect(page.getByText('example').first()).toBeVisible();
});
