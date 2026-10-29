// UNREVIEWED candidate. Pure transforms only; importing never writes files.
export const HEALTH_SOURCE = 'NativeHealthPlugin.swift';
export const HEALTH_ENTITLEMENTS_PATH = 'App/TrainOracleHealth.entitlements';
export const HEALTH_USAGE = '선택한 최근 달리기의 날짜, 운동 시간, 거리를 읽어 미검토 가져오기 후보로 표시합니다. 기존 기록을 자동 변경하거나 건강 데이터에 쓰지 않습니다.';
const clone = x => structuredClone(x);
function optIn(enabled) {
  if (typeof enabled !== 'boolean') throw new Error('HealthKit enabled must be an explicit boolean');
  return enabled;
}
export function transformHealthBridge(text, { enabled = false } = {}) {
  if (!optIn(enabled)) return text;
  const anchor = 'bridge?.registerPluginInstance(NativeDocumentsPlugin())';
  if (text.split(anchor).length !== 2 || !/override func capacitorDidLoad\(\)/.test(text) || /NativeHealthPlugin/.test(text)) throw new Error('Unexpected/previously configured bridge');
  return text.replace(anchor, anchor + '\n        bridge?.registerPluginInstance(NativeHealthPlugin())');
}
export function createHealthPlan({ enabled = false, info = {}, entitlements = {}, bridgeSource = '', sources = [] } = {}) {
  optIn(enabled);
  const plan = { enabled, info: clone(info), entitlements: clone(entitlements), bridgeSource, sources: [...sources], generatedFiles: [], reviewStatus: 'UNREVIEWED' };
  if (!enabled) return plan;
  if (Object.keys(entitlements).length || Object.keys(info).some(k => /^NSHealth/.test(k))) throw new Error('Existing health/entitlement configuration requires review');
  if (info.MinimumOSVersion && info.MinimumOSVersion !== '16.0') throw new Error('Expected iOS 16.0');
  if (sources.includes(HEALTH_SOURCE)) throw new Error('Health source already present');
  plan.bridgeSource = transformHealthBridge(bridgeSource, { enabled: true });
  plan.info.NSHealthShareUsageDescription = HEALTH_USAGE;
  plan.info.MinimumOSVersion = '16.0';
  plan.entitlements = { 'com.apple.developer.healthkit': true };
  plan.sources.push(HEALTH_SOURCE);
  plan.generatedFiles = [
    { template: 'native-templates/ios/' + HEALTH_SOURCE, destination: 'App/App/' + HEALTH_SOURCE },
    { destination: 'App/' + HEALTH_ENTITLEMENTS_PATH, plist: clone(plan.entitlements) }
  ];
  return plan;
}
const entries = section => Object.entries(section || {}).filter(([k]) => !k.endsWith('_comment'));
const unquote = value => String(value ?? '').replaceAll('"', '');
// AFTER configureXcode(project,...,plan.sources,...): base removes entitlement settings.
export function configureHealthXcode(project, { enabled = false } = {}) {
  if (!optIn(enabled)) return project;
  const o = project?.hash?.project?.objects;
  if (!o) throw new Error('Missing Xcode objects');
  const targets = entries(o.PBXNativeTarget).filter(([, t]) => unquote(t.name) === 'App');
  if (targets.length !== 1) throw new Error('Expected one App target');
  const [id, target] = targets[0];
  if (target.fileSystemSynchronizedGroups?.length) throw new Error('Unsupported synchronized groups');
  const list = o.XCConfigurationList?.[target.buildConfigurationList];
  const configs = (list?.buildConfigurations || []).map(v => o.XCBuildConfiguration?.[v.value]);
  if (configs.length !== 2 || new Set(configs.map(c => unquote(c?.name))).size !== 2 || configs.some(c => !['Debug', 'Release'].includes(unquote(c?.name)) || !c.buildSettings || unquote(c.buildSettings.IPHONEOS_DEPLOYMENT_TARGET) !== '16.0' || c.buildSettings.CODE_SIGN_ENTITLEMENTS)) throw new Error('Unexpected App configurations; run base configureXcode first');
  const sourceFiles = (target.buildPhases || []).flatMap(p => o.PBXSourcesBuildPhase?.[p.value]?.files || []).map(f => o.PBXBuildFile?.[f.value]?.fileRef).map(ref => o.PBXFileReference?.[ref]);
  if (sourceFiles.filter(f => unquote(f?.path) === HEALTH_SOURCE).length !== 1) throw new Error('Health source must be compiled exactly once in App target');
  const projects = entries(o.PBXProject);
  if (projects.length !== 1) throw new Error('Expected one PBXProject');
  const attrs = projects[0][1].attributes?.TargetAttributes?.[id];
  if (!attrs || attrs.SystemCapabilities?.['com.apple.HealthKit']) throw new Error('Missing target attributes or preexisting HealthKit');
  // No mutations before all validations pass; never configure signing credentials.
  for (const cfg of configs) cfg.buildSettings.CODE_SIGN_ENTITLEMENTS = '"' + HEALTH_ENTITLEMENTS_PATH + '"';
  attrs.SystemCapabilities = { ...attrs.SystemCapabilities, 'com.apple.HealthKit': { enabled: 1 } };
  return project;
}
// Fixture-level mirror, not a native test. Never reads user health data.
export function validateHealthQuery(input = {}, now = Date.now()) {
  const parse = x => typeof x === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(x) ? Date.parse(x) : NaN;
  const start = input.start === undefined ? now - 30 * 86400000 : parse(input.start);
  const end = input.end === undefined ? now : parse(input.end);
  const limit = input.limit === undefined ? 50 : input.limit;
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isInteger(limit) || limit < 1 || limit > 100 || start < now - 90 * 86400000 || start >= end || end > now || end - start > 90 * 86400000) throw new Error('INVALID_QUERY');
  return { start, end, limit };
}
