import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { isFirstProjectRelease } from '../../lib/release-history.mjs';
import { runRelease } from '../../lib/release-workflow.mjs';

test('uses the stable main channel while leaving version derivation to conventional commits', async () => {
  const calls = [];
  const releaseChannels = JSON.parse(await readFile(resolve('release-channels.json'), 'utf8'));
  assert.deepEqual(releaseChannels, {
    main: {
      preid: null,
      npmTag: 'latest',
    },
  });

  const result = await runRelease({
    dryRun: true,
    firstRelease: true,
    preid: releaseChannels.main.preid,
    version: async (options) => {
      calls.push(options);
      return { projectsVersionData: {}, releaseGraph: {} };
    },
    pack: async () => assert.fail('dry run must not pack'),
    changelog: async () => assert.fail('dry run must not create changelogs'),
    upload: async () => assert.fail('dry run must not upload'),
  });

  assert.deepEqual(calls, [
    {
      dryRun: true,
      firstRelease: true,
      gitCommit: false,
      gitTag: false,
      gitPush: false,
      stageChanges: false,
    },
  ]);
  assert.deepEqual(result.projectsVersionData, {});
});

test('detects first-release state from a fresh repository and project release tags', async () => {
  const root = resolve('.test-tmp');
  await mkdir(root, { recursive: true });
  const repository = await mkdtemp(join(root, 'release-history-'));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: repository });
    assert.equal(isFirstProjectRelease(repository), true);

    await writeFile(join(repository, 'README.md'), '# Fixture\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repository });
    execFileSync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'feat: fixture'],
      { cwd: repository },
    );
    execFileSync('git', ['tag', 'ccd-signer/v0.1.0'], { cwd: repository });
    assert.equal(isFirstProjectRelease(repository), false);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});
