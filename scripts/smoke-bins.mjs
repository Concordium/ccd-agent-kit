import { existsSync } from 'node:fs';

import { run } from './lib/commands.mjs';
import { publicBins } from './lib/public-bins.mjs';

const mode = parseMode(process.argv.slice(2));
const affectedProjects = parseAffectedProjects(process.env.AFFECTED_PROJECTS);

for (const bin of publicBins) {
  const exists = existsSync(bin.path);
  const affected = affectedProjects.has(bin.projectName);

  if (mode === 'full' && !exists) {
    throw new Error(`Expected public bin to exist after full build: ${bin.path}`);
  }

  if (mode === 'affected' && affected && !exists) {
    throw new Error(`Expected affected public bin to exist after affected build: ${bin.path}`);
  }

  if (!exists) {
    process.stdout.write(`Skipping missing unaffected public bin: ${bin.path}\n`);
    continue;
  }

  await run(bin.path, bin.args);
}

function parseMode(args) {
  const modeArg = args.find((arg) => arg.startsWith('--mode='));
  const mode = modeArg?.slice('--mode='.length) ?? 'full';
  if (mode !== 'full' && mode !== 'affected') {
    throw new Error(`Unsupported smoke-bin mode: ${mode}`);
  }
  return mode;
}

function parseAffectedProjects(value) {
  if (value === undefined || value.trim() === '') {
    return new Set();
  }
  return new Set(value.split(/\s+/).filter(Boolean));
}
