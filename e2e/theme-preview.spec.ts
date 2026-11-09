import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const previewUrl = process.env.SHOPGUARD_PREVIEW_URL;
const configuredPaths = process.env.SHOPGUARD_PREVIEW_PATHS?.split(',').map((path) => path.trim()).filter(Boolean) ?? ['/'];
const pages = previewUrl ? configuredPaths.map((path) => {
  if (path === '/' || path === '') return previewUrl;
  const target = new URL(path, previewUrl);
  if (!target.search && new URL(previewUrl).search) target.search = new URL(previewUrl).search;
  return target.toString();
}) : [];

test.skip(!previewUrl, 'Set SHOPGUARD_PREVIEW_URL to run read-only checks against an authorized theme preview.');

test('preview pages render semantic content and permit keyboard focus', async ({ page }) => {
  for (const url of pages) {
    await page.goto(url);
    await expect(page.locator('h1').first()).toBeVisible();
    await expect(page.locator('main, [role="main"]').first()).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toBeVisible();
  }
});

test('preview pages fit mobile, tablet, and desktop widths', async ({ page }) => {
  for (const url of pages) {
    for (const width of [390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(url);
      const layout = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
      expect(layout.content, `Horizontal overflow at ${width}px on ${url}`).toBeLessThanOrEqual(layout.viewport + 1);
    }
  }
});

test('preview pages have no axe violations', async ({ page }) => {
  for (const url of pages) {
    await page.goto(url);
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(result.violations.map(({ id, impact, help }) => ({ id, impact, help })), `Accessibility violations on ${url}`).toEqual([]);
  }
});
