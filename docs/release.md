# Release

## Model

Nx independently versions workspace projects from Conventional Commits, affected files, and the
project graph. Releasable package manifests remain at `0.0.0` in source and provide the disk
fallback when no project release tag exists. Generated versions are applied only in the CI
workspace; release automation does not commit or push manifest changes. Do not use Changesets or
hand-edit package versions for a release.

Nx 22.7.12 excludes a repository's root commit from its Conventional Commit range. Therefore, a
repository initialized with a single release-worthy root commit has no release until a later
release-worthy commit affects a releasable project. Do not add a version override or initialization
commit to force that first release. Confirm calculated projects and versions with
`pnpm release:dry-run` from `main`.

Projects use annotated tags in this form:

```text
{projectName}/v{version}
```

Public Nx project names are `ccd-signer`, `ccd-chain-client`, `ccd-config-manager`,
`ccd-id-manager`, and `ccd-skills`. Their npm names are respectively
`@ccd-agent-kit/ccd-signer`, `@ccd-agent-kit/ccd-chain-client`,
`@ccd-agent-kit/ccd-config-manager`, `@ccd-agent-kit/ccd-id-manager`, and
`@ccd-agent-kit/ccd-skills`. Public/private classification uses the explicit private flag and
workspace identity, not npm scope. Private shared packages are independently versioned but are
never published.

## Release Channel

`release-channels.json` is the release branch allowlist and contains only the stable channel on
`main`:

```json
{
  "main": {
    "preid": null,
    "npmTag": "latest"
  }
}
```

GitHub Actions selects the branch from `GITHUB_REF_NAME`; a local invocation uses
`git branch --show-current`. An unlisted branch exits successfully before version calculation,
build, release creation, or upload, including for `--dry-run`. There is no wildcard or fallback
branch. The entry fails closed unless `preid` is explicitly `null` or a nonempty string and
`npmTag` is nonempty. On `main`, `preid: null` omits Nx's prerelease option and uses its existing
stable-version mechanics; `npmTag: "latest"` selects the manual publication dist-tag.

The CI push allowlist and `release-channels.json` must remain synchronized with only `main`.
Pull requests cannot release. Every push to `main` runs full `pnpm verify`; only a successful
verification permits the automatic release job to calculate versions, package affected public
projects, create project tags and GitHub Releases, and upload assets.

## GitHub Release Assets

Each affected public project receives one npm-installable package tarball and one checksum:

```text
<projectName>-<version>.tgz
<projectName>-<version>.tgz.sha256
```

The manifest version, asset version, Nx project release, and project tag must match. Checksums use
lowercase SHA-256 in standard `<hex>  <filename>` form. Missing artifacts, release lookup failures,
or upload failures fail the automatic release job.

Public source and staged manifests set `publishConfig.access` to `public`. Private workspace
libraries are bundled and tree-shaken into each public tool package and do not remain runtime
dependencies. Third-party packages remain external npm dependencies. Each tool tarball contains
its manifest, compiled output, package README, and the root Apache License 2.0 text as `LICENSE`.
The asset-only skills package contains only its minimal manifest, README, LICENSE, and `skills/**`;
it has no executable, runtime dependency, native code, or install hook.

Artifact mapping and staging are keyed by unscoped `projectName`, never the slash-containing npm
name. The release script applies Nx-selected versions, builds selected public projects, stages
package contents, runs `npm pack`, renames the result to the project-named asset, and computes its
checksum. Dry-run remains calculation-only: it does not build, pack, checksum, tag, create a
release, upload, or publish.

Automatic release never invokes Nx `releasePublish` or npm publication. GitHub Releases hold
generated changelog text; the repository does not maintain committed `CHANGELOG.md` files.

## Manual npm Publication

npm publication is a separate, manually dispatched GitHub Actions workflow. It runs only from
`main`, targets one existing project release, downloads that release's `.tgz` and `.tgz.sha256`
assets, verifies the checksum and package identity/version, and publishes the unchanged tarball
with the `latest` dist-tag. It does not rebuild or repack the package.

The publish job uses npm trusted publishing through GitHub OIDC with `id-token: write`; it has no
`NPM_TOKEN` secret or token input. The job is bound to the protected `npm` environment. Configure
that environment to allow deployments from `main` only, disallow administrator bypass, require an
authorized npm release owner other than the workflow initiator, and prevent self-review. Before
approving, the reviewer must inspect the selected project tag and GitHub Release and confirm the
tarball identity and checksum. Dispatching the workflow does not replace this approval.

