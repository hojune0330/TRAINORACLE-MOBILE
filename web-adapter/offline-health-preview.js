// Account-OFF isolated candidate ONLY. No bootstrap side effects or account integration.
const fail = code => { throw Object.assign(new Error(code), { code }); };
const field = (o, k) => {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return fail('INVALID_DTO');
  const d = Object.getOwnPropertyDescriptor(o, k);
  if (d && !Object.hasOwn(d, 'value')) return fail('INVALID_DTO');
  return d?.value;
};
function date(value) {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) fail('INVALID_DATE');
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  const calendar = new Date(0); calendar.setUTCFullYear(year, month, 0);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > calendar.getUTCDate() || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) fail('INVALID_DATE');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) fail('INVALID_DATE');
  return { ms, iso: new Date(ms).toISOString() };
}
const number = n => { if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) fail('INVALID_NUMBER'); return n; };
const id = n => { if (typeof n !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(n)) fail('INVALID_ID'); return n; };
export function normalizeHealthPreview(payload, platform) {
  if (!['ios', 'android'].includes(platform)) fail('INVALID_PLATFORM');
  const ios = platform === 'ios', source = ios ? 'apple-healthkit' : 'health-connect';
  if (field(payload, ios ? 'source' : 'provider') !== source) fail('INVALID_SOURCE');
  const list = field(payload, ios ? 'workouts' : 'sessions');
  if (!Array.isArray(list) || list.length > 100) fail('INVALID_ROWS');
  const seen = new Map(), rows = [];
  for (const item of list) {
    const start = date(field(item, ios ? 'start' : 'startTime')), end = date(field(item, ios ? 'end' : 'endTime'));
    if (end.ms <= start.ms) fail('INVALID_DATE_ORDER');
    let recordId, sourcePackage = null, durationSeconds, distanceMeters = null;
    if (ios) {
      recordId = field(item, 'uuid');
      if (typeof recordId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(recordId)) fail('INVALID_ID');
      recordId = recordId.toLowerCase(); durationSeconds = number(field(item, 'durationSeconds'));
      const distance = field(item, 'distanceMeters');
      if (distance !== null) distanceMeters = number(distance);
    } else {
      recordId = id(field(item, 'sourceRecordId')); sourcePackage = field(item, 'sourcePackage');
      if (typeof sourcePackage !== 'string' || sourcePackage.length > 255 || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(sourcePackage)) fail('INVALID_SOURCE');
      if (field(item, 'exerciseType') !== 'running') fail('INVALID_EXERCISE');
      const provider = field(item, 'provider'); if (provider !== undefined && provider !== source) fail('INVALID_SOURCE');
      durationSeconds = (end.ms - start.ms) / 1000;
    }
    const row = Object.freeze({ source, sourcePackage, recordId, start: start.iso, end: end.iso, durationSeconds,
      durationKind: ios ? 'reported' : 'elapsed', distanceMeters, distanceStatus: distanceMeters === null ? 'not-provided' : 'provided', reviewStatus: 'UNREVIEWED' });
    const key = ios ? recordId : sourcePackage + ':' + recordId;
    if (seen.has(key)) { if (JSON.stringify(seen.get(key)) !== JSON.stringify(row)) fail('DUPLICATE_ID_CONFLICT'); continue; }
    seen.set(key, row); rows.push(row);
  }
  return Object.freeze(rows);
}
const empty = Object.freeze([]), noop = () => {};
// Cleanup completion has no UI callback. Native cancellation remains best effort.
function cleanup(driver, method, timeoutMs) {
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); });
  let operation;
  try { operation = driver[method](); } catch { clearTimeout(timer); return; }
  Promise.race([Promise.resolve(operation).catch(noop), timeout]).then(() => clearTimeout(timer), () => clearTimeout(timer));
}
export function createOfflineHealthPreviewController({ driver, platform, enabled = false, onChange = noop,
  isForeground = () => true, isContextCurrent = () => true, now = () => Date.now(), timeoutMs = 30000 } = {}) {
  let epoch = 0, visible = false, disposed = false, ready = false, active = null, rows = empty, status = 'idle';
  const snapshot = () => Object.freeze({ enabled: enabled === true, epoch, visible, busy: !!active, status, rows });
  if (enabled !== true) return Object.freeze({ getState: snapshot, open: () => false, authorize: async () => false, read: async () => false,
    close: noop, invalidateContext: noop, invalidateSession: noop, background: noop, dispose: noop });
  if (!['ios', 'android'].includes(platform) || !driver || !['open', 'request', 'invalidateContext', 'invalidateSession', 'background', 'dispose'].every(k => typeof driver[k] === 'function')) fail('INVALID_DRIVER');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) fail('INVALID_TIMEOUT');
  const notify = () => {
    if (visible && !contextCurrent()) return;
    try { onChange(snapshot()); } catch { /* Never propagate raw exceptions to host. */ }
  };
  function invalidate(method = 'invalidateContext') {
    epoch++; visible = false; ready = false; rows = empty; status = 'idle';
    const old = active; active = null;
    if (old) { clearTimeout(old.timer); old.cancel(); }
    notify(); cleanup(driver, method, timeoutMs);
  }
  function contextCurrent() {
    if (disposed) return false;
    try { if (isContextCurrent() === true) return !disposed; } catch { /* Fail closed. */ }
    // Permanently retire a detached installation, including before observer delivery.
    if (!disposed) { disposed = true; invalidate('dispose'); }
    return false;
  }
  const current = op => contextCurrent() && !disposed && visible && epoch === op.epoch && active === op && isForeground();
  async function run(method) {
    if (!contextCurrent() || !visible || active) return false;
    if (!isForeground()) { invalidate('background'); return false; }
    let cancel;
    const cancelled = new Promise(resolve => { cancel = () => resolve(false); });
    const op = { epoch, cancel, timer: null }; active = op; rows = empty; status = 'loading';
    op.timer = setTimeout(() => { if (active === op) { invalidate(); status = 'timeout'; notify(); } }, timeoutMs);
    notify(); // Reentrant close is checked before any native work.
    const work = (async () => {
      try {
        if (!current(op)) return false;
        if (!ready) { await driver.open(); if (!current(op)) return false; ready = true; }
        const end = now(); if (!Number.isFinite(end)) fail('INVALID_DATE');
        const input = method === 'readRunningWorkouts' ? { start: new Date(end - 7 * 86400000).toISOString(), end: new Date(end).toISOString(), limit: 100 } : {};
        if (!current(op)) return false;
        const result = await driver.request(method, input);
        if (!current(op)) return false;
        if (method === 'readRunningWorkouts') { const normalized = normalizeHealthPreview(result, platform); if (!current(op)) return false; rows = normalized; status = 'unreviewed'; }
        else status = 'authorization-returned'; // NOT proof of read permission.
        return true;
      } catch (error) {
        if (current(op)) status = ['USER_CANCELLED', 'CANCELLED', 'ABORT_ERR'].includes(error?.code) ? 'cancelled' : 'error';
        return false;
      } finally {
        clearTimeout(op.timer);
        if (active === op) {
          if (!isForeground()) invalidate('background');
          else { active = null; notify(); }
        }
      }
    })();
    return Promise.race([work, cancelled]);
  }
  return Object.freeze({ getState: () => { contextCurrent(); return snapshot(); },
    open: () => { if (!contextCurrent() || visible || !isForeground()) return false; visible = true; status = 'idle'; notify(); return !disposed && visible; },
    authorize: () => run('requestAuthorization'), read: () => run('readRunningWorkouts'),
    close: () => invalidate(), invalidateContext: () => invalidate(), invalidateSession: () => invalidate('invalidateSession'),
    background: () => invalidate('background'), dispose: () => { if (disposed) return; disposed = true; invalidate('dispose'); } });
}
export function installOfflineHealthPreview(env, { driver, platform, enabled = false } = {}) {
  // Default OFF does not even read env/document or install listeners.
  if (enabled !== true) return createOfflineHealthPreviewController();
  const doc = env.document, body = doc.body, documentRoot = doc.documentElement;
  if (!body || !documentRoot || !body.isConnected) fail('DOCUMENT_UNAVAILABLE');
  const root = doc.createElement('section'), entry = doc.createElement('button'), dialog = doc.createElement('dialog');
  const heading = doc.createElement('h2'), note = doc.createElement('p'), status = doc.createElement('p'), list = doc.createElement('ul');
  const auth = doc.createElement('button'), read = doc.createElement('button'), close = doc.createElement('button');
  root.setAttribute('data-offline-health-preview', ''); entry.type = auth.type = read.type = close.type = 'button';
  entry.textContent = '건강 기록 미리보기'; heading.textContent = '건강 기록 미리보기 · 미검토';
  entry.setAttribute('style', 'position:fixed;right:12px;bottom:calc(76px + env(safe-area-inset-bottom));z-index:2147483000;max-width:calc(100vw - 24px);padding:10px 14px;border:1px solid currentColor;border-radius:999px;background:Canvas;color:CanvasText;font:inherit;font-size:14px;box-shadow:0 2px 12px #0002;');
  dialog.setAttribute('style', 'box-sizing:border-box;width:min(560px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto;border:1px solid currentColor;border-radius:16px;padding:20px;background:Canvas;color:CanvasText;font:inherit;line-height:1.5;');
  list.setAttribute('style', 'padding-left:20px;max-height:50vh;overflow:auto;overflow-wrap:anywhere;');
  note.textContent = '로그인 없는 검증용 미리보기입니다. 조회한 내용은 일지·통계·분석·서버에 저장하지 않습니다. 기기의 권한 동의는 별도이며, 빈 결과만으로 권한 거절이나 기록 없음을 판단하지 않습니다. 권한 화면에서 돌아오면 미리보기를 다시 열어 조회해 주세요.';
  auth.textContent = '권한 요청'; read.textContent = '최근 7일 달리기 읽기'; close.textContent = '닫기';
  dialog.setAttribute('aria-label', '건강 기록 미리보기'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('role', 'dialog');
  if (typeof dialog.showModal !== 'function' || typeof dialog.close !== 'function') fail('MODAL_UNAVAILABLE');
  dialog.hidden = true; status.setAttribute('role', 'status');
  dialog.append(heading, note, auth, read, close, status, list); root.append(entry, dialog);
  const foreground = () => doc.visibilityState === 'visible';
  const messages = { idle: '수동으로 권한을 요청하거나 기록을 읽으세요.', loading: '요청 중 · 미검토', unreviewed: '조회 결과 미검토 · 최대 100건 · 전체 이력 아님',
    'authorization-returned': '권한 화면이 반환되었습니다. 읽기 허용 여부를 확정하지 않습니다.', cancelled: '요청이 취소되었습니다.', error: '미리보기를 표시할 수 없습니다.', timeout: '요청 시간이 초과되었습니다. 다시 열어 주세요.' };
  // Initialize every cleanup dependency before exposing context callbacks. No TDZ on disposal.
  let controller = null, observer = null, disposed = false;
  const removers = [];
  function disposeInstallation() {
    if (disposed) return;
    disposed = true; observer?.disconnect();
    for (const remove of removers.reverse()) remove();
    controller?.dispose(); root.remove();
  }
  function contextCurrent() {
    if (disposed) return false;
    if (env.document === doc && doc.documentElement === documentRoot && doc.body === body &&
        documentRoot.isConnected && body.isConnected && root.isConnected && root.ownerDocument === doc && body.contains(root)) return true;
    disposeInstallation(); return false;
  }
  controller = createOfflineHealthPreviewController({ driver, platform, enabled: true, isForeground: foreground, isContextCurrent: contextCurrent, onChange(state) {
    list.replaceChildren(); status.textContent = state.visible ? (messages[state.status] || '') : ''; auth.disabled = read.disabled = state.busy;
    if (!state.visible) { if (dialog.open && typeof dialog.close === 'function') dialog.close(); dialog.hidden = true; return; }
    if (!contextCurrent()) return;
    dialog.hidden = false;
    if (!dialog.open && typeof dialog.showModal === 'function') { try { dialog.showModal(); } catch { controller?.invalidateContext(); return; } }
    // showModal can synchronously run host focus handlers that replace/remove our DOM.
    if (!contextCurrent()) return;
    for (const row of state.rows) {
      const item = doc.createElement('li'), distance = row.distanceStatus === 'not-provided' ? '거리 미제공' : `거리 ${row.distanceMeters} m`;
      const sourceName = row.source === 'apple-healthkit' ? '애플 건강' : '헬스 커넥트';
      item.textContent = `${new Date(row.start).toLocaleString('ko-KR')} ~ ${new Date(row.end).toLocaleString('ko-KR')} | ${sourceName}${row.sourcePackage ? ' / ' + row.sourcePackage : ''} | ${row.durationSeconds}초 (${row.durationKind === 'elapsed' ? '경과시간' : '제공시간'}) | ${distance} | 미검토`;
      list.append(item);
    }
  } });
  const listen = (target, type, handler, capture = false) => { target.addEventListener(type, handler, capture); removers.push(() => target.removeEventListener(type, handler, capture)); };
  const manual = action => event => { if (event.isTrusted === true) action(); };
  listen(entry, 'click', manual(() => controller.open()));
  listen(auth, 'click', manual(() => { void controller.authorize(); })); listen(read, 'click', manual(() => { void controller.read(); }));
  listen(close, 'click', () => controller.close()); listen(dialog, 'cancel', () => controller.close());
  listen(dialog, 'close', () => { if (controller.getState().visible) controller.close(); });
  body.append(root);
  const invalidate = () => controller.invalidateContext();
  // Observation only; never consume original anchor/document adapter events.
  const originalInteraction = event => {
    if (root.contains(event.target)) return;
    if (event.type === 'keydown' && !['Enter', ' ', 'Escape', 'Tab'].includes(event.key)) return;
    if (event.target?.closest?.('a,button,input,select,textarea,[role="button"],[role="link"],[tabindex],form')) invalidate();
  };
  for (const name of ['pointerdown', 'click', 'keydown', 'submit', 'change']) listen(doc, name, originalInteraction, true);
  for (const name of ['popstate', 'hashchange']) listen(env, name, invalidate, true);
  listen(env, 'pagehide', () => controller.background(), true);
  listen(env, 'blur', event => { if (event.target === env) controller.background(); }, true);
  listen(doc, 'visibilitychange', () => { if (!foreground()) controller.background(); }, true);
  const history = env.history;
  for (const name of ['pushState', 'replaceState']) {
    const original = history[name], wrapped = function(...args) { invalidate(); return Reflect.apply(original, this, args); };
    try { history[name] = wrapped; removers.push(() => { if (history[name] === wrapped) history[name] = original; }); }
    catch { disposeInstallation(); throw new Error('HISTORY_HOOK_UNAVAILABLE'); }
  }
  if (typeof env.MutationObserver !== 'function') { disposeInstallation(); throw new Error('MUTATION_OBSERVER_UNAVAILABLE'); }
  observer = new env.MutationObserver(records => {
    if (!contextCurrent()) return;
    // Also reject remove+reinsert in one turn, even if identity looks current again.
    const retired = records.some(record => Array.from(record.removedNodes || []).some(node =>
      node === root || node === body || node === documentRoot || node.contains?.(root) || node.contains?.(body)));
    if (retired) { disposeInstallation(); return; }
    if (records.some(record => !root.contains(record.target))) invalidate();
  });
  try {
    // Observe above body so replacement is visible; document catches documentElement replacement.
    observer.observe(documentRoot, { subtree: true, childList: true, characterData: true, attributes: true });
    observer.observe(doc, { childList: true });
  } catch { disposeInstallation(); throw new Error('MUTATION_OBSERVER_UNAVAILABLE'); }
  return Object.freeze({ ...controller, dispose: disposeInstallation });
}
