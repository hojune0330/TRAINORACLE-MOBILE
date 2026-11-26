import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildHealthJournalEntry,
  createHealthJournalSaver,
  formatDistanceKm,
  formatDurationMin,
  formatPaceText,
  healthRecordFingerprint,
  HEALTH_JOURNAL_LINK_SCHEMA_VERSION,
} from '../web-adapter/health-journal-import.js';
import { installOfflineHealthPreview, normalizeHealthPreview } from '../web-adapter/offline-health-preview.js';

// ── 픽스처 ──────────────────────────────────────────────────────────────
const IOS_ROW = { uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', start: '2026-10-28T10:00:00Z', end: '2026-10-28T10:10:00Z', durationSeconds: 590, distanceMeters: 5020 };
const ANDROID_ROW = { sourcePackage: 'com.sec.android.app.shealth', sourceRecordId: 'run-2026-10-28-01', startTime: '2026-10-28T10:00:00Z', endTime: '2026-10-28T10:10:00Z', exerciseType: 'running' };
const iosRow = patch => normalizeHealthPreview({ source: 'apple-healthkit', workouts: [{ ...IOS_ROW, ...patch }] }, 'ios')[0];
const androidRow = patch => normalizeHealthPreview({ provider: 'health-connect', sessions: [{ ...ANDROID_ROW, ...patch }] }, 'android')[0];
const dateOf = ms => new Date(ms).toISOString().slice(0, 10);

// 앱의 저장 관문 중 이 경로가 만질 수 있는 부분만 옮긴 검사기. 전체 zod 스키마 대체가 아니다.
const DERIVATION_INPUTS = ['import:activity-file', 'import:provider-activity'];
const POST_PROVENANCE_FIELDS = ['system', 'distanceKm', 'durationMin', 'avgPace', 'rpe', 'rpeBand', 'activityOutcome', 'activitySlot', 'planExecutionRelation', 'planExecutionChange', 'painCheckStatus', 'painParts', 'plannedSessionLink', 'plannedRpe', 'objectiveComponents'];
function assertAppWriteGate(entry) {
  assert.equal(entry.kind, 'post-session');
  assert.equal(entry.syncState, 'local');
  assert.equal(typeof entry.id, 'string'); assert.ok(entry.id.length > 0);
  assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Number.isFinite(Date.parse(entry.savedAt)));
  if (entry.memo.trim() !== '') assert.ok(entry.memoPurpose !== undefined, 'nonempty memo requires memoPurpose');
  assert.ok(Number.isInteger(entry.rpe) && entry.rpe >= 0 && entry.rpe <= 10);
  for (const key of ['distanceKm', 'durationMin']) assert.ok(entry[key] === '' || /^\d+(?:\.\d+)?$/.test(entry[key]), key + ' 형식');
  assert.ok(entry.avgPace === '' || /^\d+'\d{2}"$/.test(entry.avgPace));
  for (const [name, value] of Object.entries(entry.fieldProvenance)) {
    assert.ok(POST_PROVENANCE_FIELDS.includes(name), '허용되지 않은 출처 필드 ' + name);
    if (value.provenance === 'DERIVED') assert.ok(value.derivedFrom.every(input => DERIVATION_INPUTS.includes(input)));
  }
  if (entry.objectiveDataState === 'CONFIRMED') assert.ok([entry.distanceKm, entry.durationMin, entry.avgPace].some(value => value.trim() !== ''));
}

/** 앱 일지 저장소 대역 — id 유지(스티커 보존), write gate, savedAt 조건 검사. */
function fakeJournal(initial = []) {
  const entries = initial.map(entry => ({ ...entry }));
  const writes = [];
  return {
    entries, writes,
    port: {
      entries: () => entries.map(entry => ({ ...entry })),
      save: entry => {
        try { assertAppWriteGate(entry); } catch { return { ok: false, total: entries.length }; }
        if (entries.some(existing => existing.id === entry.id)) return { ok: false, total: entries.length };
        entries.push({ ...entry }); writes.push({ type: 'save', id: entry.id });
        return { ok: true, total: entries.length };
      },
      update: (entry, expectedSavedAt) => {
        const index = entries.findIndex(existing => existing.id === entry.id);
        if (index < 0 || entries[index].savedAt !== expectedSavedAt) return { ok: false, total: entries.length };
        try { assertAppWriteGate(entry); } catch { return { ok: false, total: entries.length }; }
        entries[index] = { ...entry }; writes.push({ type: 'update', id: entry.id, expectedSavedAt });
        return { ok: true, total: entries.length };
      },
    },
  };
}
function fakeLinks(text = null) {
  const store = { text, sets: 0, fail: false };
  return {
    store,
    port: {
      get: () => store.text,
      set: value => { if (store.fail) return false; store.text = value; store.sets++; return true; },
    },
  };
}
let ids = 0;
const newEntryId = () => 'entry-' + (++ids);
const savers = (journal, links, platform = 'ios', extra = {}) => createHealthJournalSaver({ journal: journal.port, links: links?.port, platform, newEntryId, now: () => Date.parse('2026-11-27T01:00:00Z'), ...extra });

// ── 초안 만들기 ─────────────────────────────────────────────────────────
test('iOS 운동 1건이 앱 스키마를 만족하는 일지 초안이 된다', () => {
  const entry = buildHealthJournalEntry(iosRow(), { platform: 'ios', entryId: 'entry-a', savedAt: '2026-11-27T01:00:00.000Z', dateOf });
  assert.equal(entry.date, '2026-10-28');
  assert.equal(entry.distanceKm, '5.02');
  assert.equal(entry.durationMin, '9.83');
  assert.equal(entry.avgPace, "1'58\"");
  assert.equal(entry.title, '달리기');
  assert.equal(entry.system, '');
  assert.equal(entry.rpe, 0);
  assert.equal(entry.memo, '');
  assert.equal(entry.activityOutcome, 'COMPLETED');
  assert.equal(entry.fieldProvenance.distanceKm.derivedFrom[0], 'import:provider-activity');
  assert.equal(entry.fieldProvenance.rpe.provenance, 'MISSING');
  assertAppWriteGate(entry);
});

test('Health Connect 경과시간은 거리 없이 저장되고 거리·페이스를 0으로 만들지 않는다', () => {
  const entry = buildHealthJournalEntry(androidRow(), { platform: 'android', entryId: 'entry-b', savedAt: '2026-11-27T01:00:00.000Z', dateOf });
  assert.equal(entry.distanceKm, '');
  assert.equal(entry.avgPace, '');
  assert.equal(entry.durationMin, '10');
  assert.equal(entry.fieldProvenance.distanceKm.provenance, 'MISSING');
  assert.equal(entry.fieldProvenance.durationMin.provenance, 'DERIVED');
  assertAppWriteGate(entry);
});

test('거리 0 m와 30분/km를 넘는 페이스는 값을 꾸며내지 않는다', () => {
  assert.equal(formatDistanceKm(0), '0');
  assert.equal(formatPaceText(600, 0), '');
  assert.equal(formatPaceText(6000, 1000), '');
  assert.equal(formatPaceText(590, 5020), "1'58\"");
  assert.equal(formatDurationMin(60), '1');
  assert.throws(() => formatDistanceKm(-1), /INVALID_DISTANCE/);
});

test('기본 날짜는 기기 지역 날짜다', () => {
  const entry = buildHealthJournalEntry(iosRow(), { platform: 'ios', entryId: 'entry-c', savedAt: '2026-11-27T01:00:00.000Z' });
  const expected = new Date(Date.parse(IOS_ROW.start));
  assert.equal(entry.date, `${expected.getFullYear()}-${String(expected.getMonth() + 1).padStart(2, '0')}-${String(expected.getDate()).padStart(2, '0')}`);
});

for (const patch of [{ start: '2026-02-30T10:00:00Z' }, { distanceMeters: -5 }, { distanceMeters: '5000' }, { end: IOS_ROW.start }, { durationSeconds: Infinity }]) {
  test('미리보기 단계에서 거부되는 기록은 초안도 만들지 않는다 ' + JSON.stringify(patch), () => {
    assert.throws(() => normalizeHealthPreview({ source: 'apple-healthkit', workouts: [{ ...IOS_ROW, ...patch }] }, 'ios'), /INVALID_/);
  });
}

// 미리보기 DTO를 거치지 않은 변조 입력도 저장 전에 거부한다.
const forged = (patch = {}) => Object.freeze({ source: 'apple-healthkit', sourcePackage: null, recordId: IOS_ROW.uuid, start: '2026-10-28T10:00:00.000Z', end: '2026-10-28T10:10:00.000Z', durationSeconds: 590, durationKind: 'reported', distanceMeters: 5020, distanceStatus: 'provided', reviewStatus: 'UNREVIEWED', ...patch });
for (const [label, patch] of [['음수 거리', { distanceMeters: -5 }], ['거리 누락 표시 불일치', { distanceStatus: 'not-provided' }], ['0초', { durationSeconds: 0 }], ['경과시간 표시', { durationKind: 'elapsed' }], ['비UUID', { recordId: '<script>' }], ['상한 초과 시간', { durationSeconds: 3000 * 60 + 1 }]]) {
  test('변조된 기록은 초안을 만들지 않는다: ' + label, () => assert.throws(() => buildHealthJournalEntry(forged(patch), { platform: 'ios', entryId: 'x', savedAt: '2026-11-27T01:00:00.000Z', dateOf }), /INVALID_/));
}

test('플랫폼과 출처가 다르면 초안을 거부한다', () => {
  assert.throws(() => buildHealthJournalEntry(iosRow(), { platform: 'android', entryId: 'x', savedAt: '2026-11-27T01:00:00.000Z', dateOf }), /INVALID_SOURCE/);
  assert.throws(() => buildHealthJournalEntry(iosRow(), { platform: 'web', entryId: 'x', savedAt: '2026-11-27T01:00:00.000Z', dateOf }), /INVALID_PLATFORM/);
  assert.throws(() => buildHealthJournalEntry(iosRow(), { platform: 'ios', entryId: '', savedAt: '2026-11-27T01:00:00.000Z', dateOf }), /INVALID_ENTRY_ID/);
  const accessor = normalizeHealthPreview({ source: 'apple-healthkit', workouts: [IOS_ROW] }, 'ios')[0];
  const trapped = Object.create(null);
  for (const key of Object.keys(accessor)) Object.defineProperty(trapped, key, { value: accessor[key], enumerable: true, configurable: true });
  Object.defineProperty(trapped, 'distanceMeters', { get() { assert.fail('접근자가 실행되면 안 된다'); } });
  assert.throws(() => buildHealthJournalEntry(trapped, { platform: 'ios', entryId: 'x', savedAt: '2026-11-27T01:00:00.000Z', dateOf }), /INVALID_ROW/);
});

// ── 저장·중복 ───────────────────────────────────────────────────────────
test('확인 후 한 번만 저장되고 같은 기록 재선택은 새 일지를 만들지 않는다', () => {
  const journal = fakeJournal(), links = fakeLinks();
  const saver = savers(journal, links);
  const planned = saver.plan(iosRow());
  assert.equal(planned.status, 'ready');
  assert.equal(journal.writes.length, 0, '계획만으로는 저장하지 않는다');
  const saved = saver.commit(planned);
  assert.deepEqual({ ok: saved.ok, status: saved.status }, { ok: true, status: 'saved' });
  assert.equal(journal.entries.length, 1);
  assertAppWriteGate(journal.entries[0]);
  const again = saver.saveRow(iosRow());
  assert.equal(again.status, 'already-saved');
  assert.match(again.message, /이미 이 기록/);
  assert.equal(journal.entries.length, 1);
  assert.equal(journal.writes.length, 1);
});

test('연결표는 원본 건강 식별자를 남기지 않고 다음 실행에서도 중복을 막는다', () => {
  const links = fakeLinks(), first = fakeJournal();
  assert.equal(savers(first, links).saveRow(iosRow()).status, 'saved');
  assert.match(links.store.text, /"schemaVersion":1/);
  assert.ok(!links.store.text.includes(IOS_ROW.uuid), '원본 UUID는 저장하지 않는다');
  assert.ok(!links.store.text.includes(ANDROID_ROW.sourceRecordId));
  const second = fakeJournal(first.entries);
  assert.equal(savers(second, links).saveRow(iosRow()).status, 'already-saved');
  assert.equal(second.entries.length, 1);
});

test('대소문자만 다른 HealthKit UUID는 같은 기록이다', () => {
  const journal = fakeJournal(), links = fakeLinks(), saver = savers(journal, links);
  assert.equal(saver.saveRow(iosRow()).status, 'saved');
  assert.equal(saver.saveRow(iosRow({ uuid: IOS_ROW.uuid.toUpperCase() })).status, 'already-saved');
  assert.equal(journal.entries.length, 1);
});

test('출처 패키지가 다른 같은 recordId는 다른 기록이다', () => {
  const journal = fakeJournal(), links = fakeLinks(), saver = savers(journal, links, 'android');
  assert.equal(saver.saveRow(androidRow()).status, 'saved');
  assert.equal(saver.saveRow(androidRow({ sourcePackage: 'com.google.android.apps.fitness' })).status, 'saved');
  assert.equal(journal.entries.length, 2);
  assert.notEqual(healthRecordFingerprint('health-connect:a.b:1'), healthRecordFingerprint('health-connect:a.c:1'));
});

test('일지가 사라진 연결표는 새 저장을 막지 않고 정리된다', () => {
  const links = fakeLinks();
  const journal = fakeJournal();
  assert.equal(savers(journal, links).saveRow(iosRow()).status, 'saved');
  journal.entries.length = 0; // 사용자가 일지를 지웠다
  const result = savers(journal, links).saveRow(iosRow());
  assert.equal(result.status, 'saved');
  assert.equal(journal.entries.length, 1);
  assert.equal(JSON.parse(links.store.text).links.length, 1);
});

test('저장이 거부되면 연결표를 남기지 않는다', () => {
  const journal = fakeJournal(), links = fakeLinks();
  journal.port.save = () => ({ ok: false, total: 0 });
  const result = savers(journal, links).saveRow(iosRow());
  assert.equal(result.ok, false);
  assert.equal(result.status, 'save-rejected');
  assert.equal(links.store.text, null);
  assert.equal(links.store.sets, 0);
});

test('저장 포트가 예외를 던지거나 목록을 못 읽으면 저장하지 않는다', () => {
  const links = fakeLinks();
  const throwing = { entries: () => [], save: () => { throw new Error('RAW_STORAGE_SECRET'); }, update: () => { throw new Error('RAW'); } };
  const saver = createHealthJournalSaver({ journal: throwing, links: links.port, platform: 'ios', newEntryId, now: () => 1 });
  const result = saver.saveRow(iosRow());
  assert.equal(result.ok, false);
  assert.ok(!JSON.stringify(result).includes('RAW_STORAGE_SECRET'));
  const unreadable = createHealthJournalSaver({ journal: { entries: () => { throw new Error('X'); }, save: () => ({ ok: true }), update: () => ({ ok: true }) }, links: links.port, platform: 'ios', newEntryId, now: () => 1 });
  assert.equal(unreadable.saveRow(iosRow()).status, 'invalid-record');
  assert.equal(links.store.sets, 0);
});

test('확인 도중 일지 목록이 바뀌면 저장하지 않고 다시 계획하게 한다', () => {
  const journal = fakeJournal(), links = fakeLinks(), saver = savers(journal, links);
  const planned = saver.plan(iosRow());
  assert.equal(saver.commit(planned).ok, true);
  const stale = saver.plan(iosRow()); // 이제 already-saved
  assert.equal(stale.status, 'already-saved');
  const forged = { status: 'ready', draft: planned.draft, key: planned.key, date: planned.date, suspects: [], message: '' };
  assert.throws(() => saver.commit(forged), /UNKNOWN_PLAN/);
});

test('연결표 상한을 넘으면 오래된 연결만 정리한다', () => {
  const journal = fakeJournal(), links = fakeLinks();
  const saver = savers(journal, links, 'android', { maxLinks: 2 });
  for (const id of ['a', 'b', 'c']) assert.equal(saver.saveRow(androidRow({ sourceRecordId: id })).status, 'saved');
  const stored = JSON.parse(links.store.text);
  assert.equal(stored.schemaVersion, HEALTH_JOURNAL_LINK_SCHEMA_VERSION);
  assert.equal(stored.links.length, 2);
  assert.equal(journal.entries.length, 3);
});

test('연결표를 쓰지 못하면 저장은 사실대로 알리고 중복 위험을 함께 말한다', () => {
  const journal = fakeJournal(), links = fakeLinks();
  links.store.fail = true;
  const result = savers(journal, links).saveRow(iosRow());
  assert.equal(result.ok, true); assert.equal(result.status, 'saved'); assert.equal(result.linkRecorded, false);
  assert.match(result.message, /중복이 생길 수/);
  assert.equal(journal.entries.length, 1);
});

test('연결표를 읽지 못하면 중복을 확인할 수 없으므로 저장하지 않는다', () => {
  const journal = fakeJournal();
  const saver = createHealthJournalSaver({ journal: journal.port, links: { get() { throw new Error('STORAGE'); }, set: () => true }, platform: 'ios', newEntryId, now: () => 1 });
  assert.equal(saver.saveRow(iosRow()).status, 'invalid-record');
  assert.equal(journal.entries.length, 0);
});

test('알 수 없는 저장 의도는 일지를 쓰지 않는다', () => {
  const journal = fakeJournal(), saver = savers(journal, fakeLinks());
  const planned = saver.plan(iosRow());
  for (const intent of [{ kind: 'EXCLUDE' }, { kind: 'ADD_TO_EXISTING' }, null]) {
    assert.throws(() => saver.commit(planned, intent), /INVALID_INTENT/);
  }
  assert.equal(journal.entries.length, 0);
});

test('손상된 연결표는 무시하고 저장을 막지 않는다', () => {
  for (const text of ['{broken', '[]', '{"schemaVersion":2,"links":[]}', '{"schemaVersion":1,"links":[{"key":"nope"}]}', 'x'.repeat(70000)]) {
    const journal = fakeJournal(), links = fakeLinks(text);
    assert.equal(savers(journal, links).saveRow(iosRow()).status, 'saved');
    assert.equal(journal.entries.length, 1);
    assert.equal(JSON.parse(links.store.text).links.length, 1);
  }
});

// ── 기존 일지의 메모·스티커 ─────────────────────────────────────────────
const existingEntry = patch => ({ id: 'keep-1', kind: 'post-session', date: '2026-10-28', savedAt: '2026-10-28T12:00:00.000Z', syncState: 'local', system: '유산소', title: '저녁 조깅', distanceKm: '5', durationMin: '30', avgPace: "6'00\"", rpe: 6, memo: '다리에 힘이 좋았다', memoPurpose: 'PRIVATE_SELF_ONLY', ...patch });
const stickers = new Map([['keep-1', ['sticker-star', 'sticker-shoe']]]);

test('새 일지 저장은 기존 일지의 메모·스티커를 건드리지 않는다', () => {
  const journal = fakeJournal([existingEntry()]), links = fakeLinks();
  const result = savers(journal, links).saveRow(iosRow());
  assert.equal(result.status, 'saved');
  assert.equal(result.suspects, 1, '같은 날 비슷한 거리의 기존 일지를 알린다');
  assert.match(result.message, /비슷한 기록/);
  const kept = journal.entries.find(entry => entry.id === 'keep-1');
  assert.equal(kept.memo, '다리에 힘이 좋았다');
  assert.deepEqual([...stickers.get('keep-1')], ['sticker-star', 'sticker-shoe']);
  assert.equal(journal.entries.length, 2);
});

test('기존 일지에 붙이면 id·메모·스티커를 유지하고 가져온 수치만 채운다', () => {
  const journal = fakeJournal([existingEntry({ distanceKm: '', durationMin: '', avgPace: '' })]), links = fakeLinks();
  const saver = savers(journal, links);
  const planned = saver.plan(iosRow());
  assert.equal(planned.status, 'ready');
  const attached = saver.commit(planned, { kind: 'ATTACH', entryId: 'keep-1', expectedSavedAt: '2026-10-28T12:00:00.000Z' });
  assert.deepEqual({ ok: attached.ok, status: attached.status }, { ok: true, status: 'attached' });
  const kept = journal.entries.find(entry => entry.id === 'keep-1');
  assert.equal(journal.entries.length, 1, '새 일지를 만들지 않는다');
  assert.equal(kept.id, 'keep-1');
  assert.equal(kept.memo, '다리에 힘이 좋았다');
  assert.equal(kept.memoPurpose, 'PRIVATE_SELF_ONLY');
  assert.equal(kept.rpe, 6);
  assert.equal(kept.system, '유산소');
  assert.equal(kept.title, '저녁 조깅');
  assert.equal(kept.distanceKm, '5.02');
  assert.equal(kept.durationMin, '9.83');
  assert.equal(kept.avgPace, "1'58\"");
  assert.equal(kept.fieldProvenance.durationMin.derivedFrom[0], 'import:provider-activity');
  assert.ok(Date.parse(kept.savedAt) > Date.parse('2026-10-28T12:00:00.000Z'));
  assert.deepEqual([...stickers.get('keep-1')], ['sticker-star', 'sticker-shoe']);
  assertAppWriteGate(kept);
  assert.deepEqual(journal.writes, [{ type: 'update', id: 'keep-1', expectedSavedAt: '2026-10-28T12:00:00.000Z' }]);
  assert.equal(saver.saveRow(iosRow()).status, 'already-saved');
});

test('붙이기는 대상이 어긋나면 거부하고 아무것도 쓰지 않는다', () => {
  const attempt = (entry, { entryId = 'keep-1', expectedSavedAt = '2026-10-28T12:00:00.000Z' } = {}) => {
    const journal = fakeJournal(entry === null ? [] : [entry]), links = fakeLinks();
    const saver = savers(journal, links);
    const planned = saver.plan(iosRow());
    const result = saver.commit(planned, { kind: 'ATTACH', entryId, expectedSavedAt });
    return { result, journal, links };
  };
  const evening = attempt(existingEntry({ kind: 'evening' }));
  assert.equal(evening.result.status, 'stale-plan'); assert.equal(evening.journal.writes.length, 0); assert.equal(evening.links.store.text, null);
  const fromFile = attempt(existingEntry({ fileObservation: { source: 'FILE_UPLOAD' } }));
  assert.equal(fromFile.result.status, 'attach-refused'); assert.equal(fromFile.journal.writes.length, 0);
  const moved = attempt(existingEntry(), { expectedSavedAt: '2026-10-28T11:00:00.000Z' });
  assert.equal(moved.result.status, 'stale-plan'); assert.equal(moved.journal.writes.length, 0);
  const missing = attempt(null);
  assert.equal(missing.result.status, 'stale-plan'); assert.equal(missing.journal.entries.length, 0); assert.equal(missing.links.store.text, null);
});

test('같은 기록을 붙이기로 저장한 뒤 재선택해도 중복이 생기지 않는다', () => {
  const journal = fakeJournal([existingEntry({ distanceKm: '', durationMin: '', avgPace: '' })]), links = fakeLinks();
  const saver = savers(journal, links);
  const planned = saver.plan(iosRow());
  assert.equal(saver.commit(planned, { kind: 'ATTACH', entryId: 'keep-1', expectedSavedAt: '2026-10-28T12:00:00.000Z' }).status, 'attached');
  assert.equal(saver.saveRow(iosRow()).status, 'already-saved');
  assert.equal(journal.entries.length, 1);
});

// ── 미리보기 UI 연결 ────────────────────────────────────────────────────
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = new Map(); this.open = false; this.attributes = {}; this.disabled = false; this.textContent = ''; }
  setAttribute(k, v) { this.attributes[k] = v; }
  append(...nodes) { for (const node of nodes) { if (typeof node === 'string') { this.textContent += node; continue; } node.remove(); node.parent = this; this.children.push(node); } }
  replaceChildren() { for (const node of this.children) node.parent = null; this.children = []; this.textContent = ''; }
  get isConnected() { return this.tag === 'document' || !!this.parent?.isConnected; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type, event = {}) { for (const fn of this.listeners.get(type) || []) fn({ target: this, ...event }); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
  showModal() { this.open = true; }
  close() { this.open = false; this.emit('close'); }
  closest() { return this; }
}
function dom() {
  const env = new Element('window'), doc = new Element('document'); env.document = doc;
  doc.createElement = tag => Object.assign(new Element(tag), { ownerDocument: doc });
  doc.documentElement = doc.createElement('html'); doc.append(doc.documentElement);
  doc.body = doc.createElement('body'); doc.documentElement.append(doc.body); doc.visibilityState = 'visible';
  env.history = { pushState() { return 0; }, replaceState() { return 0; } };
  env.MutationObserver = class { constructor(fn) { this.fn = fn; } observe() {} disconnect() { this.disconnected = true; } };
  return env;
}
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function previewFixture(options = {}) {
  const requests = [];
  const driver = { open: async () => {}, request: method => new Promise((resolve, reject) => requests.push({ resolve, reject, method })), invalidateContext: async () => {}, invalidateSession: async () => {}, background: async () => {}, dispose: async () => {} };
  const env = dom();
  const preview = installOfflineHealthPreview(env, { driver, platform: 'ios', enabled: true, ...options });
  const root = env.document.body.children[0], dialog = root.children[1];
  return { env, preview, requests, root, dialog, list: dialog.children[7], saveNote: dialog.children[8] };
}

