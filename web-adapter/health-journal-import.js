// 계정 OFF 후보 전용: 건강 기록 1건 → 일지 1건 저장기.
//
// 원칙
//  - 일지 저장소를 이 모듈이 직접 만지지 않는다. 부모(앱 빌드)가 넘긴 포트
//    `journal.entries()/save()/update()`로만 읽고 쓴다. localStorage·색인·네트워크·
//    DOM을 직접 다루지 않는다.
//  - 사용자가 확인한 1건만 저장한다. 저장 전 `plan()`으로 초안과 중복을 만들고,
//    확인 후 `commit()`을 호출한다. 확인 없이 저장하는 경로는 없다.
//  - 같은 건강 기록(HealthKit UUID / Health Connect sourcePackage+sourceRecordId)을
//    다시 고르면 새 일지를 만들지 않는다. 기록→일지 연결표는 부모가 준 `links`
//    포트에만 남기고, 원본 식별자는 해시로만 보관한다.
//  - 기존 일지의 메모·스티커를 덮어쓰지 않는다: 새 일지는 항상 새 id로 만들고,
//    기존 일지에 붙이는 경우(ATTACH)에도 id를 유지한 채 가져온 수치 필드만 채운다.
//  - 가져온 값은 `import:provider-activity` 파생 출처로 표시한다. 앱의 분석 자격
//    규칙에 등록되지 않은 토큰이므로 통계·추이에서는 제외된다.
const fail = code => { throw Object.assign(new Error(code), { code }); };
const field = (o, k) => {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return fail('INVALID_ROW');
  const d = Object.getOwnPropertyDescriptor(o, k);
  if (d && !Object.hasOwn(d, 'value')) return fail('INVALID_ROW');
  return d?.value;
};
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const RECORD_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** 앱의 파생 출처 토큰. 파일 가져오기(`import:activity-file`)와 구분한다. */
export const HEALTH_PROVIDER_DERIVED_FROM = 'import:provider-activity';
export const HEALTH_PROVIDER_DERIVATION_RULE_ID = 'HEALTH_PROVIDER_ACTIVITY_V1';
export const HEALTH_JOURNAL_LINK_SCHEMA_VERSION = 1;
export const HEALTH_JOURNAL_LINK_LIMIT = 500;
/** 앱의 numeric-input 상한과 같은 값. 넘는 값은 페이스로 만들지 않는다. */
export const MAX_PACE_SECONDS_PER_KM = 1800;
export const MAX_DISTANCE_METERS = 1000 * 1000;
export const MAX_DURATION_SECONDS = 3000 * 60;

const derived = () => Object.freeze({ provenance: 'DERIVED', derivedFrom: Object.freeze([HEALTH_PROVIDER_DERIVED_FROM]), derivationRuleId: HEALTH_PROVIDER_DERIVATION_RULE_ID });
const missing = () => Object.freeze({ provenance: 'MISSING' });

function isoDate(value) {
  if (typeof value !== 'string' || value.length > 40 || !DATE.test(value)) fail('INVALID_DATE');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) fail('INVALID_DATE');
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  const calendar = new Date(0); calendar.setUTCFullYear(year, month, 0);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > calendar.getUTCDate()
    || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) fail('INVALID_DATE');
  return ms;
}

