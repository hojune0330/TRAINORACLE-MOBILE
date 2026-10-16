import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { resolve, join, dirname, relative, isAbsolute, parse } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export const SOURCE_SHA = '0b3c12f67617ff610005dbb558388c4b5899bb83';
export const SOURCE_REPOSITORY = 'hojune0330/TRAINORACLE';
export const WRAPPER_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const RECEIPT_FILE = 'trainoracle-mobile-receipt.json';
export const ORIGIN = 'https://trainoracle.io';
const OLD_ORIGIN = 'https://hojune0330.github.io/TRAINORACLE';
const OLD_EMAIL = 'hojune0330@gmail.com';
const NEW_EMAIL = 'hojune.jang@trainoracle.io';
const EXCLUDED_PATHS = Object.freeze(['.git', 'app/node_modules']);
const isExcludedPath = file => EXCLUDED_PATHS.some(root => file === root || file.startsWith(root + '/'));
const FEATURES = ['ACCOUNT_JOURNAL', 'SYNC', 'SHARING', 'PLAN_PROPOSALS', 'PLAN_BACKUP', 'PUBLIC_PROFILE', 'PRODUCT_ANALYTICS', 'FEEDBACK_BOARD', 'FILE_ANALYSIS_TCX', 'FILE_ANALYSIS_CSV', 'FILE_ANALYSIS_JSON', 'FILE_ANALYSIS_GPX', 'MINIGAME_PROGRESS'];
const SYSTEM_KEYS = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const stable = value => JSON.stringify(value);
const contains = (parent, child) => { const rel = relative(parent, child); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'))); };

export function assertSourceSha(sha) {
  if (sha !== SOURCE_SHA) throw new Error('The exact pinned source SHA is required');
  return sha;
}

export function accountOffEnvironment(base = {}) {
  const env = {};
  for (const key of SYSTEM_KEYS) if (typeof base[key] === 'string' && base[key]) env[key] = base[key];
  Object.assign(env, {
    CI: 'true', TZ: 'UTC',
    // Do not load account-level npm configuration (which may contain credentials).
    npm_config_userconfig: process.platform === 'win32' ? 'NUL' : '/dev/null',
    // Distinct paths prevent npm's double-loading guard. A child of the null
    // device cannot contain an account/global config file (ENOTDIR is ignored by npm).
    npm_config_globalconfig: process.platform === 'win32' ? 'NUL/trainoracle-global-npmrc' : '/dev/null/trainoracle-global-npmrc',
    VITE_SERVER_OPERATIONS_ENABLED: 'false', VITE_LOUNGE_PUBLIC_ENABLED: 'false',
    VITE_LOUNGE_REALTIME_URL: '', VITE_LOUNGE_PAGE_URL: '', VITE_FRIEND_ARENA_URL: '',
    VITE_ACCOUNT_PUBLIC_ENABLED: 'false', VITE_KILL_ACCOUNT: 'true',
    VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '',
    VITE_ACCOUNT_STORAGE_PRIVACY_RELEASE_APPROVED: 'false', VITE_ACCOUNT_STORAGE_PRIVACY_MIGRATION: '',
    VITE_EMAIL_AUTH_PKCE_OPERATIONS_APPROVED: 'false', VITE_PHONE_AUTH_OPERATIONS_APPROVED: 'false',
    VITE_PRIVACY_POLICY_URL: ORIGIN + '/legal/privacy.html', VITE_PRIVACY_POLICY_VERSION: '2026-10-05',
    VITE_TERMS_OF_SERVICE_URL: ORIGIN + '/legal/terms.html', VITE_TERMS_OF_SERVICE_VERSION: '2026-10-05',
  });
  for (const provider of ['KAKAO', 'GOOGLE', 'EMAIL', 'PHONE']) {
    env['VITE_' + provider + '_AUTH_ENABLED'] = 'false';
    env['VITE_KILL_' + provider + '_AUTH'] = 'true';
  }
  for (const feature of FEATURES) {
    env['VITE_FEATURE_' + feature] = 'false';
    env['VITE_KILL_' + feature] = 'true';
  }
  return env;
}

export function assertAccountOff(env) {
  const expected = accountOffEnvironment();
  for (const [key, value] of Object.entries(expected)) if (env[key] !== value) throw new Error('OFF environment contract mismatch: ' + key);
  for (const key of Object.keys(env)) if (!SYSTEM_KEYS.includes(key) && !Object.hasOwn(expected, key)) throw new Error('Unreviewed environment variable rejected');
}

async function assertNoSymlinkAncestors(target) {
  let current = resolve(target);
  while (true) {
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error('Symlink path rejected');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export async function assertOutputDirectory(sourceRoot, outputDir, { wrapperRoot = WRAPPER_ROOT, requireEmpty = true } = {}) {
  const source = resolve(sourceRoot), out = resolve(outputDir), wrapper = resolve(wrapperRoot);
  if (out !== join(wrapper, 'www') || contains(source, out) || contains(out, source) || out === parse(out).root) throw new Error('Output must be the wrapper-owned www directory outside source');
  await assertNoSymlinkAncestors(source);
  await assertNoSymlinkAncestors(out);
  if (!(await lstat(source)).isDirectory() || !(await lstat(out)).isDirectory()) throw new Error('Source and output must be existing directories');
  if (await realpath(source) !== source || await realpath(out) !== out) throw new Error('Noncanonical source/output path rejected');
  if (requireEmpty && (await readdir(out)).length) throw new Error('Output must be empty; existing files will not be deleted');
  return { sourceRoot: source, outputDir: out };
}

export async function snapshotSource(sourceRoot) {
  const root = resolve(sourceRoot);
  await assertNoSymlinkAncestors(root);
  const entries = {};
  async function visit(prefix = '') {
    for (const name of (await readdir(join(root, prefix))).sort()) {
      const file = prefix ? prefix + '/' + name : name;
      const stat = await lstat(join(root, file));
      if (stat.isSymbolicLink()) throw new Error('Source symlink rejected');
      // Only repository-root Git metadata and this app's exact install output
      // are excluded. A public/dist or nested node_modules is original input.
      if (file === '.git') continue;
      if (file === 'app/node_modules') {
        if (!stat.isDirectory()) throw new Error('App install output must be a directory');
        continue;
      }
      if (/^\.env(?:$|\.)/i.test(name) && name !== '.env.example') throw new Error('Source dotenv file rejected');
      if (stat.isDirectory()) { entries[file] = Object.freeze({ type: 'directory', mode: stat.mode & 0o777 }); await visit(file); }
      else if (stat.isFile()) entries[file] = Object.freeze({ type: 'file', mode: stat.mode & 0o777, size: stat.size, sha256: digest(await readFile(join(root, file))) });
      else throw new Error('Unsupported source file type');
    }
  }
  await visit();
  Object.freeze(entries);
  return Object.freeze({ algorithm: 'sha256', excludedDirectoryNames: EXCLUDED_PATHS, excludedPaths: EXCLUDED_PATHS, treeSha256: digest(stable(entries)), entries });
}

export function assertSourceUnchanged(before, after) {
  if (before.treeSha256 !== after.treeSha256 || stable(before.entries) !== stable(after.entries)) throw new Error('Source mutation detected; source has not been restored or deleted');
  return true;
}

function attributes(tag) {
  const result = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) result[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4];
  return result;
}

export function documentCsp(html) {
  const hashes = new Set();
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = attributes(match[1]);
    if (!Object.hasOwn(attrs, 'src') && match[2].length) hashes.add("'sha256-" + createHash('sha256').update(match[2]).digest('base64') + "'");
  }
  return ["default-src 'self'", "connect-src 'self' blob:", "img-src 'self' data: blob:", "style-src 'self' 'unsafe-inline'", "font-src 'self' data:", "script-src 'self'" + (hashes.size ? ' ' + [...hashes].sort().join(' ') : ''), "worker-src 'self' blob:", "media-src 'self' blob: data:", "frame-src 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'none'"].join('; ');
}

export function transformHtml(original) {
  if (!/<head\b[^>]*>/i.test(original) || !/<\/head\s*>/i.test(original)) throw new Error('Generated HTML requires an explicit document head');
  let html = original.replaceAll(OLD_EMAIL, NEW_EMAIL);
  // Only canonical/OG metadata changes origin. Body and privacy/terms wording stay unchanged.
  html = html.replace(/<(?:meta|link)\b[^>]*>/gi, tag => {
    const attrs = attributes(tag);
    const canonical = tag.toLowerCase().startsWith('<link') && (attrs.rel || '').toLowerCase().split(/\s+/).includes('canonical');
    const og = tag.toLowerCase().startsWith('<meta') && /^og:/i.test(attrs.property || attrs.name || '');
    return canonical || og ? tag.replaceAll(OLD_ORIGIN, ORIGIN) : tag;
  });
  html = html.replace(/<meta\b[^>]*>/gi, tag => /^content-security-policy$/i.test(attributes(tag)['http-equiv'] || '') ? '' : tag);
  const csp = documentCsp(html);
  // First in head so all subsequent scripts/resources are covered by the policy.
  html = html.replace(/<head\b[^>]*>/i, head => head + '\n<meta http-equiv="Content-Security-Policy" content="' + csp.replaceAll('&', '&amp;').replaceAll('"', '&quot;') + '">');
  return html;
}

const DENIED_CONTENT = [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/, /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{20,}/, /\bAIza[A-Za-z0-9_-]{30,}/, /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}/];

