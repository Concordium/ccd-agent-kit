import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalizePackageLcov } from './lib/coverage-paths.mjs';

// Each report must be uploaded separately: applying several flags to a combined
// report would give every package the combined coverage instead of its own.
const reports = discoverCoverageReports();
const files = reports.map(({ file }) => file).join(',');

process.stdout.write(`Coverage files: ${files || '(none)'}\n`);

if (process.env.GITHUB_OUTPUT !== undefined) {
  appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify({ include: reports })}\n`, 'utf8');
  appendFileSync(process.env.GITHUB_OUTPUT, `has_files=${reports.length > 0 ? 'true' : 'false'}\n`, 'utf8');
}

function discoverCoverageReports() {
  const packagesDir = 'packages';
  if (!existsSync(packagesDir)) {
    return [];
  }

  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ flag: entry.name, file: join(packagesDir, entry.name, 'coverage', 'lcov.info') }))
    .filter(({ file }) => existsSync(file))
    .sort((left, right) => left.flag.localeCompare(right.flag))
    .map((report) => {
      if (!/^[\w.-]{1,45}$/.test(report.flag)) throw new Error(`Invalid Codecov flag: ${report.flag}`);
      canonicalizeCoverageReport(report);
      return report;
    });
}

function canonicalizeCoverageReport({ flag, file }) {
  const original = readFileSync(file, 'utf8');
  const canonical = canonicalizePackageLcov(original, { packageName: flag });
  if (canonical !== original) writeFileSync(file, canonical, 'utf8');
}
