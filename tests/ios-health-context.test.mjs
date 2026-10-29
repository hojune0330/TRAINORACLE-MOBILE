import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createIOSHealthContext, IOS_HEALTH_CONSUMER_INTEGRATED } from '../web-adapter/ios-health-context.js';
function fixture() {
 let foreground = true, counter = 0, ctx = 0, last, complete;
 const native = { beginContext: async () => ({ contextToken: 'fixture-only', documentEpoch: 1, contextEpoch: ++ctx, sessionEpoch: 1 }), invalidateContext: async () => {}, invalidateSession: async () => {},
  readRunningWorkouts: args => { last = args; return new Promise(resolve => { complete = patch => resolve({ ...args, source: 'apple-healthkit', reviewStatus: 'UNREVIEWED', workouts: [], ...patch }); }); } };
 native.requestAuthorization = native.readRunningWorkouts;
 const client = createIOSHealthContext({ native, consumerIntegrated: true, isForeground: () => foreground, randomId: () => 'fixture-' + ++counter, timeoutMs: 1000 });
 return { client, native, sent: () => last, resolve: patch => complete(patch), background: () => { foreground = false; } };
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
test('actual consumer remains OFF, JS flag cannot enable native', async () => { assert.equal(IOS_HEALTH_CONSUMER_INTEGRATED, false); await assert.rejects(createIOSHealthContext().open(), /NOT_INTEGRATED/); });
test('current request roundtrip preserves binding', async () => { const f = fixture(); await f.client.open(); const p = f.client.request('readRunningWorkouts'); await tick(); f.resolve(); assert.equal((await p).requestId, 'fixture-1'); });
for (const scope of ['invalidateContext', 'invalidateSession']) test('late success dropped after ' + scope, async () => { const f = fixture(); await f.client.open(); const p = f.client.request('readRunningWorkouts'); const rejected = assert.rejects(p, /STALE_CONTEXT/); await tick(); await f.client[scope](); await rejected; await f.client.open(); f.resolve(); await tick(); });
test('foreground loss immediately blocks completion', async () => { const f = fixture(); await f.client.open(); const p = f.client.request('readRunningWorkouts'); const rejected = assert.rejects(p, /STALE_CONTEXT/); await tick(); f.background(); f.resolve(); await rejected; });
test('requestId mismatch dropped', async () => { const f = fixture(); await f.client.open(); const p = f.client.request('readRunningWorkouts'); const rejected = assert.rejects(p, /STALE_CONTEXT/); await tick(); f.resolve({ requestId: 'different-request' }); await rejected; });
test('epoch mismatch dropped', async () => { const f = fixture(); await f.client.open(); const p = f.client.request('readRunningWorkouts'); const rejected = assert.rejects(p, /STALE_CONTEXT/); await tick(); f.resolve({ sessionEpoch: 2 }); await rejected; });
test('caller accountID and forged binding never forwarded', async () => { const f = fixture(); await f.client.open(); const p = f.client.request('readRunningWorkouts', { accountID: 'forged', contextToken: 'forged', requestId: 'forged', limit: 1 }); await tick(); assert.equal(f.sent().accountID, undefined); assert.equal(f.sent().contextToken, 'fixture-only'); assert.equal(f.sent().requestId, 'fixture-1'); f.resolve(); await p; });
test('same-context native cancellation preserved', async () => { const f = fixture(); f.native.requestAuthorization = async () => { throw new Error('USER_CANCELLED'); }; await f.client.open(); await assert.rejects(f.client.request('requestAuthorization'), /USER_CANCELLED/); });
test('Swift stale/background invariants, source inspection ONLY', async () => {
 const s = await readFile(new URL('../native-templates/ios/NativeHealthPlugin.swift', import.meta.url), 'utf8');
 for (const text of ['CFGetTypeID(flag) == CFBooleanGetTypeID()', 'TrainOracleHealthOfflineConsumerIntegrated', 'TrainOracleAccountMode', 'contextEpoch', 'sessionEpoch', 'lifecycleEpoch', 'requestId', 'bridge?.releaseCall(call)', 'UIApplication.shared.applicationState == .active', 'UIApplication.didEnterBackgroundNotification', 'store.stop(query)', 'self.phase != "permission"', 'self.deferredAuthorization = completion', 'guard self.current(version) else { self.drop(call)', 'message.frameInfo.isMainFrame']) assert.ok(s.includes(text), text);
 assert.ok(!s.includes('call.reject("CONTEXT_CHANGED")'));
 assert.ok(s.indexOf('plugin.invalidate(session:') < s.indexOf('plugin.issueTicket(callback)'));
});

const status = Object.freeze({ available: true, enabled: false, healthScaffoldIncluded: true, healthInvocationEnabled: false, consumerMode: 'offline-preview', accountMode: 'unverified', blockedReason: 'CONTEXT_CONSUMER_NOT_INTEGRATED', healthDataRead: false, permissionRequested: false, readAuthorization: 'unknown', reviewStatus: 'UNREVIEWED' });
test('availability before open/default OFF never invokes health methods', async () => {
 let count = 0; const fail = () => { throw new Error('health method called'); }; const c = createIOSHealthContext({ native: { availability: async () => { count++; return { ...status, unwantedRaw: 'omit' }; }, beginContext: fail, readRunningWorkouts: fail, requestAuthorization: fail }, isForeground: () => true }); assert.deepEqual(await c.availability(), status); assert.equal(count, 1);
});
test('late availability after SPA invalidation settles only old local promise', async () => {
 let done; const c = createIOSHealthContext({ native: { availability: () => new Promise(r => { done = r; }), invalidateContext: async () => {} }, isForeground: () => true }); const p = c.availability(); const rejected = assert.rejects(p, /STALE_CONTEXT/); await tick(); await c.invalidate(); done(status); await rejected;
});
test('availability rejects health-reading status DTO', async () => { const c = createIOSHealthContext({ native: { availability: async () => ({ ...status, healthDataRead: true }) }, isForeground: () => true }); await assert.rejects(c.availability(), /INVALID_AVAILABILITY/); });
test('native frame/binding/gate priority source invariants ONLY', async () => {
 const s = await readFile(new URL('../native-templates/ios/NativeHealthPlugin.swift', import.meta.url), 'utf8'); const gate = s.slice(s.indexOf('private final class NativeHealthMessageGate')); assert.ok(gate.indexOf('message.frameInfo.isMainFrame') < gate.indexOf('plugin.invalidate(session:')); assert.ok(gate.includes('guard pluginID == "NativeHealth"')); assert.ok(gate.includes('["NativeHealth", "NativeHealthPlugin"]')); const bind = s.slice(s.indexOf('private func bind('), s.indexOf('@objc func beginContext')); assert.ok(bind.indexOf('guard consume(call)') < bind.indexOf('guard let token')); assert.ok(bind.indexOf('guard let token') < bind.indexOf('guard consumerIntegrationReviewed')); const a = s.slice(s.indexOf('@objc func availability'), s.indexOf('private func begin(')); assert.ok(a.includes('"healthDataRead": false')); assert.ok(a.includes('"permissionRequested": false')); assert.ok(!a.includes('store.execute(')); assert.ok(!a.includes('store.requestAuthorization('));
});
