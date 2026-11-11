#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { publishRelease } from './lib/publish-release.mjs';

const usage = 'Usage: node scripts/publish-release.mjs <release-tag> [artifact-directory]\n';
const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  process.stdout.write(usage);
  process.exit(0);
}
if (args.length < 1 || args.length > 2) {
  process.stderr.write(usage);
  process.exit(2);
}

const artifactDirectory = resolve(args[1] ?? '.release/npm-publish');
await mkdir(artifactDirectory, { recursive: true });
await publishRelease({
  releaseTag: args[0],
  artifactDirectory,
  execute: promisify(execFile),
});
