import { run } from './lib/commands.mjs';

const steps = [
  ['pnpm', ['typecheck']],
  ['pnpm', ['lint']],
  ['pnpm', ['build']],
  ['pnpm', ['ci:test']],
  ['pnpm', ['test:scripts']],
  ['pnpm', ['patch-coverage']],
  ['node', ['scripts/smoke-bins.mjs', '--mode=full']],
];

for (const [command, args] of steps) {
  await run(command, args);
}
