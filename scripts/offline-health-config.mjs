export const OFFLINE_HEALTH_CONTRACT = 'OFFLINE_NATIVE_HEALTH_PREVIEW_V1';
export function parseOfflineHealthBuildArgs(args) {
  if (!Array.isArray(args) || args.some(x => typeof x !== 'string')) throw Error('INVALID_BUILD_ARGS');
  if (args.length !== 2 && args.length !== 3 || args[0] !== '--source' || !args[1] || args[1].startsWith('--') || args.length === 3 && args[2] !== '--offline-health-preview') throw Error('Usage: --source <immutable checkout> [--offline-health-preview]');
  return { source: args[1], offlineHealthPreview: args.length === 3 };
}
export function createOfflineHealthBuildConfig({enabled = false, accountMode, sourceSha} = {}) {
  if (typeof enabled !== 'boolean' || accountMode !== 'off' || typeof sourceSha !== 'string' || !/^[a-f0-9]{40}$/.test(sourceSha)) throw Error('OFFLINE_HEALTH_BUILD_CONFIG_REJECTED');
  return Object.freeze({schemaVersion:1,enabled,accountMode:'off',sourceSha,consumerContract:OFFLINE_HEALTH_CONTRACT});
}
