import { globSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const CATALOG_PATTERN = 'packages/*/src/**/assets/*/catalog.json';
const MARKDOWN_FILENAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

/**
 * Discover and validate every source skill catalog in the workspace.
 *
 * @param {string} workspaceRoot absolute or relative workspace root
 * @returns {Promise<Array<{directory: string, catalogPath: string, files: string[]}>>}
 */
export async function readSkillCatalogs(workspaceRoot) {
  const root = path.resolve(workspaceRoot);
  const catalogPaths = globSync(CATALOG_PATTERN, { cwd: root }).sort();

  return Promise.all(
    catalogPaths.map(async (relativeCatalogPath) => {
      const catalogPath = path.resolve(root, relativeCatalogPath);
      const directory = path.dirname(catalogPath);
      const parsed = JSON.parse(await readFile(catalogPath, 'utf8'));

      if (!Array.isArray(parsed) || !parsed.every((file) => typeof file === 'string')) {
        throw new TypeError(`Skill catalog must be an array of Markdown filenames: ${catalogPath}`);
      }

      const files = [...parsed];
      if (new Set(files).size !== files.length) {
        throw new Error(`Skill catalog contains duplicate filenames: ${catalogPath}`);
      }
      for (const file of files) {
        if (!MARKDOWN_FILENAME.test(file) || path.basename(file) !== file) {
          throw new Error(`Invalid skill Markdown filename in ${catalogPath}: ${file}`);
        }
      }

      return { directory, catalogPath, files };
    }),
  );
}
