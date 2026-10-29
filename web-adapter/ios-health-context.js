// UNREVIEWED standalone facade. Parent owns actual offline-only preview/router wiring; never an account authenticator.
export const IOS_HEALTH_CONSUMER_INTEGRATED = false;
export const IOS_HEALTH_STATUS_FIELDS = Object.freeze(['available', 'enabled', 'healthScaffoldIncluded', 'healthInvocationEnabled', 'consumerMode', 'accountMode', 'blockedReason', 'healthDataRead', 'permissionRequested', 'readAuthorization', 'reviewStatus']);
export const IOS_HEALTH_WORKOUT_FIELDS = Object.freeze(['uuid', 'start', 'end', 'durationSeconds', 'distanceMeters']);
export function createIOSHealthContext({ native, consumerIntegrated = IOS_HEALTH_CONSUMER_INTEGRATED, isForeground = () => globalThis.document?.visibilityState === 'visible', randomId = () => globalThis.crypto.randomUUID(), timeoutMs = 30000 } = {}) {
  let epoch = 0, context = null, disposed = false;
  const pending = new Map();
  const error = code => Object.assign(new Error(code), { code });
  function clear(reason) {
    epoch++; context = null;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error(reason)); }
    pending.clear();
  }
  // MUST be awaited BEFORE router/session state changes. Local invalidation is immediate.
  async function invalidate(scope = 'context') {
    clear('STALE_CONTEXT');
    if (!native) return;
    const method = scope === 'session' ? 'invalidateSession' : 'invalidateContext';
    await native[method]();
  }
  // Frame-guarded capability/build status only. No beginContext, read, or permission prompt.
  function availability() {
    if (disposed || !isForeground() || typeof native?.availability !== 'function') return Promise.reject(error('HEALTH_STATUS_UNAVAILABLE'));
    const mine = epoch, requestId = 'status-' + randomId();
    return new Promise((resolve, reject) => {
      if (pending.has(requestId)) { reject(error('DUPLICATE_REQUEST_ID')); return; }
      const timer = setTimeout(() => { pending.delete(requestId); reject(error('HEALTH_TIMEOUT')); }, timeoutMs);
      pending.set(requestId, { reject, timer });
      const current = () => mine === epoch && !disposed && isForeground() && pending.has(requestId);
      Promise.resolve().then(() => {
        if (!current()) throw error('STALE_CONTEXT');
        return native.availability();
      }).then(value => {
        const old = pending.get(requestId);
        if (!old) return;
        const valid = current(); clearTimeout(timer); pending.delete(requestId);
        if (!valid) { reject(error('STALE_CONTEXT')); return; }
        if (!value || value.healthDataRead !== false || value.permissionRequested !== false || typeof value.enabled !== 'boolean' || typeof value.available !== 'boolean' || value.readAuthorization !== 'unknown') { reject(error('INVALID_AVAILABILITY')); return; }
        resolve(Object.freeze(Object.fromEntries(IOS_HEALTH_STATUS_FIELDS.map(key => [key, value[key]]))));
      }, reason => {
        const old = pending.get(requestId);
        if (!old) return;
        const valid = current(); clearTimeout(timer); pending.delete(requestId);
        reject(valid ? reason : error('STALE_CONTEXT'));
      });
    });
  }
  async function open() {
    if (consumerIntegrated !== true || disposed || !isForeground()) throw error('CONTEXT_CONSUMER_NOT_INTEGRATED');
    clear('STALE_CONTEXT');
    const mine = epoch;
    const value = await native.beginContext();
    if (mine !== epoch || disposed || !isForeground()) throw error('STALE_CONTEXT');
    if (!value || typeof value.contextToken !== 'string' || !value.contextToken || !['documentEpoch', 'contextEpoch', 'sessionEpoch'].every(k => Number.isSafeInteger(value[k]) && value[k] >= 0)) throw error('INVALID_NATIVE_CONTEXT');
    context = Object.freeze({ ...value });
    return { ready: true }; // Do not expose native token to account/store code.
  }
  function request(method, input = {}) {
    if (consumerIntegrated !== true || disposed || !context || !isForeground()) return Promise.reject(error('HEALTH_CONTEXT_UNAVAILABLE'));
    if (!['readRunningWorkouts', 'requestAuthorization'].includes(method)) return Promise.reject(error('INVALID_METHOD'));
    const mine = epoch, bound = context, requestId = randomId();
    if (pending.has(requestId)) return Promise.reject(error('DUPLICATE_REQUEST_ID'));
    // Never forward accountID, provenance overrides or caller-supplied binding IDs.
    const query = method === 'readRunningWorkouts' ? Object.fromEntries(['start', 'end', 'limit'].filter(k => Object.hasOwn(input, k)).map(k => [k, input[k]])) : {};
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(error('HEALTH_TIMEOUT')); }, timeoutMs);
      pending.set(requestId, { reject, timer });
      const valid = result => mine === epoch && context === bound && !disposed && isForeground() && pending.has(requestId) && (!result || result.requestId === requestId && ['documentEpoch', 'contextEpoch', 'sessionEpoch'].every(k => result[k] === bound[k]));
      Promise.resolve().then(() => {
        if (!valid()) throw error('STALE_CONTEXT');
        return native[method]({ ...query, ...bound, requestId });
      }).then(result => {
        if (!result || !valid(result)) {
          // Settle only the old local request. Never apply its result to the current consumer.
          const old = pending.get(requestId); if (old) { clearTimeout(old.timer); pending.delete(requestId); old.reject(error('STALE_CONTEXT')); }
          return;
        }
        clearTimeout(timer); pending.delete(requestId); resolve(result);
      }, reason => {
        const old = pending.get(requestId);
        if (!old) return;
        const stillCurrent = valid();
        clearTimeout(old.timer); pending.delete(requestId);
        reject(stillCurrent ? reason : error('STALE_CONTEXT'));
      });
    });
  }
  return Object.freeze({ availability, open, request, invalidate: scope => invalidate(scope), invalidateContext: () => invalidate('context'), invalidateSession: () => invalidate('session'),
    background: () => invalidate('context'), dispose: async () => { disposed = true; await invalidate('session'); } });
}
