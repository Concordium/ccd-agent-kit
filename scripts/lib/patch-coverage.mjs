import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const HUNK_HEADER_PATTERN = /^@@ -(?:\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

export function parseChangedLines(diffText) {
  const changedByFile = new Map();
  let currentFile;
  let nextNewLine;

  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      currentFile = undefined;
      nextNewLine = undefined;
      continue;
    }

    if (line.startsWith('+++ ')) {
      const file = line.slice(4).trim();
      currentFile = file === '/dev/null' ? undefined : stripGitPrefix(file);
      if (currentFile !== undefined && !changedByFile.has(currentFile)) {
        changedByFile.set(currentFile, new Set());
      }
      continue;
    }

    const hunk = HUNK_HEADER_PATTERN.exec(line);
    if (hunk !== null) {
      nextNewLine = Number(hunk[1]);
      continue;
    }

    if (currentFile === undefined || nextNewLine === undefined) continue;
    if (line.startsWith('+') && !line.startsWith('+++ ')) {
      changedByFile.get(currentFile)?.add(nextNewLine);
      nextNewLine += 1;
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('--- ')) continue;
    if (line.startsWith('\\')) continue;
    nextNewLine += 1;
  }

  return changedByFile;
}

export function evaluatePatchCoverage({ changedLinesByFile, coverageByFile, root = process.cwd() }) {
  const results = [];

  for (const [file, changedLines] of changedLinesByFile.entries()) {
    const sourcePath = normalizeRelativePath(file);
    if (!isPackageSourceFile(sourcePath)) continue;

    const coverage = coverageByFile.get(sourcePath) ?? coverageByFile.get(resolve(root, sourcePath));
    if (coverage === undefined) {
      results.push({ file: sourcePath, executable: 0, covered: 0, uncoveredLines: [], missingCoverage: true });
      continue;
    }

    const executableLines = [...changedLines]
      .filter((line) => isExecutableLine(coverage, line))
      .sort((left, right) => left - right);
    const uncoveredLines = executableLines.filter((line) => !isCoveredLine(coverage, line));

    if (executableLines.length === 0) continue;

    results.push({
      file: sourcePath,
      executable: executableLines.length,
      covered: executableLines.length - uncoveredLines.length,
      uncoveredLines,
      missingCoverage: false,
    });
  }

  return results;
}

export function loadPackageCoverage(root = process.cwd()) {
  const coverageByFile = new Map();
  const packageNames = discoverCoveragePackageNames(root);

  for (const packageName of packageNames) {
    const lcovFile = resolve(root, 'packages', packageName, 'coverage', 'lcov.info');
    if (existsSync(lcovFile)) {
      for (const [file, data] of parseLcov(readFileSync(lcovFile, 'utf8'), root, `packages/${packageName}`).entries()) {
        coverageByFile.set(file, data);
      }
    }
  }

  return coverageByFile;
}

export function summarizePatchCoverage(results) {
  const covered = results.reduce((sum, result) => sum + result.covered, 0);
  const executable = results.reduce((sum, result) => sum + result.executable, 0);
  const pct = executable === 0 ? 100 : (covered / executable) * 100;
  return { covered, executable, pct };
}

export function summarizeSourceCoverage(coverageByFile) {
  let covered = 0;
  let executable = 0;

  for (const [file, coverage] of coverageByFile.entries()) {
    if (!isPackageSourceFile(file)) continue;
    const lines = new Set(Object.values(coverage.statementMap ?? {}).map((location) => location.start.line));
    for (const line of lines) {
      executable += 1;
      if (isCoveredLine(coverage, line)) covered += 1;
    }
  }

  const pct = executable === 0 ? 100 : (covered / executable) * 100;
  return { covered, executable, pct };
}

export function parseCodecovPatchRule(codecovText) {
  const lines = codecovText.split(/\r?\n/);
  const patchIndex = lines.findIndex((line) => /^\s{4}patch:\s*$/.test(line));
  if (patchIndex === -1) return { target: 'auto', threshold: 0 };

  let target = 'auto';
  let threshold = 0;
  for (const line of lines.slice(patchIndex + 1)) {
    if (/^\s{0,4}\S/.test(line)) break;
    const targetMatch = /^\s{8}target:\s*(\S+)\s*$/.exec(line);
    if (targetMatch !== null) target = targetMatch[1];
    const thresholdMatch = /^\s{8}threshold:\s*(\S+)\s*$/.exec(line);
    if (thresholdMatch !== null) threshold = parsePercent(thresholdMatch[1]);
  }

  return { target, threshold };
}

