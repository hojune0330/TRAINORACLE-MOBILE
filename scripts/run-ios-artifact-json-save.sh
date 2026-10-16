#!/bin/bash
# Builds ONLY the separate destination app/XCUITest runner. Never the R5 app.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
OUT="$ROOT/output"
mkdir -p "$OUT"
: "${RUNNER_TEMP:?A CI-owned temporary directory is required}"
WORK=$(mktemp -d "$RUNNER_TEMP/trainoracle-json-save.XXXXXX")
APP="$WORK/prebuilt/App.app"
DERIVED="$WORK/derived"
DEVICE=''
BEFORE=''
UI_EXIT=1
BYTES_VALID=0
export APP OUT
snapshot_app() {
  node --input-type=module <<'NODE'
import fs from 'node:fs'; import path from 'node:path'; import {createHash} from 'node:crypto';
const root=process.env.APP, entries=[];
const hash=b=>createHash('sha256').update(b).digest('hex');
function walk(rel=''){for(const name of fs.readdirSync(path.join(root,rel)).sort()){const f=path.join(rel,name),p=path.join(root,f),s=fs.lstatSync(p);if(s.isSymbolicLink())entries.push([f,'link',fs.readlinkSync(p)]);else if(s.isDirectory()){entries.push([f,'dir',s.mode&511]);walk(f);}else if(s.isFile())entries.push([f,'file',s.mode&511,s.size,hash(fs.readFileSync(p))]);else throw Error('Unsupported app entry');}}
walk(); process.stdout.write(hash(JSON.stringify(entries)));
NODE
}
finish() {
  STATUS=$?
  trap - EXIT
  set +e
  AFTER=''
  if [ -n "$BEFORE" ] && [ -d "$APP" ]; then AFTER=$(snapshot_app); fi
  IMMUTABLE=0
  if [ -n "$BEFORE" ] && [ "$BEFORE" = "$AFTER" ]; then IMMUTABLE=1; else STATUS=1; fi
  if [[ "$DEVICE" =~ ^[0-9A-Fa-f-]{36}$ ]]; then
    xcrun simctl io "$DEVICE" screenshot "$OUT/ios-json-save-final.png" > "$OUT/screenshot.log" 2>&1 || true
  fi
  if [ -d "$OUT/ios-native-json-save.xcresult" ]; then
    xcrun xcresulttool export attachments --path "$OUT/ios-native-json-save.xcresult" --output-path "$OUT/ios-json-ui-attachments" > "$OUT/attachment-export.log" 2>&1 || true
  fi
  export BEFORE AFTER IMMUTABLE UI_EXIT BYTES_VALID
  node --input-type=module <<'NODE'
import fs from 'node:fs'; import path from 'node:path';
const e=process.env;
const passed=e.IMMUTABLE==='1'&&e.UI_EXIT==='0'&&e.BYTES_VALID==='1';
const report={schemaVersion:1,scope:'fresh-simulator-genuine-xcuitest-local-files-json-save',status:passed?'passed':'failed',sourceArtifactRun:38846323960,sourceSha:'0b3c12f67617ff610005dbb558388c4b5899bb83',testedBundleId:'io.trainoracle.app.debug',destinationBundleId:'io.trainoracle.ci.pickerdestination',originalAppRebuilt:false,originalAppResigned:false,storeUploadPerformed:false,originalAppTreeBefore:e.BEFORE||null,originalAppTreeAfter:e.AFTER||null,originalAppUnchanged:e.IMMUTABLE==='1',uiTestPassed:e.UI_EXIT==='0',savedDestinationBytesVerified:e.BYTES_VALID==='1'};
fs.writeFileSync(path.join(e.OUT,'ios-native-json-save-report.json'),JSON.stringify(report,null,2)+'\n');
NODE
  if [[ "$DEVICE" =~ ^[0-9A-Fa-f-]{36}$ ]]; then
    # This UUID was created by this invocation; never select/delete an existing device.
    xcrun simctl shutdown "$DEVICE" >/dev/null 2>&1 || true
    xcrun simctl delete "$DEVICE" > "$OUT/owned-simulator-cleanup.log" 2>&1 || STATUS=1
  fi
  if [ "$UI_EXIT" -ne 0 ] || [ "$BYTES_VALID" -ne 1 ]; then STATUS=1; fi
  exit "$STATUS"
}
trap finish EXIT
xcodebuild -version > "$OUT/ios-json-xcode-version.txt"
xcrun --sdk iphonesimulator --show-sdk-version > "$OUT/ios-json-sdk-version.txt"
xcrun simctl list runtimes --json > "$OUT/ios-json-runtimes.json"
node --input-type=module <<'NODE'
import fs from 'node:fs'; import {createHash} from 'node:crypto';
const archiveHash=createHash('sha256').update(fs.readFileSync('candidate-input/TrainOracle-ios-SIMULATOR.zip')).digest('hex');
if(archiveHash!=='b4aa18dbf7df12a07322991955d03471b2d2130265053c57f0e5d9ad56bcde3b')throw Error('R5 archive SHA256 mismatch');
const x=fs.readFileSync('output/ios-json-xcode-version.txt','utf8'),sdk=fs.readFileSync('output/ios-json-sdk-version.txt','utf8').trim();
const runtimes=JSON.parse(fs.readFileSync('output/ios-json-runtimes.json','utf8')).runtimes;
if(!/^Xcode 26\.3\s/m.test(x)||sdk!=='26.2'||!runtimes.some(r=>r.identifier==='com.apple.CoreSimulator.SimRuntime.iOS-26-2'&&r.isAvailable))throw Error('Exact Xcode26.3/iOS26.2 environment required');
const meta=JSON.parse(fs.readFileSync('candidate-input/native-generation-ios.json','utf8'));
if(meta.sourceSha!=='0b3c12f67617ff610005dbb558388c4b5899bb83'||meta.signingConfigured!==false||meta.baseAppId!=='io.trainoracle.app'||meta.debugAppId!=='io.trainoracle.app.debug')throw Error('Unexpected R5 source or identity');
NODE
ditto -x -k candidate-input/TrainOracle-ios-SIMULATOR.zip "$WORK/prebuilt"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist")" = io.trainoracle.app.debug
BEFORE=$(snapshot_app)
node --input-type=module <<'NODE'
import fs from 'node:fs'; import {createHash} from 'node:crypto';
fs.writeFileSync('output/ios-json-artifact-origin.json',JSON.stringify({sourceArtifactRun:38846323960,sourceCommit:'53f16fcc3c38cf3918114199adb9d4ac91115e4a',zipSha256:createHash('sha256').update(fs.readFileSync('candidate-input/TrainOracle-ios-SIMULATOR.zip')).digest('hex'),harnessCommit:process.env.GITHUB_SHA||null,originalAppRebuilt:false,originalAppResigned:false},null,2)+'\n');
NODE
DEVICE=$(xcrun simctl create "TrainOracleJSON-$(basename "$WORK")" com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro com.apple.CoreSimulator.SimRuntime.iOS-26-2)
[[ "$DEVICE" =~ ^[0-9A-Fa-f-]{36}$ ]]
printf '%s\n' "$DEVICE" > "$OUT/ios-json-owned-simulator.txt"
xcrun simctl boot "$DEVICE"
xcrun simctl bootstatus "$DEVICE" -b > "$OUT/ios-json-boot.log" 2>&1
xcrun simctl install "$DEVICE" "$APP"
# No app target, binary, signing operation, capability shim or JS injection for R5.
xcodebuild -project native-ui-tests/ios/NativeJSONSaveHarness.xcodeproj -scheme NativeJSONSaveHarness -configuration Debug -sdk iphonesimulator -destination "platform=iOS Simulator,id=$DEVICE" -derivedDataPath "$DERIVED" CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build-for-testing > "$OUT/ios-json-harness-build.log" 2>&1
shopt -s nullglob
RUNS=("$DERIVED/Build/Products/"*.xctestrun)
[ "${#RUNS[@]}" -eq 1 ]
set +e
xcodebuild test-without-building -xctestrun "${RUNS[0]}" -destination "platform=iOS Simulator,id=$DEVICE" -parallel-testing-enabled NO -maximum-concurrent-test-simulator-destinations 1 -resultBundlePath "$OUT/ios-native-json-save.xcresult" -only-testing:NativeJSONSaveUITests/NativeJSONSaveUITests/testActualNativeJSONSaveToOwnedLocalFolder CODE_SIGNING_ALLOWED=NO > "$OUT/ios-json-uitest.log" 2>&1
UI_EXIT=$?
set -e
# Collect destination evidence on UI failure too; UI_EXIT remains a strict gate.
DEST_CONTAINER=$(xcrun simctl get_app_container "$DEVICE" io.trainoracle.ci.pickerdestination data)
export DEST_CONTAINER
# Read ONLY the genuine saved destination, never NativeDocuments-* source temp files.
node --input-type=module <<'NODE'
import fs from 'node:fs'; import path from 'node:path'; import {createHash} from 'node:crypto';
const folder=path.join(process.env.DEST_CONTAINER,'Documents','NativeJSONSave');
const folderStat=fs.lstatSync(folder);
if(!folderStat.isDirectory()||folderStat.isSymbolicLink())throw Error('Unsafe destination');
const names=fs.readdirSync(folder);
if(names.length!==1||!names[0].toLowerCase().endsWith('.json'))throw Error('Expected exactly one new destination JSON');
const file=path.join(folder,names[0]),stat=fs.lstatSync(file);
if(!stat.isFile()||stat.isSymbolicLink()||stat.size===0||stat.size>65536)throw Error('Invalid saved JSON file');
const bytes=fs.readFileSync(file);
// Preserve fresh-CI destination bytes even if validation subsequently fails.
fs.writeFileSync(path.join(process.env.OUT,'trainoracle-ios-native-export.json'),bytes,{flag:'wx'});
fs.writeFileSync(path.join(process.env.OUT,'ios-native-json-saved-bytes.json'),JSON.stringify({bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),validation:'not-completed',evidenceSource:'owned-destination-after-real-picker-save'},null,2)+'\n');
let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw Error('Invalid saved UTF8 JSON');}
if(!value||Array.isArray(value)||typeof value!=='object'||value.app!=='TRAINORACLE'||value.format!=='trainoracle.journal.v1'||!Array.isArray(value.entries)||value.entries.length!==0||typeof value.exportedAt!=='string'||!Number.isFinite(Date.parse(value.exportedAt))||Object.keys(value).sort().join(',')!=='app,entries,exportedAt,format')throw Error('Fresh empty-journal export contract failed');
fs.writeFileSync(path.join(process.env.OUT,'ios-native-json-saved-bytes.json'),JSON.stringify({validUTF8:true,validJSON:true,pinnedFormat:true,emptyEntries:true,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),evidenceSource:'owned-destination-after-real-picker-save'},null,2)+'\n');
NODE
BYTES_VALID=1
