import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const workflowPath = resolve('.github/workflows/publish-npm.yml');

test('manual npm publication is main-only, OIDC-authorized, and protected by the npm environment', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  assert.match(workflow, /workflow_dispatch:\s*[\s\S]*release_tag:\s*[\s\S]*required:\s*true/);
  assert.match(workflow, /if:\s*github\.ref\s*==\s*['"]refs\/heads\/main['"]/);
  assert.match(workflow, /environment:\s*npm/);
  assert.match(workflow, /permissions:\s*[\s\S]*contents:\s*read/);
  assert.match(workflow, /permissions:\s*[\s\S]*id-token:\s*write/);
  assert.match(workflow, /node scripts\/publish-release\.mjs/);
  assert.match(workflow, /inputs\.release_tag/);
  assert.doesNotMatch(workflow, /secrets\.|NPM_TOKEN|npm-token|NODE_AUTH_TOKEN/);
  const installCommands = workflow
    .split('\n')
    .map((line) => line.trim().replace(/^run:\s*/, ''))
    .filter((line) => /^(?:npm|pnpm)\s+(?:install|ci)\b/.test(line));
  assert.equal(installCommands.length, 1, 'only the pinned npm CLI may be installed');
  const npmCliInstall = installCommands[0].match(
    /^npm install --global npm@(\d+)\.(\d+)\.(\d+) --ignore-scripts$/,
  );
  assert.ok(npmCliInstall, 'npm CLI install must be global, pinned, and ignore scripts');
  assert.ok(
    Number(npmCliInstall[1]) > 11 ||
      (Number(npmCliInstall[1]) === 11 &&
        (Number(npmCliInstall[2]) > 5 ||
          (Number(npmCliInstall[2]) === 5 && Number(npmCliInstall[3]) >= 1))),
    'trusted publishing requires npm >=11.5.1',
  );
  assert.doesNotMatch(workflow, /\bnpm\s+pack\b/);
  assert.doesNotMatch(workflow, /\bpush:\s*|pull_request:/);
});
