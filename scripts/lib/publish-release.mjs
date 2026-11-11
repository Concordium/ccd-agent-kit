import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { publicPackages } from './public-packages.mjs';

const NPM_TAG = 'latest';
const VERSION_PATTERN = '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)';
const publicPackageByProject = new Map(publicPackages.map((pkg) => [pkg.projectName, pkg.packageName]));

/**
 * Download, verify, inspect, and publish one unchanged stable public GitHub Release tarball
 * to npm's `latest` distribution tag.
 * The injected executor receives an executable name, argument array, and optional exec options.
 * It must return an object whose `stdout` is available for commands that produce inspected data.
 */
export async function publishRelease({ releaseTag, artifactDirectory, execute }) {
  const tag = parseReleaseTag(releaseTag);
  const expectedPackageName = publicPackageByProject.get(tag.projectName);
  if (expectedPackageName === undefined) throw new Error('Release tag does not identify a public package.');

  const tarballName = `${tag.projectName}-${tag.version}.tgz`;
  const tarball = join(artifactDirectory, tarballName);
  const checksum = `${tarball}.sha256`;
  await execute('gh', [
    'release',
    'download',
    releaseTag,
    '--pattern',
    tarballName,
    '--pattern',
    `${tarballName}.sha256`,
    '--dir',
    artifactDirectory,
  ]);

  const [tarballBytes, checksumText] = await Promise.all([readFile(tarball), readFile(checksum, 'utf8')]);
  const expectedChecksum = createHash('sha256').update(tarballBytes).digest('hex');
  if (checksumText !== `${expectedChecksum}  ${tarballName}\n`) {
    throw new Error('Release asset checksum is invalid.');
  }

  const inspected = await execute('tar', ['-xOf', tarball, 'package/package.json']);
  const manifest = parseManifest(inspected?.stdout);
  if (manifest.name !== expectedPackageName)
    throw new Error('Release archive package identity does not match its tag.');
  if (manifest.version !== tag.version) throw new Error('Release archive version does not match its tag.');

  await execute('npm', ['publish', tarball, '--tag', NPM_TAG, '--access', 'public', '--ignore-scripts']);
}

function parseReleaseTag(releaseTag) {
  if (typeof releaseTag !== 'string') throw new Error('Invalid release tag.');
  const match = new RegExp(`^([a-z0-9-]+)/v(${VERSION_PATTERN})$`).exec(releaseTag);
  if (match === null) throw new Error('Release tag must identify a stable release.');
  return { projectName: match[1], version: match[2] };
}

function parseManifest(stdout) {
  if (typeof stdout !== 'string') throw new Error('Unable to inspect release archive package manifest.');
  let manifest;
  try {
    manifest = JSON.parse(stdout);
  } catch {
    throw new Error('Release archive package manifest is invalid JSON.');
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Release archive package manifest is invalid.');
  }
  return manifest;
}
