// Independent offline-only facade. No Capacitor fallback, storage, account identifiers or record mutation.
export const ANDROID_HEALTH_CHANNEL = 'TrainOracleHealthPreview';
export function createAndroidHealthContext({ window: win = globalThis.window, accountMode = 'off', timeoutMs = 95000, randomId = () => globalThis.crypto.randomUUID() } = {}) {
  if (!win || win !== win.top || win.location.origin !== 'https://localhost' || accountMode !== 'off') throw new Error('OFFLINE_MAIN_FRAME_REQUIRED');
  const channel = win[ANDROID_HEALTH_CHANNEL];
  if (!channel || typeof channel.postMessage !== 'function' || channel.onmessage) throw new Error('HEALTH_CHANNEL_UNAVAILABLE');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('INVALID_TIMEOUT');
  let sessionId = randomId(), contextId = randomId(), binding = null, generation = 0, disposed = false, authorizing = false;
  const waiting = new Map();
  const failAll = reason => { for (const p of waiting.values()) { clearTimeout(p.timer); p.reject(new Error(reason)); } waiting.clear(); };
  const invalidateContext = (reason = 'CONTEXT_INVALIDATED') => {
    generation++; binding = null; contextId = randomId(); authorizing = false;
    failAll(reason);
    if (!disposed) channel.postMessage(JSON.stringify({v:1,method:'invalidate'}));
  };
  const onMessage = event => {
    let m; try { m = JSON.parse(event.data); } catch { return; }
    const p = waiting.get(m.requestId);
    if (!p || p.generation !== generation || m.v !== 1 || m.sessionId !== sessionId || m.contextId !== contextId) return;
    if (p.method !== 'open' && m.epoch !== binding?.epoch) return;
    if (m.ok && p.method === 'open' && (!m.result || typeof m.result.token !== 'string' || !Number.isSafeInteger(m.result.epoch) || m.epoch !== m.result.epoch)) return;
    waiting.delete(m.requestId); clearTimeout(p.timer);
    if (!m.ok) p.reject(new Error(typeof m.error === 'string' ? m.error : 'HEALTH_ERROR'));
    else { if (p.method === 'open') binding = {token:m.result.token,epoch:m.result.epoch}; p.resolve(m.result); }
  };
  channel.onmessage = onMessage;
  const call = (method,args = {}) => {
    if (disposed || accountMode !== 'off') return Promise.reject(new Error('HEALTH_CONTEXT_CLOSED'));
    if (method !== 'open' && !binding) return Promise.reject(new Error('OPEN_REQUIRED'));
    if (waiting.size) return Promise.reject(new Error('BUSY'));
    const requestId = randomId(), g = generation;
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => { if(waiting.get(requestId)?.generation === g) invalidateContext('HEALTH_TIMEOUT'); },timeoutMs);
      waiting.set(requestId,{method,generation:g,resolve,reject,timer});
      try { channel.postMessage(JSON.stringify({v:1,requestId,sessionId,contextId,accountMode,method,args,...(binding || {})})); }
      catch { invalidateContext('HEALTH_CHANNEL_UNAVAILABLE'); }
    });
  };
  const pagehide = () => invalidateContext('BACKGROUND');
  const injectedInvalidation = () => invalidateContext('NAVIGATION');
  const visibility = () => { if (win.document.hidden && !authorizing) pagehide(); };
  win.addEventListener('pagehide',pagehide); win.addEventListener('trainoracle-health-invalidated',injectedInvalidation);
  win.document.addEventListener('visibilitychange',visibility);
  return Object.freeze({
    open: () => { invalidateContext('REOPEN'); return call('open'); },
    availability: () => call('availability'),
    requestAuthorization: async () => { authorizing = true; try { return await call('requestAuthorization'); } finally { authorizing = false; } },
    readRunningWorkouts: args => {
      if (!args || typeof args !== 'object' || Array.isArray(args)) return Promise.reject(new Error('INVALID_RANGE_OR_LIMIT'));
      if (Object.hasOwn(args,'limit') && (typeof args.limit !== 'number' || !Number.isFinite(args.limit) || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)) return Promise.reject(new Error('INVALID_RANGE_OR_LIMIT'));
      return call('readRunningWorkouts',args);
    },
    invalidateContext,
    session: () => { invalidateContext('SESSION_CHANGED'); sessionId = randomId(); },
    background: pagehide,
    dispose: () => { invalidateContext('DISPOSED'); disposed = true; if(channel.onmessage === onMessage) channel.onmessage = null; win.removeEventListener('pagehide',pagehide); win.removeEventListener('trainoracle-health-invalidated',injectedInvalidation); win.document.removeEventListener('visibilitychange',visibility); }
  });
}
