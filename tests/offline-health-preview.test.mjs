import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createOfflineHealthPreviewController as create, installOfflineHealthPreview as install, normalizeHealthPreview as normalize, normalizeHealthAvailability as normalizeStatus } from '../web-adapter/offline-health-preview.js';
import { createIOSHealthContext } from '../web-adapter/ios-health-context.js';
const row = (patch = {}) => ({ uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', start: '2026-10-28T10:00:00Z', end: '2026-10-28T10:10:00Z', durationSeconds: 590, distanceMeters: null, ...patch });
const payload = (patch = {}) => ({ source: 'apple-healthkit', workouts: [row()], ...patch });
const android = (patch = {}) => ({ provider: 'health-connect', sessions: [{ sourcePackage: 'com.fixture.running', sourceRecordId: 'record-1', startTime: row().start, endTime: row().end, exerciseType: 'running', ...patch }] });
const tick = async () => { for (let n = 0; n < 10; n++) await Promise.resolve(); };
function fixture(options = {}) {
  const calls = [], requests = [], states = [];
  let foreground = true;
  const driver = { open: async () => { calls.push('open'); }, request: (method, input) => { calls.push(method); return new Promise((resolve, reject) => requests.push({ resolve, reject, input })); },
    invalidateContext: async () => { calls.push('invalidateContext'); }, invalidateSession: async () => { calls.push('invalidateSession'); }, background: async () => { calls.push('background'); }, dispose: async () => { calls.push('dispose'); } };
  const controller = create({ enabled: true, driver, platform: 'ios', timeoutMs: 100, now: () => Date.parse('2026-10-29T10:00:00Z'), isForeground: () => foreground, onChange: s => states.push(s), ...options });
  return { controller, calls, requests, states, driver, loseForeground: () => { foreground = false; } };
}
test('default OFF never reads env, driver, DOM, history or storage', async () => {
  const poison = new Proxy({}, { get() { throw new Error('touched'); } });
  const off = install(poison, { driver: poison, platform: 'ios' });
  assert.equal(off.open(), false); assert.equal(await off.read(), false); assert.equal(await off.authorize(), false);
  off.close(); off.invalidateSession(); off.background(); off.dispose(); assert.equal(off.getState().epoch, 0);
});
test('manual controller open does not call native; query limited to last seven days', async () => {
  const f = fixture(); f.controller.open(); assert.deepEqual(f.calls, []);
  const pending = f.controller.read(); await tick(); assert.deepEqual(f.calls, ['open', 'readRunningWorkouts']);
  assert.deepEqual(f.requests[0].input, { start: '2026-10-22T10:00:00.000Z', end: '2026-10-29T10:00:00.000Z', limit: 100 });
  f.requests[0].resolve(payload()); assert.equal(await pending, true); assert.equal(f.controller.getState().status, 'unreviewed');
  const epoch = f.controller.getState().epoch; f.controller.close(); assert.equal(f.controller.getState().rows.length, 0); assert.equal(f.controller.getState().epoch, epoch + 1); f.controller.dispose();
});
for (const boundary of ['close', 'invalidateContext', 'invalidateSession', 'background', 'dispose']) {
  for (const result of ['success', 'error']) test(`late ${result} after ${boundary} never notifies/applies`, async () => {
    const f = fixture(); f.controller.open(); const pending = f.controller.read(); await tick();
    f.controller[boundary](); assert.equal(f.controller.getState().rows.length, 0); assert.equal(f.controller.getState().visible, false);
    assert.equal(await pending, false); const count = f.states.length;
    if (result === 'success') f.requests[0].resolve(payload()); else f.requests[0].reject(new Error('RAW_HEALTH_SECRET'));
    await tick(); assert.equal(f.states.length, count); assert.equal(f.controller.getState().rows.length, 0); f.controller.dispose();
  });
}
test('old response cannot overwrite newly opened context', async () => {
  const f = fixture(); f.controller.open(); const old = f.controller.read(); await tick(); f.controller.close(); await old;
  f.controller.open(); const fresh = f.controller.read(); await tick(); f.requests[1].resolve(payload({ workouts: [] })); await fresh;
  f.requests[0].resolve(payload()); await tick(); assert.equal(f.controller.getState().rows.length, 0); assert.equal(f.controller.getState().status, 'unreviewed'); f.controller.dispose();
});
test('double query/auth has one active request only', async () => {
  const f = fixture(); f.controller.open(); const p = f.controller.read(); assert.equal(await f.controller.read(), false); assert.equal(await f.controller.authorize(), false);
  await tick(); assert.equal(f.requests.length, 1); f.requests[0].resolve(payload()); await p; f.controller.dispose();
});
test('late open never dispatches request', async () => {
  let resolveOpen; const f = fixture(); f.driver.open = () => new Promise(r => { resolveOpen = r; });
  f.controller.open(); const p = f.controller.read(); f.controller.close(); assert.equal(await p, false); resolveOpen(); await tick(); assert.equal(f.requests.length, 0); f.controller.dispose();
});
test('foreground guard drops response even without event delivery', async () => {
  const f = fixture(); f.controller.open(); const p = f.controller.read(); await tick(); f.loseForeground(); f.requests[0].resolve(payload()); assert.equal(await p, false);
  assert.equal(f.controller.getState().visible, false); assert.equal(f.controller.getState().rows.length, 0); f.controller.dispose();
});
test('timeout settles hung open and invalidates; cleanup can hang safely', async () => {
  const f = fixture({ timeoutMs: 5 }); f.driver.open = () => new Promise(() => {}); f.driver.invalidateContext = () => new Promise(() => {});
  f.controller.open(); assert.equal(await f.controller.read(), false); assert.equal(f.controller.getState().status, 'timeout'); assert.equal(f.controller.getState().busy, false); f.controller.dispose();
});
test('cancellation and authorization are not read-permission proof', async () => {
  const f = fixture(); f.controller.open(); const p = f.controller.authorize(); await tick(); assert.deepEqual(f.requests[0].input, {});
  f.requests[0].reject(Object.assign(new Error('secret'), { code: 'USER_CANCELLED' })); assert.equal(await p, false); assert.equal(f.controller.getState().status, 'cancelled');
  const p2 = f.controller.authorize(); await tick(); f.requests[1].resolve({ granted: true, secret: 'must not persist' }); await p2;
  assert.equal(f.controller.getState().status, 'authorization-returned'); assert.deepEqual(f.controller.getState().rows, []); f.controller.dispose();
});
test('allowlist DTO, frozen records, distance absence vs zero and provider distinction', () => {
  const raw = payload({ token: 'secret', workouts: [row({ route: 'SECRET', distanceMeters: 0 })] });
  Object.defineProperty(raw, 'unused', { get() { throw new Error('must not access'); } });
  const rows = normalize(raw, 'ios'); assert.equal(rows[0].distanceStatus, 'provided'); assert.equal(rows[0].distanceMeters, 0);
  assert.ok(Object.isFrozen(rows) && Object.isFrozen(rows[0])); assert.ok(!JSON.stringify(rows).includes('SECRET')); assert.ok(!JSON.stringify(rows).includes('secret'));
  const a = normalize(android(), 'android')[0]; assert.equal(a.source, 'health-connect'); assert.equal(a.sourcePackage, 'com.fixture.running'); assert.equal(a.distanceStatus, 'not-provided'); assert.equal(a.durationKind, 'elapsed');
  assert.equal(normalize(payload(), 'ios')[0].distanceStatus, 'not-provided');
});
test('exact duplicates collapse; same identity conflicting fields reject atomically', () => {
  assert.equal(normalize(payload({ workouts: [row(), row()] }), 'ios').length, 1);
  assert.throws(() => normalize(payload({ workouts: [row(), row({ distanceMeters: 5 })] }), 'ios'), /DUPLICATE_ID_CONFLICT/);
  const a = android(); a.sessions.push({ ...a.sessions[0], endTime: '2026-10-28T11:00:00Z' }); assert.throws(() => normalize(a, 'android'), /DUPLICATE_ID_CONFLICT/);
});
for (const patch of [{ uuid: '<img>' }, { start: 'not a date' }, { start: '2026-02-30T10:00:00Z' }, { end: row().start }, { durationSeconds: Infinity }, { durationSeconds: -1 }, { distanceMeters: NaN }, { distanceMeters: undefined }]) test('unsafe DTO rejected ' + Object.keys(patch)[0] + JSON.stringify(patch), () => assert.throws(() => normalize(payload({ workouts: [row(patch)] }), 'ios')));
test('max100, bad source, bounds, exercise and accessors rejected', () => {
  assert.throws(() => normalize(payload({ workouts: Array.from({ length: 101 }, () => row()) }), 'ios'), /INVALID_ROWS/);
  assert.throws(() => normalize(payload({ source: 'samsung' }), 'ios'), /INVALID_SOURCE/);
  assert.throws(() => normalize(android({ sourceRecordId: 'a'.repeat(257) }), 'android'), /INVALID_ID/);
  assert.throws(() => normalize(android({ exerciseType: 'walking' }), 'android'), /INVALID_EXERCISE/);
  assert.throws(() => normalize(android({ sourcePackage: '<script>' }), 'android'), /INVALID_SOURCE/);
  const p = payload(); Object.defineProperty(p, 'workouts', { get() { throw new Error('secret'); } }); assert.throws(() => normalize(p, 'ios'), /INVALID_DTO/);
});
test('no auto storage/network/log, safe rendering source invariant (not runtime proof)', async () => {
  const source = await readFile(new URL('../web-adapter/offline-health-preview.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:localStorage|sessionStorage|indexedDB|fetch|XMLHttpRequest|sendBeacon|console)\s*[.(]/);
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|preventDefault|stopPropagation|stopImmediatePropagation/);
});
test('existing iOS context driver reusable with consumer flag explicitly synthetic', async () => {
  const native = { beginContext: async () => ({ contextToken: 'fixture', documentEpoch: 1, contextEpoch: 1, sessionEpoch: 1 }), invalidateContext: async () => {}, invalidateSession: async () => {},
    readRunningWorkouts: async args => ({ ...args, ...payload() }) };
  const driver = createIOSHealthContext({ native, consumerIntegrated: true, isForeground: () => true, randomId: () => 'fixture-1', timeoutMs: 100 });
  const c = create({ driver, platform: 'ios', enabled: true, timeoutMs: 100 }); c.open(); assert.equal(await c.read(), true); assert.equal(c.getState().rows.length, 1); c.dispose();
});
// Minimal dependency-free DOM fixture. Synthetic trusted events are fixture values, not browser automation.
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = new Map(); this.open = false; this.attributes = {}; }
  setAttribute(k, v) { this.attributes[k] = v; }
  append(...nodes) { for (const n of nodes) { n.remove(); n.parent = this; this.children.push(n); } }
  replaceChildren() { for (const n of this.children) n.parent = null; this.children = []; }
  get isConnected() { return this.tag === 'document' || !!this.parent?.isConnected; }
  contains(node) { return node === this || this.children.some(n => n.contains(node)); }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type, event = {}) { for (const fn of this.listeners.get(type) || []) fn({ target: this, ...event }); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); this.parent = null; }
  showModal() { this.open = true; }
  close() { this.open = false; this.emit('close'); }
  closest() { return this; }
}
function dom() {
  const env = new Element('window'), doc = new Element('document'); env.document = doc;
  doc.createElement = tag => Object.assign(new Element(tag), { ownerDocument: doc });
  doc.documentElement = doc.createElement('html'); doc.append(doc.documentElement);
  doc.body = doc.createElement('body'); doc.documentElement.append(doc.body); doc.visibilityState = 'visible';
  env.replaceBody = () => { const old = doc.body; old.remove(); doc.body = doc.createElement('body'); doc.documentElement.append(doc.body); return old; };
  env.history = { pushState(...args) { return args.length; }, replaceState() { return 7; } };
  env.MutationObserver = class { constructor(fn) { this.fn = fn; this.observed = []; env.observer = this; } observe(target, options) { this.observed.push({ target, options }); } disconnect() { this.disconnected = true; } };
  return env;
}
test('DOM fixture manual buttons, safe text, own mutations, synchronous routing invalidation, cleanup', async () => {
  const env = dom(), f = fixture(), original = env.history.pushState;
  const c = install(env, { driver: f.driver, platform: 'ios', enabled: true }); const root = env.document.body.children[0], [entry, dialog] = root.children;
  const [, , check, auth, read, close, , list] = dialog.children;
  assert.equal(entry.textContent, '건강 기록 미리보기'); assert.deepEqual(f.calls, []);
  entry.emit('click', { isTrusted: false }); assert.equal(c.getState().visible, false);
  entry.emit('click', { isTrusted: true }); assert.equal(c.getState().visible, true); assert.deepEqual(f.calls, []);
  env.observer.fn([{ target: dialog }]); assert.equal(c.getState().visible, true);
  env.emit('blur', { target: auth }); assert.equal(c.getState().visible, true); // child blur is not background
  read.emit('click', { isTrusted: false }); assert.deepEqual(f.calls, []);
  read.emit('click', { isTrusted: true }); await tick(); f.requests[0].resolve(payload()); await tick();
  assert.equal(list.children.length, 1); assert.match(list.children[0].textContent, /거리 미제공/);
  assert.equal(env.history.pushState({}, '', '/other'), 3); assert.equal(c.getState().rows.length, 0); assert.equal(list.children.length, 0); assert.equal(dialog.hidden, true);
  c.dispose(); assert.equal(env.history.pushState, original); assert.equal(env.document.body.children.length, 0); assert.equal(env.observer.disconnected, true);
});
for (const event of ['popstate', 'hashchange', 'pagehide', 'blur', 'visibilitychange', 'mutation', 'original-click']) test('DOM boundary ' + event, async () => {
  const env = dom(), f = fixture(), c = install(env, { driver: f.driver, platform: 'ios', enabled: true });
  c.open(); const p = c.read(); await tick();
  let prevented = false;
  if (event === 'visibilitychange') { env.document.visibilityState = 'hidden'; env.document.emit(event); }
  else if (event === 'mutation') env.observer.fn([{ target: env.document.body }]);
  else if (event === 'original-click') env.document.emit('click', { target: new Element('a'), preventDefault: () => { prevented = true; } });
  else env.emit(event);
  assert.equal(c.getState().visible, false); assert.equal(await p, false); assert.equal(prevented, false);
  f.requests[0].resolve(payload()); await tick(); assert.equal(c.getState().rows.length, 0); c.dispose();
});