test('저장 단추가 없으면 미리보기는 지금처럼 읽기 전용이다', () => {
  const { dialog, list } = previewFixture();
  assert.equal(dialog.children.length, 8);
  assert.match(dialog.children[1].textContent, /저장하지 않습니다/);
});

test('저장 단추는 두 번 눌러야 한 번 저장하고 결과를 같은 창에 남긴다', async () => {
  const journal = fakeJournal(), links = fakeLinks(), saver = savers(journal, links);
  const calls = [];
  const f = previewFixture({ saveRow: row => { calls.push(row); return saver.saveRow(row); } });
  const cell = () => f.list.children[0].children[0];
  f.preview.open(); const pending = f.preview.read(); await tick();
  f.requests[0].resolve({ source: 'apple-healthkit', workouts: [IOS_ROW] }); await pending;
  assert.equal(f.list.children.length, 1);
  assert.equal(cell().textContent, '일지로 저장');
  cell().emit('click', { isTrusted: false }); await tick();
  assert.equal(calls.length, 0, '신뢰할 수 없는 클릭은 무시한다');
  cell().emit('click', { isTrusted: true });
  assert.equal(cell().textContent, '한 번 더 누르면 저장');
  assert.equal(calls.length, 0);
  cell().emit('click', { isTrusted: true }); await tick();
  assert.equal(calls.length, 1);
  assert.equal(journal.entries.length, 1);
  assert.match(f.saveNote.textContent, /일지 1건을 저장했습니다/);
  // 다시 누르면 중복을 만들지 않고 그 사실을 알린다.
  cell().emit('click', { isTrusted: true });
  cell().emit('click', { isTrusted: true }); await tick();
  assert.equal(journal.entries.length, 1);
  assert.match(f.saveNote.textContent, /이미 이 기록/);
  f.preview.dispose();
});

