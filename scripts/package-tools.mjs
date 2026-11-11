import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { publicPackages } from './lib/public-packages.mjs';
import { packPublicPackages } from './lib/release-packages.mjs';

export { packPublicPackages } from './lib/release-packages.mjs';

/** Pack built public packages selected by full/affected mode and persist the artifact manifest. */
export async function packageTools(args = process.argv.slice(2), { workspaceRoot = process.cwd() } = {}) {
  const mode = args.find((arg) => arg.startsWith('--mode='))?.slice(7) ?? 'full';
  if (!['full', 'affected'].includes(mode)) throw new Error(`Unsupported package mode: ${mode}`);
  const affected = new Set((process.env.AFFECTED_PROJECTS ?? '').split(/\s+/));
  const projectsVersionData = {};
  for (const pkg of publicPackages) {
    if (mode === 'affected' && !affected.has(pkg.projectName)) continue;
    const path = join(workspaceRoot, pkg.packageDir, 'package.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    if (manifest.name !== pkg.packageName) throw new Error(`Public package identity mismatch: ${pkg.projectName}`);
    projectsVersionData[pkg.projectName] = { newVersion: manifest.version };
  }
  const artifacts = await packPublicPackages({ projectsVersionData, workspaceRoot });
  await mkdir(join(workspaceRoot, '.release'), { recursive: true });
  await writeFile(join(workspaceRoot, '.release/artifacts.json'), `${JSON.stringify(artifacts, null, 2)}\n`);
  return artifacts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await packageTools();