for (const detach of ['bodyreplacement', 'rootremoved']) for (const result of ['success', 'error']) for (const observerFirst of [false, true]) test(`detached ${detach}: late ${result}, observerFirst=${observerFirst}`, async () => {
  const env = dom(), f = fixture(), originalHistory = env.history.pushState;
  const c = install(env, { driver: f.driver, platform: 'ios', enabled: true });
  const body = env.document.body, root = body.children[0], [entry, dialog] = root.children, list = dialog.children[7];
  try {
    c.open(); const pending = c.read(); await tick(); const epoch = c.getState().epoch;
    if (detach === 'bodyreplacement') env.replaceBody(); else root.remove();
    const records = [{ target: detach === 'bodyreplacement' ? env.document.documentElement : body, removedNodes: [detach === 'bodyreplacement' ? body : root] }];
    if (observerFirst) env.observer.fn(records);
    if (result === 'success') f.requests[0].resolve(payload()); else f.requests[0].reject(new Error('RAW_HEALTH_SECRET'));
    assert.equal(await pending, false); await tick();
    assert.equal(c.getState().rows.length, 0); assert.equal(c.getState().visible, false); assert.ok(c.getState().epoch > epoch);
    assert.equal(list.children.length, 0); assert.equal(dialog.hidden, true);
    assert.equal(env.observer.disconnected, true); assert.equal(env.history.pushState, originalHistory);
    const calls = f.calls.length; assert.equal(c.open(), false); entry.emit('click', { isTrusted: true });
    assert.equal(await c.read(), false); assert.equal(f.calls.length, calls);
    assert.equal(env.document.body.children.length, 0);
    const epochAfterDispose = c.getState().epoch;
    env.observer.fn(records);
    assert.equal(c.getState().epoch, epochAfterDispose);
  } finally { c.dispose(); }
});
for (const detach of ['bodyreplacement', 'rootremoved']) test('late native open after ' + detach + ' never dispatches read', async () => {
  const env = dom(), f = fixture(); let resolveOpen;
  f.driver.open = () => new Promise(resolve => { resolveOpen = resolve; });
  const c = install(env, { driver: f.driver, platform: 'ios', enabled: true });
  try {
    c.open(); const pending = c.read();
    if (detach === 'bodyreplacement') env.replaceBody(); else env.document.body.children[0].remove();
    resolveOpen();
    assert.equal(await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve('UNSETTLED'), 50))]), false);
    assert.equal(f.requests.length, 0);
    assert.equal(c.open(), false); assert.equal(env.observer.disconnected, true);
  } finally { c.dispose(); }
});
for (const detach of ['bodyreplacement', 'rootremoved']) test('observer disposes already rendered preview after ' + detach, async () => {
  const env = dom(), f = fixture(), c = install(env, { driver: f.driver, platform: 'ios', enabled: true });
  const body = env.document.body, root = body.children[0], dialog = root.children[1], list = dialog.children[7];
  try {
    assert.ok(env.observer.observed.some(o => o.target === env.document.documentElement));
    c.open(); const p = c.read(); await tick(); f.requests[0].resolve(payload()); await p;
    assert.equal(list.children.length, 1);
    if (detach === 'bodyreplacement') env.replaceBody(); else root.remove();
    env.observer.fn([{ target: detach === 'bodyreplacement' ? env.document.documentElement : body, removedNodes: [detach === 'bodyreplacement' ? body : root] }]);
    assert.equal(list.children.length, 0); assert.equal(c.getState().rows.length, 0); assert.equal(c.open(), false);
    assert.equal(env.observer.disconnected, true); assert.equal(dialog.hidden, true);
  } finally { c.dispose(); }
});

