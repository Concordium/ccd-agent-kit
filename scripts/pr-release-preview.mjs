import { execFileSync } from 'node:child_process';
import { releaseVersion } from 'nx/release';
import { isFirstProjectRelease } from './lib/release-history.mjs';
import { runRelease } from './lib/release-workflow.mjs';
const marker = '<!-- ccd-release-preview -->';

/** Dry-runs Nx for release-target PRs and creates or updates their single bot comment. */
export async function previewRelease({ github, context }, version = releaseVersion) {
  const pull = context.payload.pull_request;
  const channels = JSON.parse(
    execFileSync('git', ['show', `${pull.base.sha}:release-channels.json`], { encoding: 'utf8' }),
  );
  if (!Object.hasOwn(channels, pull.base.ref)) return;
  const { projectsVersionData } = await runRelease({
    dryRun: true,
    firstRelease: isFirstProjectRelease(),
    preid: channels[pull.base.ref].preid,
    version,
  });
  const rows = Object.entries(projectsVersionData)
    .filter(([, data]) => data.newVersion !== null)
    .map(([name, data]) => `| ${name} | ${data.currentVersion} | ${data.newVersion} |`);
  const details = rows.length
    ? `| Project | Current | Expected |\n| --- | --- | --- |\n${rows.join('\n')}`
    : 'No releases expected';
  const body = `${marker}\n## Expected versions based on commits in this PR\n\n${details}\n\nEstimate for head \`${pull.head.sha}\`; versions may change.`;
  const issue = { ...context.repo, issue_number: pull.number };
  const comments = await github.paginate(github.rest.issues.listComments, issue);
  const current = (await github.rest.pulls.get({ ...context.repo, pull_number: pull.number })).data;
  if (current.state !== 'open' || current.head.sha !== pull.head.sha || current.base.ref !== pull.base.ref) return;
  const existing = comments.find(
    (comment) => comment.body?.startsWith(marker) && comment.user?.login === 'github-actions[bot]',
  );
  return existing
    ? github.rest.issues.updateComment({ ...context.repo, comment_id: existing.id, body })
    : github.rest.issues.createComment({ ...issue, body });
}
