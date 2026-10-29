import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { planAndroidHealth, ANDROID_HEALTH_VERSIONS } from './configure-android-health.mjs';
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
  assert.ok((kotlinTemplate.match(/getGrantedPermissions\(\)/g) || []).length >= 4);
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
