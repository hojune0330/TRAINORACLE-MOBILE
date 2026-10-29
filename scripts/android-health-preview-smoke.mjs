import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, assertHostedRuntime, connectNativePage, isNativePage } from './android-runtime-probe.mjs';
import { SOURCE_SHA, verifyOutput } from './prepare-web.mjs';
import { healthAvailabilityMessage } from '../web-adapter/offline-health-preview.js';
const statusCases = Object.freeze([
  { status: 'available', readAuthorization: 'required' },
  { status: 'available', readAuthorization: 'granted' },
  { status: 'unavailable', readAuthorization: 'unknown' },
  { status: 'provider-update-required', readAuthorization: 'unknown' }
].map(value => Object.freeze({ ...value, source: 'health-connect' })));
export function decodeSupportMessage(text) {
  const found = statusCases.find(value => healthAvailabilityMessage(value) === text);
  if (!found) throw new Error('HEALTH_STATUS_NOT_CONFIRMED');
  return found;
}
export async function checkInstalledPreview(page) {
  if (!isNativePage(page.url())) throw new Error('NATIVE_ORIGIN_REQUIRED');
  const entry = page.getByRole('button', { name: '건강 기록 미리보기', exact: true });
  await entry.waitFor({ state: 'visible', timeout: 30000 });
  if (await entry.count() !== 1) throw new Error('HEALTH_ENTRY_AMBIGUOUS');
  await entry.click({ timeout: 10000 });
  const dialog = page.getByRole('dialog', { name: '건강 기록 미리보기', exact: true });
  await dialog.waitFor({ state: 'visible', timeout: 10000 });
  const check = dialog.getByRole('button', { name: '기기 지원·권한 상태 확인', exact: true });
  await check.click({ timeout: 10000 });
  const status = dialog.getByRole('status');
  // Fixed metadata messages only, never health records or raw native responses.
  const allowed = statusCases.map(healthAvailabilityMessage);
  await page.waitForFunction(messages => {
    const node = document.querySelector('[data-offline-health-preview] dialog [role="status"]');
    return !!node && messages.includes(node.textContent);
  }, allowed, { timeout: 45000 });
  if (!isNativePage(page.url()) || !await dialog.isVisible()) throw new Error('HEALTH_CONTEXT_CHANGED');
  const support = decodeSupportMessage(await status.textContent());
  if (await dialog.locator('li').count() !== 0) throw new Error('STATUS_CHECK_MUST_NOT_RETURN_RECORDS');
  await dialog.getByRole('button', { name: '닫기', exact: true }).click({ timeout: 10000 });
  await dialog.waitFor({ state: 'hidden', timeout: 10000 });
  return support;
}
export async function runHealthPreviewSmoke() {
  assertHostedRuntime();
  if (process.argv.length !== 2) throw new Error('NO_ARGUMENTS_ACCEPTED');
  await verifyOutput(resolve(ROOT, 'www'), SOURCE_SHA);
  const config = JSON.parse(await readFile(resolve(ROOT, 'www/native/health-preview-config.json'), 'utf8'));
  const expectedKeys = ['schemaVersion','enabled','accountMode','sourceSha','consumerContract'].sort().join('|');
  if (!config || Array.isArray(config) || Object.keys(config).sort().join('|') !== expectedKeys || config.schemaVersion !== 1 ||
      typeof config.enabled !== 'boolean' || config.accountMode !== 'off' || config.sourceSha !== SOURCE_SHA || config.consumerContract !== 'OFFLINE_NATIVE_HEALTH_PREVIEW_V1') throw new Error('INVALID_HEALTH_CONFIG');
  await mkdir(resolve(ROOT, 'output'), { recursive: true });
  const report = { schemaVersion: 1, scope: 'ANDROID_INSTALLED_STATUS_ONLY', previewEnabled: config.enabled,
    initialStatusConfirmed: false, reloadStatusConfirmed: false, testRequestedPermission: false, testReadWorkouts: false,
    healthRecordReceptionVerified: false, physicalDeviceVerified: false };
  const output = resolve(ROOT, 'output/native-android-health-status.json');
  if (!config.enabled) { await writeFile(output, JSON.stringify(report, null, 2)+'\n'); return report; }
  const { _android } = await import('playwright-core');
  const { browser, page } = await connectNativePage(_android);
  try {
    await checkInstalledPreview(page); report.initialStatusConfirmed = true;
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await checkInstalledPreview(page); report.reloadStatusConfirmed = true;
    await page.screenshot({ path: resolve(ROOT, 'output/android-health-status-smoke.png') });
    return report;
  } finally {
    await writeFile(output, JSON.stringify(report, null, 2)+'\n');
    await browser.close();
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runHealthPreviewSmoke().catch(() => { console.error('ANDROID_HEALTH_STATUS_SMOKE_FAILED'); process.exitCode = 1; });
}