function readRow(row, platform) {
  if (platform !== 'ios' && platform !== 'android') fail('INVALID_PLATFORM');
  const source = platform === 'ios' ? 'apple-healthkit' : 'health-connect';
  if (field(row, 'source') !== source) fail('INVALID_SOURCE');
  const startMs = isoDate(field(row, 'start')), endMs = isoDate(field(row, 'end'));
  if (endMs <= startMs) fail('INVALID_DATE_ORDER');
  const durationSeconds = field(row, 'durationSeconds');
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > MAX_DURATION_SECONDS) fail('INVALID_DURATION');
  const distanceMeters = field(row, 'distanceMeters');
  if (distanceMeters !== null && (typeof distanceMeters !== 'number' || !Number.isFinite(distanceMeters) || distanceMeters < 0 || distanceMeters > MAX_DISTANCE_METERS)) fail('INVALID_DISTANCE');
  const distanceStatus = field(row, 'distanceStatus');
  if (distanceStatus !== (distanceMeters === null ? 'not-provided' : 'provided')) fail('INVALID_DISTANCE');
  const durationKind = field(row, 'durationKind');
  if (durationKind !== (platform === 'ios' ? 'reported' : 'elapsed')) fail('INVALID_DURATION');
  const recordId = field(row, 'recordId');
  let sourcePackage = null;
  if (platform === 'ios') {
    if (typeof recordId !== 'string' || !UUID.test(recordId)) fail('INVALID_ID');
  } else {
    if (typeof recordId !== 'string' || !RECORD_ID.test(recordId)) fail('INVALID_ID');
    sourcePackage = field(row, 'sourcePackage');
    if (typeof sourcePackage !== 'string' || sourcePackage.length > 255 || !PACKAGE.test(sourcePackage)) fail('INVALID_SOURCE');
  }
  const identity = platform === 'ios'
    ? 'apple-healthkit:' + recordId.toLowerCase()
    : 'health-connect:' + sourcePackage + ':' + recordId;
  return { identity, source, recordId, sourcePackage, startMs, endMs, durationSeconds, distanceMeters, durationKind };
}

/** 같은 기록인지 판단하는 키. 원본 식별자는 저장하지 않고 64비트 해시만 쓴다. */
export function healthRecordFingerprint(identity) {
  if (typeof identity !== 'string' || identity.length < 8 || identity.length > 600) fail('INVALID_IDENTITY');
  let a = 0x811c9dc5, b = 0x5bd1e995;
  for (let index = 0; index < identity.length; index++) {
    const code = identity.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x85ebca6b) >>> 0;
    b = (b ^ (b >>> 13)) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** "5.02"처럼 최대 소수 3자리. 0 m는 "0"으로 남긴다(값을 만들지 않는다). */
export function formatDistanceKm(meters) {
  if (typeof meters !== 'number' || !Number.isFinite(meters) || meters < 0) fail('INVALID_DISTANCE');
  if (meters === 0) return '0';
  return String(Number((meters / 1000).toFixed(3)));
}

/** 분 단위 소수 최대 2자리. */
export function formatDurationMin(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) fail('INVALID_DURATION');
  return String(Number((seconds / 60).toFixed(2)));
}

/** 앱 표기 `6'18"`. 거리가 없거나 상한을 넘으면 빈 문자열(값을 꾸며내지 않는다). */
export function formatPaceText(seconds, meters) {
  if (typeof meters !== 'number' || !Number.isFinite(meters) || meters <= 0) return '';
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '';
  const secondsPerKm = Math.round(seconds / (meters / 1000));
  if (!Number.isSafeInteger(secondsPerKm) || secondsPerKm <= 0 || secondsPerKm > MAX_PACE_SECONDS_PER_KM) return '';
  return `${Math.floor(secondsPerKm / 60)}'${String(secondsPerKm % 60).padStart(2, '0')}"`;
}

function deviceDate(ms) {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) fail('INVALID_DATE');
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * 확인 화면이 보여줄 초안. 저장은 `commit()`에서만 일어난다.
 * 값은 전부 건강 기록에서 파생되며 사용자가 쓴 텍스트를 섞지 않는다.
 */
export function buildHealthJournalEntry(row, { platform, entryId, savedAt, dateOf = deviceDate } = {}) {
  const record = readRow(row, platform);
  if (typeof entryId !== 'string' || entryId.length < 1 || entryId.length > 120) fail('INVALID_ENTRY_ID');
  if (typeof savedAt !== 'string' || !Number.isFinite(Date.parse(savedAt))) fail('INVALID_SAVED_AT');
  const date = dateOf(record.startMs);
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('INVALID_DATE');
  const distanceKm = record.distanceMeters === null ? '' : formatDistanceKm(record.distanceMeters);
  const durationMin = formatDurationMin(record.durationSeconds);
  const avgPace = record.distanceMeters === null ? '' : formatPaceText(record.durationSeconds, record.distanceMeters);
  return {
    id: entryId,
    kind: 'post-session',
    date,
    savedAt,
    syncState: 'local',
    activityOutcome: 'COMPLETED',
    objectiveDataState: 'CONFIRMED',
    system: '',
    title: '달리기',
    distanceKm,
    durationMin,
    avgPace,
    rpe: 0,
    memo: '',
    fieldProvenance: {
      activityOutcome: derived(),
      system: missing(),
      distanceKm: record.distanceMeters === null ? missing() : derived(),
      durationMin: derived(),
      avgPace: avgPace === '' ? missing() : derived(),
      rpe: missing(),
    },
  };
}

