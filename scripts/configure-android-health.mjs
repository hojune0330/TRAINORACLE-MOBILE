/** Pure, default-OFF candidate planner. No filesystem writes, commands, CLI or gate bypass. */
export const ANDROID_HEALTH_VERSIONS = Object.freeze({ capacitor: '8.5.3', healthConnect: '1.1.0', kotlin: '2.2.20', coroutines: '1.10.2' });
const once = (text, needle, replacement) => {
  if (typeof text !== 'string' || text.split(needle).length !== 2) throw new Error('Unexpected/ambiguous generated template: ' + needle);
  return text.replace(needle, replacement);
};
export function planAndroidHealth(input, { enabled = false } = {}) {
  if (typeof enabled !== 'boolean') throw new Error('Explicit boolean opt-in required');
  if (!enabled) return Object.freeze({ enabled: false, healthInvocationEnabled: false, disabledReason: 'DOCUMENT_SESSION_MAIN_FRAME_BINDING_UNVERIFIED', reviewStatus: 'UNREVIEWED', files: Object.freeze({}) });
  const { appId, capacitorVersion, compileSdk, agpVersion, rootGradle, appGradle, manifest, mainActivity, kotlinTemplate } = input;
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
  if (!kotlinTemplate?.startsWith('package __APP_ID__') || !kotlinTemplate.includes('@CapacitorPlugin(name = "NativeHealth")') || !kotlinTemplate.includes('UNREVIEWED') || !/private fun enter\(call: PluginCall, work: suspend \(\) -> Unit\)\s*\{\s*call\.release\(bridge\)\s*\}/.test(kotlinTemplate)) throw new Error('Expected reviewed Kotlin candidate');
  const root = once(rootGradle, `classpath 'com.android.tools.build:gradle:${agpVersion}'`, `classpath 'com.android.tools.build:gradle:${agpVersion}'\n        classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:2.2.20'`);
  let app = once(appGradle, "apply plugin: 'com.android.application'", "apply plugin: 'com.android.application'\napply plugin: 'org.jetbrains.kotlin.android'");
  app = once(app, 'dependencies {', 'dependencies {\n    implementation "androidx.health.connect:connect-client:1.1.0"\n    implementation "org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2"');
  app += '\n// Candidate requires JDK 21, matching Capacitor 8 Java target.\nkotlin { jvmToolchain(21) }\n';
  let xml = once(manifest, '<application', '<uses-permission android:name="android.permission.health.READ_EXERCISE" />\n    <queries><package android:name="com.google.android.apps.healthdata" /></queries>\n    <application');
  xml = once(xml, '</application>', `  <activity android:name=".HealthPermissionsRationaleActivity" android:exported="true">\n      <intent-filter><action android:name="androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE" /></intent-filter>\n    </activity>\n    <activity-alias android:name="ViewPermissionUsageActivity" android:exported="true" android:targetActivity=".HealthPermissionsRationaleActivity" android:permission="android.permission.START_VIEW_PERMISSION_USAGE">\n      <intent-filter><action android:name="android.intent.action.VIEW_PERMISSION_USAGE" /><category android:name="android.intent.category.HEALTH_PERMISSIONS" /></intent-filter>\n    </activity-alias>\n  </application>`);
  const main = once(mainActivity, 'registerPlugin(NativeDocumentsPlugin.class);', 'registerPlugin(NativeDocumentsPlugin.class);\n        registerPlugin(NativeHealthPlugin.class);');
  const java = 'app/src/main/java/' + appId.replaceAll('.', '/');
  return Object.freeze({ enabled: true, healthInvocationEnabled: false, disabledReason: 'DOCUMENT_SESSION_MAIN_FRAME_BINDING_UNVERIFIED', reviewStatus: 'UNREVIEWED', nativeCompilation: 'not-executed', files: Object.freeze({
    'build.gradle': root, 'app/build.gradle': app, 'app/src/main/AndroidManifest.xml': xml,
    [java + '/MainActivity.java']: main, [java + '/NativeHealthPlugin.kt']: kotlinTemplate.replaceAll('__APP_ID__', appId)
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
