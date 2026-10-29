import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { planAndroidHealth, ANDROID_HEALTH_VERSIONS, parseAndroidHealthLimit } from './configure-android-health.mjs';
const kotlinTemplate = await readFile(new URL('../native-templates/android/NativeHealthPlugin.kt', import.meta.url), 'utf8');
const fixture = () => ({
  appId: 'io.trainoracle.app', capacitorVersion: '8.5.3', compileSdk: 36, agpVersion: '8.13.0', kotlinTemplate,
  rootGradle: "buildscript { dependencies { classpath 'com.android.tools.build:gradle:8.13.0' } }",
  appGradle: "apply plugin: 'com.android.application'\nandroid { compileOptions { sourceCompatibility JavaVersion.VERSION_21; targetCompatibility JavaVersion.VERSION_21 } }\ndependencies {\n}\n",
  manifest: '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><uses-permission android:name="android.permission.INTERNET" /><application android:allowBackup="false" android:fullBackupContent="false" android:dataExtractionRules="@xml/data_extraction_rules" android:usesCleartextTraffic="false"></application></manifest>',
  mainActivity: 'package io.trainoracle.app;\npublic class MainActivity extends BridgeActivity { public void onCreate(Bundle b) { registerPlugin(NativeDocumentsPlugin.class); super.onCreate(b); } }'
});
const enabled = f => planAndroidHealth(f, { enabled: true });
test('default OFF even without source input; explicit boolean required', () => {
  assert.deepEqual(planAndroidHealth().files, {});
  assert.equal(planAndroidHealth().enabled, false);
  assert.throws(() => planAndroidHealth(fixture(), { enabled: 'true' }));
});
test('pure plan has five Android-only output files and preserves inputs', () => {
  const f = fixture(), original = structuredClone(f), p = enabled(f);
  assert.deepEqual(f, original);
  assert.equal(Object.keys(p.files).length, 5);
  assert.equal(p.healthInvocationEnabled, false);
  assert.equal(p.disabledReason, 'DOCUMENT_SESSION_MAIN_FRAME_BINDING_UNVERIFIED');
  assert.equal(p.reviewStatus, 'UNREVIEWED'); assert.equal(p.nativeCompilation, 'not-executed');
  assert.ok(Object.keys(p.files).every(k => !k.includes('..') && !k.startsWith('/') && !/ios|swift/i.test(k)));
  assert.ok(p.files['app/src/main/java/io/trainoracle/app/NativeHealthPlugin.kt'].startsWith('package io.trainoracle.app'));
});
test('pins stable HC, compiler and coroutine dependency versions', () => {
  const p = enabled(fixture());
  assert.equal(ANDROID_HEALTH_VERSIONS.healthConnect, '1.1.0');
  assert.match(p.files['build.gradle'], /kotlin-gradle-plugin:2\.2\.20/);
  assert.match(p.files['app/build.gradle'], /connect-client:1\.1\.0/);
  assert.match(p.files['app/build.gradle'], /kotlinx-coroutines-android:1\.10\.2/);
  assert.match(p.files['app/build.gradle'], /jvmToolchain\(21\)/);
  assert.doesNotMatch(JSON.stringify(p), /alpha|beta|latest|\d\.\+/);
});
test('only READ_EXERCISE added with provider query and both system rationale routes', () => {
  const xml = enabled(fixture()).files['app/src/main/AndroidManifest.xml'];
  const permissions = [...xml.matchAll(/<uses-permission[^>]*android:name="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(permissions, ['android.permission.INTERNET', 'android.permission.health.READ_EXERCISE']);
  for (const token of ['com.google.android.apps.healthdata', 'androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE', 'android.intent.action.VIEW_PERMISSION_USAGE', 'android.permission.START_VIEW_PERMISSION_USAGE', 'android.intent.category.HEALTH_PERMISSIONS']) assert.ok(xml.includes(token));
  assert.doesNotMatch(xml, /WRITE_|READ_EXERCISE_ROUTES|ACCESS_FINE_LOCATION|READ_HEALTH_DATA_HISTORY|READ_HEALTH_DATA_IN_BACKGROUND/);
});
test('preserves backup exclusions, documents bridge and startup order', () => {
  const p = enabled(fixture());
  assert.match(p.files['app/src/main/AndroidManifest.xml'], /dataExtractionRules="@xml\/data_extraction_rules"/);
  const main = p.files['app/src/main/java/io/trainoracle/app/MainActivity.java'];
  assert.ok(main.indexOf('registerPlugin(NativeDocumentsPlugin.class)') < main.indexOf('registerPlugin(NativeHealthPlugin.class)'));
  assert.ok(main.indexOf('registerPlugin(NativeHealthPlugin.class)') < main.indexOf('super.onCreate'));
});
test('rejects wrong app/Capacitor/compile/AGP and unsupported future major', () => {
  for (const change of [{appId:'evil.app.id'}, {capacitorVersion:'8.5.4'}, {compileSdk:35}, {agpVersion:'8.9.0'}, {agpVersion:'9.0.0'}]) assert.throws(() => enabled({...fixture(), ...change}));
});
test('rejects dirty, repeated or ambiguous generated templates', () => {
  for (const key of ['rootGradle','appGradle','manifest','mainActivity']) assert.throws(() => enabled({...fixture(), [key]: fixture()[key] + '\nNativeHealth'}));
  assert.throws(() => enabled({...fixture(), appGradle: fixture().appGradle + '\ndependencies {}'}));
  assert.throws(() => enabled({...fixture(), rootGradle: 'unrecognized'}));
  assert.throws(() => enabled({...fixture(), kotlinTemplate: 'unrecognized'}));
});
test('does not weaken original permission/backup gate', () => {
  for (const name of ['allowBackup','fullBackupContent','dataExtractionRules','usesCleartextTraffic']) assert.throws(() => enabled({...fixture(), manifest: fixture().manifest.replace('android:' + name, 'removed:' + name)}));
  assert.throws(() => enabled({...fixture(), manifest: fixture().manifest.replace('</manifest>', '<uses-permission android:name="android.permission.CAMERA" /></manifest>')}));
});
// These are source-contract checks, not Kotlin compilation or runtime assertions.
test('source contract: trusted local origin, revocable single read permission, manual native prompts', () => {
  assert.match(kotlinTemplate, /u\.scheme == "https" && u\.host == "localhost" && u\.port == -1 && u\.userInfo == null/);
  assert.match(kotlinTemplate, /HealthPermission\.getReadPermission\(ExerciseSessionRecord::class\)/);
  assert.ok((kotlinTemplate.match(/getGrantedPermissions\(\)/g) || []).length >= 3);
  assert.match(kotlinTemplate, /setPositiveButton\("권한 화면 열기"/);
  assert.match(kotlinTemplate, /setPositiveButton\("읽기"/);
  assert.doesNotMatch(kotlinTemplate, /override fun load|override fun handleOnStart|override fun handleOnResume/);
});
test('source contract: 28-day lookback, 7-day range, 100 output and 500 scanned bounds', () => {
  for (const text of ['Duration.ofDays(28)', 'Duration.ofDays(7)', 'limit !in 1..100', 'pageSize = 100', 'pages < 5', 'rows.length() >= limit', 'EXERCISE_TYPE_RUNNING', 'record.startTime.isBefore(start)', 'record.endTime.isAfter(end)', 'end.isAfter(now)']) assert.ok(kotlinTemplate.includes(text), text);
});
test('source contract: allowlist DTO with UNREVIEWED provenance and no sensitive fields', () => {
  for (const text of ['"sourcePackage"', '"sourceRecordId"', '"reviewStatus", "UNREVIEWED"', 'record.metadata.dataOrigin.packageName', '"bounded"']) assert.ok(kotlinTemplate.includes(text));
  assert.doesNotMatch(kotlinTemplate, /record\.(exerciseRoute|route|notes|title)|getExerciseRoute|insertRecords|updateRecords|deleteRecords|SharedPreferences|FileOutputStream|https?:\/\//);
});
test('planner cannot write files, launch builds or import existing generator to bypass gates', async () => {
  const code = await readFile(new URL('./configure-android-health.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(code, /node:fs|node:child_process|writeFile|unlink|generate-native|prepare-web|process\.env|process\.argv/);
});

// JSON reference fixture tests execute JS only. Native parser coverage below is static source-contract only.
test('JSON schema reference: only missing limit defaults, raw finite integer 1..100 required', () => {
  assert.equal(parseAndroidHealthLimit({}), 50);
  for (const value of [1, 50, 100]) assert.equal(parseAndroidHealthLimit({limit: value}), value);
  for (const value of [null, undefined, '50', '1.5', 1.5, NaN, Infinity, -Infinity, true, false, [], {}, 0, -1, 101]) assert.throws(() => parseAndroidHealthLimit({limit: value}));
});
test('native source contract: raw JSON number validation without getInt coercion', () => {
  for (const token of ['if (!call.data.has("limit")) return 50', 'call.data.opt("limit")', 'raw !is Number', '!value.isFinite()', 'value % 1.0 != 0.0', 'value < 1.0', 'value > 100.0']) assert.ok(kotlinTemplate.includes(token), token);
  assert.doesNotMatch(kotlinTemplate, /call\.getInt\(/);
});
test('P1 fail-closed source contract: every health method drops unbound calls without evaluating work', () => {
  const gate = kotlinTemplate.match(/private fun enter\(call: PluginCall, work: suspend \(\) -> Unit\)\s*\{([^}]+)\}/);
  assert.ok(gate);
  assert.equal(gate[1].trim(), 'call.release(bridge)');
  const entrypoints = [...kotlinTemplate.matchAll(/@PluginMethod\s+fun (\w+)\(call: PluginCall\) = enter\(call\)/g)].map(m => m[1]);
  assert.deepEqual(entrypoints, ['availability', 'requestReadPermission', 'readRecentRunningSessions']);
  assert.equal((kotlinTemplate.match(/@PluginMethod/g) || []).length, 3);
  const callback = kotlinTemplate.match(/private fun healthPermissionResult[^]*?\n    }/)[0];
  assert.ok(callback.includes('call?.release(bridge)'));
  assert.doesNotMatch(callback, /resolve|reject|scope\.launch|client\(/);
  assert.equal(planAndroidHealth().healthInvocationEnabled, false);
  assert.equal(enabled(fixture()).healthInvocationEnabled, false);
  assert.throws(() => enabled({...fixture(), kotlinTemplate: kotlinTemplate.replace('call.release(bridge)\n    }', 'work()\n    }')}));
});
test('P2 source contract: no query-count telemetry or misleading memo-read exclusion', () => {
  assert.doesNotMatch(kotlinTemplate, /\.put\("(?:scannedRecords|pagesRead)"/);
  assert.doesNotMatch(kotlinTemplate, /메모는 읽지|메모·심박·다른 건강정보는 읽지/);
  assert.ok(kotlinTemplate.includes('운동세션 객체'));
  assert.ok(kotlinTemplate.includes('부가필드'));
  assert.ok(kotlinTemplate.includes('사용·저장·전송하지 않습니다'));
  assert.match(kotlinTemplate, /catch \(cancelled: CancellationException\) \{ call\.release\(bridge\); throw cancelled }/);
  // No native runtime navigation/iframe/permission/lifecycle safety claim follows from these source checks.
});