for (const detach of ['body', 'root']) test('remove and reinsert ' + detach + ' still retires the original instance', () => {
  const env = dom(), f = fixture(), c = install(env, { driver: f.driver, platform: 'ios', enabled: true });
  const body = env.document.body, root = body.children[0];
  try {
    c.open();
    if (detach === 'body') { env.replaceBody(); env.document.body.remove(); env.document.body = body; env.document.documentElement.append(body); }
    else { root.remove(); body.append(root); }
    assert.equal(root.isConnected, true);
    env.observer.fn([{ target: detach === 'body' ? env.document.documentElement : body, removedNodes: [detach === 'body' ? body : root] }]);
    assert.equal(c.open(), false); assert.equal(c.getState().visible, false); assert.equal(env.observer.disconnected, true);
  } finally { c.dispose(); }
});
test('documentElement replacement is detected without original body mutation', async () => {
  const env = dom(), f = fixture(), c = install(env, { driver: f.driver, platform: 'ios', enabled: true });
  try {
    c.open(); const p = c.read(); await tick();
    const old = env.document.documentElement; old.remove();
    env.document.documentElement = env.document.createElement('html'); env.document.append(env.document.documentElement);
    f.requests[0].resolve(payload()); assert.equal(await p, false);
    assert.equal(c.getState().rows.length, 0); assert.equal(c.open(), false); assert.equal(env.observer.disconnected, true);
    assert.ok(env.observer.observed.some(o => o.target === env.document && o.options.childList));
  } finally { c.dispose(); }
});
test('synchronous host focus handler replacing body during showModal retires UI safely', () => {
  const env = dom(), f = fixture(), c = install(env, { driver: f.driver, platform: 'ios', enabled: true });
  const root = env.document.body.children[0], dialog = root.children[1];
  dialog.showModal = () => { dialog.open = true; env.replaceBody(); };
  assert.equal(c.open(), false); assert.equal(c.getState().visible, false); assert.equal(dialog.hidden, true);
  assert.equal(env.observer.disconnected, true); assert.deepEqual(f.calls, ['dispose']); c.dispose();
});
test('pure context predicate exceptions fail closed and never start native work', async () => {
  const f = fixture({ isContextCurrent: () => { throw new Error('host boundary unavailable'); } });
  assert.equal(f.controller.open(), false); assert.equal(await f.controller.read(), false); assert.deepEqual(f.calls, ['dispose']);
  assert.equal(f.controller.getState().rows.length, 0); f.controller.dispose();
});

