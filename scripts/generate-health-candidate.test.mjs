import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { generateHealthCandidate, parseArgs, parseAgpVersion } from './generate-health-candidate.mjs';
import { prepareOutput, SOURCE_SHA, WRAPPER_ROOT, RECEIPT_FILE } from './prepare-web.mjs';
import { VERSIONS } from './generate-native.mjs';
const hash = b => createHash('sha256').update(b).digest('hex');
const put = async (r, f, data) => { await mkdir(dirname(join(r, f)), { recursive: true }); await writeFile(join(r, f), data); };
const release = JSON.parse(await readFile(join(WRAPPER_ROOT, 'release-config.json'), 'utf8'));
const cap = JSON.parse(await readFile(join(WRAPPER_ROOT, 'capacitor.config.json'), 'utf8'));
async function fixture(t, platform = 'android', previewConfig) {
  const root = await mkdtemp(join(tmpdir(), 'health-candidate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [f, obj] of Object.entries({ 'release-config.json': release, 'capacitor.config.json': cap, 'package.json': {}, 'package-lock.json': {} })) await put(root, f, JSON.stringify(obj));
  await put(root, 'www/index.html', '<html><head></head><body>fixture</body></html>');
  if (previewConfig !== undefined) await put(root, 'www/native/health-preview-config.json', typeof previewConfig === 'string' ? previewConfig : JSON.stringify(previewConfig));
  const entries = {}, snapshot = { treeSha256: hash(JSON.stringify(entries)), entries };
  await prepareOutput(join(root, 'www'), { sourceSha: SOURCE_SHA, sourceBefore: snapshot, sourceAfter: snapshot });
  await put(root, 'native-templates/' + platform + '/NativeHealthPlugin.' + (platform === 'ios' ? 'swift' : 'kt'), platform === 'ios' ? '// UNREVIEWED Swift fixture' : await readFile(join(WRAPPER_ROOT, 'native-templates/android/NativeHealthPlugin.kt'), 'utf8'));
  return root;
}
function runner(root, platform = 'android', mutate = async () => {}) {
  return async options => {
    assert.equal(options.wrapperRoot, root); assert.equal(options.platform, platform);
    if (platform === 'android') {
      const java = 'android/app/src/main/java/io/trainoracle/app/';
      await put(root, 'android/build.gradle', "buildscript { dependencies { classpath 'com.android.tools.build:gradle:8.13.0' } }");
      await put(root, 'android/app/src/main/assets/capacitor.config.json', JSON.stringify(cap));
      await put(root, 'android/app/build.gradle', "apply plugin: 'com.android.application'\ndependencies {\n}\n");
      await put(root, 'android/app/src/main/AndroidManifest.xml', '<manifest><uses-permission android:name="android.permission.INTERNET"/><application android:allowBackup="false" android:fullBackupContent="false" android:dataExtractionRules="@xml/data_extraction_rules" android:usesCleartextTraffic="false"></application></manifest>');
      await put(root, 'android/app/src/main/assets/capacitor.config.json', JSON.stringify(cap));
      await put(root, java + 'MainActivity.java', 'package io.trainoracle.app;\nimport com.getcapacitor.BridgeActivity;\nimport android.os.Bundle;\npublic class MainActivity extends BridgeActivity {\n@Override public void onCreate(Bundle savedInstanceState) {\nregisterPlugin(NativeDocumentsPlugin.class);\nsuper.onCreate(savedInstanceState);\n}\n}');
    } else {
      await put(root, 'ios/App/App/Info.plist', JSON.stringify({ MinimumOSVersion: '16.0' }));
      await put(root, 'ios/App/App/NativeBridgeViewController.swift', 'override func capacitorDidLoad() {\nbridge?.registerPluginInstance(NativeDocumentsPlugin())\n}');
      await put(root, 'ios/App/App.xcodeproj/project.pbxproj', 'fixture project');
    }
    const base = { schemaVersion: 1, platform, packageId: release.appId, baseAppId: release.appId, debugAppId: release.debugAppId, debugAppName: release.debugAppName, versionName: release.versionName, versionCode: release.versionCode, sourceSha: SOURCE_SHA, capacitorVersions: VERSIONS, sdk: platform === 'ios' ? { minimum: '16.0', packageManager: 'SPM', deviceFamily: 1 } : { minimum: 26, compile: 36, target: 36 }, webReceiptSha256: hash(await readFile(join(root, 'www', RECEIPT_FILE))), nativeCompilation: 'not-executed', signingConfigured: false };
    await put(root, 'output/native-generation-' + platform + '.json', JSON.stringify(base));
    await mutate(base);
    return base;
  };
}
const opts = (root, platform = 'android') => ({ wrapperRoot: root, platform, enableHealth: true });
test('strict CLI explicit opt-in, no arbitrary output/root options', () => {
  assert.deepEqual(parseArgs(['--enable-health', '--platform', 'ios']), { enableHealth: true, platform: 'ios', enableOfflinePreview: false });
  for (const a of [[], ['--platform', 'android'], ['--enable-health'], ['--enable-health', '--platform', 'web'], ['--enable-health', '--platform', 'ios', '--output', 'x']]) assert.throws(() => parseArgs(a));
});
test('actual literal AGP parsed, ambiguity and substitution rejected', () => {
  assert.equal(parseAgpVersion("classpath 'com.android.tools.build:gradle:8.13.0'"), '8.13.0');
  for (const s of ['', "classpath 'com.android.tools.build:gradle:$version'", "classpath 'com.android.tools.build:gradle:9.0.0'", "classpath 'com.android.tools.build:gradle:8.13.0'\nclasspath 'com.android.tools.build:gradle:8.13.0'"]) assert.throws(() => parseAgpVersion(s));
});
test('default OFF rejects before generation', async t => {
  const root = await fixture(t); let ran = false;
  await assert.rejects(generateHealthCandidate({ wrapperRoot: root, platform: 'android' }, { generateNative: () => { ran = true; } }), /opt-in/); assert.equal(ran, false);
});
test('Android plan is confined to fresh native tree and truthful separate metadata', async t => {
  const root = await fixture(t), before = await readFile(join(root, 'www', RECEIPT_FILE));
  const result = await generateHealthCandidate(opts(root), { generateNative: runner(root) });
  assert.equal(result.reviewStatus, 'UNREVIEWED'); assert.equal(result.healthScaffoldIncluded, true); assert.equal(result.healthInvocationEnabled, false); assert.equal(result.disabledReason, 'CONTEXT_CONSUMER_NOT_REVIEWED'); assert.equal(result.nativeCompilation, 'not-executed'); assert.equal(result.agpVersion, '8.13.0'); assert.equal(result.modifiedFiles.length, 5);
  assert.deepEqual(await readFile(join(root, 'www', RECEIPT_FILE)), before);
  assert.match(await readFile(join(root, 'android/app/src/main/java/io/trainoracle/app/NativeHealthPlugin.kt'), 'utf8'), /package io.trainoracle.app/);
  await assert.rejects(generateHealthCandidate(opts(root), { generateNative: runner(root) }), /must not exist/);
});
for (const file of ['output/native-health-candidate-android.json', 'output/native-generation-android.json']) test('reject existing metadata ' + file, async t => {
  const root = await fixture(t); await put(root, file, '{}');
  await assert.rejects(generateHealthCandidate(opts(root), { generateNative: () => assert.fail('must not run') }), /Existing metadata/);
});
test('base failure does not configure health', async t => {
  const root = await fixture(t);
  await assert.rejects(generateHealthCandidate(opts(root), { generateNative: async () => { throw Error('receipt gate'); } }), /receipt gate/);
});
test('returned/persisted metadata mismatch rejected', async t => {
  const root = await fixture(t);
  await assert.rejects(generateHealthCandidate(opts(root), { generateNative: runner(root, 'android', b => { b.sourceSha = 'bad'; }) }), /metadata mismatch/);
});
test('input mutation rejected after original generator', async t => {
  const root = await fixture(t);
  await assert.rejects(generateHealthCandidate(opts(root), { generateNative: runner(root, 'android', () => put(root, 'www/unreviewed.txt', 'changed')) }), /Immutable input/);
});
test('invalid receipt rejected even with injected base generator', async t => {
  const root = await fixture(t); await put(root, 'www/index.html', 'tampered');
  await assert.rejects(generateHealthCandidate(opts(root), { generateNative: runner(root) }));
});
test('output symlink boundary rejected before generator', async t => {
  const root = await fixture(t), outside = await mkdtemp(join(tmpdir(), 'health-outside-')); t.after(() => rm(outside, { recursive: true, force: true }));
  try { await symlink(outside, join(root, 'output'), process.platform === 'win32' ? 'junction' : 'dir'); } catch (e) { if (e.code === 'EPERM') { t.skip('OS symlink privilege unavailable'); return; } throw e; }
  await assert.rejects(generateHealthCandidate(opts(root), { generateNative: () => assert.fail('must not run') }), /Symlink/);
});
test('post-generation native symlink boundary rejected', async t => {
  const root = await fixture(t);
  let unsupported = false;
  await assert.rejects(generateHealthCandidate(opts(root), { generateNative: runner(root, 'android', async () => {
    try { await symlink(join(root, 'www'), join(root, 'android/escape'), process.platform === 'win32' ? 'junction' : 'dir'); } catch (e) { if (e.code === 'EPERM') { unsupported = true; throw Error('Symlink unavailable'); } throw e; }
  }) }), /Symlink/);
  if (unsupported) t.skip('OS symlink privilege unavailable');
});
function projectFixture() {
  const o = { PBXNativeTarget: { T: { name: 'App', buildConfigurationList: 'L', buildPhases: [{ value: 'S' }] } }, PBXGroup: { G: { path: 'App' } }, XCConfigurationList: { L: { buildConfigurations: [{ value: 'D' }, { value: 'R' }] } }, XCBuildConfiguration: { D: { name: 'Debug', buildSettings: {} }, R: { name: 'Release', buildSettings: {} } }, PBXSourcesBuildPhase: { S: { files: [] } }, PBXBuildFile: {}, PBXFileReference: {}, PBXProject: { P: { attributes: { TargetAttributes: { T: {} } } } } };
  return { hash: { project: { objects: o } }, addSourceFile(name) { o.PBXFileReference.F = { path: name }; o.PBXBuildFile.B = { fileRef: 'F' }; o.PBXSourcesBuildPhase.S.files.push({ value: 'B' }); return {}; }, writeSync() { return JSON.stringify(o); } };
}
test('iOS compiled membership, exact entitlement path, plist and bridge applied', async t => {
  const root = await fixture(t, 'ios'), project = projectFixture();
  const result = await generateHealthCandidate(opts(root, 'ios'), { generateNative: runner(root, 'ios'), plist: { parse: JSON.parse, build: JSON.stringify }, loadProject: () => project });
  assert.equal(result.modifiedFiles.length, 5);
  const info = JSON.parse(await readFile(join(root, 'ios/App/App/Info.plist'), 'utf8')); assert.ok(info.NSHealthShareUsageDescription); assert.equal(info.NSHealthUpdateUsageDescription, undefined);
  const ent = JSON.parse(await readFile(join(root, 'ios/App/App/TrainOracleHealth.entitlements'), 'utf8')); assert.deepEqual(ent, { 'com.apple.developer.healthkit': true });
  for (const c of Object.values(project.hash.project.objects.XCBuildConfiguration)) assert.equal(c.buildSettings.CODE_SIGN_ENTITLEMENTS, '"App/TrainOracleHealth.entitlements"');
  assert.match(await readFile(join(root, 'ios/App/App/NativeBridgeViewController.swift'), 'utf8'), /NativeHealthPlugin/);
});
test('iOS source-copy-only fake registration fails closed', async t => {
  const root = await fixture(t, 'ios'), p = projectFixture(); p.addSourceFile = () => ({});
  await assert.rejects(generateHealthCandidate(opts(root, 'ios'), { generateNative: runner(root, 'ios'), plist: { parse: JSON.parse, build: JSON.stringify }, loadProject: () => p }), /compiled exactly once/);
});

test('reject unrelated preexisting output artifact without deleting it', async t => {
  const root = await fixture(t); await put(root, 'output/prior.aab', 'keep');
  await assert.rejects(generateHealthCandidate(opts(root), { generateNative: () => assert.fail('must not run') }), /Existing output artifacts/);
  assert.equal(await readFile(join(root, 'output/prior.aab'), 'utf8'), 'keep');
});
test('base generator unexpected output artifact is rejected', async t => {
  const root = await fixture(t);
  await assert.rejects(generateHealthCandidate(opts(root), { generateNative: runner(root, 'android', () => put(root, 'output/unreviewed.aab', 'unexpected')) }), /Unexpected base output artifacts/);
});
test('manual workflow reuses only original pinned action hashes and never launches apps', async () => {
  const original = await readFile(join(WRAPPER_ROOT, '.github/workflows/mobile-candidate.yml'), 'utf8');
  const workflow = await readFile(join(WRAPPER_ROOT, '.github/workflows/health-candidate.yml'), 'utf8');
  const action = /uses:\s*([^\s]+)@([a-f0-9]{40})/g;
  const allowed = new Set([...original.matchAll(action)].map(m => m[1] + '@' + m[2]));
  const actual = [...workflow.matchAll(action)].map(m => m[1] + '@' + m[2]);
  assert.ok(actual.length > 5); for (const a of actual) assert.ok(allowed.has(a), a);
  assert.ok(workflow.includes('workflow_dispatch:')); assert.ok(workflow.includes('if: inputs.enable_health == true'));
  assert.doesNotMatch(workflow, /simctl|adb\s|run-android-runtime|run-ios-artifact|store-upload|pull_request:|push:/);
  assert.ok(workflow.includes('CODE_SIGNING_ALLOWED=NO')); assert.ok(workflow.includes(':app:bundleRelease'));
});

test('integration delegates to REAL generateNative before Android health transforms, no npm install', async t => {
  const root = await fixture(t);
  await put(root, 'package.json', JSON.stringify({ dependencies: VERSIONS }));
  await put(root, 'package-lock.json', JSON.stringify({ packages: Object.fromEntries(Object.entries(VERSIONS).map(([n, v]) => ['node_modules/' + n, { version: v }])) }));
  for (const [n, version] of Object.entries(VERSIONS)) await put(root, 'node_modules/' + n + '/package.json', JSON.stringify({ version }));
  await put(root, 'node_modules/@capacitor/cli/dist/index.js', '--packagemanager <packageManager>');
  await put(root, 'native-templates/android/NativeDocumentsPlugin.java', 'package __APP_ID__; public class NativeDocumentsPlugin {}');
  await put(root, 'resources/android/res/values/brand.xml', '<resources/>');
  const calls = [];
  const runCommand = async (command, args, options) => {
    calls.push(args[1]); assert.equal(command, process.execPath); assert.equal(options.env.VITE_KILL_ACCOUNT, 'true'); assert.equal(options.cwd, root);
    if (args[1] === 'add') {
      await put(root, 'android/build.gradle', "buildscript { dependencies { classpath 'com.android.tools.build:gradle:8.13.0' } }");
      await put(root, 'android/app/src/main/assets/capacitor.config.json', JSON.stringify(cap));
      await put(root, 'android/app/build.gradle', 'apply plugin: \'com.android.application\'\nandroid { defaultConfig { applicationId "io.trainoracle.app"\nversionCode 1\nversionName "1.0" } buildTypes { release {} } }\ndependencies {\n}\n');
      await put(root, 'android/variables.gradle', 'minSdkVersion = 24\ncompileSdkVersion = 35\ntargetSdkVersion = 35\n');
      await put(root, 'android/app/src/main/AndroidManifest.xml', '<manifest><uses-permission android:name="android.permission.INTERNET"/><application></application></manifest>');
      await put(root, 'android/app/src/main/java/io/trainoracle/app/MainActivity.java', 'package io.trainoracle.app;\nimport com.getcapacitor.BridgeActivity;\npublic class MainActivity extends BridgeActivity {}');
      await put(root, 'android/app/src/main/res/values/strings.xml', '<resources/>');
    }
    return { status: 0 };
  };
  const result = await generateHealthCandidate(opts(root), { nativeDependencies: { runCommand } });
  assert.deepEqual(calls, ['add', 'sync']); assert.equal(result.reviewStatus, 'UNREVIEWED'); assert.equal(result.healthScaffoldIncluded, true); assert.equal(result.healthInvocationEnabled, false); assert.equal(result.disabledReason, 'CONTEXT_CONSUMER_NOT_REVIEWED');
  const original = JSON.parse(await readFile(join(root, 'output/native-generation-android.json'), 'utf8'));
  assert.equal(original.signingConfigured, false); assert.equal(original.nativeCompilation, 'not-executed');
  assert.match(await readFile(join(root, 'android/app/src/main/AndroidManifest.xml'), 'utf8'), /android:allowBackup="false"/);
});

const previewConfig = () => ({ schemaVersion: 1, enabled: true, accountMode: 'off', sourceSha: SOURCE_SHA, consumerContract: 'OFFLINE_NATIVE_HEALTH_PREVIEW_V1' });
test('offline preview CLI is separate, explicit and strictly parsed', () => {
  for (const p of ['ios', 'android']) for (const args of [
    ['--enable-health', '--platform', p, '--enable-offline-preview'],
    ['--enable-offline-preview', '--enable-health', '--platform', p]
  ]) assert.deepEqual(parseArgs(args), { enableHealth: true, platform: p, enableOfflinePreview: true });
  for (const args of [
    ['--enable-offline-preview', '--platform', 'ios'],
    ['--enable-health', '--platform', 'ios', '--enable-offline-preview', '--enable-offline-preview'],
    ['--enable-health', '--platform', 'ios', '--enable-offline-preview=true'],
    ['--enable-health', '--platform', 'ios', '--enable-offline-preview', '--root', '/tmp']
  ]) assert.throws(() => parseArgs(args));
});
for (const value of ['true', 1, null]) test('nonboolean preview flag rejected: ' + value, async t => {
  const root = await fixture(t);
  await assert.rejects(generateHealthCandidate({ ...opts(root), enableOfflinePreview: value }, { generateNative: () => assert.fail('must not run') }), /explicit boolean/);
});
for (const [label, config] of [
  ['missing', undefined], ['malformed', '{broken'], ['null', 'null'], ['array', '[]'],
  ['unknown key', { ...previewConfig(), unexpected: true }],
  ['missing key', { schemaVersion: 1, enabled: true, accountMode: 'off', sourceSha: SOURCE_SHA }],
  ['wrong source', { ...previewConfig(), sourceSha: '0'.repeat(40) }],
  ['account on', { ...previewConfig(), accountMode: 'on' }],
  ['flag/config mismatch', { ...previewConfig(), enabled: false }],
  ['schema type', { ...previewConfig(), schemaVersion: '1' }],
  ['enabled type', { ...previewConfig(), enabled: 'true' }],
  ['wrong contract', { ...previewConfig(), consumerContract: 'OTHER' }]
]) test('explicit offline preview rejects config: ' + label, async t => {
  const root = await fixture(t, 'ios', config); let ran = false;
  await assert.rejects(generateHealthCandidate({ ...opts(root, 'ios'), enableOfflinePreview: true }, { generateNative: () => { ran = true; throw Error('must not run'); } }));
  assert.equal(ran, false);
});
for (const platform of ['ios', 'android']) for (const explicitFalse of [false, true]) test('enabled web config with native preview OFF rejects before generation: ' + platform + '/explicitFalse=' + explicitFalse, async t => {
  const root = await fixture(t, platform, previewConfig()); let ran = false;
  const options = { ...opts(root, platform), ...(explicitFalse ? { enableOfflinePreview: false } : {}) };
  await assert.rejects(generateHealthCandidate(options, { generateNative: () => { ran = true; throw Error('must not run'); } }), /Offline preview config mismatch/);
  assert.equal(ran, false);
  await assert.rejects(readFile(join(root, 'output/native-health-candidate-' + platform + '.json')), { code: 'ENOENT' });
});
test('explicit false preview option preserves default scaffold without config', async t => {
  const root = await fixture(t);
  const result = await generateHealthCandidate({ ...opts(root), enableOfflinePreview: false }, { generateNative: runner(root) });
  assert.equal(result.healthScaffoldIncluded, true); assert.equal(result.healthInvocationEnabled, false); assert.equal(result.healthInvocationScope, undefined);
});
for (const platform of ['ios', 'android']) test('explicit preview plus receipted exact config enables only readonly scope: ' + platform, async t => {
  const root = await fixture(t, platform, previewConfig());
  const receiptBefore = await readFile(join(root, 'www', RECEIPT_FILE));
  const configBefore = await readFile(join(root, 'www/native/health-preview-config.json'));
  const result = await generateHealthCandidate({ ...opts(root, platform), enableOfflinePreview: true }, { generateNative: runner(root, platform), plist: { parse: JSON.parse, build: JSON.stringify }, loadProject: () => projectFixture() });
  assert.equal(result.healthScaffoldIncluded, true); assert.equal(result.healthInvocationEnabled, true);
  assert.equal(result.healthInvocationScope, 'OFFLINE_READONLY_PREVIEW_ONLY'); assert.equal(result.disabledReason, undefined);
  assert.equal(result.accountMode, 'off'); assert.equal(result.nativeCompilation, 'not-executed'); assert.equal(result.runtimeValidation, 'not-executed'); assert.equal(result.deviceValidation, 'not-executed');
  assert.deepEqual(await readFile(join(root, 'www', RECEIPT_FILE)), receiptBefore);
  assert.deepEqual(await readFile(join(root, 'www/native/health-preview-config.json')), configBefore);
  const persisted = JSON.parse(await readFile(join(root, 'output/native-health-candidate-' + platform + '.json'), 'utf8'));
  assert.deepEqual(persisted, result);
  if (platform === 'ios') {
    const info = JSON.parse(await readFile(join(root, 'ios/App/App/Info.plist'), 'utf8'));
    assert.equal(info.TrainOracleHealthOfflineConsumerIntegrated, true); assert.equal(info.TrainOracleAccountMode, 'off');
  }
});
test('preview config written after receipt is rejected, not re-receipted by generator', async t => {
  const root = await fixture(t, 'ios'); await put(root, 'www/native/health-preview-config.json', JSON.stringify(previewConfig()));
  await assert.rejects(generateHealthCandidate({ ...opts(root, 'ios'), enableOfflinePreview: true }, { generateNative: () => assert.fail('must not run') }));
});
test('preview config mutation by base generator is rejected as immutable input', async t => {
  const root = await fixture(t, 'ios', previewConfig());
  await assert.rejects(generateHealthCandidate({ ...opts(root, 'ios'), enableOfflinePreview: true }, { generateNative: runner(root, 'ios', () => put(root, 'www/native/health-preview-config.json', JSON.stringify({ ...previewConfig(), enabled: false }))) }), /Immutable input/);
});
test('manual preview wiring defaults off and conditionally passes both flags', async () => {
  const workflow = await readFile(join(WRAPPER_ROOT, '.github/workflows/health-candidate.yml'), 'utf8');
  assert.match(workflow, /enable_offline_preview:\s+type: boolean[\s\S]*?default: false/);
  assert.equal((workflow.match(/ENABLE_OFFLINE_PREVIEW: \$\{\{ inputs.enable_offline_preview \}\}/g) || []).length, 3);
  assert.match(workflow, /if \[ "\$ENABLE_OFFLINE_PREVIEW" = 'true' \]; then args\+=\(--offline-health-preview\); fi/);
  assert.equal((workflow.match(/if \[ "\$ENABLE_OFFLINE_PREVIEW" = 'true' \]; then args\+=\(--enable-offline-preview\); fi/g) || []).length, 2);
});

for (const platform of ['ios', 'android']) test('receipted exact disabled config and native preview OFF remain scaffold only: ' + platform, async t => {
  const root = await fixture(t, platform, { ...previewConfig(), enabled: false });
  const receiptBefore = await readFile(join(root, 'www', RECEIPT_FILE));
  const configBefore = await readFile(join(root, 'www/native/health-preview-config.json'));
  const result = await generateHealthCandidate({ ...opts(root, platform), enableOfflinePreview: false }, { generateNative: runner(root, platform), plist: { parse: JSON.parse, build: JSON.stringify }, loadProject: () => projectFixture() });
  assert.equal(result.healthScaffoldIncluded, true); assert.equal(result.healthInvocationEnabled, false); assert.equal(result.healthInvocationScope, undefined);
  assert.deepEqual(await readFile(join(root, 'www', RECEIPT_FILE)), receiptBefore);
  assert.deepEqual(await readFile(join(root, 'www/native/health-preview-config.json')), configBefore);
});
for (const [label, config] of [
  ['malformed', '{broken'], ['null', 'null'], ['array', '[]'],
  ['unknown key', { ...previewConfig(), enabled: false, unexpected: true }],
  ['missing key', { schemaVersion: 1, enabled: false, accountMode: 'off', sourceSha: SOURCE_SHA }],
  ['wrong source', { ...previewConfig(), enabled: false, sourceSha: '0'.repeat(40) }],
  ['account on', { ...previewConfig(), enabled: false, accountMode: 'on' }],
  ['enabled type', { ...previewConfig(), enabled: 0 }],
  ['wrong contract', { ...previewConfig(), enabled: false, consumerContract: 'OTHER' }]
]) test('native preview OFF rejects malformed or unbound receipted config before generation: ' + label, async t => {
  const root = await fixture(t, 'ios', config); let ran = false;
  await assert.rejects(generateHealthCandidate(opts(root, 'ios'), { generateNative: () => { ran = true; throw Error('must not run'); } }));
  assert.equal(ran, false);
});
for (const damage of ['missing receipt', 'unreceipted config']) test('native preview OFF validates existing config receipt before generation: ' + damage, async t => {
  const root = await fixture(t, 'ios', { ...previewConfig(), enabled: false }); let ran = false;
  if (damage === 'missing receipt') await rm(join(root, 'www', RECEIPT_FILE));
  else await put(root, 'www/native/health-preview-config.json', JSON.stringify({ ...previewConfig(), enabled: false }) + ' ');
  await assert.rejects(generateHealthCandidate(opts(root, 'ios'), { generateNative: () => { ran = true; throw Error('must not run'); } }));
  assert.equal(ran, false);
});
