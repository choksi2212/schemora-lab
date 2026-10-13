import { test, expect, type Page } from '@playwright/test';

const createdProjects = new Map<Page, Set<string>>();
const browserErrors = new Map<Page, string[]>();
test.beforeEach(async ({ page }) => {
  createdProjects.set(page, new Set());
  browserErrors.set(page, []);
  page.on('pageerror', (error) => browserErrors.get(page)?.push(error.message));
  page.on('response', async (response) => {
    if (
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/backend/v1/projects' &&
      response.ok()
    ) {
      const payload = (await response.json().catch(() => null)) as {
        data?: { id?: string };
      } | null;
      if (payload?.data?.id) createdProjects.get(page)?.add(payload.data.id);
    }
  });
});
test.afterEach(async ({ page, baseURL }) => {
  for (const id of createdProjects.get(page) ?? []) {
    const response = await page.request.get(`/api/backend/v1/projects/${id}`);
    if (!response.ok()) continue;
    const detail = (await response.json()) as { data: { project: { revision: number } } };
    await page.request.delete(`/api/backend/v1/projects/${id}`, {
      headers: { Origin: new URL(baseURL!).origin, 'Idempotency-Key': crypto.randomUUID() },
      data: { expectedRevision: detail.data.project.revision },
    });
  }
  expect(browserErrors.get(page), 'No uncaught browser exceptions').toEqual([]);
  createdProjects.delete(page);
  browserErrors.delete(page);
});

async function createImport(page: Page, filename: string, source: string, title: string) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Good ideas deserve/ })).toBeVisible();
  await page.getByRole('button', { name: 'Import conversation' }).click();
  await page.getByRole('textbox', { name: 'Project name' }).fill(title);
  await page.locator('#new-file').setInputFiles({
    name: filename,
    mimeType: filename.endsWith('.json') ? 'application/json' : 'text/plain',
    buffer: Buffer.from(source),
  });
  await page.getByRole('button', { name: 'Create & import' }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Review the proposed design.' })).toBeVisible({
    timeout: 45_000,
  });
}

test('imports source, links evidence, reviews superseded wiring, and persists a correction', async ({
  page,
}) => {
  const title = `Desk light ${Date.now()}`;
  const source =
    'User: Build an ESP32 LED with a 220 ohm resistor.\nAssistant: Connect GPIO18 to LED anode.\nUser: Actually, change GPIO19 to LED anode instead.\nAssistant: Use the LED cathode and GND for the return path.';
  await createImport(page, 'desk-light.txt', source, title);
  await expect(page.getByText('Deterministic extraction · limited recognition')).toBeVisible();
  const earlier = page
    .locator('.fact-card')
    .filter({ has: page.locator('.fact-value', { hasText: 'Connect GPIO18 to LED anode.' }) });
  await expect(earlier.getByText('Earlier claim · unreviewed')).toBeVisible();
  await expect(earlier.getByRole('button', { name: 'Confirm', exact: true })).toBeDisabled();
  await earlier.getByRole('button', { name: 'Show source' }).click();
  await expect(page.locator('.message-content mark')).toHaveText('Connect GPIO18 to LED anode.');
  await earlier.getByRole('button', { name: 'Mark obsolete' }).click();
  await expect(earlier.getByText('Marked obsolete', { exact: true })).toBeVisible();
  const final = page.locator('.fact-card').filter({
    has: page.locator('.fact-value', {
      hasText: 'Actually, change GPIO19 to LED anode instead.',
    }),
  });
  await final.getByRole('button', { name: 'Correct', exact: true }).click();
  await final
    .getByLabel('Your corrected value')
    .fill('Connect GPIO19 to the 220 ohm resistor, then to the LED anode.');
  await final
    .getByLabel(/Reason or context/)
    .fill('Keep the resistor explicit in the reviewed series connection.');
  await final.getByRole('button', { name: 'Save correction' }).click();
  await expect(page.getByText('Corrected by you', { exact: true })).toBeVisible();
  await page.reload();
  await expect(
    page
      .locator('.fact-value')
      .filter({ hasText: 'Connect GPIO19 to the 220 ohm resistor, then to the LED anode.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Revision history' })).toBeVisible();
  await expect(page.getByText('Still to clarify')).toBeVisible();
  await expect(page.getByText(/Confirm the exact board/)).toBeVisible();
});

test('selects one account-export conversation before extraction', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Import conversation' }).click();
  const title = `Selected thread ${Date.now()}`;
  await page.getByRole('textbox', { name: 'Project name' }).fill(title);
  await page.locator('#new-file').setInputFiles({
    name: 'conversations.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify([
        {
          title: 'Desk LED build',
          messages: [{ role: 'user', content: 'Use ESP32 and LED. Connect GPIO18 to LED anode.' }],
        },
        {
          title: 'Garden sensor notes',
          messages: [{ role: 'user', content: 'Use Arduino Uno and BME280 sensor.' }],
        },
      ]),
    ),
  });
  await page.getByRole('button', { name: 'Create & import' }).click();
  await expect(
    page.getByRole('heading', { name: 'Which conversation are you building from?' }),
  ).toBeVisible({ timeout: 45_000 });
  await page.getByRole('button', { name: /Desk LED build/ }).click();
  await expect(page.getByRole('heading', { name: 'Review the proposed design.' })).toBeVisible({
    timeout: 45_000,
  });
  await expect(
    page.locator('.message-content').filter({ hasText: 'Use ESP32 and LED.' }),
  ).toBeVisible();
  await expect(page.locator('.message-content').filter({ hasText: 'BME280' })).toHaveCount(0);
});

test('keeps file validation local and exposes keyboard-operable import', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.getByRole('button', { name: 'Import conversation' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('textbox', { name: 'Project name' }).fill('Unsupported file');
  await page.locator('#new-file').setInputFiles({
    name: 'photo.exe',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('not a conversation'),
  });
  await expect(
    page.getByText('Choose a TXT, Markdown, HTML, PDF, JSON, or ZIP conversation export.').first(),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close new project' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Import conversation' })).toBeFocused();
});
