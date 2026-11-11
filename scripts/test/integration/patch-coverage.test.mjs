import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

test('CLI includes root-level and nested source files and uses uploaded LCOV over JSON', () =>
  withCoverageRepo((root, git) => {
    mkdirSync(resolve(root, 'packages/example/src/nested'), { recursive: true });
    mkdirSync(resolve(root, 'packages/example/coverage'), { recursive: true });
    for (const name of ['index.ts', 'nested/helper.ts'])
      writeFileSync(resolve(root, 'packages/example/src', name), 'export const value = 1;\n');
    writeFileSync(
      resolve(root, 'packages/example/coverage/lcov.info'),
      'SF:src/index.ts\nDA:1,1\nend_of_record\nSF:src/nested/helper.ts\nDA:1,0\nend_of_record\n',
    );
    writeFileSync(resolve(root, 'packages/example/coverage/coverage-final.json'), '{}');
    git('add', '.');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'changes');
    // CI refs belong to the outer checkout, not this isolated fixture repository.
    const output = checkCoverage(root, '50', {
      ...process.env,
      NX_BASE: 'outside-fixture-base',
      NX_HEAD: 'outside-fixture-head',
    });
    assert.match(output, /src\/index.ts: 100.00%/);
    assert.match(output, /src\/nested\/helper.ts: 0.00%/);
    assert.match(output, /Patch coverage total: 50.00% \(1\/2\)/);
  }));

test('CLI evaluates coverage when the Git diff exceeds the child-process default buffer', () =>
  withCoverageRepo((root, git) => {
    mkdirSync(resolve(root, 'docs'), { recursive: true });
    mkdirSync(resolve(root, 'packages/example/src'), { recursive: true });
    mkdirSync(resolve(root, 'packages/example/coverage'), { recursive: true });
    writeFileSync(resolve(root, 'docs/large-fixture.txt'), `${'x'.repeat(1_100_000)}\n`);
    writeFileSync(resolve(root, 'packages/example/src/index.ts'), 'export const value = 1;\n');
    writeFileSync(resolve(root, 'packages/example/coverage/lcov.info'), 'SF:src/index.ts\nDA:1,1\nend_of_record\n');
    git('add', '.');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'large diff');
    const output = checkCoverage(root, '100');
    assert.match(output, /src\/index.ts: 100.00%/);
    assert.match(output, /Patch coverage total: 100.00% \(1\/1\)/);
  }));

test('CLI treats the empty tree as the initial-history patch base', () =>
  withCoverageRepo((root, git) => {
    mkdirSync(resolve(root, 'packages/example/src'), { recursive: true });
    mkdirSync(resolve(root, 'packages/example/coverage'), { recursive: true });
    writeFileSync(resolve(root, 'packages/example/src/index.ts'), 'export const value = 1;\n');
    writeFileSync(resolve(root, 'packages/example/coverage/lcov.info'), 'SF:src/index.ts\nDA:1,1\nend_of_record\n');
    git('add', '.');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'feat: initial source');

    const emptyTree = git('hash-object', '-t', 'tree', '/dev/null').toString().trim();
    const output = checkCoverage(root, '100', process.env, emptyTree);
    assert.match(output, /Patch coverage total: 100.00% \(1\/1\)/);
  }));

function checkCoverage(root, minimum, env = process.env, base = 'main') {
  return execFileSync(
    process.execPath,
    [resolve('scripts/check-patch-coverage.mjs'), '--base', base, '--head', 'HEAD', '--min', minimum],
    { cwd: root, encoding: 'utf8', env },
  );
}

function withCoverageRepo(run) {
  const scratchRoot = resolve('.test-tmp');
  mkdirSync(scratchRoot, { recursive: true });
  const root = mkdtempSync(resolve(scratchRoot, 'patch-coverage-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  try {
    git('init', '-b', 'main');
    git('config', 'user.name', 'Coverage test');
    git('config', 'user.email', 'coverage@example.invalid');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'baseline');
    git('checkout', '-b', 'test');
    return run(root, git);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
