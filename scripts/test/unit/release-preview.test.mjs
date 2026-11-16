import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { previewRelease } from '../../pr-release-preview.mjs';

test('creates then updates one version comment and skips non-release targets', async () => {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const pull = { number: 1, state: 'open', head: { sha }, base: { sha, ref: 'main' } };
  const context = { repo: { owner: 'owner', repo: 'repo' }, payload: { pull_request: pull } };
  const comments = [];
  const writes = [];
  const record = async (params) => writes.push(params);
  const github = {
    rest: {
      pulls: { get: async () => ({ data: pull }) },
      issues: { createComment: record, updateComment: record },
    },
    paginate: async () => comments,
  };
  const version = async () => ({
    projectsVersionData: { 'libs/config-utils': { currentVersion: '0.0.0', newVersion: '0.0.1' } },
  });
  await previewRelease({ github, context }, version);
  comments.push({ id: 1, body: writes[0].body, user: { login: 'github-actions[bot]' } });
  await previewRelease({ github, context }, version);
  pull.base.ref = 'develop';
  await previewRelease({ github, context }, version);
  assert.deepEqual([writes.length, writes[1].comment_id], [2, 1]);
  assert.match(writes[1].body, /libs\/config-utils \| 0\.0\.0 \| 0\.0\.1/);
});
