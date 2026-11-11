import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { publicPackages } from './public-packages.mjs';
import { readSkillCatalogs } from './skill-assets.mjs';
import { preparePackageEnvironment } from './package-environment.mjs';

const execute = promisify(execFile);
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const dependencyName = (specifier) =>
  specifier
    .split('/')
    .slice(0, specifier.startsWith('@') ? 2 : 1)
    .join('/');

/** Create the minimal registry manifest, preserving the public package's npm publication settings. */
export function createDistributionManifest(sourceManifest, externalDependencies) {
  if (sourceManifest.private) {
    throw new Error('Distribution must be a public package');
  }
  if (
    !/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?$/.test(sourceManifest.version ?? '') ||
    sourceManifest.version === '0.0.0-development'
  ) {
    throw new Error('Distribution requires a release version');
  }
  const dependencies = {};
  for (const [name, version] of Object.entries(externalDependencies).sort(([a], [b]) => a.localeCompare(b))) {
    if (
      typeof version !== 'string' ||
      !/^[~^<>=*\dv]/.test(version) ||
      /(?:workspace:|link:|file:|https?:|git|\/)/.test(version)
    ) {
      throw new Error(`External dependency must use a registry version: ${name}`);
    }
    dependencies[name] = version;
  }
  const manifest = {};
  for (const key of ['name', 'version', 'description', 'type']) {
    if (sourceManifest[key] !== undefined) manifest[key] = sourceManifest[key];
  }
  manifest.license = 'Apache-2.0';
  manifest.bin = sourceManifest.bin;
  manifest.files = ['dist'];
  if (sourceManifest.engines) manifest.engines = sourceManifest.engines;
  if (sourceManifest.publishConfig) manifest.publishConfig = sourceManifest.publishConfig;
  manifest.dependencies = dependencies;
  return manifest;
}

async function workspacePackages(root) {
  const packages = new Map();
  for (const entry of await readdir(join(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, 'packages', entry.name);
    let manifest;
    try {
      manifest = await json(join(dir, 'package.json'));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    packages.set(manifest.name, { dir, manifest });
  }
  return packages;
}

async function markdownFiles(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...(await markdownFiles(path)));
    else if (entry.isFile() && entry.name.endsWith('.md')) result.push(path);
  }
  return result;
}