// Synthetic support/permission metadata only. No device-health success is claimed.
const iosStatus = (patch = {}) => ({ available: true, enabled: true, healthScaffoldIncluded: true, healthInvocationEnabled: true,
  consumerMode: 'offline-preview', accountMode: 'off', healthDataRead: false, permissionRequested: false,
  readAuthorization: 'unknown', reviewStatus: 'UNREVIEWED', ...patch });
const androidStatus = (patch = {}) => ({ provider: 'health-connect', status: 'available', readExerciseGranted: false, reviewStatus: 'UNREVIEWED', ...patch });
test('default OFF also refuses support check without touching native', async () => {
  const c = create(); assert.equal(await c.checkAvailability(), false); assert.equal(c.getState().availability, null);
});
for (const platform of ['ios', 'android']) test('manual status only: no health read or permission prompt for ' + platform, async () => {
  const f = fixture({ platform }); f.controller.open(); assert.deepEqual(f.calls, []);
  const p = f.controller.checkAvailability(); await tick();
  assert.deepEqual(f.calls, platform === 'ios' ? ['availability'] : ['open', 'availability']);
  assert.deepEqual(f.requests[0].input, {});
  f.requests[0].resolve(platform === 'ios' ? iosStatus() : androidStatus()); assert.equal(await p, true);
  const s = f.controller.getState(); assert.equal(s.status, 'availability-returned'); assert.equal(s.rows.length, 0);
  assert.equal(s.availability.readAuthorization, platform === 'ios' ? 'unknown' : 'required');
  assert.ok(Object.isFrozen(s.availability)); f.controller.close(); assert.equal(f.controller.getState().availability, null); f.controller.dispose();
});
test('HealthKit support and even completed authorization never become read-permission proof', async () => {
  const f = fixture(); f.controller.open(); const p = f.controller.checkAvailability(); await tick(); f.requests[0].resolve(iosStatus()); await p;
  const a = f.controller.authorize(); await tick(); assert.deepEqual(f.calls, ['availability', 'open', 'requestAuthorization']);
  f.requests[1].resolve({ requestCompleted: true, readAuthorization: 'unknown' }); await a;
  assert.equal(f.controller.getState().availability, null); assert.equal(f.controller.getState().status, 'authorization-returned'); f.controller.dispose();
});
test('status DTO allows only fixed fields, capability and permission stay distinct', () => {
  const raw = iosStatus({ token: 'discard', workouts: ['discard'] }); Object.defineProperty(raw, 'unused', { get() { assert.fail('not read'); } });
  assert.deepEqual(normalizeStatus(raw, 'ios'), { source: 'apple-healthkit', status: 'available', readAuthorization: 'unknown' });
  assert.equal(normalizeStatus(iosStatus({ available: false, healthInvocationEnabled: false }), 'ios').status, 'unavailable');
  assert.equal(normalizeStatus(iosStatus({ enabled: false, healthInvocationEnabled: false }), 'ios').status, 'disabled');
  assert.equal(normalizeStatus(androidStatus({ readExerciseGranted: true }), 'android').readAuthorization, 'granted');
  for (const status of ['unavailable', 'provider-update-required']) assert.equal(normalizeStatus(androidStatus({ status }), 'android').readAuthorization, 'unknown');
});
for (const patch of [{ available: 'true' }, { enabled: 1 }, { healthScaffoldIncluded: false }, { healthInvocationEnabled: false }, { accountMode: 'on' },
    { consumerMode: 'account' }, { healthDataRead: true }, { permissionRequested: true }, { readAuthorization: 'granted' }, { reviewStatus: 'READY' }]) {
  test('invalid iOS support DTO refused: ' + Object.keys(patch)[0], () => assert.throws(() => normalizeStatus(iosStatus(patch), 'ios'), /INVALID_AVAILABILITY/));
}
for (const patch of [{ provider: 'samsung' }, { status: 'connected' }, { readExerciseGranted: 'true' }, { reviewStatus: 'READY' },
    { status: 'unavailable', readExerciseGranted: true }, { status: 'provider-update-required', readExerciseGranted: true }]) {
  test('invalid Android support DTO refused: ' + JSON.stringify(patch), () => assert.throws(() => normalizeStatus(androidStatus(patch), 'android'), /INVALID_AVAILABILITY/));
}
test('status DTO accessors never execute; invalid platform refused', () => {
  const value = iosStatus(); Object.defineProperty(value, 'available', { get() { assert.fail('getter executed'); } });
  assert.throws(() => normalizeStatus(value, 'ios'), /INVALID_DTO/); assert.throws(() => normalizeStatus({}, 'web'), /INVALID_PLATFORM/);
});
for (const boundary of ['close', 'invalidateContext', 'invalidateSession', 'background', 'dispose']) {
  for (const result of ['success', 'error']) test('late availability ' + result + ' after ' + boundary + ' is dropped', async () => {
    const f = fixture(); f.controller.open(); const p = f.controller.checkAvailability(); await tick(); f.controller[boundary]();
    assert.equal(await p, false); const count = f.states.length;
    if (result === 'success') f.requests[0].resolve(iosStatus()); else f.requests[0].reject(Error('RAW_PRIVATE'));
    await tick(); assert.equal(f.states.length, count); assert.equal(f.controller.getState().availability, null); f.controller.dispose();
  });
}
test('invalid status response cannot remain in consumer/UI memory', async () => {
  const f = fixture(); f.controller.open(); const p = f.controller.checkAvailability(); await tick();
  f.requests[0].resolve(iosStatus({ readAuthorization: 'granted' })); assert.equal(await p, false);
  assert.equal(f.controller.getState().status, 'error'); assert.equal(f.controller.getState().availability, null); assert.equal(f.controller.getState().rows.length, 0); f.controller.dispose();
});
for (const platform of ['ios', 'android']) test('manual status DOM UX and recheck remain safe: ' + platform, async () => {
  const env = dom(), f = fixture(), c = install(env, { driver: f.driver, platform, enabled: true });
  const root = env.document.body.children[0], dialog = root.children[1], [, , check, auth, read, , status, list] = dialog.children;
  try {
    c.open(); check.emit('click', { isTrusted: false }); assert.deepEqual(f.calls, []);
    check.emit('click', { isTrusted: true }); await tick(); assert.equal(check.disabled, true); assert.equal(auth.disabled, true);
    f.requests[0].resolve(platform === 'ios' ? iosStatus() : androidStatus({ status: 'provider-update-required' })); await tick();
    assert.equal(check.disabled, false); assert.equal(list.children.length, 0);
    if (platform === 'ios') { assert.match(status.textContent, /읽기 허용 여부는 알 수 없습니다/); assert.equal(auth.disabled, false); }
    else { assert.match(status.textContent, /설치 또는 업데이트/); assert.equal(auth.disabled, true); assert.equal(read.disabled, true); }
    check.emit('click', { isTrusted: true }); await tick();
    f.requests[1].resolve(platform === 'ios' ? iosStatus({ available: false, healthInvocationEnabled: false }) : androidStatus({ readExerciseGranted: true })); await tick();
    assert.match(status.textContent, platform === 'ios' ? /사용할 수 없습니다/ : /실제 공유한 기록/);
    c.close(); assert.equal(status.textContent, ''); assert.equal(c.getState().availability, null);
  } finally { c.dispose(); }
});

