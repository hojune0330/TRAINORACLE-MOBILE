import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SOURCE_SHA, RECEIPT_FILE, accountOffEnvironment, assertAccountOff, assertSourceSha, snapshotSource, assertSourceUnchanged, assertOutputDirectory, transformHtml, documentCsp, outputInventory, prepareOutput, verifyOutput, prepareWeb, parseCli, assertNoTrackedExcludedPaths, parseGitStatusPorcelainZ, assertGitStatusClean } from './prepare-web.mjs';

const html = '<!doctype html><html><head><link rel="canonical" href="https://hojune0330.github.io/TRAINORACLE/legal/privacy.html"><meta property="og:url" content="https://hojune0330.github.io/TRAINORACLE/"><script>\nwindow.fixture = true;\n</script><script src="/app.js"></script></head><body><p>개인정보 보존 및 이용약관 원문</p><a href="mailto:hojune0330@gmail.com">hojune0330@gmail.com</a><a href="https://hojune0330.github.io/TRAINORACLE/">기존 주소</a></body></html>';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'trainoracle-mobile-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'source'), wrapperRoot = join(root, 'wrapper'), outputDir = join(wrapperRoot, 'www');
  await mkdir(join(sourceRoot, 'app', 'scripts'), { recursive: true });
  await mkdir(join(sourceRoot, 'impl', 'src'), { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(sourceRoot, 'app', 'package.json'), JSON.stringify({ scripts: { build: 'tsc -b && vite build' } }));
  await writeFile(join(sourceRoot, 'app', 'package-lock.json'), '{}');
  await writeFile(join(sourceRoot, 'app', 'scripts', 'validate-hosted-release-env.mjs'), '// unchanged hosted validator fixture\n');
  await writeFile(join(sourceRoot, 'impl', 'src', 'fixture.ts'), 'export const intact = true;\n');
  await writeFile(join(sourceRoot, 'README.md'), 'whole repository fixture\n');
  await writeFile(join(sourceRoot, '.env.example'), 'DOCUMENTATION_ONLY=\n');
  return { root, sourceRoot, wrapperRoot, outputDir, sourceSha: SOURCE_SHA };
}

function fakeRunner(f, calls, mutate) {
  return async (command, args, options) => {
    calls.push({ command, args, options });
    assert.equal(options.cwd, join(f.sourceRoot, 'app'));
    assertAccountOff(options.env);
    if (command === 'git') return { status: 0, stdout: args.includes('rev-parse') ? SOURCE_SHA + '\n' : '' };
    if (mutate) await mutate(command, args);
    if (command === 'npm' && args[0] === 'run') {
      await writeFile(join(f.outputDir, 'index.html'), html);
      await mkdir(join(f.outputDir, 'legal'));
      await writeFile(join(f.outputDir, 'legal', 'privacy.html'), html);
      await writeFile(join(f.outputDir, 'app.js'), '/* fixture output; not an app build */');
    }
    return { status: 0, stdout: '' };
  };
}

const runtime = { platform: 'linux', node: '24.19.0' };

test('environment is freshly allowlisted and feature/auth gates fail closed', () => {
  const inherited = { PATH: '/toolchain/bin', HOME: '/account', VITE_UNKNOWN: 'true', VITE_ACCOUNT_PUBLIC_ENABLED: 'true', VITE_SUPABASE_URL: 'not-inherited', TOKEN: 'not-inherited', NODE_OPTIONS: '--require=not-inherited', NPM_CONFIG_USERCONFIG: '/account/.npmrc', DOTENV_CONFIG_PATH: '/account/.env', GH_TOKEN: 'not-inherited' };
  const env = accountOffEnvironment(inherited);
  assertAccountOff(env);
  assert.equal(env.PATH, inherited.PATH);
  for (const key of ['HOME', 'VITE_UNKNOWN', 'TOKEN', 'NODE_OPTIONS', 'NPM_CONFIG_USERCONFIG', 'DOTENV_CONFIG_PATH', 'GH_TOKEN']) assert.equal(Object.hasOwn(env, key), false);
  assert.equal(env.VITE_SUPABASE_URL, '');
  assert.equal(env.VITE_SUPABASE_ANON_KEY, '');
  for (const key of Object.keys(env)) {
    if (/^VITE_KILL_/.test(key)) assert.equal(env[key], 'true');
    if (/^VITE_FEATURE_/.test(key)) assert.equal(env[key], 'false');
  }
  for (const provider of ['KAKAO', 'GOOGLE', 'EMAIL', 'PHONE']) assert.equal(env['VITE_' + provider + '_AUTH_ENABLED'], 'false');
  for (const key of ['VITE_UNKNOWN', 'SECRET', 'DOTENV_CONFIG_PATH']) assert.throws(() => assertAccountOff({ ...env, [key]: 'not-allowed' }), /Unreviewed/);
  assert.throws(() => assertAccountOff({ ...env, VITE_KILL_ACCOUNT: 'false' }), /mismatch/);
  const missing = { ...env }; delete missing.VITE_FEATURE_SYNC;
  assert.throws(() => assertAccountOff(missing), /mismatch/);
});

