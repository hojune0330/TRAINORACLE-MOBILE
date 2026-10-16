import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './android-runtime-probe.mjs';
import { EXAMPLE_BUTTON, parseArgs, pngMetadata, changedExample, pngExportCandidates, parseUiXml, centerFromBounds, localSaveControls, nativeSaveStatus, storeScreenshotMetadata, jsonExportMetadata, observedButtonCount, JSON_ROUTE, followJsonRoute, observeNativeHandoff, safeHandoffError } from './android-native-ui-smoke.mjs';

// Fixtures only: never run the app, source tests, emulator, ADB, network, native
// compilation, account flows or runSmoke. Importing the CLI has no side effects.
const home = '- main:\n  - heading "홈" [level=1]\n  - button "운동 분석 예시 보기"\n';
const example = '- main:\n  - heading "예시 분석" [level=1]\n  - paragraph: 예시 운동 분석 결과\n  - button "PNG로 저장"\n  - button "닫기"\n';
const pkg = 'com.google.android.documentsui';
function node(attrs, children = '') {
  return '<node ' + Object.entries({ package: pkg, enabled: 'true', clickable: 'false', bounds: '[0,0][200,100]', ...attrs }).map(([key, value]) => key + '="' + value + '"').join(' ') + (children ? '>' + children + '</node>' : '/>');
}
function picker({ folder = 'Downloads', fieldCount = 1, saveCount = 1, packageName = pkg, filename = 'existing.png' } = {}) {
  return '<?xml version="1.0"?><hierarchy>' + node({ 'resource-id': pkg + ':id/toolbar' }, node({ text: folder })) + Array.from({ length: fieldCount }, () => node({ class: 'android.widget.EditText', text: filename, package: packageName })).join('') + Array.from({ length: saveCount }, () => node({ text: 'Save', clickable: 'true', package: packageName, bounds: '[300,600][500,700]' })).join('') + '</hierarchy>';
}
test('CLI preserves PNG mode and permits exactly one optional JSON-export switch', () => {
  assert.deepEqual(parseArgs([]), { exportPng: false });
  assert.deepEqual(parseArgs(['--export-png']), { exportPng: true });
  assert.deepEqual(parseArgs(['--export-json']), { exportPng: false, exportJson: true });
  for (const args of [['--phase', 'write'], ['--origin', 'https://example.com'], ['--export-png', '--export-png'], ['--export-json', '--export-png'], ['--export-json', '--export-json']]) assert.throws(() => parseArgs(args));
  assert.equal(EXAMPLE_BUTTON, '운동 분석 예시 보기');
});
test('actual changed UI requires substantial fresh ARIA, not a click or loading indicator', () => {
  assert.equal(changedExample(home, example), true);
  assert.equal(changedExample(home, home), false);
  assert.equal(changedExample(home, home + '  - button "focused"\n'), false);
  assert.equal(changedExample(home, example + '  - progressbar "loading"\n'), false);
  assert.equal(changedExample(home, example + '기록을 확인하지 못'), false);
  assert.equal(changedExample(home, ''), false);
});
test('PNG candidate detection reads only actual button labels and retains ambiguity', () => {
  assert.deepEqual(pngExportCandidates(example), ['PNG로 저장']);
  assert.deepEqual(pngExportCandidates('- text: PNG로 저장\n- link "이미지 저장"'), []);
  assert.deepEqual(pngExportCandidates('- button "이미지 저장"\n- button "PNG 다운로드"'), ['이미지 저장', 'PNG 다운로드']);
  assert.deepEqual(pngExportCandidates('- button "PNG 보기"\n- button "파일 내보내기"'), []);
});
test('UI XML parser uses fresh hierarchy attributes and parent toolbar evidence', () => {
  const parsed = parseUiXml(picker({ filename: 'owned&amp;image.png' }));
  assert.ok(parsed.some(item => item.text === 'owned&image.png'));
  assert.ok(parsed.some(item => item.text === 'Downloads' && item.ancestors.includes(pkg + ':id/toolbar')));
  assert.throws(() => parseUiXml('<node text="Downloads"/>'));
});
test('local save requires real DocumentsUI Downloads location, exactly one field and save button', () => {
  const controls = localSaveControls(picker());
  assert.equal(controls.field.text, 'existing.png');
  assert.deepEqual(centerFromBounds(controls.save.bounds), [400, 650]);
  for (const options of [{ folder: 'Google Drive' }, { folder: 'Recent' }, { fieldCount: 0 }, { fieldCount: 2 }, { saveCount: 2 }, { packageName: 'com.other.app' }]) assert.equal(localSaveControls(picker(options)), null);
  assert.ok(localSaveControls(picker({ folder: '다운로드' })));
  const merelyListed = '<hierarchy>' + node({ text: 'Downloads' }) + node({ class: 'android.widget.EditText' }) + node({ text: 'Save', clickable: 'true' }) + '</hierarchy>';
  assert.equal(localSaveControls(merelyListed), null);
});
test('coordinates can only come from nonempty observed XML bounds', () => {
  assert.deepEqual(centerFromBounds('[11,21][101,201]'), [56, 111]);
  for (const value of ['', '[0,0][0,0]', '[20,0][10,10]', '100,200', '[-1,0][10,10]']) assert.throws(() => centerFromBounds(value));
});
test('PNG verification rejects missing/non-PNG/empty files and accepts actual PNG bytes', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7WQAAAAASUVORK5CYII=', 'base64');
  assert.deepEqual(pngMetadata(png), { width: 1, height: 1, bytes: png.length });
  for (const value of [Buffer.alloc(0), Buffer.from('not a PNG'), png.subarray(0, 30)]) assert.throws(() => pngMetadata(value));
  const zero = Buffer.from(png); zero.writeUInt32BE(0, 16); assert.throws(() => pngMetadata(zero));
});
test('native IO cannot pass from a dialog or save click alone; bytes must be verified', () => {
  assert.equal(nativeSaveStatus({ requested: false, candidateCount: 1 }), 'not_reached');
  assert.equal(nativeSaveStatus({ requested: true, candidateCount: 0 }), 'not_reached');
  assert.equal(nativeSaveStatus({ requested: true, candidateCount: 2 }), 'not_reached');
  assert.equal(nativeSaveStatus({ requested: true, candidateCount: 1 }), 'failed');
  assert.equal(nativeSaveStatus({ requested: true, candidateCount: 1, saveClicked: true }), 'failed');
  assert.equal(nativeSaveStatus({ requested: true, candidateCount: 1, pngVerified: true }), 'failed');
  assert.equal(nativeSaveStatus({ requested: true, candidateCount: 1, saveClicked: true, pngVerified: true }), 'passed');
});
test('implementation scope is installed UI only and keeps native runtime gates separate', async () => {
  const text = await readFile(join(ROOT, 'scripts/android-native-ui-smoke.mjs'), 'utf8');
  assert.match(text, /assertHostedRuntime\(\)/);
  assert.match(text, /parseAndroidTarget\(\)/);
  assert.match(text, /connectNativePage\(/);
  assert.match(text, /screencap/); assert.match(text, /uiautomator/);
  assert.match(text, /beforeSave\.field\.text !== filename/);
  assert.match(text, /jsonExportMetadata\(bytes\)/);
  assert.match(text, /pngMetadata\(bytes\)/);
  assert.match(text, /storeScreenshotMetadata\(await readFile\(local\)\)/);
  const connectIndex = text.indexOf('connection = await connectNativePage');
  const displayIndex = text.indexOf("await adbRun(['shell', 'wm', 'size', '1080x1920'])");
  assert.ok(connectIndex > text.indexOf('assertHostedRuntime();'));
  assert.ok(displayIndex > connectIndex);
  assert.ok(displayIndex < text.indexOf("const home = await page.locator('body').ariaSnapshot"));
  assert.ok(text.indexOf("screenshot('example')") < text.indexOf('await followJsonRoute'));
  assert.doesNotMatch(text, /setViewportSize|deviceScaleFactor|addStyleTag|\.resize\(|\.crop\(/);
  assert.doesNotMatch(text, /runProbe\(|indexedDB|localStorage|newPage\(|launchBrowser\(|navigator\.locks\s*=|pm clear|uninstall|npm (?:ci|test)|gradlew|xcodebuild|fetch\(/);
  assert.equal((text.match(/exportButton\.click\(/g) || []).length, 1);
  assert.match(text, /noWaitAfter: true/);
  assert.match(text, /'uiautomator', 'dump', '--compressed', remote\], 25000/);
  assert.ok(text.indexOf("'android-native-export-handoff.json'") < text.indexOf('await connection.browser.close()'));
});

function jsonFixture(changes = {}) {
  return Buffer.from(JSON.stringify({ app: 'TRAINORACLE', format: 'trainoracle.journal.v1', exportedAt: '2026-10-16T00:00:00.000Z', entries: [], ...changes }));
}
test('saved JSON must be nonempty valid UTF-8 and match pinned safe empty-journal format', () => {
  const bytes = jsonFixture();
  assert.deepEqual(jsonExportMetadata(bytes), { bytes: bytes.length, validJson: true, pinnedFormat: true, emptyEntries: true });
  for (const bytes of [Buffer.alloc(0), Buffer.from('{broken'), Buffer.from([0xff]), Buffer.from('null'), Buffer.from('[]'), jsonFixture({ app: 'OTHER' }), jsonFixture({ format: 'trainoracle.journal.full-backup.v5' }), jsonFixture({ entries: [{ privateField: 'PRIVATE_SENTINEL' }] }), jsonFixture({ entries: {} }), jsonFixture({ exportedAt: 'not a date' }), jsonFixture({ unexpected: 'PRIVATE_SENTINEL' })]) {
    assert.throws(() => jsonExportMetadata(bytes), error => !error.message.includes('PRIVATE_SENTINEL'));
  }
});
test('JSON save success cannot be inferred from picker presence or a Save click', () => {
  assert.equal(nativeSaveStatus({ requested: true, candidateCount: 1, saveClicked: true, bytesVerified: false }), 'failed');
  assert.equal(nativeSaveStatus({ requested: true, candidateCount: 1, saveClicked: false, bytesVerified: true }), 'failed');
  assert.equal(nativeSaveStatus({ requested: true, candidateCount: 1, saveClicked: true, bytesVerified: true }), 'passed');
  assert.ok(localSaveControls(picker({ filename: 'trainoracle-native-ci-123-456.json' })));
  assert.equal(localSaveControls(picker({ filename: 'owned.json', folder: 'Google Drive' })), null);
});
test('JSON route uses separately observed exact buttons and leaves final export unclicked', async () => {
  const observed = [], clicked = [];
  const final = await followJsonRoute(async (name, index) => {
    observed.push(name);
    const aria = '- main:\n  - button "' + name + '"\n';
    assert.equal(observedButtonCount(aria, name), 1);
    return { click: async () => clicked.push(index) };
  });
  assert.deepEqual(observed, ['홈', '더보기', '백업·복원·휴지통', '내 일지 데이터 내려받기 (JSON)']);
  assert.deepEqual(observed, [...JSON_ROUTE]);
  assert.deepEqual(clicked, [0, 1, 2]);
  assert.equal(typeof final.click, 'function');
});
test('missing/ambiguous/disabled fresh JSON route states never guess a target', async () => {
  const label = JSON_ROUTE[2];
  assert.equal(observedButtonCount('- button "' + label + '"\n- button "' + label + '"', label), 2);
  assert.equal(observedButtonCount('- button "' + label + '" [disabled]', label), 0);
  assert.equal(observedButtonCount('- text: ' + label, label), 0);
  assert.equal(observedButtonCount('- button "백업 복원 휴지통"', label), 0);
  const clicked = [];
  const result = await followJsonRoute(async (_, index) => index === 2 ? null : { click: async () => clicked.push(index) });
  assert.equal(result, null); assert.deepEqual(clicked, [0, 1]);
});
test('store screenshot gate accepts only actual capture dimensions 1080x1920', () => {
  // Synthetic header fixtures test only the metadata gate, never create screenshots.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7WQAAAAASUVORK5CYII=', 'base64');
  const correct = Buffer.from(png); correct.writeUInt32BE(1080, 16); correct.writeUInt32BE(1920, 20);
  assert.equal(storeScreenshotMetadata(correct).height, 1920);
  for (const [width, height] of [[1080, 2400], [1920, 1080], [1080, 2160], [1, 1]]) {
    const wrong = Buffer.from(png); wrong.writeUInt32BE(width, 16); wrong.writeUInt32BE(height, 20);
    assert.throws(() => storeScreenshotMetadata(wrong), /1080x1920/);
  }
});

test('native handoff is accepted from fresh OS controls even when the sole click callback throws', async () => {
  const calls = [], events = [];
  const result = await observeNativeHandoff({
    click: async options => { calls.push('click'); assert.equal(options.noWaitAfter, true); throw Error('Target closed PRIVATE_SENTINEL'); },
    screenshot: async () => { calls.push('screenshot'); },
    dump: async () => { calls.push('xml'); return picker(); },
    event: value => events.push(value), wait: async () => {},
  });
  assert.deepEqual(calls, ['click', 'screenshot', 'xml']);
  assert.equal(result.evidence.clickReturned, false);
  assert.equal(result.evidence.accepted, true);
  assert.equal(result.evidence.nativeScreenCaptured, true);
  assert.ok(result.controls); assert.equal(result.evidence.xmlSnapshots, 1);
  assert.equal(events[1].errorType, 'target-closed');
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_SENTINEL|Target closed/);
});
test('bounded click timeout still observes native screenshot and XML without retrying the action', async () => {
  let clicks = 0, screenshots = 0;
  const result = await observeNativeHandoff({ click: () => { clicks++; return new Promise(() => {}); }, clickTimeoutMs: 1,
    screenshot: async () => { screenshots++; }, dump: async () => picker(), wait: async () => {},
  });
  assert.equal(clicks, 1); assert.equal(screenshots, 1);
  assert.equal(result.evidence.clickTimedOut, true); assert.equal(result.evidence.accepted, true);
});
test('first dump timeout or failed screenshot is diagnostic and cannot skip later fresh native observations', async () => {
  let clicks = 0, dumps = 0;
  const events = [];
  const result = await observeNativeHandoff({
    click: async () => { clicks++; }, screenshot: async () => { throw Object.assign(Error('secret screenshot failure'), { safeType: 'adb-exit' }); },
    dump: async () => { dumps++; if (dumps === 1) throw Object.assign(Error('secret dump timeout'), { timedOut: true }); return picker(); },
    event: value => events.push(value), wait: async () => {},
  });
  assert.equal(clicks, 1); assert.equal(dumps, 2); assert.equal(result.evidence.accepted, true);
  assert.equal(result.evidence.nativeScreenCaptured, false);
  assert.ok(events.some(event => event.stage === 'native-screenshot' && event.exitNonzero));
  assert.ok(events.some(event => event.stage === 'native-xml' && event.attempt === 1 && event.timedOut));
  assert.doesNotMatch(JSON.stringify(events), /secret/);
});
test('actual app-only XML yields explicit observed-without-DocumentsUI evidence, never a saved claim', async () => {
  let clicks = 0, dumps = 0;
  const xml = '<hierarchy>' + node({ package: 'io.trainoracle.app.debug', text: 'backup page' }) + '</hierarchy>';
  const result = await observeNativeHandoff({ click: async () => { clicks++; }, screenshot: async () => {}, dump: async () => { dumps++; return xml; }, wait: async () => {} });
  assert.equal(clicks, 1); assert.equal(dumps, 3); assert.equal(result.controls, null);
  assert.equal(result.evidence.accepted, false); assert.equal(result.evidence.appUiObservedWithoutDocumentsUi, true);
  assert.equal(result.evidence.conclusion, 'app-ui-observed-without-documentsui');
  assert.equal(result.evidence.documentsUiObserved, false);
});
test('unfamiliar or ambiguous DocumentsUI never authorizes Save despite a returned click', async () => {
  for (const xml of [picker({ folder: 'Google Drive' }), picker({ saveCount: 2 }), picker({ fieldCount: 2 })]) {
    const result = await observeNativeHandoff({ click: async () => {}, screenshot: async () => {}, dump: async () => xml, wait: async () => {} });
    assert.equal(result.evidence.clickReturned, true); assert.equal(result.evidence.documentsUiObserved, true);
    assert.equal(result.evidence.accepted, false); assert.equal(result.controls, null);
    assert.equal(result.evidence.conclusion, 'documentsui-without-proven-local-save-controls');
  }
});
test('no successful native XML produces unknown evidence, not proof the picker never opened', async () => {
  const result = await observeNativeHandoff({ click: async () => { throw Object.assign(Error('PRIVATE_SENTINEL'), { name: 'TimeoutError' }); }, screenshot: async () => {}, dump: async () => { throw Object.assign(Error('PRIVATE_SENTINEL'), { code: 'ENOENT' }); }, wait: async () => {} });
  assert.equal(result.evidence.xmlSnapshots, 0); assert.equal(result.evidence.accepted, false);
  assert.equal(result.evidence.conclusion, 'native-ui-unobserved');
  assert.equal(result.evidence.clickTimedOut, true);
  assert.deepEqual(safeHandoffError(Object.assign(Error('PRIVATE_SENTINEL'), { code: 'ENOENT' })), { errorType: 'file-missing', timedOut: false, exitNonzero: false });
});