for (const platform of ['ios', 'android']) test('each manual operation renews native context after idle expiry: ' + platform, async () => {
  let clock = 0, bindingUntil = -1, opens = 0;
  const calls = [];
  const driver = {
    open: async () => { opens++; bindingUntil = clock + 90000; calls.push('open'); },
    request: async method => {
      assert.ok(clock < bindingUntil, 'expired binding must never dispatch a health operation'); calls.push(method);
      return method === 'readRunningWorkouts' ? (platform === 'ios' ? payload() : android()) : {};
    },
    invalidateContext() {}, invalidateSession() {}, background() {}, dispose() {}
  };
  const c = create({ platform, driver, enabled: true, now: () => Date.parse('2026-10-29T10:00:00Z') + clock });
  try {
    c.open(); assert.equal(await c.read(), true); clock = 90001;
    assert.equal(await c.read(), true); assert.equal(opens, 2);
    assert.equal(c.getState().rows.length, 1);
    assert.deepEqual(calls, ['open', 'readRunningWorkouts', 'open', 'readRunningWorkouts']);
  } finally { c.dispose(); }
});
test('fractional-second native DTO retains valid subsecond exercise interval without equating reported and elapsed duration', () => {
  const rows = normalize(payload({ workouts: [row({ start: '2026-10-28T10:00:00.100Z', end: '2026-10-28T10:00:00.900Z', durationSeconds: 0.7 })] }), 'ios');
  assert.equal(rows[0].start, '2026-10-28T10:00:00.100Z'); assert.equal(rows[0].end, '2026-10-28T10:00:00.900Z');
  assert.equal(rows[0].durationSeconds, 0.7); assert.equal(rows[0].durationKind, 'reported');
});
test('Swift serialization source explicitly keeps fractional seconds (source contract, not native runtime)', async () => {
  const source = await readFile(new URL('../native-templates/ios/NativeHealthPlugin.swift', import.meta.url), 'utf8');
  assert.match(source, /let formatter = ISO8601DateFormatter\(\)\s+formatter.formatOptions = \[.withInternetDateTime, .withFractionalSeconds\]/);
  assert.match(source, /"start": formatter.string\(from: workout.startDate\), "end": formatter.string\(from: workout.endDate\)/);
});
