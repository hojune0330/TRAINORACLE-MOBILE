import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { ROOT, assertHostedRuntime, parseAndroidTarget, connectNativePage, isNativePage, connectionErrorCode } from './android-runtime-probe.mjs';

export const EXAMPLE_BUTTON = '운동 분석 예시 보기';
export function parseArgs(args) {
  if (args.length === 0) return { exportPng: false };
  if (args.length === 1 && args[0] === '--export-png') return { exportPng: true };
  if (args.length === 1 && args[0] === '--export-json') return { exportPng: false, exportJson: true };
  throw new Error('Use no arguments, --export-png or --export-json only (one export maximum)');
}
export function pngMetadata(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(8) !== 13) throw new Error('Invalid PNG signature or header');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || !bytes.includes(Buffer.from('IEND'))) throw new Error('Empty or incomplete PNG');
  return { width, height, bytes: bytes.length };
}
export function storeScreenshotMetadata(bytes) {
  const meta = pngMetadata(bytes);
  if (meta.width !== 1080 || meta.height !== 1920) throw new Error('Actual device screenshot must be 1080x1920');
  return meta;
}
export function jsonExportMetadata(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 65536) throw new Error('Invalid empty-journal JSON byte size');
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new Error('Invalid JSON bytes'); }
  if (!value || Array.isArray(value) || typeof value !== 'object' || value.app !== 'TRAINORACLE' || value.format !== 'trainoracle.journal.v1' || !Array.isArray(value.entries) || value.entries.length !== 0 || typeof value.exportedAt !== 'string' || !Number.isFinite(Date.parse(value.exportedAt)) || Object.keys(value).sort().join(',') !== 'app,entries,exportedAt,format') throw new Error('Pinned empty-journal JSON contract failed');
  // Report only booleans and byte count, never serialized content or user fields.
  return { bytes: bytes.length, validJson: true, pinnedFormat: true, emptyEntries: true };
}
export function observedButtonCount(aria, name) {
  let count = 0;
  for (const match of aria.matchAll(/^\s*- button "((?:\\.|[^"\\])*)"([^\n]*)$/gm)) {
    let label; try { label = JSON.parse('"' + match[1] + '"'); } catch { continue; }
    if (label === name && !match[2].includes('[disabled]')) count++;
  }
  return count;
}
export const JSON_ROUTE = Object.freeze(['홈', '더보기', '백업·복원·휴지통', '내 일지 데이터 내려받기 (JSON)']);
export async function followJsonRoute(observe) {
  for (let index = 0; index < JSON_ROUTE.length; index++) {
    const button = await observe(JSON_ROUTE[index], index);
    if (!button) return null;
    if (index === JSON_ROUTE.length - 1) return button;
    await button.click({ timeout: 10000 });
  }
  return null;
}
export function changedExample(home, example) {
  if (typeof home !== 'string' || typeof example !== 'string' || example.trim().length < 50 || example === home || /기록을 확인하지 못|Application error|\bprogressbar\b/.test(example)) return false;
  const oldLines = new Set(home.split('\n').map(line => line.trim()));
  return example.split('\n').filter(line => line.trim() && !oldLines.has(line.trim())).length >= 3;
}
export function pngExportCandidates(aria) {
  const names = [];
  for (const match of aria.matchAll(/^\s*- button "((?:\\.|[^"\\])*)"(?:[^\n]*)$/gm)) {
    let name; try { name = JSON.parse('"' + match[1] + '"'); } catch { continue; }
    if (/(?:PNG|이미지|image)/i.test(name) && /(?:저장|내보내기|다운로드|export|download|save)/i.test(name)) names.push(name);
  }
  return names;
}
export function nativeSaveStatus({ requested, candidateCount, saveClicked = false, pngVerified = false, bytesVerified = false }) {
  if (!requested || candidateCount !== 1) return 'not_reached';
  return saveClicked === true && (pngVerified === true || bytesVerified === true) ? 'passed' : 'failed';
}
function entity(value) {
  return value.replace(/&#x([0-9a-f]+);|&#([0-9]+);|&(quot|apos|amp|lt|gt);/gi, (_, hex, dec, named) => hex ? String.fromCodePoint(parseInt(hex, 16)) : dec ? String.fromCodePoint(Number(dec)) : ({ quot: '"', apos: "'", amp: '&', lt: '<', gt: '>' })[named.toLowerCase()]);
}
export function parseUiXml(xml) {
  if (!xml.includes('<hierarchy') || !xml.includes('</hierarchy>')) throw new Error('Missing fresh UI hierarchy');
  const nodes = [], stack = [];
  for (const token of xml.matchAll(/<node\b[^>]*>|<\/node\s*>/g)) {
    if (token[0].startsWith('</')) { stack.pop(); continue; }
    const attrs = {};
    for (const attr of token[0].matchAll(/([\w:-]+)="([^"<>]*)"/g)) attrs[attr[1]] = entity(attr[2]);
    const node = { ...attrs, ancestors: stack.map(index => nodes[index]['resource-id'] || '') };
    nodes.push(node);
    if (!token[0].endsWith('/>')) stack.push(nodes.length - 1);
  }
  return nodes;
}
export function centerFromBounds(bounds) {
  const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(bounds || '');
  if (!match) throw new Error('Missing observed node bounds');
  const [x1, y1, x2, y2] = match.slice(1).map(Number);
  if (x2 <= x1 || y2 <= y1) throw new Error('Empty observed node bounds');
  return [Math.floor((x1 + x2) / 2), Math.floor((y1 + y2) / 2)];
}
export function localSaveControls(xml) {
  const nodes = parseUiXml(xml);
  const owned = nodes.filter(node => /^(?:com\.google\.android\.documentsui|com\.android\.documentsui)$/.test(node.package || ''));
  const downloads = owned.some(node => /^(?:Downloads?|다운로드)$/.test(node.text || '') && [...node.ancestors, node['resource-id'] || ''].some(id => /:id\/(?:toolbar|toolbar_title|directory_header|current_directory_name)$/.test(id)));
  const fields = owned.filter(node => node.class === 'android.widget.EditText' && node.enabled === 'true');
  const saves = owned.filter(node => /^(?:Save|SAVE|저장)$/.test(node.text || node['content-desc'] || '') && node.enabled === 'true' && node.clickable === 'true');
  if (!downloads || fields.length !== 1 || saves.length !== 1) return null;
  centerFromBounds(fields[0].bounds); centerFromBounds(saves[0].bounds);
  return { field: fields[0], save: saves[0] };
}
function command(adb, serial, args, timeoutMs = 15000) {
  return new Promise((ok, bad) => {
    const child = spawn(adb, ['-s', serial, ...args], { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { child.kill('SIGKILL'); bad(new Error('ADB command timed out')); }, timeoutMs);
    child.once('error', () => { clearTimeout(timer); bad(new Error('ADB command unavailable')); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? ok() : bad(new Error('ADB command failed')); });
  });
}
async function pause(ms) { await new Promise(ok => setTimeout(ok, ms)); }
export async function runSmoke({ exportPng = false, exportJson = false } = {}) {
  assertHostedRuntime();
  if (exportPng && exportJson) throw new Error('At most one export mode is allowed');
  const target = parseAndroidTarget();
  const sdk = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
  if (!sdk) throw new Error('Android SDK is required');
  const adb = join(sdk, 'platform-tools', 'adb');
  const output = resolve(ROOT, 'output');
  await mkdir(output, { recursive: true });
  const id = 'trainoracle-native-ci-' + Date.now() + '-' + target.pid;
  const report = { scope: 'installed-native-ui-only', ui: 'not_reached', homeScreenshot: false, exampleScreenshot: false, exampleChanged: false, export: { status: 'not_reached', reason: exportPng || exportJson ? 'example-not-reached' : 'not-requested' } };
  const diagnostics = [];
  let connection;
  const adbRun = args => command(adb, target.serial, args);
  async function screenshot(name) {
    const remote = '/sdcard/' + id + '-' + name + '.png', local = join(output, 'trainoracle-android-store-' + name + '.png');
    await adbRun(['shell', 'screencap', '-p', remote]);
    await adbRun(['pull', remote, local]);
    const meta = storeScreenshotMetadata(await readFile(local));
    await adbRun(['shell', 'rm', '-f', remote]);
    return meta;
  }
  async function dumpPicker(stage) {
    const remote = '/sdcard/' + id + '-picker.xml', local = join(output, 'android-ui-picker-' + stage + '.xml');
    await adbRun(['shell', 'uiautomator', 'dump', remote]);
    await adbRun(['pull', remote, local]);
    await adbRun(['shell', 'rm', '-f', remote]);
    return await readFile(local, 'utf8');
  }
  async function tap(node) { await adbRun(['shell', 'input', 'tap', ...centerFromBounds(node.bounds).map(String)]); }
  try {
    connection = await connectNativePage((await import('playwright-core'))._android, { target, diagnostic: event => { if (diagnostics.length < 100) diagnostics.push(event); } });
    const page = connection.page;
    // Hosted emulator and exact debug package/PID have been verified above.
    // Change the REAL emulator display, never CSS, viewport emulation or pixels.
    await adbRun(['shell', 'wm', 'size', '1080x1920']);
    report.displayOverrideApplied = true;
    await page.waitForFunction(() => document.readyState === 'complete', null, { timeout: 15000 });
    if (!isNativePage(page.url())) throw new Error('Unexpected native origin');
    const home = await page.locator('body').ariaSnapshot({ timeout: 5000 });
    await writeFile(join(output, 'android-ui-home-aria.txt'), home + '\n');
    const button = page.getByRole('button', { name: EXAMPLE_BUTTON, exact: true });
    if (await button.count() !== 1 || !await button.isVisible()) throw new Error('Unique actual home example button not available');
    report.homeImage = await screenshot('home'); report.homeScreenshot = true;
    await button.click({ timeout: 10000 });
    const deadline = Date.now() + 20000;
    let example = home, previous = '', stable = false;
    while (Date.now() < deadline) {
      example = await page.locator('body').ariaSnapshot({ timeout: 3000 });
      if (changedExample(home, example) && example === previous) { stable = true; break; }
      previous = example;
      await pause(500);
    }
    await writeFile(join(output, 'android-ui-example-aria.txt'), example + '\n');
    if (!isNativePage(page.url()) || !stable || !changedExample(home, example)) throw new Error('Actual example UI did not reach a stable changed state');
    report.exampleChanged = true;
    report.exampleImage = await screenshot('example'); report.exampleScreenshot = true; report.ui = 'passed';
    if (exportPng || exportJson) {
      const mode = exportJson ? 'json' : 'png';
      let candidates = exportPng ? pngExportCandidates(example) : [];
      let exportButton;
      if (exportJson) {
        report.export = { mode, status: 'not_reached', reason: 'json-route-not-observed', stage: 'route' };
        exportButton = await followJsonRoute(async (name, index) => {
          report.export.routeStep = index;
          const routeDeadline = Date.now() + 6000;
          while (Date.now() < routeDeadline) {
            if (!isNativePage(page.url())) throw new Error('Unexpected native route origin');
            const aria = await page.locator('body').ariaSnapshot({ timeout: 2000 });
            await writeFile(join(output, 'android-ui-json-route-' + index + '-aria.txt'), aria + '\n');
            const count = observedButtonCount(aria, name);
            if (count > 1) return null;
            if (count === 1) {
              const observed = page.getByRole('button', { name, exact: true });
              if (await observed.count() !== 1) return null;
              if (await observed.isVisible() && await observed.isEnabled()) return observed;
            }
            await pause(250);
          }
          return null;
        });
        if (exportButton) candidates = [JSON_ROUTE[3]];
      } else if (candidates.length === 1) exportButton = page.getByRole('button', { name: candidates[0], exact: true });
      report.export = { mode, status: 'not_reached', reason: exportJson ? 'json-route-not-observed' : candidates.length === 0 ? 'no-unambiguous-png-or-image-export-button' : 'ambiguous-export-buttons', candidateCount: candidates.length };
      if (candidates.length === 1 && exportButton) {
        if (await exportButton.count() !== 1 || !await exportButton.isVisible() || !await exportButton.isEnabled()) throw new Error('Export button changed');
        report.export = { mode, status: 'failed', reason: 'native-save-not-verified', stage: 'export-click' };
        await exportButton.click({ timeout: 10000 }); // At most ONE export request.
        let controls = null;
        // Read fresh OS state on each observation, never reuse coordinates across
        // an action or navigate a guessed cloud/root/location.
        for (let attempt = 0; attempt < 3 && !controls; attempt++) {
          controls = localSaveControls(await dumpPicker('opened'));
          if (!controls && attempt < 2) await pause(500);
        }
        if (!controls) report.export.reason = 'picker-not-unambiguous-local-downloads';
        else {
          const filename = id + '.' + mode;
          if ((controls.field.text || '').length > 200) throw new Error('Unexpected filename field');
          await tap(controls.field);
          await adbRun(['shell', 'input', 'keyevent', 'KEYCODE_MOVE_END']);
          if (controls.field.text) await adbRun(['shell', 'input', 'keyevent', ...Array.from(controls.field.text, () => 'KEYCODE_DEL')]);
          await adbRun(['shell', 'input', 'text', filename]);
          const beforeSave = localSaveControls(await dumpPicker('before-save'));
          if (!beforeSave || beforeSave.field.text !== filename) throw new Error('Unique CI filename or local Downloads location not confirmed');
          report.export.stage = 'save-click';
          await tap(beforeSave.save);
          const local = join(output, 'trainoracle-android-native-export.' + mode);
          const saveDeadline = Date.now() + 12000;
          let saved = false;
          while (Date.now() < saveDeadline) {
            try {
              await command(adb, target.serial, ['pull', '/sdcard/Download/' + filename, local], 3000);
              const bytes = await readFile(local);
              if (exportJson) report.export.validation = jsonExportMetadata(bytes);
              else report.export.image = pngMetadata(bytes);
              saved = true; break;
            } catch { await pause(400); }
          }
          report.export.status = nativeSaveStatus({ requested: true, candidateCount: 1, saveClicked: true, bytesVerified: saved });
          report.export.reason = saved ? 'unique-local-download-' + mode + '-bytes-verified' : 'no-valid-' + mode + '-at-owned-local-path';
          await dumpPicker('after-save');
        }
      }
    }
  } catch (error) {
    if (report.ui !== 'passed') report.ui = 'failed';
    report.failure = connectionErrorCode(error);
    if (report.export.status === 'failed') report.export.reason = 'export-step-failed';
    throw new Error('Native UI smoke failed (' + report.failure + ')');
  } finally {
    await writeFile(join(output, 'android-native-ui-smoke.json'), JSON.stringify(report, null, 2) + '\n');
    await writeFile(join(output, 'android-native-ui-connection.json'), JSON.stringify(diagnostics, null, 2) + '\n');
    if (connection) await connection.browser.close();
  }
  if (report.export.status === 'failed') throw new Error('UI passed but requested native document save did not pass; inspect smoke report');
  console.log('Installed Android UI smoke: ' + report.ui + '; native document export: ' + report.export.status);
  return report;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runSmoke(parseArgs(process.argv.slice(2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