export async function outputInventory(outputDir) {
  const files = {};
  await assertNoSymlinkAncestors(outputDir);
  async function visit(prefix = '') {
    for (const name of (await readdir(join(outputDir, prefix))).sort()) {
      const file = prefix ? prefix + '/' + name : name;
      const stat = await lstat(join(outputDir, file));
      if (stat.isSymbolicLink()) throw new Error('Output symlink rejected');
      if (name.startsWith('.') || name === 'node_modules' || /\.(?:pem|key|p12|pfx|map)$/i.test(name)) throw new Error('Unsafe generated output path');
      if (stat.isDirectory()) await visit(file);
      else if (stat.isFile()) {
        const bytes = await readFile(join(outputDir, file));
        if (DENIED_CONTENT.some(pattern => pattern.test(bytes.toString('utf8')))) throw new Error('Potential credential in output rejected');
        if (file !== RECEIPT_FILE) files[file] = Object.freeze({ size: bytes.length, sha256: digest(bytes) });
      } else throw new Error('Unsupported output file type');
    }
  }
  await visit();
  return Object.freeze(files);
}

export async function prepareOutput(outputDir, { sourceSha, sourceBefore, sourceAfter }) {
  assertSourceSha(sourceSha);
  assertSourceUnchanged(sourceBefore, sourceAfter);
  const files = await outputInventory(outputDir);
  if (!Object.hasOwn(files, 'index.html') || Object.keys(files).length === 0) throw new Error('Build output has no index.html');
  // Validate and calculate all HTML edits before writing anything.
  const changes = {};
  for (const file of Object.keys(files)) if (/\.html$/i.test(file)) changes[file] = transformHtml(await readFile(join(outputDir, file), 'utf8'));
  for (const [file, html] of Object.entries(changes)) await writeFile(join(outputDir, file), html);
  const receipt = {
    schemaVersion: 1, verificationScope: 'mobile-build', sourceRegressionGate: 'separate-not-claimed-as-passed',
    sourceRepository: SOURCE_REPOSITORY, sourceSha, sourceUnchanged: true, accountMode: 'off',
    sourceTree: { before: sourceBefore, after: sourceAfter },
    environment: Object.fromEntries(Object.entries(accountOffEnvironment()).filter(([key]) => key.startsWith('VITE_'))),
    build: { platform: 'linux', node: '24.19.0', commands: [['npm', 'ci'], ['node', 'scripts/validate-hosted-release-env.mjs'], ['npm', 'run', 'build', '--', '--base', '/', '--outDir', resolve(outputDir)]] },
    files: await outputInventory(outputDir),
  };
  await writeFile(join(outputDir, RECEIPT_FILE), JSON.stringify(receipt, null, 2) + '\n');
  return verifyOutput(outputDir, sourceSha);
}