test('SHA and CLI accept only exact full pin and exact flags', () => {
  assertSourceSha(SOURCE_SHA);
  for (const sha of ['main', SOURCE_SHA.slice(0, 7), 'a'.repeat(40), SOURCE_SHA.toUpperCase(), ' ' + SOURCE_SHA]) assert.throws(() => assertSourceSha(sha));
  assert.deepEqual(parseCli(['--source', '/source', '--out', '/wrapper/www', '--source-sha', SOURCE_SHA]), { sourceRoot: '/source', outputDir: '/wrapper/www', sourceSha: SOURCE_SHA });
  for (const args of [[], ['--source', '/source'], ['--help'], ['--source', '/one', '--source', '/two', '--out', '/out', '--source-sha', SOURCE_SHA], ['--source', '/source', '--out', '/out', '--source-sha', SOURCE_SHA, '--test', 'yes']]) assert.throws(() => parseCli(args));
});

test('whole source snapshot is immutable and excludes only root .git and exact app/node_modules', async t => {
  const f = await fixture(t);
  for (const dir of ['.git', 'app/node_modules']) { await mkdir(join(f.sourceRoot, dir)); await writeFile(join(f.sourceRoot, dir, 'excluded'), 'one'); }
  const before = await snapshotSource(f.sourceRoot);
  assert(Object.isFrozen(before)); assert(Object.isFrozen(before.entries)); assert(Object.isFrozen(before.entries['README.md']));
  assert(before.entries['impl/src/fixture.ts']); assert(before.entries['README.md']); assert(before.entries['.env.example']);
  assert.deepEqual(before.excludedPaths, ['.git', 'app/node_modules']);
  for (const dir of ['.git', 'app/node_modules']) await writeFile(join(f.sourceRoot, dir, 'excluded'), 'two');
  assertSourceUnchanged(before, await snapshotSource(f.sourceRoot));
  await writeFile(join(f.sourceRoot, 'README.md'), 'mutation outside app');
  assert.throws(() => assertSourceUnchanged(before, { ...before, treeSha256: 'different' }), /mutation/);
  assert.throws(() => assertSourceUnchanged(before, { ...before, entries: {} }), /mutation/);
  const after = await snapshotSource(f.sourceRoot);
  assert.throws(() => assertSourceUnchanged(before, after), /mutation/);
});

test('source deletions/additions and dotenv files are rejected', async t => {
  const f = await fixture(t), before = await snapshotSource(f.sourceRoot);
  await rm(join(f.sourceRoot, 'impl', 'src', 'fixture.ts'));
  assert.throws(() => assertSourceUnchanged(before, { ...before, treeSha256: 'deleted' }));
  const deleted = await snapshotSource(f.sourceRoot);
  assert.throws(() => assertSourceUnchanged(before, deleted), /mutation/);
  await writeFile(join(f.sourceRoot, 'new.txt'), 'new');
  const added = await snapshotSource(f.sourceRoot);
  assert.throws(() => assertSourceUnchanged(deleted, added), /mutation/);
  for (const file of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    await writeFile(join(f.sourceRoot, 'app', file), 'FIXTURE_ONLY=');
    await assert.rejects(snapshotSource(f.sourceRoot), /dotenv/);
    await rm(join(f.sourceRoot, 'app', file));
  }
});

