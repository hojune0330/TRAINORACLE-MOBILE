import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SOURCE_SHA } from './prepare-web.mjs';

const release = JSON.parse(await readFile(new URL('../release-config.json', import.meta.url), 'utf8'));
const workflow = await readFile(new URL('../.github/workflows/mobile-candidate.yml', import.meta.url), 'utf8');
const script = workflow.match(/node --input-type=module <<'NODE'\r?\n([\s\S]*?)\r?\n          NODE/)?.[1];

test('checkout and build use the same immutable candidate pin', () => {
  assert.equal(SOURCE_SHA, release.sourceSha);
  assert.match(SOURCE_SHA, /^[a-f0-9]{40}$/);
  assert.match(workflow, /repository: hojune0330\/TRAINORACLE\r?\n\s+ref: \$\{\{ steps\.source\.outputs\.sha \}\}/);
  assert.ok(script, 'the actual workflow resolver is required');
});

test('actual workflow resolver accepts the release and rejects unsafe candidates', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'trainoracle-release-pin-'));
  try {
    for (const delta of [null, { sourceSha: 'main' }, { sourceSha: 'a'.repeat(39) },
      { sourceRepository: 'other/source' }, { accountMode: 'on' },
      { signingConfigured: true }, { storeUploadEnabled: true }]) {
      await writeFile(join(folder, 'release-config.json'), JSON.stringify({ ...release, ...delta }));
      const output = join(folder, 'output.txt');
      await writeFile(output, '');
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: folder, windowsHide: true, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: output },
      });
      if (delta === null) {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(await readFile(output, 'utf8'), 'sha=' + SOURCE_SHA + '\n');
      } else {
        assert.notEqual(result.status, 0);
        assert.equal(await readFile(output, 'utf8'), '');
      }
    }
  } finally {
    if (dirname(folder) === tmpdir() && folder.startsWith(join(tmpdir(), 'trainoracle-release-pin-'))) await rm(folder, { recursive: true });
  }
});