The workflow uses npm CLI `>=11.5.1`; npm trusted publishing requires Node `>=22.14.0`, which is
satisfied by this repository's Node `>=22.23.4` requirement. Configure one trusted publisher for
each of the five public packages under the `@ccd-agent-kit` scope with these exact values:

| npm trusted-publisher field | Value             |
| --------------------------- | ----------------- |
| Organization or user        | `Concordium`      |
| Repository                  | `ccd-agent-kit`   |
| Workflow filename           | `publish-npm.yml` |
| Environment name            | `npm`             |

Apply that configuration independently to `@ccd-agent-kit/ccd-signer`,
`@ccd-agent-kit/ccd-chain-client`, `@ccd-agent-kit/ccd-config-manager`,
`@ccd-agent-kit/ccd-id-manager`, and `@ccd-agent-kit/ccd-skills`. The workflow performs direct
`npm publish`, so explicitly enable **Allow npm publish** for every trusted publisher. New trusted
publishers created after September 3, 2026 permit staged publishing by default and do not permit
direct publishing unless this option is selected.

Each package must already exist before its trusted publisher can be configured. To bootstrap an
absent package, an authorized npm owner must use the same independently reviewed GitHub Release
asset, not a rebuilt package:

1. Download the `.tgz` and `.tgz.sha256` assets from the project release.
2. Verify the checksum and package identity/version.
3. Authenticate locally with interactive npm login and 2FA.
4. Publish the verified tarball:

```sh
npm publish ./<asset>.tgz --tag latest --access public --ignore-scripts
```

This bootstrap uses no GitHub secret. Do not add `NPM_TOKEN` to the workflow as a fallback. After
creating each trusted publisher, complete its first successful publish within two days; if that
window expires, delete and recreate the registration. Before enabling routine publication, verify
the `main`-only environment gate and independent review controls above, then successfully exercise
OIDC publication without a token fallback. See npm's current
[Trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

## Version Mapping

| Commit                                                   | Bump            |
| -------------------------------------------------------- | --------------- |
| `fix:` or `perf:`                                        | patch           |
| `feat:`                                                  | minor           |
| `type!:` or `BREAKING CHANGE:`                           | major           |
| `docs:`, `test:`, `refactor:`, `build:`, `ci:`, `chore:` | none by default |

Breaking changes include incompatible CLI/MCP schemas, config formats, or shared APIs requiring
dependent updates. Prefer package scopes such as `fix(signer): ...`,
`feat(config-manager): ...`, or `fix(chain-client): ...`. Commit headers and body lines are limited
to 160 characters; footer limits remain unchanged.

## Automation And Verification

Pull-request workflows run semantic-title and commitlint checks plus `pnpm verify:affected`.
Pushes to `main` run `pnpm verify`, then the automatic GitHub release path. Verification runs
deterministic unit and integration suites; coverage is measured from unit tests. Reports are
collected from package LCOV files and uploaded to Codecov under package flags. Configure
`CODECOV_TOKEN` with the same value as both an Actions secret and a Dependabot secret so
authenticated uploads also work for Dependabot pull requests. Codecov uploads are not required
repository checks.

`pnpm release` and `pnpm release:dry-run` call the repository release script. It invokes Nx release
APIs programmatically: versioning runs without a release commit, and changelog generation creates
and pushes project tags and GitHub Releases. GitHub CLI uploads each public tarball and checksum.
The release command accepts only `--dry-run`.

For standalone local packaging, run `pnpm build`, then `pnpm package:tools`. This packs all five
public packages at their source manifest versions into ignored `.release/`; it does not install or
publish them. Routine `pnpm verify` and `pnpm verify:affected` do not package release tarballs.

For release changes run:

```sh
pnpm release:dry-run
pnpm verify
```

GitHub Releases must remain mutable while automation runs because the Nx flow creates each release
before the release script uploads its assets.

## Installing Release Assets

Download the tarball and sibling checksum from the selected project GitHub Release and verify it
before installation. For example:

```sh
sha256sum --check ccd-signer-<VERSION>.tgz.sha256
npm install --global ./ccd-signer-<VERSION>.tgz
```

Use the equivalent short project-named asset for the other packages. `ccd-skills` is useful only
when a harness cannot consume skills served through the MCP Skills extension. Node `>=22.23.4` is
required. Hardware-backed packages additionally require the system PC/SC support needed by the
external native dependency; no broader platform matrix is claimed.
