import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

const script = resolve('scripts/collect-coverage.mjs');

function fixture(run) {
  const scratch = resolve('.test-tmp');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'collect-coverage-'));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function collect(root) {
  const output = join(root, 'github-output');
  execFileSync(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, GITHUB_OUTPUT: output },
    stdio: 'pipe',
  });
  return Object.fromEntries(
    readFileSync(output, 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function report(root, packageName, lcov = 'SF:src/index.ts\nDA:1,1\nend_of_record\n') {
  const file = join(root, 'packages', packageName, 'coverage/lcov.info');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lcov);
  return file;
}

test('creates one isolated upload per existing package report in stable order', () =>
  fixture((root) => {
    report(root, 'ccd-signer');
    report(root, 'sdk-utils');
    mkdirSync(join(root, 'packages/untested'), { recursive: true });
    writeFileSync(join(root, 'packages/not-a-package'), 'ignored');
    const output = collect(root);
    assert.equal(output.has_files, 'true');
    assert.deepEqual(JSON.parse(output.matrix), {
      include: [
        { flag: 'ccd-signer', file: 'packages/ccd-signer/coverage/lcov.info' },
        { flag: 'sdk-utils', file: 'packages/sdk-utils/coverage/lcov.info' },
      ],
    });
  }));

test('skips uploads when no packages or no reports exist', () =>
  fixture((root) => {
    for (const createPackages of [false, true]) {
      if (createPackages) mkdirSync(join(root, 'packages/ccd-signer'), { recursive: true });
      const output = collect(root);
      assert.equal(output.has_files, 'false');
      assert.deepEqual(JSON.parse(output.matrix), { include: [] });
    }
  }));

test('rejects a package name that cannot be a Codecov flag', () =>
  fixture((root) => {
    report(root, 'invalid flag');
    assert.throws(() => collect(root), /Invalid Codecov flag/);
  }));

test('canonicalizes package-relative LCOV paths before upload', () =>
  fixture((root) => {
    const sdk = report(root, 'sdk-utils', 'TN:\nSF:src/index.ts\nDA:1,1\nLF:1\nLH:1\nend_of_record\n');
    const schemas = report(root, 'schemas', 'SF:src/index.ts\nDA:1,0\nBRDA:1,0,0,-\nend_of_record\n');

    collect(root);

    assert.equal(
      readFileSync(sdk, 'utf8'),
      'TN:\nSF:packages/sdk-utils/src/index.ts\nDA:1,1\nLF:1\nLH:1\nend_of_record\n',
    );
    assert.equal(
      readFileSync(schemas, 'utf8'),
      'SF:packages/schemas/src/index.ts\nDA:1,0\nBRDA:1,0,0,-\nend_of_record\n',
    );
  }));

test('canonicalizing LCOV paths is idempotent', () =>
  fixture((root) => {
    const file = report(root, 'sdk-utils', 'SF:packages/sdk-utils/src/index.ts\nDA:1,1\nend_of_record\n');

    collect(root);
    collect(root);

    assert.equal(readFileSync(file, 'utf8'), 'SF:packages/sdk-utils/src/index.ts\nDA:1,1\nend_of_record\n');
  }));

test('rejects LCOV source paths outside the owning package', () =>
  fixture((root) => {
    report(root, 'sdk-utils', 'SF:../schemas/src/index.ts\nDA:1,1\nend_of_record\n');

    assert.throws(() => collect(root), /outside package/);
  }));