test('미리보기를 닫으면 확인 대기와 결과 문구가 사라진다', async () => {
  const f = previewFixture({ saveRow: () => 'ok' });
  const cell = () => f.list.children[0].children[0];
  f.preview.open(); const pending = f.preview.read(); await tick();
  f.requests[0].resolve({ source: 'apple-healthkit', workouts: [IOS_ROW] }); await pending;
  cell().emit('click', { isTrusted: true });
  assert.equal(cell().textContent, '한 번 더 누르면 저장');
  f.preview.close();
  assert.equal(f.list.children.length, 0); assert.equal(f.saveNote.textContent, '');
  f.preview.open(); const again = f.preview.read(); await tick();
  f.requests[1].resolve({ source: 'apple-healthkit', workouts: [IOS_ROW] }); await again;
  assert.equal(cell().textContent, '일지로 저장', '다시 열면 확인 대기가 남아 있지 않다');
  f.preview.dispose();
});

test('저장 처리기가 실패해도 미리보기는 살아 있고 실패만 알린다', async () => {
  const f = previewFixture({ saveRow: async () => { throw new Error('RAW'); } });
  const cell = () => f.list.children[0].children[0];
  f.preview.open(); const pending = f.preview.read(); await tick();
  f.requests[0].resolve({ source: 'apple-healthkit', workouts: [IOS_ROW] }); await pending;
  cell().emit('click', { isTrusted: true });
  cell().emit('click', { isTrusted: true }); await tick();
  assert.match(f.saveNote.textContent, /저장하지 못했습니다/);
  assert.ok(!f.saveNote.textContent.includes('RAW'));
  f.preview.dispose();
});

