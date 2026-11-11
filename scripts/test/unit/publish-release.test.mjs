import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import test from 'node:test';

import { publishRelease } from '../../lib/publish-release.mjs';

const releaseTag = 'ccd-signer/v1.2.3';
const version = '1.2.3';
const tarballName = `ccd-signer-${version}.tgz`;

async function fixture(run) {
  const root = resolve('.test-tmp');
  await mkdir(root, { recursive: true });
  const artifactDirectory = await mkdtemp(join(root, 'publish-release-'));
  try {
    await run(artifactDirectory);
  } finally {
    await rm(artifactDirectory, { recursive: true, force: true });
  }
}

function commandFake({ artifactDirectory, manifest, corruptChecksum = false }) {
  const calls = [];
  const bytes = Buffer.from('unchanged release tarball');
  return {
    calls,
    execute: async (command, args, options = {}) => {
      calls.push({ command, args, options });
      if (command === 'gh') {
        await writeFile(join(artifactDirectory, tarballName), bytes);
        const digest = createHash('sha256')
          .update(corruptChecksum ? Buffer.from('other') : bytes)
          .digest('hex');
        await writeFile(join(artifactDirectory, `${tarballName}.sha256`), `${digest}  ${tarballName}\n`);
        return { stdout: '' };
      }
      if (command === 'tar') return { stdout: JSON.stringify(manifest) };
      if (command === 'npm') return { stdout: '' };
      throw new Error(`Unexpected command: ${command}`);
    },
  };
}

test('downloads, verifies, inspects, and publishes the unchanged public release tarball', async () =>
  fixture(async (artifactDirectory) => {
    const fake = commandFake({
      artifactDirectory,
      manifest: { name: '@ccd-agent-kit/ccd-signer', version },
    });

    await publishRelease({ releaseTag, artifactDirectory, execute: fake.execute });

    const tarball = join(artifactDirectory, tarballName);
    assert.deepEqual(
      fake.calls.map(({ command, args }) => [command, args]),
      [
        [
          'gh',
          [
            'release',
            'download',
            releaseTag,
            '--pattern',
            tarballName,
            '--pattern',
            `${tarballName}.sha256`,
            '--dir',
            artifactDirectory,
          ],
        ],
        ['tar', ['-xOf', tarball, 'package/package.json']],
        ['npm', ['publish', tarball, '--tag', 'latest', '--access', 'public', '--ignore-scripts']],
      ],
    );
    assert.equal(
      fake.calls.some(({ command, args }) => command === 'npm' && args.includes('install')),
      false,
    );
  }));

test('rejects malformed and non-public package release tags before running commands', async () =>
  fixture(async (artifactDirectory) => {
    for (const tag of ['ccd-signer-1.2.3', 'sdk-utils/v1.2.3']) {
      const calls = [];
      await assert.rejects(
        publishRelease({
          releaseTag: tag,
          artifactDirectory,
          execute: async (...call) => calls.push(call),
        }),
        /release tag|public package/i,
      );
      assert.deepEqual(calls, []);
    }
  }));

test('rejects prerelease versions from every channel before downloading assets', async () =>
  fixture(async (artifactDirectory) => {
    for (const tag of ['ccd-signer/v1.2.3-p11-3-alpha.1', 'ccd-signer/v1.2.3-other.1']) {
      const calls = [];
      await assert.rejects(
        publishRelease({
          releaseTag: tag,
          artifactDirectory,
          execute: async (...call) => calls.push(call),
        }),
        /stable|release tag/i,
      );
      assert.deepEqual(calls, []);
    }
  }));

test('does not inspect or publish an asset whose attached checksum does not match', async () =>
  fixture(async (artifactDirectory) => {
    const fake = commandFake({
      artifactDirectory,
      manifest: { name: '@ccd-agent-kit/ccd-signer', version },
      corruptChecksum: true,
    });

    await assert.rejects(publishRelease({ releaseTag, artifactDirectory, execute: fake.execute }), /checksum/i);
    assert.deepEqual(
      fake.calls.map(({ command }) => command),
      ['gh'],
    );
  }));

test('does not publish an archive for a different package identity', async () =>
  fixture(async (artifactDirectory) => {
    const fake = commandFake({
      artifactDirectory,
      manifest: { name: '@ccd-agent-kit/ccd-chain-client', version },
    });

    await assert.rejects(
      publishRelease({ releaseTag, artifactDirectory, execute: fake.execute }),
      /package (?:identity|name)/i,
    );
    assert.deepEqual(
      fake.calls.map(({ command }) => command),
      ['gh', 'tar'],
    );
  }));

test('does not publish an archive whose version differs from its release tag', async () =>
  fixture(async (artifactDirectory) => {
    const fake = commandFake({
      artifactDirectory,
      manifest: { name: '@ccd-agent-kit/ccd-signer', version: '1.2.4' },
    });

    await assert.rejects(publishRelease({ releaseTag, artifactDirectory, execute: fake.execute }), /version/i);
    assert.deepEqual(
      fake.calls.map(({ command }) => command),
      ['gh', 'tar'],
    );
  }));

test('requires canonical checksum syntax naming the selected tarball', async () =>
  fixture(async (artifactDirectory) => {
    const fake = commandFake({
      artifactDirectory,
      manifest: { name: '@ccd-agent-kit/ccd-signer', version },
    });
    const execute = async (command, args, options) => {
      const result = await fake.execute(command, args, options);
      if (command === 'gh') {
        const checksum = join(artifactDirectory, `${tarballName}.sha256`);
        await writeFile(checksum, `${'0'.repeat(64)}  ${basename(tarballName)}.other\n`);
      }
      return result;
    };

    await assert.rejects(publishRelease({ releaseTag, artifactDirectory, execute }), /checksum/i);
    assert.deepEqual(
      fake.calls.map(({ command }) => command),
      ['gh'],
    );
  }));