export async function verifyOutput(outputDir, sourceSha = SOURCE_SHA) {
  assertSourceSha(sourceSha);
  const receipt = JSON.parse(await readFile(join(outputDir, RECEIPT_FILE), 'utf8'));
  if (receipt.schemaVersion !== 1 || receipt.verificationScope !== 'mobile-build' || receipt.sourceRegressionGate !== 'separate-not-claimed-as-passed' || receipt.sourceRepository !== SOURCE_REPOSITORY || receipt.sourceSha !== sourceSha || receipt.sourceUnchanged !== true || receipt.accountMode !== 'off') throw new Error('Mobile build receipt contract mismatch');
  assertAccountOff({ ...accountOffEnvironment(), ...receipt.environment });
  if (stable(receipt.environment) !== stable(Object.fromEntries(Object.entries(accountOffEnvironment()).filter(([key]) => key.startsWith('VITE_'))))) throw new Error('Receipt environment mismatch');
  for (const tree of [receipt.sourceTree.before, receipt.sourceTree.after]) if (digest(stable(tree.entries)) !== tree.treeSha256) throw new Error('Source snapshot hash mismatch');
  assertSourceUnchanged(receipt.sourceTree.before, receipt.sourceTree.after);
  const files = await outputInventory(outputDir);
  if (stable(files) !== stable(receipt.files)) throw new Error('Output hash or inventory mismatch');
  for (const file of Object.keys(files)) if (/\.html$/i.test(file)) {
    const html = await readFile(join(outputDir, file), 'utf8');
    const policies = [...html.matchAll(/<meta\b[^>]*>/gi)].map(match => attributes(match[0])).filter(attrs => /^content-security-policy$/i.test(attrs['http-equiv'] || ''));
    if (policies.length !== 1 || policies[0].content !== documentCsp(html)) throw new Error('Generated document CSP mismatch');
  }
  return receipt;
}