const numeric = value => {
  if (typeof value !== 'string') return null;
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** 같은 활동으로 볼 만한 기존 일지 — 알림용 힌트일 뿐 병합 권한이 아니다. */
function looksLikeSameRun(existing, draft) {
  const leftDistance = numeric(existing.distanceKm), rightDistance = numeric(draft.distanceKm);
  if (leftDistance !== null && rightDistance !== null) return Math.abs(leftDistance - rightDistance) <= 0.2;
  const leftDuration = numeric(existing.durationMin), rightDuration = numeric(draft.durationMin);
  if (leftDuration !== null && rightDuration !== null) return Math.abs(leftDuration - rightDuration) <= 2;
  return false;
}

function parseLinks(raw) {
  if (raw === null || raw === undefined) return [];
  if (typeof raw !== 'string' || raw.length > 65536) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  if (parsed.schemaVersion !== HEALTH_JOURNAL_LINK_SCHEMA_VERSION || !Array.isArray(parsed.links)) return [];
  const links = [];
  for (const item of parsed.links) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const { key, entryId, date, savedAt, source } = item;
    if (typeof key !== 'string' || !/^[a-f0-9]{16}$/.test(key)) continue;
    if (typeof entryId !== 'string' || entryId.length < 1 || entryId.length > 120) continue;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (typeof savedAt !== 'string' || !Number.isFinite(Date.parse(savedAt))) continue;
    if (source !== 'apple-healthkit' && source !== 'health-connect') continue;
    if (links.some(link => link.key === key)) continue;
    links.push({ key, entryId, date, savedAt, source });
  }
  return links;
}

