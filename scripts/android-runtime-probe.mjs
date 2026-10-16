import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const EXPECTED_ORIGIN = 'https://localhost';
const TRUE_FLAGS = ['probeReady', 'secureContext', 'locksAvailable', 'cryptoAvailable', 'indexedDBAvailable', 'localStorageAvailable', 'nativeDocumentsAvailable', 'appPluginAvailable', 'realLock', 'cryptoRoundTrip', 'localStorageRoundTrip', 'indexedDBRoundTrip', 'rootRendered', 'coreContentPresent'];
const FALSE_FLAGS = ['storageFailureVisible'];
const PERSISTENCE_FLAGS = ['localStoragePersistence', 'indexedDBPersistence'];

export function parseArgs(args) {
  if (args.length !== 2 || args[0] !== '--phase' || !['write', 'read'].includes(args[1])) throw new Error('Use --phase write or --phase read only');
  return { phase: args[1] };
}
export function extractDiagnostic(swift) {
  const matches = [...swift.matchAll(/\blet\s+script\s*=\s*#"""\r?\n([\s\S]*?)\r?\n[ \t]*"""#/g)];
  if (matches.length !== 1 || !matches[0][1].trim()) throw new Error('Expected exactly one shared Swift raw diagnostic');
  return matches[0][1];
}
export function isNativePage(url) {
  try { const u = new URL(url); return u.origin === EXPECTED_ORIGIN && !u.username && !u.password; } catch { return false; }
}
export function decodeResult(value, phase) {
  parseArgs(['--phase', phase]);
  const raw = typeof value === 'string' ? JSON.parse(value) : value;
  if (!raw || Array.isArray(raw) || typeof raw !== 'object' || raw.storageStage !== phase) throw new Error('Diagnostic stage mismatch');
  const allowed = new Set([...TRUE_FLAGS, ...FALSE_FLAGS, ...PERSISTENCE_FLAGS]);
  for (const [key, val] of Object.entries(raw)) {
    if (key !== 'storageStage' && (!allowed.has(key) || typeof val !== 'boolean')) throw new Error('Unexpected or non-boolean diagnostic field');
  }
  const output = { phaseWrite: phase === 'write', phaseRead: phase === 'read' };
  for (const key of [...TRUE_FLAGS, ...FALSE_FLAGS]) {
    if (typeof raw[key] !== 'boolean') throw new Error('Missing boolean diagnostic field: ' + key);
    output[key] = raw[key];
  }
  if (phase === 'read') for (const key of PERSISTENCE_FLAGS) {
    if (typeof raw[key] !== 'boolean') throw new Error('Missing persistence field: ' + key);
    output[key] = raw[key];
  }
  return output;
}
export function assertPassed(result, phase) {
  parseArgs(['--phase', phase]);
  if (result.phaseWrite !== (phase === 'write') || result.phaseRead !== (phase === 'read')) throw new Error('Output stage mismatch');
  for (const key of TRUE_FLAGS) if (result[key] !== true) throw new Error('Android runtime capability failed: ' + key);
  for (const key of FALSE_FLAGS) if (result[key] !== false) throw new Error('Android runtime UI failure: ' + key);
  if (phase === 'read') for (const key of PERSISTENCE_FLAGS) if (result[key] !== true) throw new Error('Same-APK update persistence failed: ' + key);
  return true;
}
export function parseAndroidTarget(env = process.env) {
  const serial = env.TRAINORACLE_ANDROID_SERIAL;
  const pid = Number(env.TRAINORACLE_ANDROID_PID);
  const socket = env.TRAINORACLE_ANDROID_SOCKET;
  if (!/^emulator-[0-9]+$/.test(serial || '') || !Number.isSafeInteger(pid) || pid < 1 || socket !== 'webview_devtools_remote_' + pid) throw new Error('Expected the owned CI emulator serial, PID and matching WebView socket');
  return { serial, pid, socket, pkg: 'io.trainoracle.app.debug' };
}
export function selectWebView(views, target) {
  // Public AndroidWebView exposes package/PID; the shell independently verified
  // that this PID owns target.socket before exporting the target identity.
  const matches = views.filter(view => view.pkg() === target.pkg && view.pid() === target.pid);
  if (matches.length > 1) throw new Error('Ambiguous matching Android WebViews');
  return matches[0];
}
export function connectionErrorCode(error) {
  const text = String(error?.message || '');
  if (/timed out|timeout/i.test(text)) return 'timeout';
  if (/ambiguous/i.test(text)) return 'ambiguous';
  if (/closed|disconnected/i.test(text)) return 'closed';
  if (/origin|navigated/i.test(text)) return 'origin';
  if (/ECONNREFUSED/i.test(text)) return 'connection-refused';
  if (/protocol|method.*found/i.test(text)) return 'protocol';
  return 'connection-error'; // Never persist raw errors or protocol payloads.
}
async function bounded(operation, ms) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Operation timed out')), ms); })]); }
  finally { clearTimeout(timer); }
}
export async function connectNativePage(android, { target = parseAndroidTarget(), timeoutMs = 45000, intervalMs = 500, diagnostic = () => {} } = {}) {
  const deadline = Date.now() + timeoutMs;
  let devices = [], last = 'pending', stage = 'adb-devices';
  const emit = (extra = {}) => diagnostic({ stage, code: last, ...extra });
  try {
    // Official Android attachment opens localabstract /devtools/browser directly
    // and enables Playwright's WebView-specific protocol path. It does not need
    // a browser websocket field in /json/version or a page-only CDP endpoint.
    devices = await bounded(android.devices({ host: '127.0.0.1', port: 5037, omitDriverInstall: true }), Math.max(1, deadline - Date.now()));
    const matches = devices.filter(device => device.serial() === target.serial);
    emit({ deviceCount: devices.length, matchingDeviceCount: matches.length });
    if (matches.length !== 1) throw new Error('Ambiguous or missing owned emulator');
    const selected = matches[0];
    last = 'device-selected';
    while (Date.now() < deadline) {
      stage = 'webview-discovery';
      const views = selected.webViews();
      const view = selectWebView(views, target);
      emit({ webViewCount: views.length, matchingWebView: Boolean(view) });
      if (view) {
        stage = 'webview-page';
        last = 'webview-selected';
        const page = await bounded(view.page(), Math.max(1, deadline - Date.now()));
        stage = 'native-origin';
        while (Date.now() < deadline) {
          const url = page.url();
          if (isNativePage(url)) {
            last = 'connected'; emit({ nativeOrigin: true });
            return { page, browser: { close: async () => { for (const device of devices) await bounded(device.close(), 2000); } } };
          }
          if (url && url !== 'about:blank') throw new Error('Unexpected native WebView origin');
          await new Promise(ok => setTimeout(ok, Math.min(intervalMs, Math.max(1, deadline - Date.now()))));
        }
        throw new Error('Native origin timed out');
      }
      last = 'no-matching-webview';
      await new Promise(ok => setTimeout(ok, Math.min(intervalMs, Math.max(1, deadline - Date.now()))));
    }
    throw new Error('WebView discovery timed out');
  } catch (error) {
    last = connectionErrorCode(error); emit();
    for (const device of devices) { try { await bounded(device.close(), 2000); } catch { diagnostic({ stage: 'disconnect', code: 'disconnect-error' }); } }
    throw new Error('Android WebView connection failed at ' + stage + ' (' + last + ')');
  }
}
export function assertHostedRuntime(env = process.env, platform = process.platform, arch = process.arch) {
  if (env.GITHUB_ACTIONS !== 'true' || env.CI !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted' || platform !== 'linux' || arch !== 'x64') throw new Error('Native runtime probe requires an ephemeral GitHub-hosted Linux x86_64 runner');
}
export async function runProbe({ phase }) {
  parseArgs(['--phase', phase]);
  assertHostedRuntime();
  const body = extractDiagnostic(await readFile(resolve(ROOT, 'native-probe/NativeReleaseProbe.swift'), 'utf8'));
  const { _android } = await import('playwright-core');
  const output = resolve(ROOT, 'output');
  await mkdir(output, { recursive: true });
  const diagnostics = [];
  let connection;
  try {
    connection = await connectNativePage(_android, { diagnostic: event => { if (diagnostics.length < 100) diagnostics.push(event); } });
  } finally {
    await writeFile(resolve(output, 'android-webview-connection-' + phase + '.json'), JSON.stringify(diagnostics, null, 2) + '\n');
  }
  const { browser, page } = connection;
  try {
    await page.waitForFunction(() => document.readyState === 'complete' && Boolean(window.__NATIVE_CAPABILITIES__), null, { timeout: 45000 });
    if (!isNativePage(page.url())) throw new Error('Native WebView navigated away');
    // Only the repository-owned shared diagnostic is executed; phase is its sole argument.
    // No browser creation, capability overrides, canonical DB access or source-suite execution.
    const value = await page.evaluate(async ({ body, phase }) => {
      if (location.origin !== 'https://localhost') throw new Error('Unexpected WebView origin');
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      return await Promise.race([
        new AsyncFunction('phase', body)(phase),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Diagnostic timed out')), 30000))
      ]);
    }, { body, phase });
    const result = decodeResult(value, phase);
    await writeFile(resolve(output, 'native-android-probe-' + phase + '.json'), JSON.stringify(result, null, 2) + '\n');
    try { await writeFile(resolve(output, 'android-ui-aria.txt'), await page.locator('body').ariaSnapshot({ timeout: 5000 }) + '\n'); } catch { /* optional UI evidence */ }
    assertPassed(result, phase);
    console.log('Android native WebView ' + phase + ' probe passed');
    return result;
  } finally { await browser.close(); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runProbe(parseArgs(process.argv.slice(2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
