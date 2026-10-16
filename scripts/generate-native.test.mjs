import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { VERSIONS, validateConfiguration, transformMainActivity, transformVariables, transformAndroidGradle, transformManifest, DATA_EXTRACTION_RULES, BACKUP_DOMAINS, transformStoryboard, transformSwiftPackage, transformBridge, transformAppDelegate, transformSceneDelegate, configureXcode, generateNative, parseArgs } from './generate-native.mjs';
import { prepareOutput, SOURCE_SHA, WRAPPER_ROOT } from './prepare-web.mjs';
const require = createRequire(import.meta.url);
const release = JSON.parse(await readFile(join(WRAPPER_ROOT, 'release-config.json'), 'utf8'));
const cap = JSON.parse(await readFile(join(WRAPPER_ROOT, 'capacitor.config.json'), 'utf8'));
function archive(bytes) {
  const tar = gunzipSync(bytes), files = {};
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString().replace(/\0.*$/, '');
    if (!name) break;
    const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/, '').trim(), 8) || 0;
    if (header[156] !== 53) files[name] = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}
const android = archive(await readFile(join(WRAPPER_ROOT, 'node_modules/@capacitor/cli/assets/android-template.tar.gz')));
const ios = archive(await readFile(join(WRAPPER_ROOT, 'node_modules/@capacitor/cli/assets/ios-spm-template.tar.gz')));
const text = (files, name) => { assert.ok(files[name], name); return files[name].toString(); };
async function put(root, file, data) { await mkdir(dirname(join(root, file)), { recursive: true }); await writeFile(join(root, file), data); }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'trainoracle-native-test-'));
  await put(root, 'release-config.json', JSON.stringify(release)); await put(root, 'capacitor.config.json', JSON.stringify(cap));
  await put(root, 'package.json', JSON.stringify({ dependencies: VERSIONS }));
  await put(root, 'package-lock.json', JSON.stringify({ packages: Object.fromEntries(Object.entries(VERSIONS).map(([k, v]) => ['node_modules/' + k, { version: v }])) }));
  for (const [name, version] of Object.entries(VERSIONS)) await put(root, 'node_modules/' + name + '/package.json', JSON.stringify({ version }));
  await put(root, 'node_modules/@capacitor/cli/dist/index.js', '--packagemanager <packageManager>');
  await put(root, 'native-templates/android/NativeDocumentsPlugin.java', 'package __APP_ID__; public class NativeDocumentsPlugin {}');
  await put(root, 'resources/android/res/values/brand.xml', '<resources/>');
  await put(root, 'resources/android/res/drawable/splash.xml', '<layer-list/>');
  await put(root, 'resources/android/res/drawable-v24/ic_launcher_foreground.xml', '<vector/>');
  await put(root, 'source/app/main.ts', 'ORIGINAL_SOURCE_SENTINEL');
  await put(root, 'www/index.html', '<html><head></head><body>fixture</body></html>');
  const entries = {}, snapshot = { treeSha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex'), entries };
  await prepareOutput(join(root, 'www'), { sourceSha: SOURCE_SHA, sourceBefore: snapshot, sourceAfter: snapshot });
  return root;
}
function fixtureRunner(root, calls, mutation) {
  return async (command, args, options) => {
    calls.push({ command, args, options });
    assert.equal(command, process.execPath); assert.equal(options.cwd, root);
    assert.equal(args[0], join(root, 'node_modules/@capacitor/cli/bin/capacitor'));
    assert.ok(['add', 'sync'].includes(args[1])); assert.equal(args[2], 'android');
    if (args[1] === 'add') {
      for (const [file, content] of Object.entries(android)) if (!file.includes('MainActivity.java')) await put(root, 'android/' + file, content);
      await put(root, 'android/app/src/main/java/io/trainoracle/app/MainActivity.java', text(android, 'app/src/main/java/com/getcapacitor/myapp/MainActivity.java').replace('com.getcapacitor.myapp', release.appId));
    }
    if (mutation) await mutation(args);
    return { status: 0 };
  };
}
test('CLI permits only explicit platform, no source/output/delete flags', () => {
  assert.deepEqual(parseArgs(['--platform', 'ios']), { platform: 'ios' });
  for (const args of [[], ['--platform', 'web'], ['--platform', 'android', '--delete'], ['--source', '/source']]) assert.throws(() => parseArgs(args));
});
test('configuration rejects transport, navigation, SDK, identity and source drift', () => {
  assert.equal(validateConfiguration(release, cap), true);
  for (const delta of [{ server: { url: 'https://example.com' } }, { server: { cleartext: true } }, { android: { allowMixedContent: true } }, { server: { allowNavigation: ['*.example.com'] } }, { android: { path: '../source' } }, { appId: 'different.id.app' }, { plugins: { App: { disableBackButtonHandler: true } } }]) assert.throws(() => validateConfiguration(release, { ...cap, ...delta }));
  for (const delta of [{ sourceSha: 'bad' }, { versionName: '1.0.0-beta' }, { versionCode: -1 }, { appId: 'io.bad-id.app' }, { androidTargetSdk: 35 }, { iosMinimumVersion: '15.0' }, { debugAppId: release.appId }, { debugAppName: 'TrainOracle' }]) assert.throws(() => validateConfiguration({ ...release, ...delta }, cap));
});
test('Android registration precedes super and preserves official default Back', () => {
  const result = transformMainActivity(text(android, 'app/src/main/java/com/getcapacitor/myapp/MainActivity.java').replace('com.getcapacitor.myapp', release.appId), release.appId);
  assert.ok(result.indexOf('registerPlugin(') < result.indexOf('super.onCreate('));
  assert.doesNotMatch(result, /onBackPressed|OnBackPressedCallback/);
  assert.throws(() => transformMainActivity('class Unknown {}', release.appId));
});
test('Android versions and all cloud/device storage domains are enforced', () => {
  const vars = transformVariables(text(android, 'variables.gradle'), release);
  for (const value of ['minSdkVersion = 26', 'compileSdkVersion = 36', 'targetSdkVersion = 36']) assert.ok(vars.includes(value));
  const gradle = transformAndroidGradle(text(android, 'app/build.gradle'), release);
  assert.match(gradle, /applicationId "io.trainoracle.app"/); assert.match(gradle, /versionName "1.0.0"/);
  assert.match(gradle, /debug\s*\{\s*applicationIdSuffix "\.debug"\s*\}/);
  assert.doesNotMatch(gradle, /release\s*\{[^}]*applicationIdSuffix/);
  const manifest = transformManifest(text(android, 'app/src/main/AndroidManifest.xml'));
  for (const attr of ['allowBackup="false"', 'fullBackupContent="false"', 'dataExtractionRules="@xml/data_extraction_rules"', 'usesCleartextTraffic="false"']) assert.ok(manifest.includes(attr));
  for (const domain of BACKUP_DOMAINS) assert.equal((DATA_EXTRACTION_RULES.match(new RegExp('domain="' + domain + '"', 'g')) || []).length, 2);
  assert.throws(() => transformManifest('<manifest><uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE"/><application/></manifest>'));
});
test('iOS storyboard and exact SwiftPM pin preserve local App package references', () => {
  const sb = transformStoryboard(text(ios, 'App/App/Base.lproj/Main.storyboard'));
  assert.match(sb, /customClass="NativeBridgeViewController" customModule="App"/);
  assert.throws(() => transformStoryboard(sb));
  const original = text(ios, 'App/CapApp-SPM/Package.swift').replace('    dependencies: [', '    dependencies: [\n        .package(name: "CapacitorApp", path: "../../../node_modules/@capacitor/app"),');
  const result = transformSwiftPackage(original);
  assert.match(result, /exact: "8.5.3"/); assert.match(result, /\.iOS\("16.0"\)/); assert.ok(result.includes('path: "../../../node_modules/@capacitor/app"'));
  assert.throws(() => transformSwiftPackage('unknown'));
});
test('DEBUG probe runs once after super.viewDidAppear, never capacitorDidLoad; backup prep remains before WebView', async () => {
  const original = await readFile(join(WRAPPER_ROOT, 'native-templates/ios/NativeBridgeViewController.swift'), 'utf8');
  const withoutProbe = transformBridge(original, false);
  assert.match(withoutProbe, /override func instanceDescriptor\(\) -> InstanceDescriptor\s*\{\s*NativeStoreBackupPreparation.prepareBeforeWebViewCreation\(\)\s*return super.instanceDescriptor\(\)/);
  assert.doesNotMatch(withoutProbe, /NativeReleaseProbe.attach/);
  assert.equal(await readFile(join(WRAPPER_ROOT, 'native-templates/ios/NativeBridgeViewController.swift'), 'utf8'), original);
  const withProbe = transformBridge(original, true);
  assert.match(withProbe, /#if DEBUG\s+private var nativeReleaseProbeAttached = false\s+override func viewDidAppear\(_ animated: Bool\)\s*\{\s*super.viewDidAppear\(animated\)\s*guard !nativeReleaseProbeAttached else \{ return \}\s*nativeReleaseProbeAttached = true\s*NativeReleaseProbe.attach\(to: bridge\?\.webView\)\s*\}\s*#endif/);
  assert.equal((withProbe.match(/NativeReleaseProbe\.attach\(/g) || []).length, 1);
  const loadHook = withProbe.match(/override func capacitorDidLoad\(\)\s*\{[\s\S]*?\n    \}/)?.[0];
  assert.ok(loadHook);
  assert.match(loadHook, /bridge\?\.registerPluginInstance\(NativeDocumentsPlugin\(\)\)/);
  assert.doesNotMatch(loadHook, /NativeReleaseProbe|evaluateJavaScript|callAsyncJavaScript/);
  const prepHook = /override func instanceDescriptor\(\) -> InstanceDescriptor\s*\{[\s\S]*?\n    \}/;
  assert.equal(withProbe.match(prepHook)?.[0], withoutProbe.match(prepHook)?.[0]);
  const releaseText = withProbe.replace(/#if DEBUG[\s\S]*?#endif/g, '');
  assert.doesNotMatch(releaseText, /NativeReleaseProbe|nativeReleaseProbeAttached|override func viewDidAppear/);
  assert.throws(() => transformBridge(original.replace('override func capacitorDidLoad()', 'override func viewDidAppear(_ animated: Bool) {}\n    override func capacitorDidLoad()'), true), /preexisting probe appearance/);
});
test('actual xcode 3.0.1 parser registers App Sources and privacy Resources, strips signing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'trainoracle-pbx-test-')), file = join(dir, 'project.pbxproj');
  await writeFile(file, ios['App/App.xcodeproj/project.pbxproj']);
  const project = require('xcode').project(file); project.parseSync();
  configureXcode(project, release, ['NativeBridgeViewController.swift', 'NativeDocumentsPlugin.swift', 'NativeReleaseProbe.swift', 'NativeAppLifecycleTrace.swift'], ['PrivacyInfo.xcprivacy']);
  const out = project.writeSync();
  for (const name of ['NativeBridgeViewController.swift', 'NativeDocumentsPlugin.swift', 'NativeReleaseProbe.swift', 'NativeAppLifecycleTrace.swift']) assert.ok(out.includes(name + ' in Sources'));
  assert.ok(out.includes('PrivacyInfo.xcprivacy in Resources'));
  const objects = project.hash.project.objects;
  const targetEntry = Object.entries(objects.PBXNativeTarget).find(([id, t]) => !id.endsWith('_comment') && String(t.name).replaceAll('"', '') === 'App');
  const appTarget = targetEntry[1];
  const sourcePhaseId = appTarget.buildPhases.map(p => p.value).find(id => objects.PBXSourcesBuildPhase[id]);
  assert.ok(sourcePhaseId, 'App target must own a Sources build phase');
  const compiledNames = objects.PBXSourcesBuildPhase[sourcePhaseId].files.map(ref => {
    const build = objects.PBXBuildFile[ref.value];
    return String(objects.PBXFileReference[build.fileRef].path).replaceAll('"', '');
  });
  for (const name of ['NativeBridgeViewController.swift', 'NativeDocumentsPlugin.swift', 'NativeReleaseProbe.swift', 'NativeAppLifecycleTrace.swift']) assert.ok(compiledNames.includes(name), name + ' must be in the actual App Sources phase');
  assert.doesNotMatch(out, /DEVELOPMENT_TEAM|PROVISION|CODE_SIGN|ProvisioningStyle/);
  assert.doesNotMatch(out, /IPHONEOS_DEPLOYMENT_TARGET = 15/);
  assert.match(out, /TARGETED_DEVICE_FAMILY = 1/);
  assert.match(out, /MARKETING_VERSION = 1.0.0/);
  const configs = Object.values(project.hash.project.objects.XCBuildConfiguration).filter(c => typeof c === 'object' && c.buildSettings?.APP_DISPLAY_NAME);
  assert.equal(configs.length, 2);
  for (const config of configs) {
    const isDebug = String(config.name).replaceAll('"', '') === 'Debug';
    assert.equal(config.buildSettings.PRODUCT_BUNDLE_IDENTIFIER, isDebug ? 'io.trainoracle.app.debug' : 'io.trainoracle.app');
    assert.equal(config.buildSettings.APP_DISPLAY_NAME, isDebug ? '"TrainOracle Test"' : '"TrainOracle"');
    const conditions = String(config.buildSettings.SWIFT_ACTIVE_COMPILATION_CONDITIONS || '').replaceAll('"', '').split(/\s+/);
    assert.equal(conditions.includes('DEBUG'), isDebug, 'App Swift DEBUG must be enabled only in Debug');
    if (!isDebug) assert.doesNotMatch(String(config.buildSettings.OTHER_SWIFT_FLAGS || ''), /(?:^|\s|"|\\)-D\s*DEBUG(?:$|\s|"|\\)/);
  }
  await writeFile(file, out); const roundtrip = require('xcode').project(file); roundtrip.parseSync();
});
test('fresh Android generation invokes installed add/sync only and preserves input bytes', async () => {
  const root = await fixture(), calls = [];
  const inputs = ['release-config.json', 'capacitor.config.json', 'package.json', 'package-lock.json', 'native-templates/android/NativeDocumentsPlugin.java', 'www/trainoracle-mobile-receipt.json', 'source/app/main.ts'];
  const before = await Promise.all(inputs.map(f => readFile(join(root, f), 'utf8')));
  const result = await generateNative({ platform: 'android', wrapperRoot: root }, { runCommand: fixtureRunner(root, calls) });
  assert.equal(result.nativeCompilation, 'not-executed'); assert.equal(calls.length, 2);
  assert.equal(result.baseAppId, 'io.trainoracle.app'); assert.equal(result.debugAppId, 'io.trainoracle.app.debug');
  assert.match(await readFile(join(root, 'android/app/src/debug/res/values/trainoracle_debug.xml'), 'utf8'), /name="app_name">TrainOracle Test/);
  assert.deepEqual(calls.map(c => c.args.slice(1)), [['add', 'android'], ['sync', 'android']]);
  assert.deepEqual(await Promise.all(inputs.map(f => readFile(join(root, f), 'utf8'))), before);
  assert.match(await readFile(join(root, 'android/app/src/main/java/io/trainoracle/app/NativeDocumentsPlugin.java'), 'utf8'), /package io.trainoracle.app;/);
  assert.ok(await lstat(join(root, 'android/app/src/main/res/values/brand.xml')));
  assert.equal(await readFile(join(root, 'android/app/src/main/res/drawable/splash.xml'), 'utf8'), '<layer-list/>');
  assert.equal(await readFile(join(root, 'android/app/src/main/res/drawable-v24/ic_launcher_foreground.xml'), 'utf8'), '<vector/>');
  for (const name of Object.keys(android).filter(f => /(?:^|\/)splash\.[A-Za-z0-9]+$/.test(f))) await assert.rejects(lstat(join(root, 'android', name)), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(join(root, 'output/native-generation-android.json'))).sourceSha, SOURCE_SHA);
  await assert.rejects(generateNative({ platform: 'android', wrapperRoot: root }, { runCommand: () => { throw new Error('must not run'); } }), /must not exist/);
});
test('invalid web receipt blocks every command before native generation', async () => {
  const root = await fixture(); await put(root, 'www/index.html', 'tampered'); let calls = 0;
  await assert.rejects(generateNative({ platform: 'android', wrapperRoot: root }, { runCommand: () => { calls++; } }), /hash|inventory/);
  assert.equal(calls, 0); assert.ok(!(await readdir(root)).includes('android'));
});
test('installed dependency drift blocks commands', async () => {
  const root = await fixture(); await put(root, 'node_modules/@capacitor/app/package.json', '{"version":"8.1.3"}');
  await assert.rejects(generateNative({ platform: 'android', wrapperRoot: root }), /Dependency version drift/);
});
test('config mutation during runner fails without deleting generated platform', async () => {
  const root = await fixture(), calls = [];
  await assert.rejects(generateNative({ platform: 'android', wrapperRoot: root }, { runCommand: fixtureRunner(root, calls, () => put(root, 'capacitor.config.json', '{}')) }), /Source configuration changed/);
  assert.equal(calls.length, 1); assert.ok((await lstat(join(root, 'android'))).isDirectory());
});
test('web mutation during runner fails and no metadata is published', async () => {
  const root = await fixture(), calls = [];
  await assert.rejects(generateNative({ platform: 'android', wrapperRoot: root }, { runCommand: fixtureRunner(root, calls, () => put(root, 'www/index.html', 'modified')) }), /hash|inventory/);
  assert.ok(!(await readdir(root)).includes('output'));
});

test('generator limits deletion to stock generated splash files, never source or platform directories', async () => {
  const implementation = await readFile(join(WRAPPER_ROOT, 'scripts/generate-native.mjs'), 'utf8');
  assert.doesNotMatch(implementation, /\b(?:rm|rmdir|execFile|execSync)\s*\(/);
  assert.equal((implementation.match(/await unlink\(/g) || []).length, 1);
  assert.match(implementation, /inside\(generatedRes, stock\)/);
  assert.doesNotMatch(implementation, /(?:git clone|git checkout|npm install|npm ci|xcodebuild|gradlew assemble)/);
  assert.match(implementation, /await checkedRun\(\['add'/);
  assert.match(implementation, /await checkedRun\(\['sync'/);
});

test('installed Capacitor lifecycle provides the real bridge WebView before capacitorDidLoad', async () => {
  const controller = await readFile(join(WRAPPER_ROOT, 'node_modules/@capacitor/ios/Capacitor/Capacitor/CAPBridgeViewController.swift'), 'utf8');
  const bridge = await readFile(join(WRAPPER_ROOT, 'node_modules/@capacitor/ios/Capacitor/Capacitor/CapacitorBridge.swift'), 'utf8');
  const loadView = controller.match(/override public final func loadView\(\)\s*\{[\s\S]*?\n    \}/)?.[0];
  assert.ok(loadView);
  assert.ok(loadView.indexOf('prepareWebView(') < loadView.indexOf('capacitorBridge = CapacitorBridge('));
  assert.ok(loadView.indexOf('capacitorBridge = CapacitorBridge(') < loadView.indexOf('capacitorDidLoad()'));
  assert.match(controller, /public var bridgedWebView: WKWebView\?\s*\{\s*return webView/);
  assert.match(bridge, /public var webView: WKWebView\?\s*\{\s*return bridgeDelegate\?\.bridgedWebView/);
  assert.match(controller, /webView = aWebView/);
  assert.match(controller, /override open func viewDidAppear\(_ animated: Bool\)\s*\{\s*super.viewDidAppear\(animated\)/);
  assert.doesNotMatch(controller, /(?:final\s+func|func\s+final)\s+viewDidAppear/);
  const didLoad = controller.match(/override open func viewDidLoad\(\)\s*\{[\s\S]*?\n    \}/)?.[0];
  assert.match(didLoad, /super.viewDidLoad\(\)\s+loadWebView\(\)/);
  assert.match(controller, /public final func loadWebView\(\)[\s\S]*?webView\?\.load\(URLRequest/);
});

test('real scene factory uses the production NativeBridge subclass, not an unused storyboard assumption', () => {
  const original = text(ios, 'App/App/SceneDelegate.swift');
  const out = transformSceneDelegate(original);
  assert.equal(out.replace('window?.rootViewController = NativeBridgeViewController()', 'window?.rootViewController = CAPBridgeViewController()'), original);
  assert.equal((out.match(/rootViewController\s*=\s*NativeBridgeViewController\(\)/g) || []).length, 1);
  assert.doesNotMatch(out, /rootViewController\s*=\s*CAPBridgeViewController/);
  assert.ok(out.indexOf('NativeBridgeViewController()') < out.indexOf('window?.makeKeyAndVisible()'));
  assert.match(out, /SceneDelegateProxy.shared.scene\(scene, willConnectTo: session, options: connectionOptions\)/);
  assert.match(text(ios, 'App/App/AppDelegate.swift'), /config.delegateClass = SceneDelegate.self/);
  const info = require('plist').parse(text(ios, 'App/App/Info.plist'));
  assert.equal(info.UIApplicationSceneManifest.UISceneConfigurations.UIWindowSceneSessionRoleApplication[0].UISceneDelegateClassName, '$(PRODUCT_MODULE_NAME).SceneDelegate');
  assert.throws(() => transformSceneDelegate(out), /Unexpected SceneDelegate/);
  assert.throws(() => transformSceneDelegate(original.replace('CAPBridgeViewController()', 'OtherController()')), /Unexpected SceneDelegate/);
});

test('CI AppDelegate injection preserves every original return and scene behavior, fails on template drift', () => {
  const original = text(ios, 'App/App/AppDelegate.swift');
  assert.equal(transformAppDelegate(original, false), original);
  const injected = '\n        #if DEBUG && TRAINORACLE_NATIVE_CI_PROBE\n        NativeAppLifecycleTrace.install()\n        #endif';
  const out = transformAppDelegate(original, true);
  assert.equal(out.replace(injected, ''), original);
  assert.equal((out.match(/NativeAppLifecycleTrace.install\(\)/g) || []).length, 1);
  const entry = out.match(/didFinishLaunchingWithOptions[\s\S]*?\n    \}/)?.[0];
  assert.ok(entry.indexOf('NativeAppLifecycleTrace.install()') < entry.indexOf('return true'));
  assert.throws(() => transformAppDelegate(original.replace('return true', 'return false'), true), /Unexpected AppDelegate/);
  assert.throws(() => transformAppDelegate(out, true), /Unexpected AppDelegate/);
});

test('CI lifecycle tracer is wholly dual-macro guarded, records no signal values or user data, and uses the real view tree', async () => {
  const trace = await readFile(join(WRAPPER_ROOT, 'native-probe/NativeAppLifecycleTrace.swift'), 'utf8');
  assert.match(trace, /^#if DEBUG && TRAINORACLE_NATIVE_CI_PROBE\n[\s\S]*\n#endif\s*$/);
  assert.equal(trace.replace(/^#if DEBUG && TRAINORACLE_NATIVE_CI_PROBE\n[\s\S]*\n#endif\s*$/, ''), '');
  assert.match(trace, /UIApplication.didBecomeActiveNotification/);
  assert.match(trace, /DispatchQueue.main.async \{ snapshot\(discoverWindow: true\) \}/);
  assert.match(trace, /snapshot\(discoverWindow: false\)/);
  assert.match(trace, /app.connectedScenes/);
  assert.match(trace, /\.isKeyWindow/);
  assert.match(trace, /window\?\.rootViewController/);
  assert.match(trace, /\$0 is NativeBridgeViewController/);
  assert.match(trace, /view as\? WKWebView/);
  assert.match(trace, /pending.append\(contentsOf: view.subviews\)/);
  assert.match(trace, /NativeReleaseProbe.attach\(to: webView\)/);
  assert.match(trace, /\.cachesDirectory/);
  assert.match(trace, /appendingPathComponent\("TrainOracleNativeCI"/);
  assert.match(trace, /appendingPathComponent\("native-app-lifecycle.json"\)/);
  assert.doesNotMatch(trace, /evaluateJavaScript|callAsyncJavaScript|\.rootViewController\s*=|loadViewIfNeeded|setResourceValues|\.text\b|accessibilityLabel|absoluteString|contentsOfDirectory/);
  assert.doesNotMatch(trace, /result\[[^\]]+\]\s*=\s*(?:arguments|phase|argumentPhase)\b/);
  assert.match(trace, /"environmentPhaseRecognized": phase.map/);
  assert.match(trace, /"argumentFlagPresent": flag != nil/);
  const generator = await readFile(join(WRAPPER_ROOT, 'scripts/generate-native.mjs'), 'utf8');
  assert.match(generator, /copy\(join\(root, 'native-probe\/NativeAppLifecycleTrace.swift'\), 'App\/App\/NativeAppLifecycleTrace.swift'\)/);
  assert.match(generator, /\['NativeReleaseProbe.swift', 'NativeAppLifecycleTrace.swift'\]/);
  assert.doesNotMatch(generator, /SWIFT_ACTIVE_COMPILATION_CONDITIONS.*TRAINORACLE_NATIVE_CI_PROBE/);
});
