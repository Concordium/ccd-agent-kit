import { execFileSync } from 'node:child_process';

import { run } from './lib/commands.mjs';

const base = process.env.NX_BASE;
const head = process.env.NX_HEAD;
const affectedArgs = base !== undefined && head !== undefined ? ['--base', base, '--head', head] : [];
const affectedProjects = listAffectedProjects(affectedArgs);

if (affectedArgs.length > 0) {
  process.stdout.write(`Nx affected base: ${base}\n`);
  process.stdout.write(`Nx affected head: ${head}\n`);
} else {
  process.stdout.write('Nx affected base/head: default local Nx detection\n');
}
process.stdout.write(`Affected projects: ${affectedProjects.join(' ') || '(none)'}\n`);

await run('pnpm', ['nx', 'affected', '-t', 'typecheck', 'lint', 'build', 'test', ...affectedArgs]);
await run('pnpm', ['test:scripts']);
await run('pnpm', ['patch-coverage', ...affectedArgs]);
await run('node', ['scripts/smoke-bins.mjs', '--mode=affected'], {
  env: { ...process.env, AFFECTED_PROJECTS: affectedProjects.join(' ') },
});

function listAffectedProjects(affectedArgs) {
  const output = execFileSync('pnpm', ['nx', 'show', 'projects', '--affected', ...affectedArgs], {
    encoding: 'utf8',
  }).trim();

  if (output.startsWith('[')) {
    const parsed = JSON.parse(output);
    if (!Array.isArray(parsed) || parsed.some((project) => typeof project !== 'string')) {
      throw new Error(`Unexpected Nx affected project output: ${output}`);
    }
    return parsed;
  }

  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
