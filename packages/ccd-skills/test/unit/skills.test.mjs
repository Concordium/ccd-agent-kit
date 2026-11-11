import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildSkills } from '../../../../scripts/build-skills.mjs';

const workspaceRoot = fileURLToPath(new URL('../../../../', import.meta.url));

test('builds all repository skills as directories containing SKILL.md', async () => {
  const scratchRoot = path.join(process.cwd(), '.test-tmp');
  await mkdir(scratchRoot, { recursive: true });
  const outputDir = await mkdtemp(path.join(scratchRoot, 'skills-'));

  try {
    await buildSkills({ workspaceRoot, outputDir });

    const entries = await readdir(outputDir, { withFileTypes: true });
    const generatedSkills = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          try {
            await access(path.join(outputDir, entry.name, 'SKILL.md'));
            return true;
          } catch {
            return false;
          }
        }),
    );

    assert.equal(generatedSkills.filter(Boolean).length, 7);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