function nulRecords(text) {
  if (typeof text !== 'string' || text.includes('\uFFFD') || (text !== '' && !text.endsWith('\0'))) throw new Error('Malformed NUL-delimited Git output');
  return text === '' ? [] : text.slice(0, -1).split('\0');
}

function assertGitPath(file) {
  if (typeof file !== 'string' || !file || file.startsWith('/') || file.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Malformed Git path');
  return file;
}

export function assertNoTrackedExcludedPaths(stdout) {
  for (const file of nulRecords(stdout)) {
    assertGitPath(file);
    if (isExcludedPath(file)) throw new Error('Tracked source exists under an excluded VCS/install root');
  }
}

export function parseGitStatusPorcelainZ(stdout) {
  const fields = nulRecords(stdout), records = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index], status = field.slice(0, 2);
    if (field[2] !== ' ' || !/^(?:\?\?|!!|[ MADRCUT]{2})$/.test(status) || status === '  ') throw new Error('Malformed porcelain Git status');
    const rawPath = field.slice(3);
    const path = ['??', '!!'].includes(status) ? rawPath.replace(/\/$/, '') : rawPath;
    const record = { status, path: assertGitPath(path) };
    // Porcelain v1 -z emits destination first, then a separate original path.
    // Neither filenames containing newlines nor literal " -> " are separators.
    if (/[RC]/.test(status)) record.originalPath = assertGitPath(fields[++index]);
    records.push(Object.freeze(record));
  }
  return Object.freeze(records);
}

export function assertGitStatusClean(stdout) {
  for (const record of parseGitStatusPorcelainZ(stdout)) {
    // Tracked modifications/deletions/renames/copies are NEVER exempt, even
    // under an install/dist-looking path. Only generated untracked/ignored
    // content under the exact two roots is permitted.
    if (!['??', '!!'].includes(record.status) || !isExcludedPath(record.path)) throw new Error('Source checkout must be clean before and after commands');
  }
}

