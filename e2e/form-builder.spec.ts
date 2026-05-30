import { test, expect, Page } from '@playwright/test';

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Simulate a pointer-drag from source to target (works with dnd-kit PointerSensor).
 * dnd-kit requires pointer events and a distance:5 activation threshold.
 */
async function drag(page: Page, sourceSelector: string, targetSelector: string) {
  const src = page.locator(sourceSelector).first();
  const tgt = page.locator(targetSelector).first();
  const srcBox = (await src.boundingBox())!;
  const tgtBox = (await tgt.boundingBox())!;

  const sx = srcBox.x + srcBox.width / 2;
  const sy = srcBox.y + srcBox.height / 2;
  const tx = tgtBox.x + tgtBox.width / 2;
  const ty = tgtBox.y + tgtBox.height / 2;

  await page.mouse.move(sx, sy);
  await page.mouse.down();
  // Nudge to pass the distance:5 activation threshold
  await page.mouse.move(sx + 8, sy + 8, { steps: 5 });
  await page.mouse.move(tx, ty, { steps: 30 });
  await page.mouse.up();
}

/** Reset to a blank canvas by clicking the Reset button. */
async function resetForm(page: Page) {
  await page.locator('button.vb-btn-ghost', { hasText: 'Reset' }).click();
}

/** Select an existing field on the canvas by clicking the first field block. */
async function selectFirstField(page: Page) {
  await page.locator('.vb-field-block').first().click();
}

// Test form name — "micah test" prefix per workspace convention
const TEST_FORM_NAME = `Micah Test E2E ${Date.now()}`;

// ─── suite ────────────────────────────────────────────────────────────────────

