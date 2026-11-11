import { publicPackages } from './public-packages.mjs';

/**
 * Version with Nx, pack public tarballs, then create release metadata and upload assets.
 * First-release state is forwarded to Nx so disk versions seed conventional version calculation.
 * A non-null preid selects the Nx prerelease channel for calculated versions.
 * Private projects retain independent release metadata but never produce registry artifacts.
 * Dry runs calculate versions only; no packing, tags, releases, or uploads occur.
 */
export async function runRelease({
  dryRun = false,
  firstRelease = false,
  preid = null,
  version,
  pack,
  changelog,
  upload,
}) {
  const versionOptions = {
    dryRun,
    firstRelease,
    gitCommit: false,
    gitTag: false,
    gitPush: false,
    stageChanges: false,
  };
  if (preid !== null) versionOptions.preid = preid;
  const { projectsVersionData, releaseGraph } = await version(versionOptions);
  const publicProjects = new Set(publicPackages.map((pkg) => pkg.projectName));
  const selected = Object.fromEntries(
    Object.entries(projectsVersionData).filter(([name, data]) => publicProjects.has(name) && data.newVersion != null),
  );
  const projects = Object.keys(selected);
  if (dryRun || !Object.values(projectsVersionData).some((data) => data.newVersion != null)) {
    return { projects, projectsVersionData, artifacts: [] };
  }
  const artifacts = projects.length === 0 ? [] : await pack(selected);
  const remaining = new Set(projects);
  const packageNames = new Map(publicPackages.map((pkg) => [pkg.projectName, pkg.packageName]));
  for (const artifact of artifacts) {
    if (
      !remaining.delete(artifact.projectName) ||
      artifact.name !== packageNames.get(artifact.projectName) ||
      artifact.version !== selected[artifact.projectName].newVersion ||
      artifact.tag !== `${artifact.projectName}/v${artifact.version}` ||
      typeof artifact.tarball !== 'string' ||
      artifact.tarball.trim() === '' ||
      typeof artifact.checksum !== 'string' ||
      artifact.checksum.trim() === ''
    ) {
      throw new Error('Release artifacts do not match the planned public project versions.');
    }
  }
  if (remaining.size > 0) throw new Error('Missing artifacts for planned public project releases.');
  await changelog({
    dryRun: false,
    versionData: projectsVersionData,
    releaseGraph,
    gitCommit: false,
    gitTag: true,
    gitPush: true,
    stageChanges: false,
    interactive: 'none',
  });
  if (artifacts.length > 0) await upload(artifacts);
  return { projects, projectsVersionData, artifacts };
}
