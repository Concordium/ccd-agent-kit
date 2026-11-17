import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { publicPackages } from '../../lib/public-packages.mjs';

test('Nx release groups separate public GitHub releases from private libraries', () => {
  const output = execFileSync('pnpm', ['exec', 'nx', 'release', '--printConfig=debug'], {
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NX_DAEMON: 'false' },
  });
  const config = JSON.parse(output.split('START FINAL INTERNAL CONFIG\n')[1].split('\n===')[0]);
  const { public: publicGroup, private: privateGroup } = config.groups;
  const publicProjects = publicPackages.map(({ projectName }) => projectName).sort();

  assert.deepEqual([...publicGroup.projects].sort(), publicProjects);
  assert.ok(privateGroup.projects.length > 0);
  assert.ok(privateGroup.projects.every((project) => project.startsWith('libs/')));
  assert.equal(publicGroup.changelog.createRelease.provider, 'github');
  assert.equal(privateGroup.changelog.createRelease, false);
  for (const group of [publicGroup, privateGroup]) {
    assert.equal(group.projectsRelationship, 'independent');
    assert.equal(group.releaseTag.pattern, '{projectName}/v{version}');
  }
  assert.equal(config.changelog.git.tag, true);
});
