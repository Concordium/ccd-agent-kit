import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Prepare protected, repository-local state for npm packing. */
export async function preparePackageEnvironment(root, inherited = process.env) {
  const env = Object.fromEntries(
    Object.entries(inherited).filter(
      ([key]) =>
        !/^(?:CCD(?:_|$)|XDG_|HOME$|USERPROFILE$|NODE_|NPM_CONFIG_|npm_config_|GH_TOKEN$|GITHUB_TOKEN$)/.test(key),
    ),
  );
  await Promise.all(
    ['home', 'config', 'data', 'state', 'cache', 'runtime', 'tmp'].map((dir) =>
      mkdir(join(root, dir), { recursive: true, mode: 0o700 }),
    ),
  );
  await writeFile(join(root, '.npmrc'), '', { mode: 0o600 });
  await writeFile(join(root, 'global-npmrc'), '', { mode: 0o600 });
  return {
    ...env,
    HOME: join(root, 'home'),
    USERPROFILE: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_RUNTIME_DIR: join(root, 'runtime'),
    npm_config_cache: join(root, 'npm-cache'),
    npm_config_userconfig: join(root, '.npmrc'),
    npm_config_globalconfig: join(root, 'global-npmrc'),
    npm_config_ignore_scripts: 'false',
    npm_config_devdir: join(root, 'node-gyp'),
    npm_config_workspaces: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    TMPDIR: join(root, 'tmp'),
  };
}