export function runCommand(command, args, options) {
  const result = spawnSync(command, args, { ...options, encoding: 'utf8', stdio: options.capture ? ['ignore', 'pipe', 'ignore'] : 'ignore', maxBuffer: 16 * 1024 * 1024 });
  return { status: result.status, stdout: options.capture ? result.stdout || '' : '' };
}

export async function prepareWeb({ sourceRoot, outputDir, sourceSha }, { runCommand: run = runCommand, runtime = { platform: process.platform, node: process.versions.node }, inheritedEnv = process.env, wrapperRoot = WRAPPER_ROOT } = {}) {
  assertSourceSha(sourceSha);
  if (runtime.platform !== 'linux' || runtime.node !== '24.19.0') throw new Error('Mobile build requires Linux Node 24.19.0');
  const paths = await assertOutputDirectory(sourceRoot, outputDir, { wrapperRoot });
  const source = paths.sourceRoot, out = paths.outputDir, cwd = join(source, 'app');
  const before = await snapshotSource(source);
  for (const name of ['app/package.json', 'app/package-lock.json', 'app/scripts/validate-hosted-release-env.mjs']) if (!before.entries[name] || before.entries[name].type !== 'file') throw new Error('Full source checkout is required');
  if (!before.entries['impl/src'] || before.entries['impl/src'].type !== 'directory') throw new Error('Original app and ../impl/src layout is required');
  const env = accountOffEnvironment(inheritedEnv);
  assertAccountOff(env);
  const checked = async (command, args, options = {}) => {
    let result;
    try { result = await run(command, args, { cwd, env: { ...env }, ...options }); }
    finally { assertSourceUnchanged(before, await snapshotSource(source)); }
    if (!result || result.status !== 0) throw new Error('Preparation command failed (output suppressed)');
    return result.stdout || '';
  };
  const assertGitState = async () => {
    const head = (await checked('git', ['-C', source, 'rev-parse', 'HEAD'], { capture: true })).trim();
    if (head !== sourceSha) throw new Error('Checkout HEAD does not match pinned SHA');
    assertNoTrackedExcludedPaths(await checked('git', ['-C', source, 'ls-files', '-z'], { capture: true }));
    assertGitStatusClean(await checked('git', ['-C', source, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'], { capture: true }));
  };
  const buildStep = async (command, args) => {
    try { return await checked(command, args); }
    finally { await assertGitState(); }
  };
  await assertGitState();
  await buildStep('npm', ['ci']);
  await buildStep(process.execPath, ['scripts/validate-hosted-release-env.mjs']);
  await buildStep('npm', ['run', 'build', '--', '--base', '/', '--outDir', out]);
  const after = await snapshotSource(source);
  assertSourceUnchanged(before, after);
  // Never remove or clean source/public/dist. The caller supplies an empty www.
  return prepareOutput(out, { sourceSha, sourceBefore: before, sourceAfter: after });
}

export function parseCli(argv) {
  const parsed = {};
  const keys = { '--source': 'sourceRoot', '--out': 'outputDir', '--source-sha': 'sourceSha' };
  for (let index = 0; index < argv.length; index += 2) {
    const key = keys[argv[index]], value = argv[index + 1];
    if (!key || Object.hasOwn(parsed, key) || !value || value.startsWith('--')) throw new Error('Usage: --source <sourceRoot> --out <wrapper/www> --source-sha <40sha>');
    parsed[key] = value;
  }
  if (Object.keys(parsed).length !== 3) throw new Error('All three CLI flags are required');
  assertSourceSha(parsed.sourceSha);
  return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  Promise.resolve().then(() => prepareWeb(parseCli(process.argv.slice(2)))).then(receipt => {
    console.log(JSON.stringify({ verificationScope: receipt.verificationScope, sourceRegressionGate: receipt.sourceRegressionGate, sourceSha: receipt.sourceSha, sourceUnchanged: receipt.sourceUnchanged, accountMode: receipt.accountMode, outputFiles: Object.keys(receipt.files).length }));
  }).catch(() => { console.error('Mobile web preparation failed; no source regression pass is claimed.'); process.exitCode = 1; });
}
