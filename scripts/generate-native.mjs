import { readFile, writeFile, readdir, lstat, realpath, mkdir, unlink } from 'node:fs/promises';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { verifyOutput, SOURCE_SHA, WRAPPER_ROOT, RECEIPT_FILE, accountOffEnvironment } from './prepare-web.mjs';

export const VERSIONS = Object.freeze({ '@capacitor/core': '8.5.3', '@capacitor/cli': '8.5.3', '@capacitor/android': '8.5.3', '@capacitor/ios': '8.5.3', '@capacitor/app': '8.1.2', xcode: '3.0.1' });
const hash = value => createHash('sha256').update(value).digest('hex');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const exists = async file => { try { await lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const inside = (base, file) => { const r = relative(base, file); return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith('../') && !r.startsWith('..\\')); };
async function safeTree(file) {
  const s = await lstat(file);
  if (s.isSymbolicLink()) throw new Error('Symlink rejected: ' + file);
  if (s.isDirectory()) for (const name of await readdir(file)) await safeTree(join(file, name));
  else if (!s.isFile()) throw new Error('Unsupported file type');
}
async function safeAncestors(file) {
  for (let p = resolve(file); ; p = dirname(p)) {
    if ((await lstat(p)).isSymbolicLink()) throw new Error('Symlink ancestor rejected');
    if (dirname(p) === p) break;
  }
}
export function validateConfiguration(release, cap) {
  if (release.appId !== 'io.trainoracle.app' || !/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){2,}$/.test(release.appId)) throw new Error('Invalid pinned application ID');
  if (release.debugAppId !== release.appId + '.debug' || release.debugAppName !== 'TrainOracle Test') throw new Error('Debug application isolation required');
  if (release.versionName !== '1.0.0' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release.versionName) || release.versionCode !== 1) throw new Error('Invalid pinned version');
  if (release.sourceSha !== SOURCE_SHA || release.iosMinimumVersion !== '16.0' || release.androidMinSdk !== 26 || release.androidCompileSdk !== 36 || release.androidTargetSdk !== 36) throw new Error('Pinned release SDK/source mismatch');
  if (cap.appId !== release.appId || cap.appName !== release.appName || cap.webDir !== 'www') throw new Error('Capacitor identity/webDir mismatch');
  // Deny executable/path overrides, even if they appear innocuous today.
  if (cap.android?.path || cap.ios?.path || cap.plugins?.App?.disableBackButtonHandler === true) throw new Error('Unreviewed platform/back-handler override');
  function inspect(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, v] of Object.entries(value)) {
      if (key === 'cleartext' && v !== false || key === 'allowMixedContent' && v !== false || key === 'allowNavigation' && (!Array.isArray(v) || v.some(x => typeof x !== 'string' || x.includes('*')))) throw new Error('Unsafe navigation/transport configuration');
      inspect(v);
    }
  }
  if (cap.server && Object.hasOwn(cap.server, 'url')) throw new Error('server.url forbidden');
  inspect(cap);
  if (cap.server?.androidScheme && cap.server.androidScheme !== 'https') throw new Error('HTTPS Android scheme required');
  return true;
}
export function transformMainActivity(text, appId) {
  if (!new RegExp('package\\s+' + appId.replaceAll('.', '\\.') + '\\s*;').test(text) || !/public class MainActivity extends BridgeActivity\s*\{\s*\}/.test(text)) throw new Error('Unexpected MainActivity template');
  return text.replace('import com.getcapacitor.BridgeActivity;', 'import com.getcapacitor.BridgeActivity;\nimport android.os.Bundle;').replace(/public class MainActivity extends BridgeActivity\s*\{\s*\}/, `public class MainActivity extends BridgeActivity {\n    @Override public void onCreate(Bundle savedInstanceState) {\n        registerPlugin(NativeDocumentsPlugin.class);\n        super.onCreate(savedInstanceState);\n    }\n}`);
}
function replaceRequired(text, regex, replacement, name) {
  if (!regex.test(text)) throw new Error('Unexpected generated template: ' + name);
  regex.lastIndex = 0;
  return text.replace(regex, replacement);
}
export function transformVariables(text, release) {
  for (const [key, value] of Object.entries({ minSdkVersion: release.androidMinSdk, compileSdkVersion: release.androidCompileSdk, targetSdkVersion: release.androidTargetSdk })) text = replaceRequired(text, new RegExp('\\b' + key + '\\s*=\\s*\\d+', 'g'), key + ' = ' + value, key);
  return text;
}
export function transformAndroidGradle(text, release) {
  for (const [key, value] of Object.entries({ applicationId: '"' + release.appId + '"', versionCode: release.versionCode, versionName: '"' + release.versionName + '"' })) text = replaceRequired(text, new RegExp('\\b' + key + '\\s+(?:"[^"]*"|\'[^\']*\'|\\d+)', 'g'), key + ' ' + value, key);
  if (/\bdebug\s*\{|applicationIdSuffix/.test(text)) throw new Error('Unexpected preexisting debug identity configuration');
  return replaceRequired(text, /\bbuildTypes\s*\{/, 'buildTypes {\n        debug {\n            applicationIdSuffix ".debug"\n        }', 'Android buildTypes');
}
export function transformManifest(text) {
  const permissions = [...text.matchAll(/<uses-permission\b[^>]*android:name="([^"]+)"/g)].map(m => m[1]);
  if (permissions.some(p => p !== 'android.permission.INTERNET') || /usesCleartextTraffic="true"/.test(text)) throw new Error('Unreviewed Android permission/cleartext');
  return replaceRequired(text, /<application\b[^>]*>/, tag => {
    tag = tag.replace(/\s+android:(?:allowBackup|fullBackupContent|dataExtractionRules|usesCleartextTraffic)="[^"]*"/g, '');
    return tag.replace('<application', '<application android:allowBackup="false" android:fullBackupContent="false" android:dataExtractionRules="@xml/data_extraction_rules" android:usesCleartextTraffic="false"');
  }, 'application');
}
// API 31+: exclude every documented storage domain, including device-protected storage.
export const BACKUP_DOMAINS = Object.freeze(['root', 'file', 'database', 'sharedpref', 'external', 'device_root', 'device_file', 'device_database', 'device_sharedpref']);
export const DATA_EXTRACTION_RULES = '<?xml version="1.0" encoding="utf-8"?>\n<data-extraction-rules>\n' + ['cloud-backup', 'device-transfer'].map(section => '  <' + section + '>\n' + BACKUP_DOMAINS.map(domain => '    <exclude domain="' + domain + '" path="." />').join('\n') + '\n  </' + section + '>').join('\n') + '\n</data-extraction-rules>\n';
export function transformStoryboard(text) {
  if ((text.match(/customClass="CAPBridgeViewController"/g) || []).length !== 1 || !/customClass="CAPBridgeViewController"\s+customModule="Capacitor"/.test(text)) throw new Error('Unexpected Main.storyboard bridge class/module');
  return text.replace(/customClass="CAPBridgeViewController"\s+customModule="Capacitor"/, 'customClass="NativeBridgeViewController" customModule="App"');
}
export function transformSwiftPackage(text) {
  text = replaceRequired(text, /\.package\(url:\s*"https:\/\/github\.com\/ionic-team\/capacitor-swift-pm\.git",\s*(?:from|exact):\s*"[^"]+"\)/, '.package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.3")', 'Capacitor SwiftPM');
  return replaceRequired(text, /\.iOS\((?:\.v\d+(?:_\d+)?|"[\d.]+")\)/g, '.iOS("16.0")', 'SwiftPM iOS minimum');
}
export function transformBridge(text, probe) {
  if (!/override func capacitorDidLoad\(\)\s*\{/.test(text) || !text.includes('bridge?.registerPluginInstance(NativeDocumentsPlugin())')) throw new Error('Unexpected native bridge registration');
  if (!text.includes('enum NativeStoreBackupPreparation') || !text.includes('static func prepareBeforeWebViewCreation()')) throw new Error('Expected empty/new-store backup preparation helper');
  if (/override func instanceDescriptor/.test(text)) throw new Error('Unexpected preexisting initialization override');
  // Capacitor 8.5.3 final loadView invokes instanceDescriptor first, before
  // constructing WKWebViewConfiguration, WKWebsiteDataStore or the WebView.
  text = text.replace(/final class NativeBridgeViewController: CAPBridgeViewController\s*\{/, 'final class NativeBridgeViewController: CAPBridgeViewController {\n    override func instanceDescriptor() -> InstanceDescriptor {\n        NativeStoreBackupPreparation.prepareBeforeWebViewCreation()\n        return super.instanceDescriptor()\n    }');
  if (!probe) return text;
  if (/override func viewDidAppear|nativeReleaseProbeAttached|NativeReleaseProbe\.attach/.test(text)) throw new Error('Unexpected preexisting probe appearance hook');
  // capacitorDidLoad precedes viewDidLoad/loadWebView: the probe must not start
  // JavaScript evaluation there. Appearance is after navigation was initiated.
  // This repairs harness timing, not a claim that the prior failure is explained.
  return replaceRequired(text, /final class NativeBridgeViewController: CAPBridgeViewController\s*\{/, `final class NativeBridgeViewController: CAPBridgeViewController {
    #if DEBUG
    private var nativeReleaseProbeAttached = false
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !nativeReleaseProbeAttached else { return }
        nativeReleaseProbeAttached = true
        NativeReleaseProbe.attach(to: bridge?.webView)
    }
    #endif`, 'NativeBridgeViewController');
}
export function transformSceneDelegate(text) {
  // Capacitor 8.5.3's scene template creates its root programmatically. The
  // storyboard alone does not select our subclass for this live scene path.
  const factory = /window\?\.rootViewController\s*=\s*CAPBridgeViewController\(\)/g;
  if (!/class SceneDelegate: UIResponder, UIWindowSceneDelegate\s*\{/.test(text) || [...text.matchAll(factory)].length !== 1 || !text.includes('window = UIWindow(windowScene: windowScene)') || !text.includes('window?.makeKeyAndVisible()') || !text.includes('SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)')) throw new Error('Unexpected SceneDelegate root factory');
  return text.replace(factory, 'window?.rootViewController = NativeBridgeViewController()');
}
export function transformAppDelegate(text, probe) {
  if (!probe) return text;
  if (!/@UIApplicationMain\s+class AppDelegate: UIResponder, UIApplicationDelegate\s*\{/.test(text) || text.includes('NativeAppLifecycleTrace')) throw new Error('Unexpected AppDelegate entry template');
  const launch = /func application\(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: \[UIApplication\.LaunchOptionsKey: Any\]\?\) -> Bool\s*\{([\s\S]*?)\n    \}/g;
  const matches = [...text.matchAll(launch)];
  if (matches.length !== 1 || matches[0][1].replace(/\/\/[^\n]*/g, '').trim() !== 'return true') throw new Error('Unexpected AppDelegate didFinishLaunching body');
  return text.replace(launch, method => method.replace(/\{/, '{\n        #if DEBUG && TRAINORACLE_NATIVE_CI_PROBE\n        NativeAppLifecycleTrace.install()\n        #endif'));
}
export function configureXcode(project, release, sources, resources) {
  const objects = project.hash.project.objects;
  const entries = section => Object.entries(section || {}).filter(([key]) => !key.endsWith('_comment'));
  const targets = entries(objects.PBXNativeTarget).filter(([, t]) => String(t.name).replaceAll('"', '') === 'App');
  if (targets.length !== 1) throw new Error('Expected one App target');
  const [targetId, target] = targets[0];
  const groups = entries(objects.PBXGroup).filter(([, g]) => String(g.path).replaceAll('"', '') === 'App');
  // Fail closed rather than assuming file-system synchronized groups compile copied files.
  if (groups.length !== 1 || target.fileSystemSynchronizedGroups?.length) throw new Error('Unsupported synchronized/ambiguous App group');
  const groupId = groups[0][0];
  for (const file of sources) if (!project.addSourceFile(file, { target: targetId }, groupId)) throw new Error('Source target registration failed: ' + file);
  // xcode 3.0.1 addResourceFile assumes a Cordova-style Resources group.
  // Capacitor has only App, so register its file reference and build phase explicitly.
  for (const name of resources) {
    const file = project.addFile(name, groupId);
    if (!file) throw new Error('Resource target registration failed: ' + name);
    file.uuid = project.generateUuid(); file.target = targetId;
    project.addToPbxBuildFileSection(file);
    project.addToPbxResourcesBuildPhase(file);
  }
  const configList = objects.XCConfigurationList[target.buildConfigurationList];
  if (!configList) throw new Error('Missing App configuration list');
  const appConfigs = new Set(configList.buildConfigurations.map(v => v.value));
  for (const [id, cfg] of entries(objects.XCBuildConfiguration)) {
    const s = cfg.buildSettings;
    if (!s) continue;
    for (const key of Object.keys(s)) if (/DEVELOPMENT_TEAM|PROVISION|CODE_SIGN|ENTITLEMENTS/.test(key)) delete s[key];
    if (s.IPHONEOS_DEPLOYMENT_TARGET || appConfigs.has(id)) s.IPHONEOS_DEPLOYMENT_TARGET = '16.0';
    if (appConfigs.has(id)) {
      const name = String(cfg.name).replaceAll('"', '');
      if (!['Debug', 'Release'].includes(name)) throw new Error('Unreviewed App build configuration');
      Object.assign(s, { PRODUCT_BUNDLE_IDENTIFIER: name === 'Debug' ? release.debugAppId : release.appId, APP_DISPLAY_NAME: '"' + (name === 'Debug' ? release.debugAppName : release.appName) + '"', MARKETING_VERSION: release.versionName, CURRENT_PROJECT_VERSION: String(release.versionCode), TARGETED_DEVICE_FAMILY: '1' });
    }
  }
  for (const [, p] of entries(objects.PBXProject)) for (const a of Object.values(p.attributes?.TargetAttributes || {})) { delete a.ProvisioningStyle; delete a.DevelopmentTeam; if (a.SystemCapabilities && /icloud|healthkit/i.test(JSON.stringify(a.SystemCapabilities))) throw new Error('Forbidden iOS capability'); }
  return project;
}
export function runCommand(command, args, options) {
  const result = spawnSync(command, args, { ...options, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  return { status: result.status };
}

export async function generateNative({ platform, wrapperRoot = WRAPPER_ROOT }, { runCommand: run = runCommand } = {}) {
  if (!['android', 'ios'].includes(platform)) throw new Error('--platform must be android or ios');
  const root = resolve(wrapperRoot);
  await safeAncestors(root);
  if (await realpath(root) !== root) throw new Error('Noncanonical wrapper root');
  const native = join(root, platform), www = join(root, 'www');
  if (await exists(native)) throw new Error('Platform directory must not exist; no delete/reuse is permitted');
  for (const alternate of ['capacitor.config.ts', 'capacitor.config.js']) if (await exists(join(root, alternate))) throw new Error('Alternate executable Capacitor config rejected');
  const watched = ['release-config.json', 'capacitor.config.json', 'package.json', 'package-lock.json'];
  for (const name of watched) await safeTree(join(root, name));
  const initial = Object.fromEntries(await Promise.all(watched.map(async name => [name, hash(await readFile(join(root, name)))])));
  const unchanged = async () => { for (const name of watched) if (hash(await readFile(join(root, name))) !== initial[name]) throw new Error('Source configuration changed: ' + name); };
  const release = await json(join(root, 'release-config.json')), cap = await json(join(root, 'capacitor.config.json')), pkg = await json(join(root, 'package.json')), lock = await json(join(root, 'package-lock.json'));
  validateConfiguration(release, cap);
  if (Object.keys(pkg.scripts || {}).some(k => /^capacitor:/.test(k))) throw new Error('Unreviewed Capacitor hooks rejected');
  for (const [name, version] of Object.entries(VERSIONS)) {
    if ((pkg.dependencies?.[name] ?? pkg.devDependencies?.[name]) !== version || lock.packages?.['node_modules/' + name]?.version !== version || (await json(join(root, 'node_modules', name, 'package.json'))).version !== version) throw new Error('Dependency version drift: ' + name);
  }
  const receipt = await verifyOutput(www, release.sourceSha);
  const receiptHash = hash(await readFile(join(www, RECEIPT_FILE)));
  const required = platform === 'android' ? ['native-templates/android/NativeDocumentsPlugin.java', 'resources/android/res'] : ['native-templates/ios/NativeDocumentsPlugin.swift', 'native-templates/ios/NativeBridgeViewController.swift', 'resources/ios/AppIcon.appiconset', 'resources/ios/Splash.imageset', 'resources/ios/PrivacyInfo.xcprivacy'];
  for (const file of required) await safeTree(join(root, file));
  const probe = platform === 'ios' && await exists(join(root, 'native-probe/NativeReleaseProbe.swift'));
  if (probe) {
    await safeTree(join(root, 'native-probe/NativeReleaseProbe.swift'));
    await safeTree(join(root, 'native-probe/NativeAppLifecycleTrace.swift'));
    const sdkController = await readFile(join(root, 'node_modules/@capacitor/ios/Capacitor/Capacitor/CAPBridgeViewController.swift'), 'utf8');
    if (!/override\s+open\s+func\s+viewDidAppear\(_ animated: Bool\)/.test(sdkController)) throw new Error('Installed SDK viewDidAppear is not verified overridable');
  }
  if (await exists(join(root, 'output'))) await safeTree(join(root, 'output'));
  const metadataPath = join(root, 'output', 'native-generation-' + platform + '.json');
  if (await exists(metadataPath)) throw new Error('Existing generation metadata will not be overwritten');
  const cli = join(root, 'node_modules/@capacitor/cli/bin/capacitor');
  const cliSource = await readFile(join(root, 'node_modules/@capacitor/cli/dist/index.js'), 'utf8');
  if (platform === 'ios' && !cliSource.includes('--packagemanager <packageManager>')) throw new Error('Installed CLI lacks SPM selection');
  const checkWeb = async () => { await verifyOutput(www, release.sourceSha); if (hash(await readFile(join(www, RECEIPT_FILE))) !== receiptHash) throw new Error('Web receipt changed'); };
  const checkedRun = async args => {
    let result;
    try { result = await run(process.execPath, [cli, ...args], { cwd: root, env: accountOffEnvironment(process.env) }); }
    finally { await unchanged(); await checkWeb(); }
    if (result?.status !== 0) throw new Error('Capacitor command failed: ' + args.join(' '));
    await safeTree(native);
  };
  await checkedRun(['add', platform, ...(platform === 'ios' ? ['--packagemanager', 'SPM'] : [])]);
  await checkedRun(['sync', platform]);
  const writeNative = async (rel, data) => {
    const dest = resolve(native, rel);
    if (!inside(native, dest)) throw new Error('Native output boundary rejected');
    await mkdir(dirname(dest), { recursive: true });
    await safeAncestors(dirname(dest));
    if (await exists(dest)) await safeTree(dest);
    await writeFile(dest, data);
  };
  const editNative = async (rel, transform) => writeNative(rel, transform(await readFile(join(native, rel), 'utf8')));
  const copy = async (source, dest) => {
    await safeTree(source);
    if ((await lstat(source)).isDirectory()) for (const name of await readdir(source)) await copy(join(source, name), join(dest, name));
    else await writeNative(dest, await readFile(source));
  };
  if (platform === 'android') {
    const java = 'app/src/main/java/' + release.appId.replaceAll('.', '/');
    await editNative(java + '/MainActivity.java', t => transformMainActivity(t, release.appId));
    const plugin = await readFile(join(root, 'native-templates/android/NativeDocumentsPlugin.java'), 'utf8');
    if (!plugin.includes('package __APP_ID__;')) throw new Error('Native plugin package placeholder missing');
    await writeNative(java + '/NativeDocumentsPlugin.java', plugin.replaceAll('__APP_ID__', release.appId));
    await editNative('variables.gradle', t => transformVariables(t, release));
    await editNative('app/build.gradle', t => transformAndroidGradle(t, release));
    await writeNative('app/src/debug/res/values/trainoracle_debug.xml', '<?xml version="1.0" encoding="utf-8"?>\n<resources><string name="app_name">TrainOracle Test</string><string name="title_activity_main">TrainOracle Test</string></resources>\n');
    // Only the just-generated wrapper-owned Android resource tree is eligible.
    // Stock density/orientation PNGs otherwise override the supplied splash XML
    // or cause duplicate resources. Never remove a platform directory or input.
    const generatedRes = join(native, 'app/src/main/res');
    await safeTree(generatedRes);
    for (const file of await allFiles(generatedRes)) {
      if (!/(?:^|[\\/])splash\.[A-Za-z0-9]+$/.test(file)) continue;
      const stock = resolve(generatedRes, file);
      if (!inside(generatedRes, stock) || !(await lstat(stock)).isFile()) throw new Error('Stock splash boundary rejected');
      await unlink(stock);
    }
    await copy(join(root, 'resources/android/res'), 'app/src/main/res');
    await editNative('app/src/main/AndroidManifest.xml', transformManifest);
    await writeNative('app/src/main/res/xml/data_extraction_rules.xml', DATA_EXTRACTION_RULES);
  } else {
    const require = createRequire(join(root, 'package.json'));
    const plist = require('plist');
    for (const file of ['NativeDocumentsPlugin.swift', 'NativeBridgeViewController.swift']) await writeNative('App/App/' + file, file.startsWith('NativeBridge') ? transformBridge(await readFile(join(root, 'native-templates/ios', file), 'utf8'), probe) : await readFile(join(root, 'native-templates/ios', file)));
    if (probe) {
      await copy(join(root, 'native-probe/NativeReleaseProbe.swift'), 'App/App/NativeReleaseProbe.swift');
      await copy(join(root, 'native-probe/NativeAppLifecycleTrace.swift'), 'App/App/NativeAppLifecycleTrace.swift');
      await editNative('App/App/AppDelegate.swift', text => transformAppDelegate(text, true));
    }
    for (const asset of ['AppIcon.appiconset', 'Splash.imageset']) await copy(join(root, 'resources/ios', asset), 'App/App/Assets.xcassets/' + asset);
    await copy(join(root, 'resources/ios/PrivacyInfo.xcprivacy'), 'App/App/PrivacyInfo.xcprivacy');
    await editNative('App/App/Base.lproj/Main.storyboard', transformStoryboard);
    const appDelegate = await readFile(join(native, 'App/App/AppDelegate.swift'), 'utf8');
    if (!appDelegate.includes('config.delegateClass = SceneDelegate.self')) throw new Error('Unexpected configured SceneDelegate');
    await editNative('App/App/SceneDelegate.swift', transformSceneDelegate);
    await editNative('App/CapApp-SPM/Package.swift', transformSwiftPackage);
    await editNative('App/App/Info.plist', text => {
      const info = plist.parse(text);
      if (info.NSAppTransportSecurity && Object.entries(info.NSAppTransportSecurity).some(([k, v]) => k !== 'NSAllowsLocalNetworking' || v !== true)) throw new Error('Unsafe ATS configuration');
      if (/healthkit|icloud|ubiquity/i.test(JSON.stringify(info))) throw new Error('Forbidden iOS capability');
      info.NSAppTransportSecurity = { NSAllowsArbitraryLoads: false };
      info.MinimumOSVersion = release.iosMinimumVersion;
      info.CFBundleIdentifier = '$(PRODUCT_BUNDLE_IDENTIFIER)';
      info.CFBundleDisplayName = '$(APP_DISPLAY_NAME)';
      info.CFBundleShortVersionString = release.versionName;
      info.CFBundleVersion = String(release.versionCode);
      info.UIDeviceFamily = [1];
      return plist.build(info);
    });
    const projectPath = join(native, 'App/App.xcodeproj/project.pbxproj');
    const project = require('xcode').project(projectPath); project.parseSync();
    configureXcode(project, release, ['NativeDocumentsPlugin.swift', 'NativeBridgeViewController.swift', ...(probe ? ['NativeReleaseProbe.swift', 'NativeAppLifecycleTrace.swift'] : [])], ['PrivacyInfo.xcprivacy']);
    await writeNative('App/App.xcodeproj/project.pbxproj', project.writeSync());
    for (const file of await allFiles(native)) if (/\.entitlements$/.test(file) && /healthkit|icloud|ubiquity/i.test(await readFile(join(native, file), 'utf8'))) throw new Error('Forbidden entitlement');
  }
  await unchanged(); await checkWeb();
  await safeTree(native);
  const metadata = { schemaVersion: 1, platform, packageId: release.appId, baseAppId: release.appId, debugAppId: release.debugAppId, debugAppName: release.debugAppName, versionName: release.versionName, versionCode: release.versionCode, sourceSha: receipt.sourceSha, capacitorVersions: VERSIONS, sdk: platform === 'ios' ? { minimum: '16.0', packageManager: 'SPM', deviceFamily: 1 } : { minimum: 26, compile: 36, target: 36 }, webReceiptSha256: receiptHash, nativeCompilation: 'not-executed', signingConfigured: false };
  await mkdir(join(root, 'output'), { recursive: true });
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });
  return metadata;
}
async function allFiles(root, prefix = '') {
  const result = [];
  for (const name of await readdir(join(root, prefix))) { const rel = join(prefix, name); if ((await lstat(join(root, rel))).isDirectory()) result.push(...await allFiles(root, rel)); else result.push(rel); }
  return result;
}
export function parseArgs(args) {
  if (args.length !== 2 || args[0] !== '--platform' || !['android', 'ios'].includes(args[1])) throw new Error('Usage: node scripts/generate-native.mjs --platform android|ios');
  return { platform: args[1] };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await generateNative(parseArgs(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
