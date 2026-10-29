/** Pure, default-OFF candidate planner. No filesystem writes, commands, CLI or gate bypass. */
export const ANDROID_HEALTH_VERSIONS = Object.freeze({ capacitor: '8.5.3', healthConnect: '1.1.0', kotlin: '2.2.20', coroutines: '1.10.2', webkit: '1.14.0' });
const once = (text, needle, replacement) => {
  if (typeof text !== 'string' || text.split(needle).length !== 2) throw new Error('Unexpected/ambiguous generated template: ' + needle);
  return text.replace(needle, replacement);
};
export function planAndroidHealth(input, { enabled = false, previewEnabled = false, consumerIntegrationReviewed = false, accountMode = 'off' } = {}) {
  if (typeof previewEnabled !== 'boolean' || typeof consumerIntegrationReviewed !== 'boolean') throw new Error('Explicit preview review booleans required');
  if (previewEnabled && (!enabled || !consumerIntegrationReviewed || accountMode !== 'off')) throw new Error('Reviewed offline-only consumer required');
  if (typeof enabled !== 'boolean') throw new Error('Explicit boolean opt-in required');
  if (!enabled) return Object.freeze({ enabled: false, healthInvocationEnabled: false, disabledReason: 'DOCUMENT_SESSION_MAIN_FRAME_BINDING_UNVERIFIED', reviewStatus: 'UNREVIEWED', files: Object.freeze({}) });
  const { appId, capacitorVersion, compileSdk, agpVersion, rootGradle, appGradle, manifest, mainActivity, kotlinTemplate, runtimeConfig } = input;
  if (accountMode !== 'off') throw new Error('Pinned account-off mode required');
  if (appId !== 'io.trainoracle.app' || capacitorVersion !== '8.5.3' || compileSdk !== 36) throw new Error('Pinned identity/SDK mismatch');
  const agp = /^8\.(\d+)\.(\d+)$/.exec(agpVersion ?? '');
  if (!agp || +agp[1] < 9 || (+agp[1] === 9 && +agp[2] < 1)) throw new Error('Reviewed AGP 8.9.1+ required (8.x only)');
  for (const text of [rootGradle, appGradle, manifest, mainActivity]) {
    if (typeof text !== 'string' || /NativeHealth|HealthPermissionsRationale|health\.connect|health\.READ|kotlin-android|org\.jetbrains\.kotlin|kotlin-gradle-plugin/.test(text)) throw new Error('Existing/unreviewed health or Kotlin configuration');
  }
  // Only plan over post-gate generated templates. This check never replaces receipt/tree/version gates.
  const permissions = [...manifest.matchAll(/<uses-permission\b[^>]*android:name="([^"]+)"/g)].map(m => m[1]);
  if (permissions.length !== 1 || permissions[0] !== 'android.permission.INTERNET' ||
      !manifest.includes('android:allowBackup="false"') || !manifest.includes('android:fullBackupContent="false"') ||
      !manifest.includes('android:dataExtractionRules="@xml/data_extraction_rules"') ||
      !manifest.includes('android:usesCleartextTraffic="false"') || /<queries\b|usesCleartextTraffic="true"/.test(manifest)) throw new Error('Existing generator safety gate required');
  if (!mainActivity.includes('registerPlugin(NativeDocumentsPlugin.class);') || !mainActivity.includes('package ' + appId + ';')) throw new Error('Expected document bridge registration');
  if (!/public class MainActivity extends BridgeActivity\s*\{/.test(mainActivity) ||
      (mainActivity.match(/registerPlugin\(NativeDocumentsPlugin\.class\);/g) || []).length !== 1 ||
      (mainActivity.match(/super\.onCreate\(/g) || []).length !== 1 ||
      mainActivity.indexOf('registerPlugin(NativeDocumentsPlugin.class);') > mainActivity.indexOf('super.onCreate(') ||
      /\bvoid\s+load\s*\(/.test(mainActivity)) throw new Error('Early eager-registration startup contract required');
  const runtimePath = 'app/src/main/assets/capacitor.config.json';
  let runtimeOutput;
  if (previewEnabled) {
    if (typeof runtimeConfig !== 'string' || runtimeConfig.length > 131072) throw new Error('Fresh generated runtimeConfig JSON text required');
    let cap;
    try { cap = JSON.parse(runtimeConfig); } catch { throw new Error('Invalid generated runtime config JSON'); }
    if (!cap || Array.isArray(cap) || typeof cap !== 'object' || cap.appId !== appId || cap.appName !== 'TrainOracle' || cap.webDir !== 'www' ||
        cap.loggingBehavior !== 'none' || cap.server?.hostname !== 'localhost' || cap.server?.androidScheme !== 'https' ||
        cap.server?.cleartext !== false || Object.hasOwn(cap.server, 'url') ||
        (cap.server.allowNavigation !== undefined && (!Array.isArray(cap.server.allowNavigation) || cap.server.allowNavigation.length !== 0)) ||
        cap.android?.allowMixedContent !== false || cap.android?.path !== undefined || cap.ios?.path !== undefined ||
        (Object.hasOwn(cap, 'accountMode') && cap.accountMode !== 'off')) throw new Error('Pinned generated identity/account-off/transport config required');
    if (cap.plugins !== undefined && (!cap.plugins || Array.isArray(cap.plugins) || typeof cap.plugins !== 'object')) throw new Error('Invalid generated plugins config');
    if (Object.keys(cap.plugins || {}).some(k => /health/i.test(k)) || cap.plugins?.App?.disableBackButtonHandler === true) throw new Error('Preexisting health/unsafe plugin config rejected');
    // Exact native-only relative output. Never return a root capacitor.config.json write.
    cap.plugins = { ...(cap.plugins || {}), NativeHealth: { accountMode: 'off' } };
    runtimeOutput = JSON.stringify(cap, null, 2) + '\n';
  }
  if (!kotlinTemplate?.startsWith('package __APP_ID__') || !kotlinTemplate.includes('@CapacitorPlugin(name = "NativeHealth")') || !kotlinTemplate.includes('UNREVIEWED') || !/private fun enter\(call: PluginCall\)\s*\{\s*call\.release\(bridge\)\s*\}/.test(kotlinTemplate) || !kotlinTemplate.includes('private const val OFFLINE_PREVIEW_ENABLED = false')) throw new Error('Expected reviewed Kotlin candidate');
  const root = once(rootGradle, `classpath 'com.android.tools.build:gradle:${agpVersion}'`, `classpath 'com.android.tools.build:gradle:${agpVersion}'\n        classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:2.2.20'`);
  let app = once(appGradle, "apply plugin: 'com.android.application'", "apply plugin: 'com.android.application'\napply plugin: 'org.jetbrains.kotlin.android'");
  app = once(app, 'dependencies {', 'dependencies {\n    implementation "androidx.webkit:webkit:1.14.0"\n    implementation "androidx.health.connect:connect-client:1.1.0"\n    implementation "org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2"');
  app += '\n// Candidate requires JDK 21, matching Capacitor 8 Java target.\nkotlin { jvmToolchain(21) }\n';
  let xml = once(manifest, '<application', '<uses-permission android:name="android.permission.health.READ_EXERCISE" />\n    <queries><package android:name="com.google.android.apps.healthdata" /></queries>\n    <application');
  xml = once(xml, '</application>', `  <activity android:name=".HealthPermissionsRationaleActivity" android:exported="true">\n      <intent-filter><action android:name="androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE" /></intent-filter>\n    </activity>\n    <activity-alias android:name="ViewPermissionUsageActivity" android:exported="true" android:targetActivity=".HealthPermissionsRationaleActivity" android:permission="android.permission.START_VIEW_PERMISSION_USAGE">\n      <intent-filter><action android:name="android.intent.action.VIEW_PERMISSION_USAGE" /><category android:name="android.intent.category.HEALTH_PERMISSIONS" /></intent-filter>\n    </activity-alias>\n  </application>`);
  const main = once(mainActivity, 'registerPlugin(NativeDocumentsPlugin.class);', 'registerPlugin(NativeDocumentsPlugin.class);\n        registerPlugin(NativeHealthPlugin.class);');
  const java = 'app/src/main/java/' + appId.replaceAll('.', '/');
  return Object.freeze({ enabled: true, healthInvocationEnabled: previewEnabled, publicCapacitorInvocationEnabled: false, runtimeConfigPath: previewEnabled ? runtimePath : null, startupStrategy: 'capacitor-8.5.3-eager-pluginhandle-before-loadWebView', startupRuntimeVerified: false, disabledReason: previewEnabled ? null : 'PREVIEW_OPT_IN_REQUIRED', reviewStatus: 'UNREVIEWED', nativeCompilation: 'not-executed', files: Object.freeze({
    'build.gradle': root, 'app/build.gradle': app, 'app/src/main/AndroidManifest.xml': xml,
    ...(previewEnabled ? { [runtimePath]: runtimeOutput } : {}),
    [java + '/MainActivity.java']: main, [java + '/NativeHealthPlugin.kt']: kotlinTemplate.replaceAll('__APP_ID__', appId).replace('private const val OFFLINE_PREVIEW_ENABLED = false', 'private const val OFFLINE_PREVIEW_ENABLED = ' + previewEnabled)
  }) });
}

/** Executable JSON-side schema reference, NOT a native ingress/authorization mechanism. */
export function parseAndroidHealthLimit(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('Object required');
  if (!Object.hasOwn(data, 'limit')) return 50;
  const value = data.limit;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > 100) throw new TypeError('INVALID_RANGE_OR_LIMIT');
  return value;
}