function defaultEntryId() {
  try { return globalThis.crypto.randomUUID(); }
  catch { return 'h_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
}

const SAVED_MESSAGE = '일지 1건을 저장했습니다. 일지에서 메모와 스티커를 더할 수 있어요.';
const SUSPECT_MESSAGE = '일지 1건을 저장했습니다. 같은 날 비슷한 기록이 있어 중복인지 확인해 주세요.';
const ALREADY_MESSAGE = '이미 이 기록으로 저장한 일지가 있어 새로 만들지 않았습니다.';
const ATTACHED_MESSAGE = '기존 일지에 거리·시간 값을 채웠습니다. 메모와 스티커는 그대로입니다.';
const FAILED_MESSAGE = '일지를 저장하지 못했습니다. 기기 저장 공간을 확인해 주세요.';
const LINK_LOST_MESSAGE = '일지 1건을 저장했습니다. 다만 같은 기록을 다시 고르면 중복이 생길 수 있어요.';

export function createHealthJournalSaver({ journal, links = null, platform, now = () => Date.now(),
  newEntryId = defaultEntryId, dateOf = deviceDate, maxLinks = HEALTH_JOURNAL_LINK_LIMIT } = {}) {
  if (!journal || typeof journal !== 'object' || ['entries', 'save', 'update'].some(name => typeof journal[name] !== 'function')) fail('INVALID_JOURNAL_PORT');
  if (links !== null && (typeof links !== 'object' || typeof links.get !== 'function' || typeof links.set !== 'function')) fail('INVALID_LINK_PORT');
  if (!['ios', 'android'].includes(platform)) fail('INVALID_PLATFORM');
  if (!Number.isSafeInteger(maxLinks) || maxLinks < 1 || maxLinks > 5000) fail('INVALID_LINK_LIMIT');

  const memory = new Map();
  const plans = new WeakSet();
  const linkList = () => {
    if (links === null) return [...memory.values()];
    let raw;
    try { raw = links.get(); } catch { fail('LINK_STORAGE_UNAVAILABLE'); }
    if (raw !== null && typeof raw !== 'string') fail('LINK_STORAGE_UNAVAILABLE');
    return parseLinks(raw);
  };
  const saveLinks = list => {
    const trimmed = list.slice(-maxLinks);
    if (links === null) {
      memory.clear();
      for (const link of trimmed) memory.set(link.key, link);
      return true;
    }
    try { return links.set(JSON.stringify({ schemaVersion: HEALTH_JOURNAL_LINK_SCHEMA_VERSION, links: trimmed })) === true; }
    catch { return false; }
  };
  const readEntries = () => {
    let entries;
    try { entries = journal.entries(); } catch { fail('JOURNAL_UNAVAILABLE'); }
    if (!Array.isArray(entries)) fail('JOURNAL_UNAVAILABLE');
    return entries.filter(entry => entry && typeof entry === 'object' && typeof entry.id === 'string');
  };
  const freshId = entries => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = newEntryId();
      if (typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 120 && !entries.some(entry => entry.id === candidate)) return candidate;
    }
    fail('ENTRY_ID_UNAVAILABLE');
  };
  const nextStamp = previous => {
    const at = now();
    if (!Number.isFinite(at)) fail('INVALID_SAVED_AT');
    const before = typeof previous === 'string' ? Date.parse(previous) : NaN;
    const ms = Number.isFinite(before) && before >= at ? before + 1 : at;
    return new Date(ms).toISOString();
  };
  const messageFor = result => result.ok === false ? FAILED_MESSAGE
    : result.status === 'already-saved' ? ALREADY_MESSAGE
      : result.status === 'attached' ? ATTACHED_MESSAGE
        : result.suspects > 0 ? SUSPECT_MESSAGE : SAVED_MESSAGE;

  function plan(row) {
    const record = readRow(row, platform);
    const key = healthRecordFingerprint(record.identity);
    const entries = readEntries();
    const list = linkList();
    const linked = list.find(link => link.key === key);
    if (linked) {
      const entry = entries.find(candidate => candidate.id === linked.entryId);
      if (entry) {
        const prepared = Object.freeze({ status: 'already-saved', key, entryId: linked.entryId, date: entry.date, suspects: Object.freeze([]), message: ALREADY_MESSAGE });
        plans.add(prepared);
        return prepared;
      }
      saveLinks(list.filter(link => link.key !== key)); // 사라진 일지의 연결표만 정리한다.
    }
    const entryId = freshId(entries);
    const draft = buildHealthJournalEntry(row, { platform, entryId, savedAt: nextStamp(), dateOf });
    const suspects = Object.freeze(entries
      .filter(entry => entry.kind === 'post-session' && entry.date === draft.date && looksLikeSameRun(entry, draft))
      .slice(0, 5)
      .map(entry => Object.freeze({ entryId: entry.id, title: typeof entry.title === 'string' ? entry.title.slice(0, 60) : '', savedAt: typeof entry.savedAt === 'string' ? entry.savedAt : '' })));
    const prepared = Object.freeze({ status: 'ready', key, entryId, date: draft.date, draft: Object.freeze({ ...draft, fieldProvenance: Object.freeze(draft.fieldProvenance) }), suspects, message: suspects.length ? SUSPECT_MESSAGE : SAVED_MESSAGE });
    plans.add(prepared);
    return prepared;
  }

  function recordLink(entries, prepared) {
    let list;
    try { list = linkList(); } catch { return false; }
    list = list.filter(link => link.key !== prepared.key && entries.some(entry => entry.id === link.entryId));
    list.push({ key: prepared.key, entryId: prepared.entryId, date: prepared.date, savedAt: entries.find(entry => entry.id === prepared.entryId)?.savedAt ?? new Date(now()).toISOString(), source: platform === 'ios' ? 'apple-healthkit' : 'health-connect' });
    // 연결표를 쓰지 못하면 다음에 같은 기록으로 새 일지가 생길 수 있음을 결과로 알린다.
    return saveLinks(list);
  }

  function commit(prepared, intent = { kind: 'SAVE_NEW' }) {
    if (!prepared || typeof prepared !== 'object' || !plans.has(prepared)) fail('UNKNOWN_PLAN');
    if (!intent || typeof intent !== 'object' || (intent.kind !== 'SAVE_NEW' && intent.kind !== 'ATTACH')) fail('INVALID_INTENT');
    if (prepared.status === 'already-saved') return { ok: true, status: 'already-saved', entryId: prepared.entryId, suspects: 0, linkRecorded: true, message: ALREADY_MESSAGE };
    let entries;
    try { entries = readEntries(); } catch { return { ok: false, status: 'save-rejected', suspects: 0, linkRecorded: false, message: FAILED_MESSAGE }; }
    let existingLinks;
    try { existingLinks = linkList(); } catch { return { ok: false, status: 'save-rejected', suspects: 0, linkRecorded: false, message: FAILED_MESSAGE }; }
    // 확인을 받은 뒤 일지 목록이 바뀌었으면 다시 계획한다(중복·동시 저장 회피).
    if (entries.some(entry => entry.id === prepared.draft.id) || existingLinks.some(link => link.key === prepared.key)) {
      return { ok: false, status: 'stale-plan', suspects: 0, linkRecorded: false, message: FAILED_MESSAGE };
    }
    let result;
    if (intent.kind === 'ATTACH') {
      const existing = entries.find(entry => entry.id === intent.entryId);
      if (!existing || existing.kind !== 'post-session' || existing.savedAt !== intent.expectedSavedAt) return { ok: false, status: 'stale-plan', suspects: 0, linkRecorded: false, message: FAILED_MESSAGE };
      // 다른 날짜의 일지에 남의 기록 수치를 붙이지 않는다.
      if (existing.date !== prepared.date) return { ok: false, status: 'attach-refused', suspects: 0, linkRecorded: false, message: FAILED_MESSAGE };
      if (existing.fileObservation !== undefined) return { ok: false, status: 'attach-refused', suspects: 0, linkRecorded: false, message: FAILED_MESSAGE };
      const draft = prepared.draft;
      const merged = {
        ...existing,
        distanceKm: draft.distanceKm === '' ? existing.distanceKm : draft.distanceKm,
        durationMin: draft.durationMin,
        avgPace: draft.avgPace === '' ? existing.avgPace : draft.avgPace,
        savedAt: nextStamp(existing.savedAt),
        fieldProvenance: {
          ...(existing.fieldProvenance ?? {}),
          distanceKm: draft.fieldProvenance.distanceKm,
          durationMin: draft.fieldProvenance.durationMin,
          avgPace: draft.fieldProvenance.avgPace,
        },
      };
      try { result = journal.update(merged, intent.expectedSavedAt); } catch { result = null; }
      if (!result || result.ok !== true) return { ok: false, status: 'save-rejected', suspects: 0, linkRecorded: false, message: FAILED_MESSAGE };
      const recorded = recordLink(entries.map(entry => entry.id === existing.id ? merged : entry), { ...prepared, entryId: existing.id, date: existing.date });
      return { ok: true, status: 'attached', entryId: existing.id, suspects: 0, linkRecorded: recorded, message: recorded ? ATTACHED_MESSAGE : LINK_LOST_MESSAGE };
    }
    try { result = journal.save(prepared.draft); } catch { result = null; }
    if (!result || result.ok !== true) return { ok: false, status: 'save-rejected', suspects: 0, linkRecorded: false, message: FAILED_MESSAGE };
    const recorded = recordLink([...entries, prepared.draft], prepared);
    return { ok: true, status: 'saved', entryId: prepared.draft.id, suspects: prepared.suspects.length, linkRecorded: recorded,
      message: recorded ? messageFor({ ok: true, status: 'saved', suspects: prepared.suspects.length }) : LINK_LOST_MESSAGE };
  }

  /** 미리보기 버튼이 곧바로 부르는 경로. 예외를 던지지 않고 결과 문구를 돌려준다. */
  function saveRow(row) {
    let prepared;
    try { prepared = plan(row); } catch { return { ok: false, status: 'invalid-record', suspects: 0, linkRecorded: false, message: FAILED_MESSAGE }; }
    try { return commit(prepared); } catch { return { ok: false, status: 'save-rejected', suspects: 0, linkRecorded: false, message: FAILED_MESSAGE }; }
  }

  return Object.freeze({ plan, commit, saveRow });
}
