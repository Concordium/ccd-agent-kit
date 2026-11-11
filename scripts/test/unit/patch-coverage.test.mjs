import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluatePatchCoverage,
  parseChangedLines,
  parseCodecovPatchRule,
  parseLcov,
  summarizePatchCoverage,
  summarizeSourceCoverage,
} from '../../lib/patch-coverage.mjs';

test('parseChangedLines returns added line numbers by file', () => {
  const changed = parseChangedLines(`diff --git a/packages/example/src/index.ts b/packages/example/src/index.ts
index 1111111..2222222 100644
--- a/packages/example/src/index.ts
+++ b/packages/example/src/index.ts
@@ -10,0 +11,2 @@
+const added = true;
+const alsoAdded = true;
@@ -20,2 +22,2 @@
-const removed = true;
 const context = true;
+const replacement = true;
`);

  assert.deepEqual([...changed.get('packages/example/src/index.ts')], [11, 12, 23]);
});

test('evaluatePatchCoverage reports covered and uncovered executable changed lines', () => {
  const changedLinesByFile = new Map([['packages/example/src/index.ts', new Set([1, 2, 3, 4])]]);
  const coverageByFile = new Map([
    [
      'packages/example/src/index.ts',
      {
        statementMap: {
          0: { start: { line: 1 }, end: { line: 1 } },
          1: { start: { line: 3 }, end: { line: 3 } },
          2: { start: { line: 4 }, end: { line: 4 } },
        },
        s: { 0: 1, 1: 0, 2: 2 },
      },
    ],
  ]);

  const results = evaluatePatchCoverage({ changedLinesByFile, coverageByFile, root: process.cwd() });

  assert.deepEqual(results, [
    {
      file: 'packages/example/src/index.ts',
      executable: 3,
      covered: 2,
      uncoveredLines: [3],
      missingCoverage: false,
    },
  ]);
  assert.deepEqual(summarizePatchCoverage(results), { covered: 2, executable: 3, pct: 66.66666666666666 });
});

test('evaluatePatchCoverage flags changed source files missing coverage data', () => {
  const results = evaluatePatchCoverage({
    changedLinesByFile: new Map([['packages/example/src/index.ts', new Set([1])]]),
    coverageByFile: new Map(),
    root: process.cwd(),
  });

  assert.deepEqual(results, [
    {
      file: 'packages/example/src/index.ts',
      executable: 0,
      covered: 0,
      uncoveredLines: [],
      missingCoverage: true,
    },
  ]);
});

test('parseLcov converts line coverage into executable line coverage', () => {
  const coverage = parseLcov(
    `TN:
SF:src/index.ts
DA:10,1
DA:11,0
end_of_record
`,
    process.cwd(),
    'packages/example',
  );

  assert.deepEqual(coverage.get('packages/example/src/index.ts'), {
    statementMap: {
      0: { start: { line: 10 }, end: { line: 10 } },
      1: { start: { line: 11 }, end: { line: 11 } },
    },
    s: { 0: 1, 1: 0 },
  });
});

test('parseLcov accepts canonical repository-relative package paths', () => {
  const coverage = parseLcov(
    `SF:packages/example/src/index.ts
DA:10,1
end_of_record
`,
    process.cwd(),
    'packages/example',
  );

  assert.deepEqual([...coverage.keys()], ['packages/example/src/index.ts']);
});

test('LCOV partial branches and branch-only lines count as uncovered', () => {
  const file = 'packages/example/src/index.ts';
  const coverageByFile = parseLcov(`SF:${file}
DA:1,4
DA:2,4
BRDA:1,0,0,4
BRDA:1,0,1,0
BRDA:2,0,0,2
BRDA:2,0,1,2
BRDA:3,0,0,-
BRDA:4,0,0,2
end_of_record
`);
  const results = evaluatePatchCoverage({
    changedLinesByFile: new Map([[file, new Set([1, 2, 3, 4])]]),
    coverageByFile,
  });
  assert.equal(results[0].executable, 4);
  assert.equal(results[0].covered, 2);
  assert.deepEqual(results[0].uncoveredLines, [1, 3]);
  assert.equal(summarizeSourceCoverage(coverageByFile).pct, 50);
});

test('summarizeSourceCoverage totals package source files only', () => {
  const coverage = new Map([
    [
      'packages/example/src/index.ts',
      {
        statementMap: {
          0: { start: { line: 1 }, end: { line: 1 } },
          1: { start: { line: 2 }, end: { line: 2 } },
          2: { start: { line: 3 }, end: { line: 3 } },
        },
        s: { 0: 1, 1: 0, 2: 2 },
      },
    ],
    [
      'packages/example/test/index.test.ts',
      { statementMap: { 0: { start: { line: 1 }, end: { line: 1 } } }, s: { 0: 0 } },
    ],
  ]);

  assert.deepEqual(summarizeSourceCoverage(coverage), { covered: 2, executable: 3, pct: 66.66666666666666 });
});

test('parseCodecovPatchRule reads patch target and threshold', () => {
  assert.deepEqual(
    parseCodecovPatchRule(`coverage:
  status:
    project:
      default:
        target: auto
    patch:
      default:
        target: auto
        threshold: 1%
`),
    { target: 'auto', threshold: 1 },
  );
});

test('evaluatePatchCoverage ignores non-package-source files and non-executable lines', () => {
  const results = evaluatePatchCoverage({
    changedLinesByFile: new Map([
      ['docs/architecture.md', new Set([1])],
      ['packages/example/src/index.ts', new Set([2])],
    ]),
    coverageByFile: new Map([
      ['packages/example/src/index.ts', { statementMap: { 0: { start: { line: 1 }, end: { line: 1 } } }, s: { 0: 0 } }],
    ]),
    root: process.cwd(),
  });

  assert.deepEqual(results, []);
});
