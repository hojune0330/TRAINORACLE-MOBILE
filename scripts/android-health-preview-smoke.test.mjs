import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { checkInstalledPreview, decodeSupportMessage, runHealthPreviewSmoke } from './android-health-preview-smoke.mjs';
import { healthAvailabilityMessage } from '../web-adapter/offline-health-preview.js';
const text = healthAvailabilityMessage({ source: 'health-connect', status: 'available', readAuthorization: 'required' });
function fixture({ origin = 'https://localhost/', entryCount = 1, rows = 0, visible = true, message = text } = {}) {
  const calls = [];
  const button = name => ({ waitFor: async () => calls.push('wait:' + name), count: async () => entryCount, click: async () => calls.push('click:' + name) });
  const dialog = {
    waitFor: async options => calls.push('dialog:' + options.state),
    isVisible: async () => visible,
    getByRole: (role, options) => role === 'status' ? { textContent: async () => message } : button(options.name),
    locator: selector => { assert.equal(selector, 'li'); return { count: async () => rows }; }
  };
  const page = { url: () => origin,
    getByRole: (role, options) => role === 'dialog' ? dialog : button(options.name),
    waitForFunction: async (fn, allowed, options) => { assert.equal(options.timeout, 45000); assert.ok(allowed.includes(text)); assert.equal(typeof fn, 'function'); }
  };
  return { page, calls };
}
test('synthetic status UI path clicks only entry, support check and close; no permission/data action', async () => {
  const f = fixture(); const result = await checkInstalledPreview(f.page);
  assert.equal(result.readAuthorization, 'required');
  assert.deepEqual(f.calls.filter(x => x.startsWith('click:')), ['click:건강 기록 미리보기', 'click:기기 지원·권한 상태 확인', 'click:닫기']);
});
test('foreign native origin refused before any action', async () => {
  const f = fixture({ origin: 'https://trainoracle.io/' }); await assert.rejects(checkInstalledPreview(f.page), /NATIVE_ORIGIN_REQUIRED/); assert.deepEqual(f.calls, []);
});
test('ambiguous health entry never authorizes any click', async () => {
  const f = fixture({ entryCount: 2 }); await assert.rejects(checkInstalledPreview(f.page), /HEALTH_ENTRY_AMBIGUOUS/); assert.equal(f.calls.filter(x => x.startsWith('click:')).length, 0);
});
test('record-bearing or stale UI never counts as status-only success', async () => {
  await assert.rejects(checkInstalledPreview(fixture({ rows: 1 }).page), /STATUS_CHECK_MUST_NOT_RETURN_RECORDS/);
  await assert.rejects(checkInstalledPreview(fixture({ visible: false }).page), /HEALTH_CONTEXT_CHANGED/);
});
test('only exact fixed metadata messages decode; raw error cannot escape', () => {
  for (const value of [{ status: 'available', readAuthorization: 'required' }, { status: 'available', readAuthorization: 'granted' },
    { status: 'unavailable', readAuthorization: 'unknown' }, { status: 'provider-update-required', readAuthorization: 'unknown' }]) {
    assert.equal(decodeSupportMessage(healthAvailabilityMessage({ source: 'health-connect', ...value })).status, value.status);
  }
  assert.throws(() => decodeSupportMessage('RAW_PRIVATE'), error => error.message === 'HEALTH_STATUS_NOT_CONFIRMED');
});
test('runtime runner refuses a normal local environment before device/file access', { skip: process.env.GITHUB_ACTIONS === 'true' && process.env.CI === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted' ? 'Local rejection case only; actual hosted runtime is a separate workflow stage' : false }, async () => {
  await assert.rejects(runHealthPreviewSmoke(), /ephemeral GitHub-hosted/);
});
test('source contract keeps real attachment, receipt, reload and health-record nonverification explicit', async () => {
  const source = await readFile(new URL('./android-health-preview-smoke.mjs', import.meta.url), 'utf8');
  assert.match(source, /await verifyOutput/); assert.match(source, /await connectNativePage\(_android\)/);
  assert.match(source, /await page.reload/); assert.match(source, /healthRecordReceptionVerified: false/);
  assert.match(source, /testRequestedPermission: false, testReadWorkouts: false/);
  assert.doesNotMatch(source, /grantPermissions|requestAuthorization\(|readRunningWorkouts\(|newPage\(|connectOverCDP|localStorage|sessionStorage|indexedDB/);
  const shell = await readFile(new URL('./run-android-runtime.sh', import.meta.url), 'utf8');
  const gate = shell.indexOf('timeout 150 node scripts/android-health-preview-smoke.mjs');
  assert.ok(gate > shell.indexOf('launch_and_forward\ntimeout 150 node scripts/android-runtime-probe.mjs --phase read'));
  assert.ok(gate < shell.indexOf('timeout 240 node scripts/android-native-ui-smoke.mjs --export-json'));
});