/** Bundle only repository-private code from compiled bin entrypoints into a separate distribution. */
export async function stagePackageDistribution({ workspaceRoot, packageDir, outputDir }) {
  workspaceRoot = resolve(workspaceRoot);
  packageDir = resolve(packageDir);
  outputDir = resolve(outputDir);
  if (outputDir === packageDir || outputDir.startsWith(`${packageDir}${sep}`))
    throw new Error('Distribution must be outside the source package');
  const packages = await workspacePackages(workspaceRoot);
  if (
    outputDir === workspaceRoot ||
    workspaceRoot.startsWith(`${outputDir}${sep}`) ||
    [...packages.values()].some(
      ({ dir }) => outputDir === dir || outputDir.startsWith(`${dir}${sep}`) || dir.startsWith(`${outputDir}${sep}`),
    )
  ) {
    throw new Error('Distribution must not overlap workspace source directories');
  }
  const source = await json(join(packageDir, 'package.json'));
  const graph = new Map();
  const external = {};
  function visit(pkg) {
    if (graph.has(pkg.manifest.name)) return;
    graph.set(pkg.manifest.name, pkg);
    for (const [name, version] of Object.entries(pkg.manifest.dependencies ?? {})) {
      const local = packages.get(name);
      if (local) {
        if (!local.manifest.private) throw new Error(`Cannot bundle public workspace dependency ${name}`);
        visit(local);
      } else {
        if (external[name] !== undefined && external[name] !== version)
          throw new Error(`Conflicting dependency ranges for ${name}`);
        external[name] = version;
      }
    }
  }
  visit({ dir: packageDir, manifest: source });
  const manifest = createDistributionManifest(source, external);
  if (!manifest.bin || typeof manifest.bin !== 'object') throw new Error('Public package requires named bins');
  for (const path of Object.values(manifest.bin)) {
    if (!/^(?:\.\/)?dist\/bin\/[^/]+\.js$/.test(path) || path.includes('..'))
      throw new Error(`Invalid bin path: ${path}`);
  }
  await mkdir(outputDir, { recursive: true });
  if ((await readdir(outputDir)).length > 0) throw new Error('Distribution staging directory must be empty');
  const result = await build({
    absWorkingDir: workspaceRoot,
    entryPoints: Object.values(manifest.bin).map((path) => join(packageDir, path)),
    outdir: join(outputDir, 'dist/bin'),
    bundle: true,
    treeShaking: true,
    splitting: false,
    minify: false,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    metafile: true,
    plugins: [
      {
        name: 'private-workspace-only',
        setup(builder) {
          builder.onResolve({ filter: /^[^./]|^@/ }, (args) => {
            if (args.kind === 'entry-point' || args.path.startsWith('/') || builtins.has(args.path)) return;
            const name = dependencyName(args.path);
            const owner = [...graph.values()].find((pkg) => args.importer.startsWith(`${pkg.dir}${sep}`));
            if (!owner?.manifest.dependencies?.[name])
              throw new Error(`Undeclared dependency ${name} in ${args.importer}`);
            const local = graph.get(name);
            if (local) {
              const subpath = args.path === name ? '.' : `.${args.path.slice(name.length)}`;
              const exports = local.manifest.exports;
              let target = typeof exports === 'string' ? (subpath === '.' ? exports : undefined) : exports?.[subpath];
              if (target && typeof target === 'object') target = target.import ?? target.default;
              if (typeof target !== 'string') throw new Error(`Cannot resolve private export ${args.path}`);
              return { path: resolve(local.dir, target) };
            }
            if (!(name in external)) throw new Error(`Unknown external dependency ${name}`);
            return { path: args.path, external: true };
          });
        },
      },
    ],
    logLevel: 'silent',
  });
  for (const input of Object.keys(result.metafile.inputs)) {
    const path = resolve(workspaceRoot, input);
    if (
      ![...graph.values()].some((pkg) => path.startsWith(`${pkg.dir}${sep}`)) ||
      path.split(sep).includes('node_modules')
    ) {
      throw new Error(`Third-party or non-package code bundled: ${input}`);
    }
  }
  const usedDependencies = new Set(
    Object.values(result.metafile.outputs).flatMap((output) =>
      output.imports
        .filter((entry) => entry.external && !builtins.has(entry.path))
        .map((entry) => dependencyName(entry.path)),
    ),
  );
  manifest.dependencies = Object.fromEntries(
    Object.entries(manifest.dependencies).filter(([name]) => usedDependencies.has(name)),
  );
  const skillCatalogs = (await readSkillCatalogs(workspaceRoot)).filter(({ directory }) => {
    const path = resolve(directory);
    return [...graph.values()].some(({ dir }) => path.startsWith(`${resolve(dir)}${sep}`));
  });
  const skillDirectories = skillCatalogs.map(({ directory }) => resolve(directory));
  const assets = new Map();
  for (const pkg of graph.values()) {
    // Source assets are authoritative; incremental dist builds may retain deleted Markdown.
    for (const path of await markdownFiles(join(pkg.dir, 'src'))) {
      if (skillDirectories.some((directory) => path.startsWith(`${directory}${sep}`))) continue;
      const name = basename(path);
      if (assets.has(name)) throw new Error(`Relocated markdown asset collision: ${name}`);
      assets.set(name, path);
      await copyFile(path, join(outputDir, 'dist/bin', name));
    }
  }
  const owners = new Set();
  for (const { directory, catalogPath, files } of skillCatalogs) {
    const owner = basename(directory);
    if (owners.has(owner)) throw new Error(`Skill asset owner collision: ${owner}`);
    owners.add(owner);
    const destination = join(outputDir, 'dist/bin/assets', owner);
    await mkdir(destination, { recursive: true });
    await copyFile(catalogPath, join(destination, 'catalog.json'));
    for (const file of files) await copyFile(join(directory, file), join(destination, file));
  }
  for (const path of Object.values(manifest.bin)) await chmod(join(outputDir, path), 0o755);
  await copyFile(join(packageDir, 'README.md'), join(outputDir, 'README.md'));
  await copyFile(join(workspaceRoot, 'LICENSE'), join(outputDir, 'LICENSE'));
  await writeFile(join(outputDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { packageDir: outputDir, manifest };
}

/** Stage the asset-only skills package without runtime dependencies or executable bins. */
export async function stageSkillsDistribution({ workspaceRoot, packageDir, outputDir }) {
  workspaceRoot = resolve(workspaceRoot);
  packageDir = resolve(packageDir);
  outputDir = resolve(outputDir);
  if (outputDir === packageDir || outputDir.startsWith(`${packageDir}${sep}`))
    throw new Error('Distribution must be outside the source package');
  const packages = await workspacePackages(workspaceRoot);
  if (
    outputDir === workspaceRoot ||
    workspaceRoot.startsWith(`${outputDir}${sep}`) ||
    [...packages.values()].some(
      ({ dir }) => outputDir === dir || outputDir.startsWith(`${dir}${sep}`) || dir.startsWith(`${outputDir}${sep}`),
    )
  ) {
    throw new Error('Distribution must not overlap workspace source directories');
  }
  const source = await json(join(packageDir, 'package.json'));
  const manifest = createDistributionManifest(source, {});
  delete manifest.bin;
  delete manifest.dependencies;
  manifest.files = ['skills'];
  await mkdir(outputDir, { recursive: true });
  if ((await readdir(outputDir)).length > 0) throw new Error('Distribution staging directory must be empty');
  await cp(join(packageDir, 'dist/skills'), join(outputDir, 'skills'), { recursive: true });
  await copyFile(join(packageDir, 'README.md'), join(outputDir, 'README.md'));
  await copyFile(join(workspaceRoot, 'LICENSE'), join(outputDir, 'LICENSE'));
  await writeFile(join(outputDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { packageDir: outputDir, manifest };
}

/** Pack without lifecycle scripts, rename using the Nx project name, then write its SHA-256 sidecar. */
export async function packPackageDistribution({ packageDir, outputDir, projectName }) {
  outputDir = resolve(outputDir);
  await mkdir(outputDir, { recursive: true });
  const scratch = await mkdtemp(join(outputDir, '.pack-'));
  try {
    const { stdout } = await execute(
      'npm',
      ['pack', '--json', '--ignore-scripts', '--workspaces=false', '--pack-destination', outputDir],
      {
        cwd: packageDir,
        env: await preparePackageEnvironment(scratch),
        timeout: 120_000,
        killSignal: 'SIGKILL',
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const [{ filename, version }] = JSON.parse(stdout);
    const tarballPath = join(outputDir, `${projectName}-${version}.tgz`);
    await rename(join(outputDir, basename(filename)), tarballPath);
    const checksumPath = `${tarballPath}.sha256`;
    const checksum = createHash('sha256')
      .update(await readFile(tarballPath))
      .digest('hex');
    await writeFile(checksumPath, `${checksum}  ${basename(tarballPath)}\n`);
    return { tarballPath, checksumPath };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Stage and pack selected public Nx projects.
 * Each returned artifact uses `projectName` for the Nx release and `name` for the scoped npm package.
 */
export async function packPublicPackages({ projectsVersionData, outputDirectory, workspaceRoot = process.cwd() }) {
  workspaceRoot = resolve(workspaceRoot);
  outputDirectory = resolve(outputDirectory ?? join(workspaceRoot, '.release/artifacts'));
  const scratchRoot = join(workspaceRoot, '.release');
  await mkdir(scratchRoot, { recursive: true });
  const scratch = await mkdtemp(join(scratchRoot, 'stage-'));
  try {
    const artifacts = [];
    const projects = new Map(publicPackages.map((pkg) => [pkg.projectName, pkg]));
    for (const [project, data] of Object.entries(projectsVersionData)) {
      const pkg = projects.get(project);
      if (!pkg || data.newVersion == null) continue;
      const packageDir = resolve(workspaceRoot, pkg.packageDir);
      const source = await json(join(packageDir, 'package.json'));
      if (source.name !== pkg.packageName) throw new Error(`Public package identity mismatch: ${project}`);
      if (source.version !== data.newVersion) throw new Error(`Version mismatch for ${source.name}`);
      const stage = join(scratch, project);
      if (pkg.kind === 'skills') {
        await stageSkillsDistribution({ workspaceRoot, packageDir, outputDir: stage });
      } else {
        await stagePackageDistribution({ workspaceRoot, packageDir, outputDir: stage });
      }
      const packed = await packPackageDistribution({
        packageDir: stage,
        outputDir: outputDirectory,
        projectName: project,
      });
      artifacts.push({
        projectName: project,
        name: source.name,
        version: source.version,
        tag: `${project}/v${source.version}`,
        tarball: packed.tarballPath,
        checksum: packed.checksumPath,
      });
    }
    return artifacts;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
