import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const EXPECTED_ORIGIN = 'https://localhost';
export const CDP_ENDPOINT = 'http://127.0.0.1:9222';
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
export async function connectNativePage(chromium, { timeoutMs = 45000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let browser;
    try {
      browser = await chromium.connectOverCDP(CDP_ENDPOINT, { timeout: Math.min(5000, Math.max(1, deadline - Date.now())) });
      while (Date.now() < deadline) {
        const pages = browser.contexts().flatMap(context => context.pages()).filter(p => isNativePage(p.url()));
        if (pages.length === 1) return { browser, page: pages[0] };
        if (pages.length > 1) throw new Error('Ambiguous native WebView');
        await new Promise(ok => setTimeout(ok, 500));
      }
    } catch {
      // The forwarded app process may not have exposed its WebView yet.
    }
    if (browser) await browser.close().catch(() => {}); // Disconnect attached CDP, never launch a browser.
    if (Date.now() < deadline) await new Promise(ok => setTimeout(ok, 500));
  }
  throw new Error('Native localhost WebView CDP connection timed out');
}
export function assertHostedRuntime(env = process.env, platform = process.platform, arch = process.arch) {
  if (env.GITHUB_ACTIONS !== 'true' || env.CI !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted' || platform !== 'linux' || arch !== 'x64') throw new Error('Native runtime probe requires an ephemeral GitHub-hosted Linux x86_64 runner');
}
export async function runProbe({ phase }) {
  parseArgs(['--phase', phase]);
  assertHostedRuntime();
  const body = extractDiagnostic(await readFile(resolve(ROOT, 'native-probe/NativeReleaseProbe.swift'), 'utf8'));
  const { chromium } = await import('playwright-core');
  const { browser, page } = await connectNativePage(chromium);
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
    const output = resolve(ROOT, 'output');
    await mkdir(output, { recursive: true });
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