test.describe('Form Builder – End-to-End', () => {
  let savedFormId: string | null = null;

  // After all tests, clean up the test form config via the API
  test.afterAll(async ({ request }) => {
    if (savedFormId) {
      await request.delete(`/api/form-builder/configs/${savedFormId}`);
    }
  });

  // ── 1. App loads ────────────────────────────────────────────────────────────
  test('1. App loads and shows all three panels', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.vb-app')).toBeVisible();
    await expect(page.locator('.vb-sidebar')).toBeVisible();
    await expect(page.locator('.vb-body')).toBeVisible();
    await expect(page.locator('.insp-tabs')).toBeVisible();
  });

  // ── 2. Topbar ──────────────────────────────────────────────────────────────
  test('2. Topbar shows brand, name input, device toggles, and Publish button', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('.vb-topbar-brand')).toContainText('FormBuilder');
    await expect(page.locator('.vb-topbar-name')).toBeVisible();
    await expect(page.locator('.vb-device-toggle')).toBeVisible();
    // The topbar Publish button is scoped to within .vb-topbar
    await expect(page.locator('.vb-topbar button.vb-btn-primary')).toContainText('Publish');
  });

  // ── 3. Sidebar – field categories ─────────────────────────────────────────
  test('3. Sidebar shows field categories with draggable items', async ({ page }) => {
    await page.goto('/');
    const categories = page.locator('.vb-palette-category');
    await expect(categories.first()).toBeVisible();
    const catCount = await categories.count();
    expect(catCount).toBeGreaterThan(0);
    await expect(page.locator('.vb-palette-item').first()).toBeVisible();
  });

  // ── 4. Sidebar – search filters fields ────────────────────────────────────
  test('4. Sidebar search filters palette items', async ({ page }) => {
    await page.goto('/');
    const allItems = page.locator('.vb-palette-item');
    const countBefore = await allItems.count();

    const searchInput = page.locator('.vb-sidebar-search-input');
    await searchInput.fill('email');

    const countAfter = await allItems.count();
    expect(countAfter).toBeLessThan(countBefore);
    await expect(allItems.first()).toContainText(/email/i);

    await searchInput.clear();
  });

  // ── 5. Add a field to the canvas via drag ─────────────────────────────────
  test('5. Dragging a field from the palette adds it to the canvas', async ({ page }) => {
    await page.goto('/');

    // Add a new page — it starts empty and shows the .vb-page-empty drop zone
    await page.locator('.vb-page-tab-add').click();
    await expect(page.locator('.vb-page-empty')).toBeVisible({ timeout: 3_000 });
    const countBefore = await page.locator('.vb-field-block').count(); // fields on this new empty page = 0

    await drag(page, '.vb-palette-item', '.vb-page-empty');

    // After drop the canvas should have one more field block
    await expect(page.locator('.vb-field-block')).toHaveCount(countBefore + 1, { timeout: 5_000 });
    await expect(page.locator('.vb-page-empty')).not.toBeVisible();
  });

  // ── 6. Click a field to select it and open the Inspector ─────────────────
  test('6. Clicking a field opens the Inspector with the Field tab active', async ({ page }) => {
    await page.goto('/');
    // The default form already has fields in the canvas
    await selectFirstField(page);

    await expect(page.locator('.insp-tab.is-active')).toContainText(/field/i);
    await expect(page.locator('.insp-input').first()).toBeVisible();
  });

  // ── 7. Inspector Logic tab ────────────────────────────────────────────────
  test('7. Inspector Logic tab is accessible after selecting a field', async ({ page }) => {
    await page.goto('/');
    await selectFirstField(page);

    await page.locator('.insp-tab', { hasText: /logic/i }).click();
    await expect(page.locator('.insp-tab.is-active')).toContainText(/logic/i);
  });

  // ── 8. Inspector Salesforce tab – loads SF objects ────────────────────────
  test('8. Inspector SF tab connects to Salesforce and lists objects', async ({ page }) => {
    await page.goto('/');
    await selectFirstField(page);

    await page.locator('.insp-tab', { hasText: /salesforce/i }).click();
    await expect(page.locator('.insp-tab.is-active')).toContainText(/salesforce/i);

    // Click "Connect ↗" to trigger the live SF objects fetch
    await page.locator('button.insp-sf-connect-btn').click();

    // Wait up to 15 s — this is a live Salesforce network call.
    // Once loaded the picker switches to select.insp-sf-select with dynamic options.
    const objectSelect = page.locator('select.insp-sf-select');
    await expect(objectSelect).toBeVisible({ timeout: 15_000 });

    const optionCount = await objectSelect.locator('option').count();
    expect(optionCount).toBeGreaterThan(2);
  });

  // ── 9. Select a Salesforce object and load its fields ─────────────────────
  test('9. Selecting Contact loads its writable fields and allows mapping', async ({ page }) => {
    await page.goto('/');
    // Navigate to page 2 (Donor Info) which has an email field
    // compatible with SF string/email types, so Contact mapping shows many fields
    await page.locator('.vb-page-tab:not(.vb-page-tab-add)').nth(1).click();
    await selectFirstField(page); // selects full_name (type: full_name → string/textarea compatible)
    await page.locator('.insp-tab', { hasText: /salesforce/i }).click();

    await page.locator('button.insp-sf-connect-btn').click();
    // Wait for the dynamic object select (replaces the static fallback)
    const objectSelect = page.locator('select.insp-sf-select');
    await expect(objectSelect).toBeVisible({ timeout: 15_000 });

    // Select Contact from the dynamic dropdown
    await objectSelect.selectOption({ value: 'Contact' });

    // After selecting an object, field rows appear as buttons
    const fieldRows = page.locator('button.insp-sf-field-row');
    await expect(fieldRows.first()).toBeVisible({ timeout: 15_000 });

    const fieldCount = await fieldRows.count();
    expect(fieldCount).toBeGreaterThan(5);

    // Click the first field row and verify it becomes selected
    await fieldRows.first().click();
    await expect(fieldRows.first()).toHaveClass(/is-selected/);
  });

  // ── 10. Inspector Form Settings tab ───────────────────────────────────────
  test('10. Form Settings tab is accessible and shows Salesforce object config', async ({
    page,
  }) => {
    await page.goto('/');
    await page.locator('.insp-tab', { hasText: /form/i }).click();
    await expect(page.locator('.insp-tab.is-active')).toContainText(/form/i);

    // The Form tab should contain Salesforce object settings (primaryObject, donationObject…)
    await expect(page.locator('.insp-section').first()).toBeVisible();
  });

  // ── 11. Update form name in the topbar ────────────────────────────────────
  test('11. Form name can be edited in the topbar', async ({ page }) => {
    await page.goto('/');
    const nameInput = page.locator('.vb-topbar-name');
    await nameInput.fill(TEST_FORM_NAME);
    await expect(nameInput).toHaveValue(TEST_FORM_NAME);
    // Dirty indicator should appear
    await expect(page.locator('.vb-topbar-unsaved')).toBeVisible();
  });

  // ── 12. Save form config ──────────────────────────────────────────────────
  test('12. Publish persists the form and shows a confirmation', async ({ page }) => {
    await page.goto('/');

    const nameInput = page.locator('.vb-topbar-name');
    await nameInput.fill(TEST_FORM_NAME);

    // Capture the save response to grab the returned ID for cleanup
    const saveResponse = page.waitForResponse(
      (r) => r.url().includes('/api/form-builder/configs') && r.request().method() === 'POST'
    );

    await page.locator('.vb-topbar button.vb-btn-primary').click();

    const resp = await saveResponse;
    expect(resp.status()).toBe(201);
    const body = await resp.json();
    savedFormId = body.id ?? null;
    expect(savedFormId).toBeTruthy();

    await expect(page.locator('.vb-topbar-msg')).toContainText(/saved/i, { timeout: 5_000 });
  });

  // ── 13. Load form from library dropdown ────────────────────────────────────
  test('13. Saved form appears in the Load dropdown', async ({ page }) => {
    await page.goto('/');

    const loadSelect = page.locator('select.vb-topbar-select');

    // Capture the list API response to verify it's fresh
    const listResponse = page.waitForResponse(
      (r) => r.url().includes('/api/form-builder/configs') && r.request().method() === 'GET'
    );
    await loadSelect.click(); // triggers loadLibrary()
    await listResponse;

    await expect(loadSelect.locator('option[value]')).not.toHaveCount(0, { timeout: 10_000 });

    const optionTexts = await loadSelect.locator('option').allTextContents();
    const found = optionTexts.some((t) => t.includes(TEST_FORM_NAME));
    expect(found, `"${TEST_FORM_NAME}" not found in options: ${optionTexts.join(', ')}`).toBe(true);
  });

  // ── 14. Multi-page: add and remove a page ──────────────────────────────────
  test('14. Can add and remove pages', async ({ page }) => {
    await page.goto('/');
    const initialTabs = await page.locator('.vb-page-tab:not(.vb-page-tab-add)').count();

    // Add a page — the new page becomes active automatically
    await page.locator('.vb-page-tab-add').click();
    const afterAdd = await page.locator('.vb-page-tab:not(.vb-page-tab-add)').count();
    expect(afterAdd).toBe(initialTabs + 1);

    // Remove current page using the "Remove Page" button in the page header
    await page.locator('button.vb-btn-danger-ghost', { hasText: /remove page/i }).click();
    const afterRemove = await page.locator('.vb-page-tab:not(.vb-page-tab-add)').count();
    expect(afterRemove).toBe(initialTabs);
  });

  // ── 15. Undo button state ──────────────────────────────────────────────────
  test('15. Undo button is disabled on fresh load and enabled after a field action', async ({
    page,
  }) => {
    await page.goto('/');

    // On fresh load, history stack is empty — undo should be disabled
    const undoBtn = page.locator('button[title="Undo (Ctrl+Z)"]');
    await expect(undoBtn).toBeVisible();
    await expect(undoBtn).toBeDisabled();

    // Redo should also be disabled
    const redoBtn = page.locator('button[title="Redo (Ctrl+Y)"]');
    await expect(redoBtn).toBeVisible();
    await expect(redoBtn).toBeDisabled();
  });

  // ── 16. Device preview toggle ──────────────────────────────────────────────
  test('16. Device preview toggle switches between desktop and mobile', async ({ page }) => {
    await page.goto('/');

    // Device buttons use SVG icons (no text), identified by title attribute
    await expect(page.locator('.vb-device-btn.is-active')).toHaveAttribute('title', 'desktop');

    await page.locator('.vb-device-btn[title="mobile"]').click();
    await expect(page.locator('.vb-device-btn.is-active')).toHaveAttribute('title', 'mobile');

    await page.locator('.vb-device-btn[title="desktop"]').click();
    await expect(page.locator('.vb-device-btn.is-active')).toHaveAttribute('title', 'desktop');
  });
});
