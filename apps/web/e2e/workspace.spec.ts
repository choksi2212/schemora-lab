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

test('connects exact terminals in the 3D workbench and persists graph edits', async ({ page }) => {
  const title = `3D wiring ${Date.now()}`;
  await createImport(
    page,
    '3d-wiring.txt',
    'User: Build an ESP32 LED with a 220 ohm resistor.\nAssistant: Use GPIO19, the resistor, the LED, and ground.',
    title,
  );
  await page.getByRole('link', { name: /Open circuit workspace/ }).click();
  await expect(page.getByRole('heading', { name: 'Circuit workbench 3D view' })).toBeVisible();
  await expect(page.getByRole('region', { name: /Illustrative circuit workbench/ })).toBeVisible();

  const arrangeList = page.getByRole('list', { name: 'Components to arrange' });
  await arrangeList.getByRole('button', { name: 'YAGEO 220 Ω resistor' }).click();
  await expect(page.getByText(/X 0 · Z 0.12 · rotation 0°/)).toBeVisible();
  await page.getByRole('button', { name: 'Move right' }).click();
  await expect(page.getByText(/X 0.25 · Z 0.12 · rotation 0°/)).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByText(/X 0 · Z 0.12 · rotation 0°/)).toBeVisible();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.getByText(/X 0.25 · Z 0.12 · rotation 0°/)).toBeVisible();

  const saveResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname.endsWith('/circuit'),
  );
  await page.getByRole('button', { name: 'Save circuit' }).click();
  const saved = await saveResponse;
  expect(saved.status(), await saved.text()).toBe(200);
  await expect(page.getByRole('status').filter({ hasText: 'Circuit saved.' })).toBeVisible();
  await page.reload();
  await expect(page.getByText('3 graph wires')).toBeVisible();
  await page
    .getByRole('list', { name: 'Components to arrange' })
    .getByRole('button', { name: 'YAGEO 220 Ω resistor' })
    .click();
  await expect(page.getByText(/X 0.25 · Z 0.12 · rotation 0°/)).toBeVisible();

  await page.getByRole('button', { name: 'Validate saved circuit' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Validation finished for the saved circuit.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Generate assembly guide' }).click();
  await expect(page.getByRole('heading', { name: 'Assembly guide' })).toBeVisible();
  await expect(page.getByText(/Identify ESP32-DevKitC V4/)).toBeVisible();
  await page
    .getByRole('list', { name: 'Assembly steps' })
    .getByRole('button', { name: /Identify ESP32-DevKitC V4/ })
    .click();
  await expect(page.getByText('Why this step?')).toBeVisible();
  await page.getByRole('button', { name: 'Detailed' }).click();
  await expect(page.getByText(/J3 position 8/)).toBeVisible();
  await expect(
    page
      .locator('[aria-label="Contextual teaching"] article')
      .filter({ hasText: 'GPIO: a controllable signal pin' })
      .getByRole('link', { name: /ESP32-DevKitC V4 User Guide/ }),
  ).toHaveAttribute('href', /docs\.espressif\.com/);
  await page.getByRole('button', { name: 'Quick' }).click();
  await expect(page.getByText(/Use the exact GPIO label shown in this step/)).toBeVisible();
  await page.getByRole('list', { name: 'Assembly steps' }).getByRole('button').first().click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText(/Step 2 of/)).toBeVisible();
  await expect(page.getByText(/0 of .* steps confirmed/)).toBeVisible();
  await page.getByRole('button', { name: 'I completed this step' }).click();
  await expect(page.getByText(/1 of .* steps confirmed/)).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Generate assembly guide' }).click();
  await expect(page.getByText(/1 of .* steps confirmed/)).toBeVisible();

  const terminalList = page.getByRole('list', { name: 'Connectable circuit terminals' });
  await terminalList.getByRole('button', { name: /ESP32-DevKitC V4.*GPIO19/ }).click();
  await terminalList.getByRole('button', { name: /YAGEO 220 Ω resistor: Lead B/ }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Wire added between the selected terminals.' }),
  ).toBeVisible();
  await expect(page.getByText('4 graph wires')).toBeVisible();
  await page.getByRole('button', { name: 'Save circuit' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Circuit saved.' })).toBeVisible();
  await page.reload();
  await expect(page.getByText('4 graph wires')).toBeVisible();

  await page.getByRole('button', { name: 'Remove wire 4' }).click();
  await expect(page.getByText('3 graph wires')).toBeVisible();
  await page.getByRole('button', { name: 'Save circuit' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Circuit saved.' })).toBeVisible();
  await page.reload();
  await expect(page.getByText('3 graph wires')).toBeVisible();
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