test('저장 처리기 옵션은 함수만 받는다', () => {
  assert.throws(() => installOfflineHealthPreview(dom(), { driver: {}, platform: 'ios', enabled: true, saveRow: 'x' }), /INVALID_SAVE_HANDLER/);
});

test('bootstrap은 부모가 넘긴 저장 처리기만 미리보기로 전달한다', async () => {
  const { installOfflineHealthBootstrap } = await import('../web-adapter/health-bootstrap.js');
  const env = { location: { protocol: 'capacitor:', hostname: 'localhost' }, document: { readyState: 'complete', visibilityState: 'visible', body: {} }, crypto: { randomUUID: () => 'synthetic-id' } };
  env.top = env;
  const seen = [];
  const installPreview = (window, options) => { seen.push(options); return 'installed'; };
  const handler = () => 'ok';
  assert.equal(await installOfflineHealthBootstrap(env, { enabled: true, platform: 'ios', createDriver: () => ({}), installPreview }), 'installed');
  assert.deepEqual(Object.keys(seen[0]).sort(), ['driver', 'enabled', 'platform'], '옵션이 없으면 예전과 같은 옵션만 넘긴다');
  await installOfflineHealthBootstrap(env, { enabled: true, platform: 'ios', saveRow: handler, createDriver: () => ({}), installPreview });
  assert.equal(seen[1].saveRow, handler);
});

// ── 정적 경계 ───────────────────────────────────────────────────────────
test('저장기는 저장소·네트워크·DOM·로그를 직접 만지지 않는다 (부모 포트로만 동작)', async () => {
  const source = await readFile(new URL('../web-adapter/health-journal-import.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:localStorage|sessionStorage|indexedDB|fetch|XMLHttpRequest|sendBeacon|console)\s*[.(]/);
  assert.doesNotMatch(source, /\bdocument\b|innerHTML|outerHTML|insertAdjacentHTML/);
  assert.doesNotMatch(source, /alert\(|confirm\(/);
});

test('초안은 사용자가 쓴 텍스트나 원본 식별자를 담지 않는다', () => {
  const entry = buildHealthJournalEntry(iosRow(), { platform: 'ios', entryId: 'entry-z', savedAt: '2026-11-27T01:00:00.000Z', dateOf });
  assert.ok(!JSON.stringify(entry).includes(IOS_ROW.uuid));
  assert.equal(entry.memo, '');
  assert.equal(entry.bodyPartMetadata, undefined);
});
