import { readFile, writeFile, readdir, lstat, realpath, mkdir } from 'node:fs/promises';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { generateNative, configureXcode, VERSIONS, validateConfiguration } from './generate-native.mjs';
import { WRAPPER_ROOT, SOURCE_SHA, RECEIPT_FILE, verifyOutput } from './prepare-web.mjs';
import { createHealthPlan, configureHealthXcode, HEALTH_SOURCE, HEALTH_ENTITLEMENTS_PATH } from './configure-health.mjs';
import { planAndroidHealth } from './configure-android-health.mjs';
const hash = x => createHash('sha256').update(x).digest('hex');
const json = async p => JSON.parse(await readFile(p, 'utf8'));
const exists = async p => { try { await lstat(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
async function ancestors(p) {
  for (let q = resolve(p); ; q = dirname(q)) { if ((await lstat(q)).isSymbolicLink()) throw Error('Symlink ancestor rejected'); if (dirname(q) === q) break; }
}
async function tree(p, prefix = '') {
  const s = await lstat(p);
  if (s.isSymbolicLink()) throw Error('Symlink rejected: ' + p);
  if (s.isFile()) return { [prefix]: hash(await readFile(p)) };
  if (!s.isDirectory()) throw Error('Unsupported file type');
  const out = {};
  for (const n of (await readdir(p)).sort()) Object.assign(out, await tree(join(p, n), prefix ? prefix + '/' + n : n));
  return out;
}
export function parseArgs(args) {
  const enableOfflinePreview = args.includes('--enable-offline-preview');
  if (args.length !== (enableOfflinePreview ? 4 : 3) || args.filter(x => x === '--enable-health').length !== 1 || args.filter(x => x === '--enable-offline-preview').length > 1) throw Error('Usage: --enable-health --platform android|ios [--enable-offline-preview]');
  const a = args.filter(x => x !== '--enable-health' && x !== '--enable-offline-preview');
  if (a[0] !== '--platform' || !['android', 'ios'].includes(a[1])) throw Error('Explicit --platform required');
  return { platform: a[1], enableHealth: true, enableOfflinePreview };
}
export function parseAgpVersion(text) {
  const all = [...text.matchAll(/classpath\s+['"]com\.android\.tools\.build:gradle:([^'"]+)['"]/g)];
  if (all.length !== 1 || !/^8\.\d+\.\d+$/.test(all[0][1])) throw Error('Actual pinned AGP classpath required');
  return all[0][1];
}
// This config must already be included in the immutable web receipt, never patched here.
async function verifyOfflinePreview(root, enableOfflinePreview) {
  const configPath = join(root, 'www/native/health-preview-config.json');
  // Legacy scaffold-only bundles may omit this config. Any present config must
  // be receipted, source-bound and agree with the native opt-in in BOTH directions.
  if (!enableOfflinePreview && !(await exists(configPath))) return;
  await verifyOutput(join(root, 'www'), SOURCE_SHA);
  const config = await json(configPath);
  const expected = { schemaVersion: 1, enabled: enableOfflinePreview, accountMode: 'off', sourceSha: SOURCE_SHA, consumerContract: 'OFFLINE_NATIVE_HEALTH_PREVIEW_V1' };
  if (!config || Array.isArray(config) || typeof config !== 'object' || Object.keys(config).sort().join('|') !== Object.keys(expected).sort().join('|') || Object.entries(expected).some(([key, value]) => config[key] !== value)) throw Error('Offline preview config mismatch');
}
export async function generateHealthCandidate({ platform, enableHealth = false, enableOfflinePreview = false, wrapperRoot = WRAPPER_ROOT }, deps = {}) {
  if (enableHealth !== true || !['android', 'ios'].includes(platform)) throw Error('Explicit health opt-in/platform required');
  if (typeof enableOfflinePreview !== 'boolean') throw Error('Offline preview opt-in must be an explicit boolean');
  const root = resolve(wrapperRoot), native = join(root, platform), output = join(root, 'output');
  await ancestors(root);
  if (await realpath(root) !== root) throw Error('Noncanonical root');
  if (await exists(native)) throw Error('Platform directory must not exist');
  if (await exists(output)) await tree(output);
  const metaPath = join(output, 'native-health-candidate-' + platform + '.json');
  const basePath = join(output, 'native-generation-' + platform + '.json');
  if (await exists(metaPath) || await exists(basePath)) throw Error('Existing metadata rejected');
  if (await exists(output) && (await readdir(output)).length) throw Error('Existing output artifacts rejected; use a fresh candidate checkout');
  const template = 'native-templates/' + platform + '/NativeHealthPlugin.' + (platform === 'ios' ? 'swift' : 'kt');
  const watched = ['release-config.json', 'capacitor.config.json', 'package.json', 'package-lock.json', 'www', template];
  const before = {};
  for (const p of watched) { await ancestors(join(root, p)); before[p] = await tree(join(root, p)); }
  const unchanged = async () => { for (const p of watched) { await ancestors(join(root, p)); if (JSON.stringify(await tree(join(root, p))) !== JSON.stringify(before[p])) throw Error('Immutable input changed: ' + p); } };
  const release = await json(join(root, 'release-config.json')), cap = await json(join(root, 'capacitor.config.json'));
  validateConfiguration(release, cap);
  if (release.accountMode !== 'off' || release.signingConfigured !== false || release.storeUploadEnabled !== false) throw Error('Offline unsigned candidate only');
  await verifyOfflinePreview(root, enableOfflinePreview);
  // CLI always delegates all original receipt/dependency/offline gates to the real generator.
  // Injection is solely for local fixtures, like generateNative's command injection.
  const base = await (deps.generateNative ?? generateNative)({ platform, wrapperRoot: root }, deps.nativeDependencies);
  await unchanged(); await ancestors(native); const baseline = await tree(native);
  await ancestors(output); const baseOutput = await tree(output);
  if (Object.keys(baseOutput).length !== 1 || !Object.hasOwn(baseOutput, 'native-generation-' + platform + '.json')) throw Error('Unexpected base output artifacts');
  if (await exists(metaPath)) throw Error('Unexpected candidate metadata');
  const persisted = await json(basePath), receipt = await verifyOutput(join(root, 'www'), SOURCE_SHA);
  const receiptHash = hash(await readFile(join(root, 'www', RECEIPT_FILE)));
  if (JSON.stringify(base) !== JSON.stringify(persisted) || base.schemaVersion !== 1 || base.platform !== platform || base.sourceSha !== SOURCE_SHA || receipt.sourceSha !== SOURCE_SHA || base.webReceiptSha256 !== receiptHash || base.packageId !== release.appId || base.baseAppId !== release.appId || base.debugAppId !== release.debugAppId || base.debugAppName !== release.debugAppName || base.versionName !== release.versionName || base.versionCode !== release.versionCode || base.nativeCompilation !== 'not-executed' || base.signingConfigured !== false || JSON.stringify(base.capacitorVersions) !== JSON.stringify(VERSIONS) || JSON.stringify(base.sdk) !== JSON.stringify(platform === 'ios' ? { minimum: '16.0', packageManager: 'SPM', deviceFamily: 1 } : { minimum: 26, compile: 36, target: 36 })) throw Error('Base generation metadata mismatch');
  const baseHash = hash(await readFile(basePath));
  let files, agpVersion;
  const read = rel => readFile(join(native, rel), 'utf8');
  if (platform === 'android') {
    const rootGradle = await read('build.gradle'); agpVersion = parseAgpVersion(rootGradle);
    const java = 'app/src/main/java/' + release.appId.replaceAll('.', '/');
    const plan = planAndroidHealth({ appId: release.appId, capacitorVersion: VERSIONS['@capacitor/android'], compileSdk: release.androidCompileSdk, agpVersion, rootGradle, appGradle: await read('app/build.gradle'), manifest: await read('app/src/main/AndroidManifest.xml'), mainActivity: await read(java + '/MainActivity.java'), kotlinTemplate: await readFile(join(root, template), 'utf8'), runtimeConfig: enableOfflinePreview ? await read('app/src/main/assets/capacitor.config.json') : undefined }, { enabled: true, previewEnabled: enableOfflinePreview, consumerIntegrationReviewed: enableOfflinePreview, accountMode: 'off' });
    if (plan.healthInvocationEnabled !== enableOfflinePreview) throw Error('Android helper invocation/config mismatch');
    files = plan.files;
    const expected = ['build.gradle', 'app/build.gradle', 'app/src/main/AndroidManifest.xml', java + '/MainActivity.java', java + '/NativeHealthPlugin.kt', ...(enableOfflinePreview ? ['app/src/main/assets/capacitor.config.json'] : [])];
    if (!plan.enabled || Object.keys(files).sort().join('|') !== expected.sort().join('|') || Object.hasOwn(baseline, java + '/NativeHealthPlugin.kt')) throw Error('Unexpected Android plan');
  } else {
    const require = createRequire(join(root, 'package.json'));
    const plist = deps.plist ?? require('plist');
    const plan = createHealthPlan({ enabled: true, consumerIntegrated: enableOfflinePreview, accountMode: 'off', info: plist.parse(await read('App/App/Info.plist')), bridgeSource: await read('App/App/NativeBridgeViewController.swift') });
    if (plan.healthInvocationEnabled !== enableOfflinePreview) throw Error('iOS helper invocation/config mismatch');
    const ent = 'App/' + HEALTH_ENTITLEMENTS_PATH, source = 'App/App/' + HEALTH_SOURCE;
    if (Object.keys(baseline).some(p => p.endsWith('.entitlements')) || Object.hasOwn(baseline, source)) throw Error('Preexisting health source/entitlements rejected');
    const projectPath = join(native, 'App/App.xcodeproj/project.pbxproj');
    const project = deps.loadProject ? await deps.loadProject(projectPath) : require('xcode').project(projectPath);
    if (!deps.loadProject) project.parseSync();
    configureXcode(project, release, [HEALTH_SOURCE], []);
    configureHealthXcode(project, { enabled: true });
    files = { 'App/App/Info.plist': plist.build(plan.info), 'App/App/NativeBridgeViewController.swift': plan.bridgeSource, [source]: await readFile(join(root, template), 'utf8'), [ent]: plist.build(plan.entitlements), 'App/App.xcodeproj/project.pbxproj': project.writeSync() };
  }
  // Fully plan before writing. No absolute, traversal, metadata or artifact paths.
  for (const [rel, data] of Object.entries(files)) {
    const r = relative(native, resolve(native, rel));
    if (typeof data !== 'string' || isAbsolute(rel) || rel.includes('\\') || rel.split('/').some(x => !x || x === '.' || x === '..') || isAbsolute(r) || r.startsWith('..') || r === '' || rel.startsWith('output/')) throw Error('Native output boundary rejected');
  }
  for (const [rel, data] of Object.entries(files)) {
    await ancestors(native); await tree(native);
    const dest = join(native, rel);
    let parent = dirname(dest); while (!(await exists(parent))) parent = dirname(parent);
    await ancestors(parent); await mkdir(dirname(dest), { recursive: true }); await ancestors(dirname(dest));
    if (await exists(dest)) { const s = await lstat(dest); if (!s.isFile() || s.isSymbolicLink()) throw Error('Unsafe output file'); }
    await writeFile(dest, data, { flag: Object.hasOwn(baseline, rel) ? 'w' : 'wx' });
  }
  const expected = { ...baseline, ...Object.fromEntries(Object.entries(files).map(([k, v]) => [k, hash(v)])) };
  const final = await tree(native);
  if (JSON.stringify(Object.entries(final).sort()) !== JSON.stringify(Object.entries(expected).sort())) throw Error('Unexpected native tree mutation');
  await unchanged(); await verifyOutput(join(root, 'www'), SOURCE_SHA);
  await ancestors(output);
  if (JSON.stringify(await tree(output)) !== JSON.stringify(baseOutput) || hash(await readFile(basePath)) !== baseHash) throw Error('Base metadata/output changed');
  const metadata = { schemaVersion: 1, platform, reviewStatus: 'UNREVIEWED', healthScaffoldIncluded: true, healthInvocationEnabled: enableOfflinePreview, ...(enableOfflinePreview ? { healthInvocationScope: 'OFFLINE_READONLY_PREVIEW_ONLY' } : { disabledReason: 'CONTEXT_CONSUMER_NOT_REVIEWED' }), sourceSha: SOURCE_SHA, webReceiptSha256: receiptHash, baseGenerationSha256: baseHash, nativeCompilation: 'not-executed', runtimeValidation: 'not-executed', deviceValidation: 'not-executed', signingConfigured: false, storeUploadEnabled: false, accountMode: 'off', ...(agpVersion ? { agpVersion } : {}), modifiedFiles: Object.keys(files).sort(), nativeFilesSha256: final };
  await writeFile(metaPath, JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });
  return metadata;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await generateHealthCandidate(parseArgs(process.argv.slice(2))); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
