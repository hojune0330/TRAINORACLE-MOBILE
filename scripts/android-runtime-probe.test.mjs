import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ROOT, CDP_ENDPOINT, parseArgs, extractDiagnostic, isNativePage, decodeResult, assertPassed, connectNativePage, assertHostedRuntime } from './android-runtime-probe.mjs';

// Pure parser/gate tests only. No app source imports, remote requests, emulator,
// native compiler, Playwright browser launch or diagnostic JS execution.
function fixture(phase = 'write') {
  return { probeReady: true, storageStage: phase, secureContext: true, locksAvailable: true, cryptoAvailable: true, indexedDBAvailable: true, localStorageAvailable: true, nativeDocumentsAvailable: true, appPluginAvailable: true, realLock: true, cryptoRoundTrip: true, localStorageRoundTrip: true, indexedDBRoundTrip: true, rootRendered: true, coreContentPresent: true, storageFailureVisible: false, ...(phase === 'read' ? { localStoragePersistence: true, indexedDBPersistence: true } : {}) };
}
test('direct runtime execution rejects local machines and self-hosted runners', () => {
  const hosted = { GITHUB_ACTIONS: 'true', CI: 'true', RUNNER_ENVIRONMENT: 'github-hosted' };
  assert.doesNotThrow(() => assertHostedRuntime(hosted, 'linux', 'x64'));
  for (const env of [{}, { ...hosted, RUNNER_ENVIRONMENT: 'self-hosted' }, { ...hosted, GITHUB_ACTIONS: 'false' }, { ...hosted, CI: 'false' }]) assert.throws(() => assertHostedRuntime(env, 'linux', 'x64'));
  assert.throws(() => assertHostedRuntime(hosted, 'win32', 'x64'));
  assert.throws(() => assertHostedRuntime(hosted, 'linux', 'arm64'));
});
test('phase parser accepts only explicit write/read; no origin, source or browser flags', () => {
  for (const phase of ['write', 'read']) assert.deepEqual(parseArgs(['--phase', phase]), { phase });
  for (const args of [[], ['--phase', '1'], ['--phase', 'READ'], ['--phase=read'], ['--phase', 'write', '--origin', 'https://example.org'], ['--phase', 'read', '--phase', 'write']]) assert.throws(() => parseArgs(args));
});
test('Swift raw-string parser extracts exactly one body without executing it', () => {
  const body = 'throw new Error("MUST NOT EXECUTE");\nreturn JSON.stringify({storageStage:phase});';
  const swift = 'let script = #"""\n' + body + '\n        """#';
  assert.equal(extractDiagnostic(swift), body);
  assert.equal(extractDiagnostic(swift.replaceAll('\n', '\r\n')), body.replaceAll('\n', '\r\n'));
  for (const input of ['', 'let script = "not a raw string"', swift + '\n' + swift, 'let script = #"""\n\n"""#']) assert.throws(() => extractDiagnostic(input));
});
test('origin gate permits only the actual secure native localhost origin', () => {
  for (const url of ['https://localhost', 'https://localhost/', 'https://localhost/index.html', 'https://localhost:443/']) assert.equal(isNativePage(url), true);
  for (const url of ['http://localhost', 'https://localhost:9222/', 'https://127.0.0.1/', 'https://localhost.evil.test', 'https://user:pass@localhost/', 'capacitor://localhost', 'about:blank', 'not a url']) assert.equal(isNativePage(url), false);
});
test('write gate validates stage and emits boolean-only diagnostic values', () => {
  const result = decodeResult(JSON.stringify(fixture()), 'write');
  assert.equal(assertPassed(result, 'write'), true);
  assert.ok(Object.values(result).every(value => typeof value === 'boolean'));
  assert.equal(result.phaseWrite, true); assert.equal(result.phaseRead, false);
  assert.ok(!('storageStage' in result));
});
test('read gate requires both real persistence flags, never infers them from roundtrip', () => {
  assert.equal(assertPassed(decodeResult(fixture('read'), 'read'), 'read'), true);
  for (const key of ['localStoragePersistence', 'indexedDBPersistence']) {
    const missing = fixture('read'); delete missing[key];
    assert.throws(() => decodeResult(missing, 'read'), /persistence/);
    const failed = fixture('read'); failed[key] = false;
    assert.throws(() => assertPassed(decodeResult(failed, 'read'), 'read'), /persistence/);
  }
});
test('every capability and UI flag must pass, including native plugin and rendered core', () => {
  for (const [key, value] of Object.entries(fixture())) {
    if (key === 'storageStage') continue;
    const bad = fixture(); bad[key] = !value;
    assert.throws(() => assertPassed(decodeResult(bad, 'write'), 'write'), key);
    const missing = fixture(); delete missing[key];
    assert.throws(() => decodeResult(missing, 'write'), key);
  }
});
test('malformed, non-boolean, unknown and wrong-stage data fail closed', () => {
  for (const raw of [null, [], false, '{}', '{broken', fixture('read'), { ...fixture(), localStorageRoundTrip: 'true' }, { ...fixture(), userData: 'never accepted' }, { ...fixture(), fabricated: true }]) assert.throws(() => decodeResult(raw, 'write'));
  assert.throws(() => decodeResult(fixture(), 'other'));
  assert.throws(() => assertPassed(decodeResult(fixture(), 'write'), 'read'), /stage/);
});
test('CDP attachment selects an existing native page without creating pages or browsers', async () => {
  let calls = 0;
  const native = { url: () => 'https://localhost/' };
  const browser = { contexts: () => [{ pages: () => [{ url: () => 'about:blank' }, native] }] };
  const chromium = { connectOverCDP: async (endpoint, options) => { calls++; assert.equal(endpoint, CDP_ENDPOINT); assert.ok(options.timeout > 0); return browser; } };
  assert.deepEqual(await connectNativePage(chromium), { browser, page: native });
  assert.equal(calls, 1);
});
test('shared diagnostic is read as text only and confines storage access to its reserved probe', async () => {
  const swift = await readFile(resolve(ROOT, 'native-probe/NativeReleaseProbe.swift'), 'utf8');
  const body = extractDiagnostic(swift); // Deliberately never eval/compile/run shared JS.
  assert.match(body, /const localKey='__trainoracle_native_ci_probe_v1__'/);
  for (const match of body.matchAll(/localStorage\.(?:getItem|setItem|removeItem)\(([^,)]+)/g)) assert.equal(match[1], 'localKey');
  const databaseCalls = [...body.matchAll(/indexedDB\.(?:open|deleteDatabase)\(([^,)]+)/g)];
  assert.equal(databaseCalls.length, 2);
  for (const match of databaseCalls) assert.equal(match[1], "'__trainoracle_native_ci_probe_v1__'");
  assert.match(body, /navigator\.locks\.request\(/);
  assert.match(body, /crypto\.subtle\.encrypt\(/);
  assert.match(body, /crypto\.subtle\.decrypt\(/);
  assert.doesNotMatch(body, /(?:navigator\.locks|crypto\.subtle|isSecureContext)\s*=|Object\.defineProperty|fetch\(|XMLHttpRequest/);
});
test('runner is attach-only and never imports or runs an original source regression suite', async () => {
  const text = await readFile(resolve(ROOT, 'scripts/android-runtime-probe.mjs'), 'utf8');
  assert.doesNotMatch(text, /chromium\.launch|launchPersistentContext|newContext\(|newPage\(|addInitScript\(|exposeBinding\(|spawn\(|execFile\(/);
  assert.match(text, /connectOverCDP\(/);
  assert.match(text, /new AsyncFunction\('phase', body\)\(phase\)/);
});
test('shell keeps the same APK and data, isolates a CI AVD, and captures an actual screen', async () => {
  const shell = await readFile(resolve(ROOT, 'scripts/run-android-runtime.sh'), 'utf8');
  assert.match(shell, /RUNNER_ENVIRONMENT/);
  assert.match(shell, /google_apis;x86_64/);
  assert.match(shell, /boot_deadline=\$\(\(SECONDS \+ 180\)\)/);
  assert.match(shell, /install -r "\$APK"/);
  assert.match(shell, /am force-stop "\$PACKAGE"/);
  assert.doesNotMatch(shell, /\badb\s+uninstall\b|"\$ADB"[^\n]*\buninstall\b|\bpm\s+clear\b/);
  assert.match(shell, /cmd package resolve-activity/);
  assert.match(shell, /webview_devtools_remote_\$pid/);
  assert.match(shell, /shell screencap -p \/sdcard\//);
  assert.match(shell, /pull \/sdcard\/trainoracle-native-ci\.png/);
  assert.doesNotMatch(shell, /exec-out|MainActivity|npx playwright|npm (?:ci|install)/);
});