test('source and output symlinks are rejected', async t => {
  const f = await fixture(t);
  try { await symlink(join(f.sourceRoot, 'impl'), join(f.sourceRoot, 'alias'), 'junction'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Host cannot create symlinks'); return; } throw error; }
  await assert.rejects(snapshotSource(f.sourceRoot), /symlink/i);
  await symlink(join(f.sourceRoot, 'impl'), join(f.outputDir, 'linked-directory'), 'junction');
  await assert.rejects(outputInventory(f.outputDir), /symlink/i);
});

test('output safeguards never delete existing data and enforce wrapper/www outside source', async t => {
  const f = await fixture(t);
  await assertOutputDirectory(f.sourceRoot, f.outputDir, f);
  for (const outputDir of [f.sourceRoot, join(f.sourceRoot, 'dist'), f.root, join(f.wrapperRoot, 'dist')]) await assert.rejects(assertOutputDirectory(f.sourceRoot, outputDir, f), /wrapper-owned/);
  await assert.rejects(assertOutputDirectory(f.root, f.outputDir, f), /outside source/);
  await writeFile(join(f.outputDir, 'sentinel'), 'keep');
  await assert.rejects(assertOutputDirectory(f.sourceRoot, f.outputDir, f), /empty/);
  assert.equal(await readFile(join(f.outputDir, 'sentinel'), 'utf8'), 'keep');
});

test('HTML transforms only contact and canonical/OG origins, retaining legal wording and original link', () => {
  const transformed = transformHtml(html);
  assert(transformed.includes('href="https://trainoracle.io/legal/privacy.html"'));
  assert(transformed.includes('content="https://trainoracle.io/"'));
  assert(transformed.includes('href="mailto:hojune.jang@trainoracle.io"'));
  assert(transformed.includes('<p>개인정보 보존 및 이용약관 원문</p>'));
  assert(transformed.includes('<a href="https://hojune0330.github.io/TRAINORACLE/">기존 주소</a>'));
  assert(!transformed.includes('hojune0330@gmail.com'));
  assert.throws(() => transformHtml('<html><body>fragment</body></html>'), /head/);
});

test('CSP is first in head, strict, unique, and hashes exact existing inline script bytes', () => {
  const inline = '\nwindow.fixture = true;\n';
  const hash = createHash('sha256').update(inline).digest('base64');
  const transformed = transformHtml(html.replace('<head>', '<head><meta http-equiv="Content-Security-Policy" content="default-src *">'));
  assert.equal((transformed.match(/http-equiv="Content-Security-Policy"/g) || []).length, 1);
  assert(transformed.includes('<head>\n<meta http-equiv="Content-Security-Policy"'));
  const csp = documentCsp(transformed);
  for (const directive of ["default-src 'self'", "connect-src 'self' blob:", "img-src 'self' data: blob:", "style-src 'self' 'unsafe-inline'", "font-src 'self' data:", "worker-src 'self' blob:", "media-src 'self' blob: data:", "frame-src 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'none'"]) assert(csp.includes(directive));
  assert(csp.includes("script-src 'self' 'sha256-" + hash + "'"));
  assert(!csp.includes('https:')); assert(!csp.includes('ws:')); assert(!csp.includes('unsafe-eval'));
  assert(!csp.split('; ').find(item => item.startsWith('script-src')).includes('unsafe-inline'));
  assert(transformed.includes('<script>' + inline + '</script>'));
});

test('receipt hashes all output, preserves whole source tree proof and disclaims regression', async t => {
  const f = await fixture(t), tree = await snapshotSource(f.sourceRoot);
  await writeFile(join(f.outputDir, 'index.html'), html);
  await mkdir(join(f.outputDir, 'legal'));
  await writeFile(join(f.outputDir, 'legal', 'terms.html'), html);
  await writeFile(join(f.outputDir, 'app.js'), 'fixture bytes');
  const receipt = await prepareOutput(f.outputDir, { sourceSha: SOURCE_SHA, sourceBefore: tree, sourceAfter: tree });
  assert.equal(receipt.verificationScope, 'mobile-build');
  assert.equal(receipt.sourceRegressionGate, 'separate-not-claimed-as-passed');
  assert.equal(receipt.sourceUnchanged, true); assert.equal(receipt.accountMode, 'off');
  assert.deepEqual(receipt.sourceTree.before.entries, tree.entries);
  assert.equal(Object.keys(receipt.files).length, 3);
  assert(!Object.hasOwn(receipt.files, RECEIPT_FILE));
  const bytes = await readFile(join(f.outputDir, 'app.js'));
  assert.deepEqual(receipt.files['app.js'], { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  assert((await readFile(join(f.outputDir, 'legal', 'terms.html'), 'utf8')).includes('Content-Security-Policy'));
  await verifyOutput(f.outputDir);
  await writeFile(join(f.outputDir, 'app.js'), 'tampered');
  await assert.rejects(verifyOutput(f.outputDir), /hash or inventory/);
});

test('receipt rejects added/removed files, edited scope, source proof, and environment', async t => {
  const f = await fixture(t), tree = await snapshotSource(f.sourceRoot);
  await writeFile(join(f.outputDir, 'index.html'), html);
  const receipt = await prepareOutput(f.outputDir, { sourceSha: SOURCE_SHA, sourceBefore: tree, sourceAfter: tree });
  await writeFile(join(f.outputDir, 'extra.txt'), 'unexpected');
  await assert.rejects(verifyOutput(f.outputDir), /inventory/);
  await rm(join(f.outputDir, 'extra.txt'));
  const index = await readFile(join(f.outputDir, 'index.html'));
  await rm(join(f.outputDir, 'index.html'));
  await assert.rejects(verifyOutput(f.outputDir), /inventory/);
  await writeFile(join(f.outputDir, 'index.html'), index);
  for (const mutate of [r => { r.sourceRegressionGate = 'passed'; }, r => { r.sourceTree.before.entries = {}; }, r => { r.environment.VITE_UNKNOWN = 'true'; }]) {
    const changed = structuredClone(receipt); mutate(changed);
    await writeFile(join(f.outputDir, RECEIPT_FILE), JSON.stringify(changed));
    await assert.rejects(verifyOutput(f.outputDir));
  }
});

test('unsafe output paths and credential-shaped fixture data fail closed', async t => {
  const f = await fixture(t);
  await writeFile(join(f.outputDir, '.env'), 'FIXTURE_ONLY=');
  await assert.rejects(outputInventory(f.outputDir), /Unsafe/);
  await rm(join(f.outputDir, '.env'));
  await writeFile(join(f.outputDir, 'fixture.txt'), '-----BEGIN PRIVATE KEY-----');
  await assert.rejects(outputInventory(f.outputDir), /Potential credential/);
});

test('fixture-only command orchestration uses original install, validator, build and never source tests', async t => {
  const f = await fixture(t), calls = [];
  const receipt = await prepareWeb(f, { wrapperRoot: f.wrapperRoot, runtime, inheritedEnv: { VITE_UNKNOWN: 'no', GH_TOKEN: 'not-inherited' }, runCommand: fakeRunner(f, calls) });
  assert.equal(receipt.sourceUnchanged, true);
  assert.deepEqual(calls.filter(call => call.command === 'npm').map(call => call.args), [['ci'], ['run', 'build', '--', '--base', '/', '--outDir', f.outputDir]]);
  assert.deepEqual(calls.filter(call => call.command !== 'git')[1].args, ['scripts/validate-hosted-release-env.mjs']);
  assert.equal(calls.filter(call => call.args.includes('rev-parse')).length, 4);
  assert.equal(calls.filter(call => call.args.includes('ls-files') && call.args.includes('-z')).length, 4);
  assert.equal(calls.filter(call => call.args.includes('status') && call.args.includes('-z')).length, 4);
  assert(calls.every(call => !call.args.includes('test') && !call.args.includes('typecheck')));
  assertSourceUnchanged(receipt.sourceTree.before, await snapshotSource(f.sourceRoot));
});

test('command mutation is detected immediately even on command failure, without repairing source', async t => {
  const f = await fixture(t), calls = [];
  const baseRunner = fakeRunner(f, calls, async (command, args) => { if (args[0] === 'ci') await writeFile(join(f.sourceRoot, 'README.md'), 'mutated by fixture'); });
  const runner = async (command, args, options) => { const result = await baseRunner(command, args, options); return args[0] === 'ci' ? { status: 1 } : result; };
  await assert.rejects(prepareWeb(f, { wrapperRoot: f.wrapperRoot, runtime, runCommand: runner }), /Source mutation/);
  assert.equal(await readFile(join(f.sourceRoot, 'README.md'), 'utf8'), 'mutated by fixture');
  assert.equal(calls.filter(call => call.command === 'npm').length, 1);
  assert.deepEqual(await readdir(f.outputDir), []);
});

test('wrong runtime/SHA, dirty checkout, and failed validator abort before build', async t => {
  const f = await fixture(t);
  for (const badRuntime of [{ platform: 'win32', node: '24.19.0' }, { platform: 'linux', node: '24.18.0' }]) await assert.rejects(prepareWeb(f, { runtime: badRuntime }), /Linux Node/);
  await assert.rejects(prepareWeb({ ...f, sourceSha: 'a'.repeat(40) }, { runtime }), /pinned/);
  let npmCalls = 0;
  await assert.rejects(prepareWeb(f, { wrapperRoot: f.wrapperRoot, runtime, runCommand: async (command, args) => {
    if (command === 'git') return { status: 0, stdout: args.includes('rev-parse') ? SOURCE_SHA : args.includes('ls-files') ? '' : ' M README.md\0' };
    npmCalls++; return { status: 0 };
  } }), /clean/);
  assert.equal(npmCalls, 0);
  const calls = [];
  await assert.rejects(prepareWeb(f, { wrapperRoot: f.wrapperRoot, runtime, runCommand: async (command, args, options) => {
    calls.push(args);
    if (command === 'git') return { status: 0, stdout: args.includes('rev-parse') ? SOURCE_SHA : '' };
    return { status: args.includes('scripts/validate-hosted-release-env.mjs') ? 1 : 0 };
  } }), /command failed/);
  assert(!calls.some(args => args.includes('build')));
});

for (const path of ['dist/input.txt', 'app/dist/input.txt', 'app/public/dist/input.txt', 'node_modules/input.txt', 'app/public/node_modules/input.txt', 'impl/.git/input.txt']) {
  test('snapshot includes original input and detects deletion: ' + path, async t => {
    const f = await fixture(t), file = join(f.sourceRoot, path);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, 'original nested input');
    const before = await snapshotSource(f.sourceRoot);
    assert(before.entries[path]);
    assert.equal(before.entries[path].sha256, createHash('sha256').update('original nested input').digest('hex'));
    await rm(file);
    const after = await snapshotSource(f.sourceRoot);
    assert.throws(() => assertSourceUnchanged(before, after), /Source mutation/);
  });
}

test('ls-files NUL guard rejects any tracked file under exact excluded roots only', () => {
  assertNoTrackedExcludedPaths('app/public/dist/a\0app/public/node_modules/a\0node_modules/a\0impl/.git/a\0.gitignore\0app/node_modules_extra/a\0');
  for (const path of ['.git', '.git/config', 'app/node_modules', 'app/node_modules/package/index.js', 'app/node_modules/a\nb.js']) assert.throws(() => assertNoTrackedExcludedPaths(path + '\0'), /Tracked source/);
  for (const invalid of ['README.md\n', 'README.md\0\0', '../README.md\0', '/README.md\0']) assert.throws(() => assertNoTrackedExcludedPaths(invalid), /Malformed/);
});

test('porcelain -z parser handles rename/copy, newlines, arrows and quoted-looking paths literally', () => {
  const destination = 'app/public/dist/new\nname -> literal.txt', original = 'app/public/node_modules/old name.txt';
  const copyDestination = 'app/public/copy "name".txt', copyOriginal = 'impl/src/back\\slash.txt';
  const records = parseGitStatusPorcelainZ('R  ' + destination + '\0' + original + '\0C  ' + copyDestination + '\0' + copyOriginal + '\0?? app/node_modules/generated\nfile -> x\0');
  assert.deepEqual(records, [
    { status: 'R ', path: destination, originalPath: original },
    { status: 'C ', path: copyDestination, originalPath: copyOriginal },
    { status: '??', path: 'app/node_modules/generated\nfile -> x' },
  ]);
  assert(Object.isFrozen(records));
  assert.throws(() => assertGitStatusClean('R  app/node_modules/new\0app/node_modules/old\0'), /clean/);
  for (const bad of ['R  new\0', 'C  new\0', ' M file\n', ' M file\0\0', '?? \0', 'xx name\0']) assert.throws(() => parseGitStatusPorcelainZ(bad), /Malformed/);
});

test('Git cleanliness exempts only untracked or ignored exact roots, never tracked changes', () => {
  assertGitStatusClean('?? app/node_modules/generated.txt\0!! app/node_modules/\0!! .git/metadata\0');
  for (const path of ['dist/input.txt', 'app/dist/input.txt', 'app/public/dist/input.txt', 'app/node_modules/a', '.git/config', 'node_modules/input.txt', 'app/public/node_modules/input.txt']) {
    for (const status of [' M', 'D ', ' D', 'M ', ' T', 'UU']) assert.throws(() => assertGitStatusClean(status + ' ' + path + '\0'), /clean/);
  }
  for (const path of ['app/public/dist/a', 'app/dist/a', 'dist/a', 'node_modules/a', 'app/public/node_modules/a', 'impl/.git/a', 'app/node_modules_extra/a', 'app/node_modules\nnot-a-child/a']) {
    for (const status of ['??', '!!']) assert.throws(() => assertGitStatusClean(status + ' ' + path + '\0'), /clean/);
  }
});

test('tracked install roots are rejected before npm even when Git status looks clean', async t => {
  const f = await fixture(t), calls = [];
  await assert.rejects(prepareWeb(f, { wrapperRoot: f.wrapperRoot, runtime, runCommand: async (command, args) => {
    calls.push({ command, args });
    return { status: 0, stdout: args.includes('rev-parse') ? SOURCE_SHA : args.includes('ls-files') ? 'app/node_modules/tracked.js\0' : '' };
  } }), /Tracked source/);
  assert(!calls.some(call => call.command === 'npm'));
});

for (const stage of ['ci', 'build']) {
  test('Git HEAD must remain pinned after ' + stage + ' even if original source bytes are unchanged', async t => {
    const f = await fixture(t), calls = [], before = await snapshotSource(f.sourceRoot);
    let head = SOURCE_SHA;
    const baseRunner = fakeRunner(f, calls);
    await assert.rejects(prepareWeb(f, { wrapperRoot: f.wrapperRoot, runtime, runCommand: async (command, args, options) => {
      if (command === 'git' && args.includes('rev-parse')) { calls.push({ command, args, options }); return { status: 0, stdout: head }; }
      const result = await baseRunner(command, args, options);
      if (command === 'npm' && (stage === 'ci' ? args[0] === 'ci' : args.includes('build'))) head = 'a'.repeat(40);
      return result;
    } }), /HEAD does not match/);
    assertSourceUnchanged(before, await snapshotSource(f.sourceRoot));
    if (stage === 'ci') assert(!calls.some(call => call.args.includes('scripts/validate-hosted-release-env.mjs')));
    await assert.rejects(readFile(join(f.outputDir, RECEIPT_FILE)), /ENOENT/);
  });
}

test('post-command tracked Git changes are rejected without relying only on tree hashes', async t => {
  const f = await fixture(t), calls = [], before = await snapshotSource(f.sourceRoot);
  let installed = false;
  const baseRunner = fakeRunner(f, calls);
  await assert.rejects(prepareWeb(f, { wrapperRoot: f.wrapperRoot, runtime, runCommand: async (command, args, options) => {
    const result = await baseRunner(command, args, options);
    if (command === 'npm' && args[0] === 'ci') installed = true;
    if (command === 'git' && args.includes('status') && installed) return { status: 0, stdout: ' D app/public/dist/tracked.txt\0' };
    return result;
  } }), /clean/);
  assertSourceUnchanged(before, await snapshotSource(f.sourceRoot));
  assert(!calls.some(call => call.args.includes('build')));
});

test('post-command ls-files cannot introduce tracked paths under excluded install output', async t => {
  const f = await fixture(t), calls = [];
  let installed = false;
  const baseRunner = fakeRunner(f, calls);
  await assert.rejects(prepareWeb(f, { wrapperRoot: f.wrapperRoot, runtime, runCommand: async (command, args, options) => {
    const result = await baseRunner(command, args, options);
    if (command === 'npm' && args[0] === 'ci') installed = true;
    if (command === 'git' && args.includes('ls-files') && installed) return { status: 0, stdout: 'app/node_modules/newly-tracked.js\0' };
    return result;
  } }), /Tracked source/);
  assert(!calls.some(call => call.args.includes('build')));
});

test('npm mutation of a nested public/dist input aborts immediately and preserves evidence', async t => {
  const f = await fixture(t), calls = [], file = join(f.sourceRoot, 'app/public/dist/preserved.txt');
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, 'original source file');
  const runner = fakeRunner(f, calls, async (command, args) => { if (args[0] === 'ci') await rm(file); });
  await assert.rejects(prepareWeb(f, { wrapperRoot: f.wrapperRoot, runtime, runCommand: runner }), /Source mutation/);
  await assert.rejects(readFile(file), /ENOENT/);
  assert(!calls.some(call => call.args.includes('build')));
});
