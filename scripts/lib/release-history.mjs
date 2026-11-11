import { execFileSync } from 'node:child_process';

/** Return whether a repository has no Nx project release tag and needs first-release handling. */
export function isFirstProjectRelease(cwd = process.cwd()) {
  return execFileSync('git', ['tag', '--list', '*/v*'], { cwd, encoding: 'utf8' }).trim() === '';
}
