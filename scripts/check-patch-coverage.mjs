import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import {
  evaluatePatchCoverage,
  formatLineList,
  loadPackageCoverage,
  parseCodecovPatchRule,
  parseChangedLines,
  summarizePatchCoverage,
  summarizeSourceCoverage,
} from './lib/patch-coverage.mjs';

const options = parseArgs(process.argv.slice(2));
const base = options.base ?? process.env.NX_BASE ?? 'main';
const head = options.head ?? process.env.NX_HEAD ?? 'HEAD';
const coverageByFile = loadPackageCoverage();
const sourceCoverage = summarizeSourceCoverage(coverageByFile);
const gate = resolvePatchCoverageGate({ min: options.min, sourceCoverage });

// Filter source files after parsing: Git's ordinary ** pathspec misses src/index.ts.
// nx-set-shas uses the empty tree for a first commit; symmetric commit diff syntax cannot accept a tree.
const baseType = execFileSync('git', ['cat-file', '-t', base], { encoding: 'utf8' }).trim();
const revisionArgs = baseType === 'tree' ? [base, head] : [`${base}...${head}`];
const diffArgs = ['diff', '--unified=0', '--no-ext-diff', ...revisionArgs];
const diffText = execFileSync('git', diffArgs, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const changedLinesByFile = parseChangedLines(diffText);
const results = evaluatePatchCoverage({ changedLinesByFile, coverageByFile });
const summary = summarizePatchCoverage(results);

process.stdout.write(`Patch coverage base/head: ${base}...${head}\n`);
process.stdout.write(
  `Patch coverage gate: ${gate.required.toFixed(2)}% (${gate.description}; source coverage ${sourceCoverage.pct.toFixed(
    2,
  )}%)\n`,
);

if (results.length === 0) {
  process.stdout.write('Patch coverage: no changed executable package source lines.\n');
  process.exit(0);
}

for (const result of results) {
  if (result.missingCoverage) {
    process.stdout.write(`${result.file}: missing coverage report\n`);
    continue;
  }

  const pct = ((result.covered / result.executable) * 100).toFixed(2);
  process.stdout.write(
    `${result.file}: ${pct}% (${result.covered}/${result.executable}) uncovered lines: ${formatLineList(
      result.uncoveredLines,
    )}\n`,
  );
}

process.stdout.write(`Patch coverage total: ${summary.pct.toFixed(2)}% (${summary.covered}/${summary.executable})\n`);

const missingCoverage = results.filter((result) => result.missingCoverage);
if (missingCoverage.length > 0) {
  throw new Error(
    `Patch coverage is missing coverage data for ${missingCoverage.length} changed source file(s). ` +
      'Run package tests with coverage before checking patch coverage.',
  );
}

if (summary.pct < gate.required) {
  throw new Error(`Patch coverage ${summary.pct.toFixed(2)}% is below required ${gate.required.toFixed(2)}%.`);
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--base') {
      parsed.base = requireValue(args, (index += 1), arg);
      continue;
    }
    if (arg === '--head') {
      parsed.head = requireValue(args, (index += 1), arg);
      continue;
    }
    if (arg === '--min') {
      parsed.min = Number(requireValue(args, (index += 1), arg));
      if (!Number.isFinite(parsed.min) || parsed.min < 0 || parsed.min > 100) {
        throw new Error('--min must be a number from 0 to 100.');
      }
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function resolvePatchCoverageGate({ min, sourceCoverage }) {
  if (min !== undefined) {
    return { required: min, description: '--min override' };
  }

  if (process.env.PATCH_COVERAGE_MIN !== undefined) {
    const required = parseCoveragePercent(process.env.PATCH_COVERAGE_MIN, 'PATCH_COVERAGE_MIN');
    return { required, description: 'PATCH_COVERAGE_MIN override' };
  }

  const codecovFile = 'codecov.yml';
  if (!existsSync(codecovFile)) {
    return { required: sourceCoverage.pct, description: 'source coverage; codecov.yml not found' };
  }

  const rule = parseCodecovPatchRule(readFileSync(codecovFile, 'utf8'));
  const target =
    rule.target === 'auto' ? sourceCoverage.pct : parseCoveragePercent(rule.target, 'codecov patch target');
  const required = Math.max(0, target - rule.threshold);
  return {
    required,
    description:
      rule.target === 'auto'
        ? `codecov patch target auto minus ${rule.threshold}% threshold`
        : `codecov patch target ${target}% minus ${rule.threshold}% threshold`,
  };
}

function parseCoveragePercent(value, label) {
  const normalized = value.endsWith('%') ? value.slice(0, -1) : value;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`${label} must be a number from 0 to 100.`);
  }
  return parsed;
}

function requireValue(args, index, option) {
  const value = args[index];
  if (value === undefined || value.startsWith('--')) throw new Error(`${option} requires a value.`);
  return value;
}
