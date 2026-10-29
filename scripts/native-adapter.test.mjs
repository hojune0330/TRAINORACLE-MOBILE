import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const source = await readFile(new URL('web-adapter/bootstrap.js', root), 'utf8');
const context = { URL, Blob, Uint8Array, btoa, Map, Set, Promise, globalThis: { btoa },
  Capacitor: { isNativePlatform: () => false }, registerPlugin: name => ({ name }),
  installOfflineHealthBootstrap: () => assert.fail('health preview must not start in this fixture') };
vm.createContext(context);
// Only the two inspected static imports are injected. Unknown future imports still fail parsing.
const executableSource = source
  .replace(/^import \{ Capacitor, registerPlugin \} from '@capacitor\/core';\r?\n/m, '')
  .replace(/^import \{ installOfflineHealthBootstrap \} from '\.\/health-bootstrap\.js';\r?\n/m, '')
  .replace(/\bexport /g, '');
vm.runInContext(executableSource + '\nglobalThis.api = { MAX_DOCUMENT_BYTES, capabilities, safeDocumentPath, safeExternalURL, validFilename, blobPayload, installAdapter, NativeDocuments };', context);
const api = context.globalThis.api;
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
function fixture() {
  let originalClicks = 0, creates = 0, revokes = 0, time = 100;
  const listeners = new Map();
  class Anchor {
    constructor(href, download, target = '') { this.href = href; this.target = target; this.attributes = { href }; if (download !== undefined) this.attributes.download = download; }
    hasAttribute(k) { return Object.hasOwn(this.attributes, k); }
    getAttribute(k) { return this.attributes[k] ?? null; }
    closest() { return this; }
    click() { originalClicks++; }
  }
  const env = { Blob, HTMLAnchorElement: Anchor, performance: { now: () => time }, URL: {
    createObjectURL() { return 'blob:local/' + ++creates; }, revokeObjectURL() { revokes++; }
  }, btoa, location: { href: 'https://localhost/index.html', origin: 'https://localhost' },
    document: { addEventListener(k, fn) { listeners.set(k, fn); }, removeEventListener(k) { listeners.delete(k); } },
    isSecureContext: true, navigator: { locks: { request() {} } }, crypto: { subtle: {} }, indexedDB: {}, localStorage: {} };
  const saves = [], locals = [], externals = [];
  const plugin = { async saveDocument(v) { saves.push(v); return { status: 'cancelled' }; },
    async openLocalDocument(v) { locals.push(v); }, async openExternal(v) { externals.push(v); } };
  const dispose = api.installAdapter(env, plugin);
  const click = (anchor, trusted = true) => {
    const event = { target: anchor, isTrusted: trusted, prevented: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() {} };
    listeners.get('click')(event); return event;
  };
  const gesture = (trusted = true) => click({ closest: () => null }, trusted);
  const key = (key = 'Enter', trusted = true, repeat = false) => listeners.get('keydown')({ key, isTrusted: trusted, repeat });
  return { env, Anchor, saves, locals, externals, dispose, click, gesture, key, advance: ms => { time += ms; }, counts: () => ({ originalClicks, creates, revokes }) };
}
test('registerPlugin contract and no startup native writes', async () => {
  assert.equal(api.NativeDocuments.name, 'NativeDocuments');
  const f = fixture(); await tick(); assert.equal(f.saves.length + f.locals.length + f.externals.length, 0); f.dispose();
});
test('synchronous Blob capture survives immediate revoke: original JSON bytes and Unicode filename', async () => {
  const f = fixture(); const bytes = new TextEncoder().encode('{"한국어":true}');
  const href = f.env.URL.createObjectURL(new Blob([bytes], { type: 'application/json' }));
  f.gesture(); new f.Anchor(href, '운동 기록.json').click(); f.env.URL.revokeObjectURL(href);
  assert.equal(f.saves.length, 0); await tick();
  assert.equal(f.saves.length, 1); assert.equal(f.saves[0].filename, '운동 기록.json');
  assert.deepEqual(Buffer.from(f.saves[0].dataBase64, 'base64'), Buffer.from(bytes));
  assert.equal(f.counts().originalClicks, 0); assert.equal(f.counts().revokes, 1); f.dispose();
});
test('PNG click event captured and duplicate while picker busy suppressed', async () => {
  const f = fixture(), bytes = Uint8Array.of(137,80,78,71,0,255);
  const href = f.env.URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
  const a = new f.Anchor(href, 'plot.png'); assert.equal(f.click(a).prevented, true); a.click(); f.env.URL.revokeObjectURL(href);
  await tick(); assert.equal(f.saves.length, 1); assert.deepEqual(Buffer.from(f.saves[0].dataBase64, 'base64'), Buffer.from(bytes)); f.dispose();
});
test('revoked before click is not captured; ordinary web downloads remain untouched', () => {
  const f = fixture(); const href = f.env.URL.createObjectURL(new Blob(['{}'], { type: 'application/json' }));
  f.env.URL.revokeObjectURL(href); new f.Anchor(href, 'a.json').click(); new f.Anchor('/ordinary', undefined).click();
  assert.equal(f.counts().originalClicks, 2); f.dispose();
});
test('exact 32MiB accepted and 32MiB+1 rejected before reading', async () => {
  const max = api.MAX_DOCUMENT_BYTES; assert.equal(max, 33554432);
  const payload = await api.blobPayload(new Blob([new Uint8Array(max)], { type: 'image/png' }), 'max.png');
  assert.equal(Buffer.from(payload.dataBase64, 'base64').length, max);
  let read = false;
  await assert.rejects(api.blobPayload({ type: 'image/png', size: max + 1, arrayBuffer() { read = true; } }, 'too.png'));
  assert.equal(read, false);
});
test('invalid MIME/name and inconsistent size rejected', async () => {
  for (const name of ['', '../x.json', 'a/b.json', 'a\\b.json', '..', String.fromCharCode(0)]) assert.equal(api.validFilename(name), false);
  await assert.rejects(api.blobPayload(new Blob(['x'], { type: 'text/html' }), 'x.html'));
  await assert.rejects(api.blobPayload({ type: 'image/png', size: 1, arrayBuffer: async () => new ArrayBuffer(2) }, 'a.png'));
});
test('safe local HTML allowlist rejects traversal, encoded paths, schemes, queries', () => {
  const base = 'capacitor://localhost/index.html';
  assert.equal(api.safeDocumentPath('legal/privacy.html', base), 'legal/privacy.html');
  assert.equal(api.safeDocumentPath('/support.html', base), 'support.html');
  for (const value of ['../secret.html', 'legal/../x.html', './x.html', '%2e%2e/x.html', '%252e/x.html', 'legal%2fx.html', 'legal\\x.html', '//host/x.html', 'https://localhost/a.html', 'javascript:x.html', 'a.html?x=1', 'a.html#x', 'a.txt', '/a//b.html']) assert.equal(api.safeDocumentPath(value, base), null, value);
});
test('external HTTPS/mailto allowlist only dispatches trusted click', async () => {
  const f = fixture();
  for (const u of ['http://example.org', 'javascript:alert(1)', 'file:///x', 'https://user:pass@example.org', 'mailto:a@example.org?subject=x%0aBcc:x', 'https://example.org/\\x']) assert.equal(api.safeExternalURL(u), null, u);
  assert.equal(f.click(new f.Anchor('https://example.org', undefined), false).prevented, true);
  assert.equal(f.click(new f.Anchor('https://example.org', undefined)).prevented, true);
  f.click(new f.Anchor('mailto:a@example.org', undefined));
  f.click(new f.Anchor('legal/privacy.html', undefined, '_blank'));
  f.click(new f.Anchor('../x.html', undefined, '_blank'));
  await tick(); assert.equal(f.externals.length, 2); assert.equal(f.locals.length, 1); assert.equal(f.locals[0].path, 'legal/privacy.html'); f.dispose();
});
test('capabilities are booleans, never invoke locks/crypto/storage operations', () => {
  const forbidden = () => { throw new Error('mutation'); };
  const lock = { request: forbidden }, subtle = { encrypt: forbidden }, storage = { setItem: forbidden, removeItem: forbidden, clear: forbidden };
  const env = { isSecureContext: true, navigator: { locks: lock }, crypto: { subtle }, indexedDB: { open: forbidden, deleteDatabase: forbidden }, localStorage: storage };
  const result = api.capabilities(env); assert.equal(Object.values(result).every(x => x === true), true);
  assert.equal(env.navigator.locks, lock); assert.equal(env.crypto.subtle, subtle); assert.equal(env.localStorage, storage);
  const unavailable = api.capabilities({ get localStorage() { throw new Error('denied'); } });
  assert.equal(Object.values(unavailable).every(x => x === false), true);
});
test('native templates retain bounded, public API, local-only contracts', async () => {
  const java = await readFile(new URL('native-templates/android/NativeDocumentsPlugin.java', root), 'utf8');
  const swift = await readFile(new URL('native-templates/ios/NativeDocumentsPlugin.swift', root), 'utf8');
  const bridge = await readFile(new URL('native-templates/ios/NativeBridgeViewController.swift', root), 'utf8');
  for (const fragment of ['package __APP_ID__', 'Intent.ACTION_CREATE_DOCUMENT', '@ActivityCallback', 'Activity.RESULT_OK', 'openOutputStream', '32 * 1024 * 1024', 'setJavaScriptEnabled(false)', 'setBlockNetworkLoads(true)', 'request.hasGesture()']) assert.ok(java.includes(fragment), fragment);
  assert.ok(java.indexOf('Activity.RESULT_OK') < java.indexOf('openOutputStream'));
  for (const fragment of ['CAPBridgedPlugin', 'UIDocumentPickerViewController(forExporting:', 'asCopy: true', 'documentPickerWasCancelled', 'cleanTransient()', 'allowsContentJavaScript = false', '.nonPersistent()', 'compileContentRuleList', '.linkActivated', 'loadFileURL']) assert.ok(swift.includes(fragment), fragment);
  for (const fragment of ['registerPluginInstance(NativeDocumentsPlugin())', 'isExcludedFromBackup = true', 'WebKit', 'Application Support', 'NativeStoreBackupPreparation', 'prepareBeforeWebViewCreation()', 'guard entries.isEmpty else { continue }', 'contentsOfDirectory(atPath:', 'resolvingSymlinksInPath()', 'createDirectory(at:']) assert.ok(bridge.includes(fragment), fragment);
  assert.ok(bridge.indexOf('guard entries.isEmpty') < bridge.indexOf('setResourceValues(values)'));
  const controller = bridge.substring(bridge.indexOf('final class NativeBridgeViewController'), bridge.indexOf('enum NativeStoreBackupPreparation'));
  assert.doesNotMatch(controller, /prepareBeforeWebViewCreation\(|setResourceValues|viewDidLoad|viewDidAppear|NotificationCenter/);
  assert.doesNotMatch(bridge, /removeItem|moveItem|Data\(contentsOf|UserDefaults|willEnterForegroundNotification/);
  assert.doesNotMatch(source, /navigator\.userActivation\s*=|userActivation\.(isActive|hasBeenActive)\s*=/);
  assert.doesNotMatch(java + swift + bridge, /console\.log|Log\.|print\(|NSLog|onBackPressed|evaluateJavaScript|iCloud|HealthKit|SensorManager|ACTION_SEND/);
  assert.doesNotMatch(source, /fetch\(|XMLHttpRequest|localStorage\.(setItem|clear|removeItem)|indexedDB\.open|console\./);
});

test('ungated programmatic and synthetic downloads never save or fall back to browser', async () => {
  const f = fixture();
  const href = f.env.URL.createObjectURL(new Blob(['{}'], { type: 'application/json' }));
  const a = new f.Anchor(href, 'blocked.json');
  a.click(); f.gesture(false); a.click(); f.key('Enter', false); a.click();
  assert.equal(f.click(a, false).prevented, true);
  await tick(); assert.equal(f.saves.length, 0); assert.equal(f.counts().originalClicks, 0); f.dispose();
});
test('one trusted gesture authorizes exactly one ensuing download, never reuse', async () => {
  const f = fixture();
  const make = () => {
    const href = f.env.URL.createObjectURL(new Blob(['{}'], { type: 'application/json' }));
    const a = new f.Anchor(href, 'once.json'); a.click(); f.env.URL.revokeObjectURL(href);
  };
  f.gesture(); make(); await tick(); assert.equal(f.saves.length, 1);
  make(); await tick(); assert.equal(f.saves.length, 1);
  f.gesture(); make(); await tick(); assert.equal(f.saves.length, 2); f.dispose();
});
test('trusted activation expires at 5 seconds and repeated/irrelevant keys do not arm', async () => {
  const f = fixture();
  const href = f.env.URL.createObjectURL(new Blob(['{}'], { type: 'application/json' }));
  const a = new f.Anchor(href, 'expired.json');
  f.gesture(); f.advance(5000); a.click();
  f.key('Enter', true, true); a.click(); f.key('Escape'); a.click();
  await tick(); assert.equal(f.saves.length, 0);
  f.key('Enter'); a.click(); await tick(); assert.equal(f.saves.length, 1); f.dispose();
});
test('asynchronous PNG export within activation window survives immediate revoke', async () => {
  const f = fixture(); const bytes = Uint8Array.of(137,80,78,71,255,0,42);
  f.key(' '); await tick(); f.advance(4999);
  const href = f.env.URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
  new f.Anchor(href, 'async.png').click(); f.env.URL.revokeObjectURL(href);
  await tick(); assert.equal(f.saves.length, 1);
  assert.deepEqual(Buffer.from(f.saves[0].dataBase64, 'base64'), Buffer.from(bytes)); f.dispose();
});

test('bootstrap dependencies are explicitly injected and future imports are not silently removed', () => {
  assert.match(source, /^import \{ installOfflineHealthBootstrap \} from '\.\/health-bootstrap\.js';/m);
  assert.doesNotMatch(executableSource, /^import /m);
  assert.throws(() => vm.runInContext('import unknown from "unreviewed";\n' + executableSource, context), /import statement/);
});