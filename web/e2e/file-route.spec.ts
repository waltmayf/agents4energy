/**
 * Smoke test for the `/file` route (issue #502 — HPC/Analytics slice 4).
 *
 * There's no PySpark-generated artifact to point at yet (that lands once
 * #501 merges), so this uploads a tiny fixture image itself, under
 * `files/artifacts/`, via the existing Files page upload path (per the
 * issue: "Testable with any file placed under files/artifacts/ — upload one
 * via the existing browser upload path"). The Files page (files/page.tsx)
 * always uploads to the flat `files/` root using the real File's `.name`,
 * with no folder navigation — so to land the object under `files/artifacts/`
 * specifically, the test constructs a browser `File` whose `.name` already
 * contains the `artifacts/` segment (a File's `.name` is just metadata, not
 * a real path, so this is a legitimate value — not a workaround) and injects
 * it into the hidden `[data-testid="file-input"]` via a DataTransfer, the
 * standard way to drive a real `<input type="file">` from a test without a
 * native file-picker dialog.
 */
import { test, expect } from '@playwright/test';

// 1x1 transparent PNG.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test.describe('/file route', () => {
  test('renders an uploaded files/artifacts/ image via a presigned URL', async ({ page }) => {
    test.setTimeout(60_000);
    const fileName = `e2e-smoke-${test.info().testId}.png`;
    const relativePath = `artifacts/${fileName}`;

    await page.goto('files');
    await expect(page.getByRole('button', { name: 'Sign in' })).not.toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="file-input"]')).toBeAttached({ timeout: 15_000 });

    await page.evaluate(
      ({ relativePath, base64 }) => {
        const input = document.querySelector('[data-testid="file-input"]') as HTMLInputElement;
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const file = new File([bytes], relativePath, { type: 'image/png' });
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        input.files = dataTransfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      },
      { relativePath, base64: TINY_PNG_BASE64 },
    );

    // Upload completes and the Files table refreshes with the new row.
    await expect(page.getByTestId(`file-row-${relativePath}`)).toBeVisible({ timeout: 20_000 });

    try {
      const s3Key = `files/artifacts/${fileName}`;
      await page.goto(`file?s3Key=${encodeURIComponent(s3Key)}`);
      // The /file page resolves a presigned URL via Amplify getUrl and renders
      // it as an <img> for image file types.
      await expect(page.locator('img')).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('img')).toHaveAttribute('src', /^https:\/\//);
    } finally {
      // Clean up: delete the fixture file via the same UI path.
      await page.goto('files');
      await page
        .getByTestId(`file-row-${relativePath}`)
        .getByRole('button', { name: `Delete ${relativePath}` })
        .click();
      await page.getByTestId('confirm-delete-file').click();
      await expect(page.getByTestId(`file-row-${relativePath}`)).not.toBeVisible({ timeout: 15_000 });
    }
  });

  test('rejects an s3Key outside the files/ prefix', async ({ page }) => {
    await page.goto(`file?s3Key=${encodeURIComponent('other-bucket-area/secret.txt')}`);
    await expect(page.getByText('Unable to load file')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('img')).toHaveCount(0);
  });
});
