import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('entry page renders and creates a circle', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('heading', { name: /find coherence/i })).toBeVisible();
	await page.getByRole('button', { name: 'Open a circle' }).first().click();
	await expect(page).toHaveURL(/\/room\/\d{6}#/);
	await expect(page.getByRole('heading', { name: /Circle \d{6}/ })).toBeVisible();
});

test('prejoin requires a name', async ({ page }) => {
	await page.goto('/room/123456');
	const btn = page.getByRole('button', { name: 'Enter the circle' });
	await expect(btn).toBeDisabled();
	await page.getByPlaceholder('Your name').fill('Ada');
	await expect(btn).toBeEnabled();
});

test('join muted: mic starts off and unmute is explicit', async ({ page }) => {
	await page.goto('/room/123456');
	await page.getByPlaceholder('Your name').fill('Ada');
	await page.getByRole('button', { name: 'Enter the circle' }).click();
	await expect(page.getByRole('button', { name: 'Unmute' })).toBeVisible();
});

test('entry page passes axe accessibility scan', async ({ page }) => {
	await page.goto('/');
	const results = await new AxeBuilder({ page }).analyze();
	expect(results.violations).toEqual([]);
});

test('two browsers share a room code (P2P join)', async ({ browser }) => {
	const ctx1 = await browser.newContext();
	const ctx2 = await browser.newContext();
	const p1 = await ctx1.newPage();
	const p2 = await ctx2.newPage();
	const code = String(Math.floor(100000 + Math.random() * 900000));

	for (const [p, n] of [[p1, 'Ada'], [p2, 'Grace']] as const) {
		await p.goto(`/room/${code}`);
		await p.getByPlaceholder('Your name').fill(n);
		await p.getByRole('button', { name: 'Enter the circle' }).click();
	}
	// peer join is async over relays — generous timeout
	await expect(p2.locator('.seat:not(.empty)')).toHaveCount(2, { timeout: 30_000 });
	await ctx1.close();
	await ctx2.close();
});
