import { Capacitor, registerPlugin } from '@capacitor/core';
export const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
export const NativeDocuments = registerPlugin('NativeDocuments');
const TYPES = new Set(['application/json', 'image/png']);
const badChars = value => [...value].some(c => c.charCodeAt(0) <= 32 || c === '\\');
export function capabilities(env) {
  const has = read => { try { return !!read(); } catch { return false; } };
  return Object.freeze({ secureContext: has(() => env.isSecureContext),
    locksRequest: has(() => typeof env.navigator?.locks?.request === 'function'),
    cryptoSubtle: has(() => env.crypto?.subtle), indexedDB: has(() => env.indexedDB),
    localStorage: has(() => env.localStorage) });
}
export function safeDocumentPath(raw, base) {
  if (typeof raw !== 'string' || !raw || badChars(raw) || /[?#%]/.test(raw) || raw.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  const valid = p => p && p !== '.' && p !== '..' && /^[a-z0-9_-][a-z0-9_.-]*$/i.test(p);
  if (!raw.replace(/^\//, '').split('/').every(valid) || !/\.html$/i.test(raw)) return null;
  try {
    const u = new URL(raw, base), b = new URL(base);
    const p = u.pathname.replace(/^\//, '');
    return u.origin === b.origin && p.split('/').every(valid) ? p : null;
  } catch { return null; }
}
export function safeExternalURL(raw) {
  if (typeof raw !== 'string' || !raw || badChars(raw) || /%0[ad]/i.test(raw)) return null;
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:' && u.hostname && !u.username && !u.password) return u.href;
    if (u.protocol === 'mailto:' && u.pathname) return u.href;
  } catch {}
  return null;
}
export function validFilename(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 255 && name !== '.' && name !== '..' &&
    ![...name].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || c === '/' || c === '\\');
}
export async function blobPayload(blob, filename, encode = globalThis.btoa) {
  if (!validFilename(filename)) throw new Error('INVALID_FILENAME');
  if (!TYPES.has(blob.type) || !Number.isSafeInteger(blob.size) || blob.size < 0 || blob.size > MAX_DOCUMENT_BYTES) throw new Error('INVALID_DOCUMENT');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.byteLength !== blob.size || bytes.byteLength > MAX_DOCUMENT_BYTES) throw new Error('INVALID_DOCUMENT');
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 0x8000) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  return { filename, mimeType: blob.type, dataBase64: encode(chunks.join('')) };
}
export function installAdapter(env, plugin) {
  const blobs = new Map(), originalCreate = env.URL.createObjectURL, originalRevoke = env.URL.revokeObjectURL;
  const anchorProto = env.HTMLAnchorElement.prototype, originalClick = anchorProto.click;
  let busy = false;
  let activationAt = null;
  const now = () => env.performance?.now?.() ?? Date.now();
  const armActivation = event => {
    if (event.isTrusted === true) activationAt = now();
  };
  const onKeyDown = event => {
    if (!event.repeat && !event.ctrlKey && !event.altKey && !event.metaKey && ['Enter', ' ', 'Spacebar'].includes(event.key)) armActivation(event);
  };
  const takeActivation = () => {
    const issued = activationAt;
    activationAt = null; // Every attempted tracked download consumes the permit.
    if (issued === null) return false;
    const age = now() - issued;
    return age >= 0 && age < 5000;
  };
  env.__NATIVE_CAPABILITIES__ = capabilities(env);
  env.URL.createObjectURL = function(blob) {
    const url = originalCreate.call(this, blob);
    if (blob instanceof env.Blob) blobs.set(url, blob);
    return url;
  };
  env.URL.revokeObjectURL = function(url) { blobs.delete(String(url)); return originalRevoke.call(this, url); };
  const consumeDownload = anchor => {
    if (!anchor.hasAttribute('download')) return false;
    const blob = blobs.get(anchor.href);
    if (!blob) return false;
    // Keep a strong reference synchronously, before immediate revoke by the original app.
    const filename = anchor.getAttribute('download');
    const authorized = takeActivation();
    if (!authorized || busy) return true; // Suppress native AND browser fallback.
    busy = true;
    Promise.resolve().then(() => blobPayload(blob, filename, env.btoa.bind(env)))
      .then(payload => plugin.saveDocument(payload)).catch(() => {}).finally(() => { busy = false; });
    return true;
  };
  anchorProto.click = function() { if (!consumeDownload(this)) return originalClick.call(this); };
  const onClick = event => {
    armActivation(event); // Capture phase runs before original button/link handlers.
    const a = event.target?.closest?.('a');
    if (!a) return;
    if (consumeDownload(a)) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    const raw = a.getAttribute('href') || '';
    const local = a.target === '_blank' ? safeDocumentPath(raw, env.location.href) : null;
    if (local) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.isTrusted) Promise.resolve().then(() => plugin.openLocalDocument({ path: local })).catch(() => {});
      return;
    }
    const external = safeExternalURL(raw);
    let outside = false;
    try { outside = new URL(raw, env.location.href).origin !== env.location.origin; } catch {}
    if (outside || a.target === '_blank' || (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !raw.startsWith(env.location.origin + '/'))) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (external && event.isTrusted) Promise.resolve().then(() => plugin.openExternal({ url: external })).catch(() => {});
    }
  };
  env.document.addEventListener('click', onClick, true);
  env.document.addEventListener('keydown', onKeyDown, true);
  return () => { env.URL.createObjectURL = originalCreate; env.URL.revokeObjectURL = originalRevoke;
    anchorProto.click = originalClick; env.document.removeEventListener('click', onClick, true);
    env.document.removeEventListener('keydown', onKeyDown, true); activationAt = null; blobs.clear(); };
}
if (typeof window !== 'undefined') {
  window.__NATIVE_CAPABILITIES__ = capabilities(window);
  if (Capacitor.isNativePlatform()) installAdapter(window, NativeDocuments);
}
