import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Rewrite LCOV source-file entries for one package report to repository-relative
 * paths under that package, preserving all non-`SF:` LCOV content unchanged.
 *
 * Native package-relative paths such as `src/index.ts`, absolute paths inside
 * the package, and already-canonical paths such as
 * `packages/sdk-utils/src/index.ts` all become the same canonical form. Paths
 * that escape the owning package or name a different package are rejected.
 *
 * @param {string} lcovText LCOV report text to rewrite.
 * @param {{ root?: string, packageName: string }} options Repository root and
 *   the package directory name that owns the report.
 * @returns {string} LCOV text with canonical repository-relative `SF:` paths.
 */
export function canonicalizePackageLcov(lcovText, { root = process.cwd(), packageName }) {
  return lcovText
    .split(/(\r?\n)/)
    .map((part) =>
      part.startsWith('SF:') ? `SF:${canonicalizePackageSourcePath(part.slice(3), { root, packageName })}` : part,
    )
    .join('');
}

/**
 * Convert one LCOV source-file path to a repository-relative path owned by the
 * package that produced the report.
 *
 * @param {string} sourcePath LCOV `SF:` path without the `SF:` prefix.
 * @param {{ root?: string, packageName: string }} options Repository root and
 *   the package directory name that owns the report.
 * @returns {string} Repository-relative path using `/` separators.
 */
export function canonicalizePackageSourcePath(sourcePath, { root = process.cwd(), packageName }) {
  const normalizedSourcePath = normalizePath(sourcePath);
  const packagePrefix = `packages/${packageName}/`;
  const packageRoot = resolve(root, 'packages', packageName);

  let absolutePath;
  if (isAbsolute(sourcePath)) {
    absolutePath = resolve(sourcePath);
  } else if (normalizedSourcePath.startsWith('packages/')) {
    if (!normalizedSourcePath.startsWith(packagePrefix)) {
      throw new Error(`LCOV source path is outside package ${packageName}: ${sourcePath}`);
    }
    absolutePath = resolve(root, normalizedSourcePath);
  } else {
    absolutePath = resolve(packageRoot, sourcePath);
  }

  const packageRelative = normalizePath(relative(packageRoot, absolutePath));
  if (
    packageRelative === '' ||
    packageRelative.startsWith('../') ||
    packageRelative === '..' ||
    isAbsolute(packageRelative)
  ) {
    throw new Error(`LCOV source path is outside package ${packageName}: ${sourcePath}`);
  }

  const rootRelative = normalizePath(relative(root, absolutePath));
  if (!rootRelative.startsWith(packagePrefix)) {
    throw new Error(`LCOV source path is outside package ${packageName}: ${sourcePath}`);
  }
  return rootRelative;
}

function normalizePath(path) {
  return path.split(sep).join('/');
}
