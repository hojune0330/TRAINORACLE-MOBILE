import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { planAndroidHealth, ANDROID_HEALTH_VERSIONS, parseAndroidHealthLimit } from './configure-android-health.mjs';
const kotlinTemplate = await readFile(new URL('../native-templates/android/NativeHealthPlugin.kt', import.meta.url), 'utf8');
const fixture = () => ({
  runtimeConfig: JSON.stringify({appId:'io.trainoracle.app',appName:'TrainOracle',webDir:'www',loggingBehavior:'none',server:{hostname:'localhost',androidScheme:'https',cleartext:false},android:{allowMixedContent:false},plugins:{App:{someExistingOption:true}}}),
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
  assert.equal(p.disabledReason, 'PREVIEW_OPT_IN_REQUIRED');
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

test('compiled gate remains OFF unless explicit reviewed offline preview opt-in', () => {
  for(const opts of [{previewEnabled:true},{enabled:true,previewEnabled:true},{enabled:true,previewEnabled:true,consumerIntegrationReviewed:true,accountMode:'account'}]) assert.throws(()=>planAndroidHealth(fixture(),opts));
  const p=planAndroidHealth(fixture(),{enabled:true,previewEnabled:true,consumerIntegrationReviewed:true,accountMode:'off'});
  assert.equal(p.healthInvocationEnabled,true); assert.equal(p.publicCapacitorInvocationEnabled,false);
  assert.match(p.files['app/src/main/java/io/trainoracle/app/NativeHealthPlugin.kt'],/OFFLINE_PREVIEW_ENABLED = true/);
  assert.equal(p.runtimeConfigPath,'app/src/main/assets/capacitor.config.json');
  assert.equal(Object.keys(p.files).length,6);
  assert.deepEqual(JSON.parse(p.files[p.runtimeConfigPath]).plugins.NativeHealth,{accountMode:'off'});
  assert.equal(JSON.parse(p.files[p.runtimeConfigPath]).plugins.App.someExistingOption,true);
  assert.equal(Object.hasOwn(p.files,'capacitor.config.json'),false);
});
test('JSON reference strict raw limit schema',()=>{
  assert.equal(parseAndroidHealthLimit({}),50);
  for(const value of [null,'50',1.5,NaN,Infinity,true,[],{},0,101]) assert.throws(()=>parseAndroidHealthLimit({limit:value}));
});
test('native source contract only: legacy drop, verified mainframe ingress, feature checks and context',()=>{
  assert.match(kotlinTemplate,/private fun enter\(call: PluginCall\) \{ call.release\(bridge\) }/);
  for(const s of ['WEB_MESSAGE_LISTENER','DOCUMENT_START_SCRIPT','!main','fixedOrigin(origin)','c.proxy !== proxy','c.used.add(id)','current === r.ctx','epoch == r.ctx.epoch','SystemClock.elapsedRealtime()','accountMode','private const val OFFLINE_PREVIEW_ENABLED = false','old.javaClass == BridgeWebViewClient::class.java','super.onPageStarted','super.onPageCommitVisible','r.ctx.proxy.postMessage','catch(cancelled: CancellationException)']) assert.ok(kotlinTemplate.includes(s),s);
  assert.doesNotMatch(kotlinTemplate,/call.resolve|call.reject|\.put\("(?:scannedRecords|pagesRead)"/);
  assert.ok((kotlinTemplate.match(/requireLive\(r\)/g)||[]).length>=8);
});

test('preview runtime config requires fresh native JSON with pinned identity/off/transport and no health config',()=>{
  const opts={enabled:true,previewEnabled:true,consumerIntegrationReviewed:true,accountMode:'off'};
  const f=fixture(), original=f.runtimeConfig;
  const cap=JSON.parse(original);
  for(const runtimeConfig of [undefined,null,{},'not JSON','[]',JSON.stringify({...cap,appId:'io.wrong.app'}),JSON.stringify({...cap,appName:'Wrong'}),JSON.stringify({...cap,accountMode:'account'}),JSON.stringify({...cap,webDir:'remote'}),JSON.stringify({...cap,server:{...cap.server,url:'https://remote.example'}}),JSON.stringify({...cap,server:{...cap.server,hostname:'remote.example'}}),JSON.stringify({...cap,server:{...cap.server,allowNavigation:['*']}}),JSON.stringify({...cap,android:{allowMixedContent:true}}),JSON.stringify({...cap,plugins:{NativeHealth:{accountMode:'off'}}}),JSON.stringify({...cap,plugins:{HealthConnect:{}}})]) assert.throws(()=>planAndroidHealth({...f,runtimeConfig},opts));
  planAndroidHealth(f,opts);assert.equal(f.runtimeConfig,original);
  const scaffold=enabled(f);assert.equal(Object.hasOwn(scaffold.files,'app/src/main/assets/capacitor.config.json'),false);
});
test('reject late/duplicate registration and custom MainActivity load override',()=>{
  const f=fixture();
  for(const mainActivity of [f.mainActivity.replace('registerPlugin(NativeDocumentsPlugin.class); super.onCreate(b);','super.onCreate(b); registerPlugin(NativeDocumentsPlugin.class);'),f.mainActivity.replace('registerPlugin(NativeDocumentsPlugin.class);','registerPlugin(NativeDocumentsPlugin.class); registerPlugin(NativeDocumentsPlugin.class);'),f.mainActivity+'\nprotected void load() {}']) assert.throws(()=>enabled({...f,mainActivity}));
  assert.equal(enabled(f).startupRuntimeVerified,false);
});
test('native late-load guards are source contracts, not runtime startup proof',()=>{
  for(const text of ['if (loadAttempted) return','android.os.Looper.getMainLooper()','!activity.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)','bridge.webView.url == null || bridge.webView.url == "about:blank"']) assert.ok(kotlinTemplate.includes(text),text);
});

test('P2 referenced native contract: both readiness events reconcile and old document cannot bind by first proxy',()=>{
  for(const s of ['private var commitObserved = false','private var proxyReady = false','private fun reconcileDocumentReady()', 'private fun acceptDocumentReady(', 'probeNavigationEpoch != navigationEpoch','window.__TrainOracleHealthProbe','JSONObject.quote(challenge)','probeChallenge = null']) assert.ok(kotlinTemplate.includes(s),s);
  assert.doesNotMatch(kotlinTemplate,/documentProxy = startingProxy|startingProxy = proxy/);
});
test('P2 referenced native contract: lifecycle ON_RESUME retries exact original permission request with cleanup',()=>{
  for(const s of ['LifecycleEventObserver','Lifecycle.Event.ON_RESUME','addObserver(resumeObserver)','removeObserver(resumeObserver)','permissionFlightRequest = r','val original = permissionFlightRequest','permissionResultRequest = original','pending !== r']) assert.ok(kotlinTemplate.includes(s),s);
});
