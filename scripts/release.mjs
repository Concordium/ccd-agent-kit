import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { releaseChangelog, releaseVersion } from 'nx/release';

import { run } from './lib/commands.mjs';
import { isFirstProjectRelease } from './lib/release-history.mjs';
import { packPublicPackages } from './lib/release-packages.mjs';
import { runRelease } from './lib/release-workflow.mjs';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--dry-run')) {
  throw new Error('Usage: pnpm release [--dry-run]');
}

const releaseChannels = JSON.parse(await readFile(new URL('../release-channels.json', import.meta.url), 'utf8'));
if (releaseChannels === null || typeof releaseChannels !== 'object' || Array.isArray(releaseChannels)) {
  throw new Error('release-channels.json must contain a JSON object.');
}

const branch =
  process.env.GITHUB_REF_NAME ?? execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();
if (!Object.hasOwn(releaseChannels, branch)) {
  process.stdout.write(`No release channel configured for branch "${branch}"; skipping release.\n`);
  process.exit(0);
}

const channel = releaseChannels[branch];
if (channel === null || typeof channel !== 'object' || Array.isArray(channel)) {
  throw new Error(`Release channel for branch "${branch}" must be an object.`);
}
if (
  !Object.hasOwn(channel, 'preid') ||
  (channel.preid !== null && (typeof channel.preid !== 'string' || channel.preid.trim() === ''))
) {
  throw new Error(`Release channel for branch "${branch}" must define preid as null or a non-empty string.`);
}
if (!Object.hasOwn(channel, 'npmTag') || typeof channel.npmTag !== 'string' || channel.npmTag.trim() === '') {
  throw new Error(`Release channel for branch "${branch}" must define npmTag as a non-empty string.`);
}

process.stdout.write(
  `Release channel: branch="${branch}", preid=${
    channel.preid === null ? 'null' : `"${channel.preid}"`
  }, npmTag="${channel.npmTag}" (npm publication disabled).\n`,
);

const result = await runRelease({
  dryRun: args.includes('--dry-run'),
  firstRelease: isFirstProjectRelease(),
  preid: channel.preid,
  version: releaseVersion,
  pack: async (projectsVersionData) => {
    await run('pnpm', ['nx', 'run-many', '-t', 'build', '-p', ...Object.keys(projectsVersionData)]);
    return packPublicPackages({ projectsVersionData });
  },
  changelog: releaseChangelog,
  upload: async (artifacts) => {
    for (const artifact of artifacts) {
      await run('gh', ['release', 'upload', artifact.tag, artifact.tarball, artifact.checksum]);
    }
  },
});

for (const name of result.projects) {
  const version = result.projectsVersionData[name].newVersion;
  process.stdout.write(`${name}/v${version}: ${name}-${version}.tgz and SHA-256 checksum\n`);
}
if (result.projects.length === 0) process.stdout.write('No public package releases planned.\n');
