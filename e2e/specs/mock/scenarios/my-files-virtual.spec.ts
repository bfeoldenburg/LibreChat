import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { FileContext, FileSources } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import type { Page } from '@playwright/test';

/**
 * The My Files table renders only the rows near its scroll position. With a list
 * far longer than the dialog, scrolling has to keep mounting rows down to the
 * last file, and each mounted row has to report its place in the whole list.
 * The account menu sits behind the mobile drawer on a phone-width viewport, so
 * this scenario uses a desktop viewport.
 */
test.describe.configure({ timeout: 120_000 });
test.use({ viewport: { width: 1280, height: 800 } });

const FILE_COUNT = 200;

const files: TFile[] = Array.from({ length: FILE_COUNT }, (_, index) => ({
  file_id: `virtual-file-${index}`,
  filename: `Virtual fixture ${String(index).padStart(3, '0')}.txt`,
  filepath: `/files/virtual-file-${index}.txt`,
  user: 'virtual-files-user',
  bytes: 100,
  object: 'file',
  source: FileSources.local,
  type: 'text/plain',
  usage: 0,
  embedded: false,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
}));

async function openMyFiles(page: Page, entries = files) {
  await page.route('**/api/files', (route) => route.fulfill({ json: entries }));
  await page.goto('/c/new', { timeout: 15000 });
  await page.getByTestId('nav-user').click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'My Files', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'My Files', exact: true });
  await expect(dialog).toBeVisible({ timeout: 15000 });
  const table = dialog.getByRole('table');
  if (entries.length > 0) {
    await expect(table.locator('tbody tr[aria-rowindex="2"]')).toBeVisible();
  }
  return { dialog, table };
}

/** Wheels over the table until the last row is mounted, as a user scrolling down would. */
async function scrollToLastRow(page: Page, table: ReturnType<Page['getByRole']>) {
  const lastRow = table.locator(`tbody tr[aria-rowindex="${FILE_COUNT + 1}"]`);
  await table.hover();
  for (let attempt = 0; attempt < 80 && (await lastRow.count()) === 0; attempt++) {
    await page.mouse.wheel(0, 1200);
  }
  return lastRow;
}

test.describe('my files virtual table', () => {
  test('scrolling the files table reaches the last file @scenario:my-files-scroll-reaches-last-file', async ({
    page,
  }) => {
    const { table } = await openMyFiles(page);
    const mounted = await table.locator('tbody tr[aria-rowindex]').count();
    expect(mounted).toBeLessThan(FILE_COUNT);

    const lastRow = await scrollToLastRow(page, table);
    await expect(lastRow).toBeInViewport();
    await expect(lastRow).toContainText('Virtual fixture');
  });

  test('a mounted file row reports its position in the whole list @scenario:my-files-rows-report-position', async ({
    page,
  }) => {
    const { table } = await openMyFiles(page);
    await expect(table).toHaveAttribute('aria-rowcount', String(FILE_COUNT + 1));
    await expect(table.locator('thead tr')).toHaveAttribute('aria-rowindex', '1');

    const lastRow = await scrollToLastRow(page, table);
    await expect(lastRow).toBeInViewport();
    /* The spacer rows that stand in for unmounted files stay out of the tree. */
    const spacers = table.locator('tbody tr:not([aria-rowindex])');
    for (const spacer of await spacers.all()) {
      await expect(spacer).toHaveAttribute('aria-hidden', 'true');
    }
  });

  test('keeps the table header compact for a single row and an empty filter', async ({ page }) => {
    const { dialog, table } = await openMyFiles(page);
    const header = table.locator('thead');
    const headerHeight = () => header.evaluate((element) => element.getBoundingClientRect().height);
    const fullHeaderHeight = await headerHeight();
    const filter = dialog.getByRole('textbox', { name: 'Filter files...' });

    await filter.fill('Virtual fixture 000');
    await expect(table.locator('tbody tr')).toHaveCount(1);
    expect(await headerHeight()).toBeCloseTo(fullHeaderHeight, 0);

    await filter.fill('nothing-matches-this');
    await expect(table.getByText('No results.')).toBeVisible();
    expect(await headerHeight()).toBeCloseTo(fullHeaderHeight, 0);
  });

  test('downloads the selected original and allows retry after an error', async ({ page }) => {
    const file: TFile = {
      ...files[0],
      file_id: 'generated-original',
      filename: 'job-image-original.png',
      filepath: '/images/fixture/job-image-original.png',
      context: FileContext.image_generation,
      type: 'image/png',
      metadata: { imageDisplayFileId: 'generated-display' },
    };
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTokAAAAASUVORK5CYII=',
      'base64',
    );
    let attempts = 0;
    let finishDownload!: () => void;
    const downloadReady = new Promise<void>((resolve) => {
      finishDownload = resolve;
    });
    await page.route('**/api/files/download/*/generated-original', async (route) => {
      expect(await route.request().headerValue('authorization')).toMatch(/^Bearer /);
      if (++attempts === 1) {
        await route.fulfill({ status: 404 });
        return;
      }
      await downloadReady;
      await route.fulfill({
        body: bytes,
        contentType: 'application/octet-stream',
        headers: { 'x-file-metadata': encodeURIComponent(JSON.stringify(file)) },
      });
    });
    const { dialog } = await openMyFiles(page, [file]);
    const button = dialog.getByRole('button', { name: `Download ${file.filename}` });
    await button.click();
    await expect(page.getByText('Error downloading file.', { exact: false })).toBeVisible();

    const downloadEvent = page.waitForEvent('download');
    await button.click();
    try {
      await expect(button).toBeDisabled();
    } finally {
      finishDownload();
    }
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe(file.filename);
    expect(await readFile(await download.path())).toEqual(bytes);
    await expect(button).toBeEnabled();
    expect(attempts).toBe(2);
  });
});
