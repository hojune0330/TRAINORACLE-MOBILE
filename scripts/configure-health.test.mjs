import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHealthPlan, transformHealthBridge, configureHealthXcode, validateHealthQuery, HEALTH_SOURCE } from './configure-health.mjs';
const bridge = 'override func capacitorDidLoad() {\n bridge?.registerPluginInstance(NativeDocumentsPlugin())\n}';
const fixture = () => ({ hash: { project: { objects: {
 PBXNativeTarget: { T: { name: 'App', buildConfigurationList: 'L', buildPhases: [{ value: 'S' }] } },
 XCConfigurationList: { L: { buildConfigurations: [{ value: 'D' }, { value: 'R' }] } },
 XCBuildConfiguration: { D: { name: 'Debug', buildSettings: { IPHONEOS_DEPLOYMENT_TARGET: '16.0' } }, R: { name: 'Release', buildSettings: { IPHONEOS_DEPLOYMENT_TARGET: '16.0' } } },
 PBXSourcesBuildPhase: { S: { files: [{ value: 'B' }] } }, PBXBuildFile: { B: { fileRef: 'F' } },
 PBXFileReference: { F: { path: HEALTH_SOURCE } }, PBXProject: { P: { attributes: { TargetAttributes: { T: {} } } } }
} } } });
test('default OFF leaves inputs unchanged', () => {
 const input = { info: { CFBundleName: 'App' }, bridgeSource: bridge, sources: ['NativeDocumentsPlugin.swift'] }; const before = structuredClone(input);
 const plan = createHealthPlan(input); assert.deepEqual(input, before); assert.equal(plan.enabled, false); assert.deepEqual(plan.info, input.info); assert.deepEqual(plan.generatedFiles, []); assert.equal(plan.bridgeSource, bridge);
});
test('nonboolean opt-in rejected', () => { for (const enabled of ['true', 1, null]) assert.throws(() => createHealthPlan({ enabled })); });
test('opt-in read-only entitlement purpose and source', () => {
 const p = createHealthPlan({ enabled: true, bridgeSource: bridge }); assert.equal(p.info.MinimumOSVersion, '16.0'); assert.ok(p.info.NSHealthShareUsageDescription); assert.equal(p.info.NSHealthUpdateUsageDescription, undefined); assert.deepEqual(p.entitlements, { 'com.apple.developer.healthkit': true }); assert.deepEqual(p.sources, [HEALTH_SOURCE]); assert.equal(p.generatedFiles.length, 2); assert.equal(p.reviewStatus, 'UNREVIEWED'); assert.equal(p.consumerIntegrationReviewed, false); assert.equal(p.healthDataGate, 'CONTEXT_CONSUMER_NOT_INTEGRATED');
});
test('registration once and OFF identity', () => { assert.equal(transformHealthBridge(bridge), bridge); const patched = transformHealthBridge(bridge, { enabled: true }); assert.equal(patched.match(/NativeHealthPlugin/g).length, 1); assert.throws(() => transformHealthBridge(patched, { enabled: true })); assert.throws(() => transformHealthBridge('unknown', { enabled: true })); });
test('preexisting entitlements/purpose rejected', () => { for (const args of [{ entitlements: { x: true } }, { info: { NSHealthShareUsageDescription: 'old' } }, { info: { MinimumOSVersion: '15.0' } }]) assert.throws(() => createHealthPlan({ enabled: true, bridgeSource: bridge, ...args })); });
test('Xcode OFF identity', () => { const p = fixture(); const before = structuredClone(p); assert.equal(configureHealthXcode(p), p); assert.deepEqual(p, before); });
test('Xcode capability and both entitlement paths', () => { const p = fixture(); configureHealthXcode(p, { enabled: true }); const o = p.hash.project.objects; assert.equal(o.PBXProject.P.attributes.TargetAttributes.T.SystemCapabilities['com.apple.HealthKit'].enabled, 1); for (const c of Object.values(o.XCBuildConfiguration)) assert.equal(c.buildSettings.CODE_SIGN_ENTITLEMENTS, '"App/TrainOracleHealth.entitlements"'); });
test('source copy alone is not compilation membership', () => { const p = fixture(); p.hash.project.objects.PBXSourcesBuildPhase.S.files = []; const before = structuredClone(p); assert.throws(() => configureHealthXcode(p, { enabled: true })); assert.deepEqual(p, before); });
test('wrong minimum fails without mutation', () => { const p = fixture(); p.hash.project.objects.XCBuildConfiguration.D.buildSettings.IPHONEOS_DEPLOYMENT_TARGET = '15.0'; const before = structuredClone(p); assert.throws(() => configureHealthXcode(p, { enabled: true })); assert.deepEqual(p, before); });
test('duplicate Xcode opt-in rejected', () => { const p = fixture(); configureHealthXcode(p, { enabled: true }); assert.throws(() => configureHealthXcode(p, { enabled: true })); });
const now = Date.parse('2026-10-29T00:00:00Z');
test('query defaults 30 days / 50', () => assert.deepEqual(validateHealthQuery({}, now), { start: now - 30 * 86400000, end: now, limit: 50 }));
test('query accepts 90 day / 100 bound', () => assert.equal(validateHealthQuery({ start: new Date(now - 90 * 86400000).toISOString(), limit: 100 }, now).limit, 100));
for (const [name, input] of Object.entries({ zero: { limit: 0 }, huge: { limit: 101 }, fractional: { limit: 1.5 }, string: { limit: '50' }, future: { end: '2026-10-30T00:00:00Z' }, old: { start: '2026-01-01T00:00:00Z' }, badDate: { start: 'bad' }, reverse: { start: '2026-10-29T00:00:00Z', end: '2026-10-28T00:00:00Z' } })) test('reject query: ' + name, () => assert.throws(() => validateHealthQuery(input, now)));
test('Swift source privacy invariants, NOT native compile', async () => {
 const s = await readFile(new URL('../native-templates/ios/NativeHealthPlugin.swift', import.meta.url), 'utf8');
 for (const required of ['message.frameInfo.isMainFrame', 'securityOrigin.protocol == "capacitor"', 'securityOrigin.host == "localhost"', 'tickets.removeValue', 'generation == value', 'Set<HKSampleType>()', 'predicateForWorkouts(with: .running)', '.strictEndDate', 'limit <= 100', '-90 * 86400', '"UNREVIEWED"', '"apple-healthkit"', '"emptyDoesNotMeanDenied": true']) assert.ok(s.includes(required), required);
 for (const forbidden of ['HKWorkoutRouteQuery', 'workout.metadata', 'sourceRevision', 'store.save(', 'UserDefaults', 'FileManager', 'authorizationStatus(for:']) assert.ok(!s.includes(forbidden), forbidden);
 const load = s.slice(s.indexOf('public override func load()'), s.indexOf('fileprivate func trusted')); assert.ok(!load.includes('requestAuthorization(')); assert.ok(!load.includes('store.execute('));
});