export function parseLcov(lcovText, root = process.cwd(), relativePrefix = '') {
  const coverageByFile = new Map();
  let currentFile;
  let statementIndex = 0;

  for (const line of lcovText.split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      currentFile = normalizeSourceFile(line.slice(3), root, relativePrefix);
      coverageByFile.set(currentFile, { statementMap: {}, s: {} });
      statementIndex = 0;
      continue;
    }

    if (line.startsWith('DA:') && currentFile !== undefined) {
      const [lineNumber, hits] = line.slice(3).split(',', 2).map(Number);
      const coverage = coverageByFile.get(currentFile);
      coverage.statementMap[String(statementIndex)] = {
        start: { line: lineNumber },
        end: { line: lineNumber },
      };
      coverage.s[String(statementIndex)] = hits;
      statementIndex += 1;
    }

    if (line.startsWith('BRDA:') && currentFile !== undefined) {
      const [lineNumber, , , hits] = line.slice(5).split(',');
      const coverage = coverageByFile.get(currentFile);
      coverage.branches ??= {};
      (coverage.branches[lineNumber] ??= []).push(hits === '-' ? 0 : Number(hits));
    }

    if (line === 'end_of_record') {
      const coverage = coverageByFile.get(currentFile);
      // LCOV can report branches on lines without a DA record. Codecov includes
      // those executable lines too, rather than dropping them from the denominator.
      for (const [line, hits] of Object.entries(coverage?.branches ?? {})) {
        if (statementIdsForLine(coverage, Number(line)).length > 0) continue;
        coverage.statementMap[String(statementIndex)] = { start: { line: Number(line) }, end: { line: Number(line) } };
        coverage.s[String(statementIndex++)] = Math.max(...hits);
      }
      currentFile = undefined;
    }
  }

  return coverageByFile;
}

function parsePercent(rawValue) {
  const value = rawValue.endsWith('%') ? rawValue.slice(0, -1) : rawValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`Invalid percentage value in codecov.yml: ${rawValue}`);
  }
  return parsed;
}

function normalizeSourceFile(sourceFile, root, relativePrefix) {
  if (sourceFile.startsWith('/')) return normalizeRelativePath(relative(root, sourceFile));
  const normalizedSourceFile = normalizeRelativePath(sourceFile);
  if (normalizedSourceFile.startsWith('packages/')) return normalizedSourceFile;
  return normalizeRelativePath(relativePrefix === '' ? sourceFile : `${relativePrefix}/${sourceFile}`);
}

export function formatLineList(lines) {
  return lines.length === 0 ? '(none)' : lines.join(', ');
}

function isPackageSourceFile(file) {
  return /^packages\/[^/]+\/src\/.+\.ts$/.test(file) && !file.endsWith('.d.ts');
}

function isExecutableLine(coverage, line) {
  return statementIdsForLine(coverage, line).length > 0;
}

function isCoveredLine(coverage, line) {
  return (
    statementIdsForLine(coverage, line).some((id) => Number(coverage.s?.[id] ?? 0) > 0) &&
    (coverage.branches?.[line] ?? []).every((hits) => hits > 0)
  );
}

function statementIdsForLine(coverage, line) {
  return Object.entries(coverage.statementMap ?? {})
    .filter(([, location]) => location.start.line <= line && location.end.line >= line)
    .map(([id]) => id);
}

function discoverCoveragePackageNames(root) {
  const packagesDir = resolve(root, 'packages');
  if (!existsSync(packagesDir)) return [];
  return readDirectoryNames(packagesDir).filter((name) =>
    existsSync(resolve(packagesDir, name, 'coverage', 'lcov.info')),
  );
}

function readDirectoryNames(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function stripGitPrefix(file) {
  if (file.startsWith('a/') || file.startsWith('b/')) return file.slice(2);
  return file;
}

function normalizeRelativePath(path) {
  return path.split(sep).join('/');
}
