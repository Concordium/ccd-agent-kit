# Development

## Toolchain And Workflow

Use Node `>=22.23.4`, pnpm, Nx, and TypeScript ESM. For substantive changes:

1. Update [architecture](./architecture.md) when boundaries, contracts, configuration,
   release behavior, or security rules change.
2. Add or update TSDoc for changed exported APIs and executable tool contracts.
3. Write positive, negative, guard, and error-path tests.
4. Implement the change, then run affected and full verification as appropriate.

Follow [AGENTS.md](../AGENTS.md) for Conventional Commits, pull requests, releases, and
review requirements.

## Commands

```sh
pnpm install
pnpm test             # all deterministic package unit and integration suites
pnpm test:unit        # unit suites with coverage
pnpm test:integration # deterministic integration suites without coverage
pnpm test:scripts     # repository script unit and integration suites
pnpm verify:affected  # CI-style Nx affected verification
pnpm verify           # full typecheck, lint, build, tests, coverage, and smoke checks
pnpm release:dry-run  # calculate releases for the current configured release branch
pnpm build && pnpm package:tools  # manually pack all public tools into .release/
pnpm --filter @ccd-agent-kit/ccd-signer test:unit
pnpm --filter @ccd-agent-kit/ccd-signer test:integration
pnpm lint:commits --from <base-sha> --to <head-sha>
```

The scripts under `scripts/` are the canonical verification entry points. CI workflows
must be thin wrappers around them. Use `pnpm verify:affected` during development and
`pnpm verify` for full pre-merge confidence. These routine commands do not pack or install
release tarballs.

`package:tools` calls `scripts/package-tools.mjs` and packs all five public packages at their
current manifest versions. It does not build first; existing build output is required. The
generated tarballs and checksums are under the ignored `.release/` directory.

The stable release channel is configured for `main` in root `release-channels.json` with
`preid: null` and npm tag `latest`, paired with the GitHub Actions push branch allowlist. Run
`pnpm release:dry-run` from `main`; an unlisted branch skips before Nx version calculation. See
[release](./release.md) for release calculation, manual npm publication, and server-side repository
setup rules.

## Test Boundaries And Coverage

Keep executable deterministic cases physically separated under each package's existing
`test/` or `tests/` root:

- `unit/` exercises one component with collaborators substituted. A storage component's
  own filesystem behavior is unit behavior. Pure cryptography, SDK helpers, codecs,
  direct-byte behavior, and native orchestration with fake card or transport collaborators
  are also unit behavior.
- `integration/` exercises real collaboration between repository components, CLI/catalog
  boundaries, protocol servers, IPC sockets, or a service through the repository's real
  transport/APDU pipeline, even when the external endpoint, card, or PC/SC layer is fake.
- `live/` contains explicit opt-in node, hardware, provider, or verifier tests. Live tests
  are excluded from normal verification, coverage, and Nx caching.

Fixtures and shared helpers stay outside suite directories. Unit and integration suites
must be independently runnable. Coverage is unit-only; integration runs must disable
coverage and must not overwrite official coverage output. Packages without integration
cases should pass without placeholder tests.

Classify tests by component boundary, not mechanics. Do not improve coverage by adding
exclusions, relaxing gates, or misclassifying integration behavior as unit behavior.

## Test Design And Scratch State

Test local behavior rather than TypeScript, schemas, CLI frameworks, SDK internals,
dependencies, or mock tautologies. For failures, prefer stable error class/code/kind,
exit code, `isError`, and state-preservation assertions. Assert exact user-facing wording
only when that wording is contractual.

Create a unique directory per test under `process.cwd()/.test-tmp/` and clean it in
`afterEach` or `finally`. Point test `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and
`XDG_STATE_HOME` beneath that directory. Unit and coverage tests must never use OS-global
temporary paths or read or write real user state.

## Executable Contracts

After building, exercise package bins rather than source files. Help must be offline
and must not require native bindings. Commander help exits `0`, usage errors exit `2`,
and domain or runtime failures exit `1`. MCP stdout is reserved for protocol frames;
startup diagnostics go to stderr.

Build and smoke scripts follow explicit mappings: Nx project `ccd-config-manager`, npm package
`@ccd-agent-kit/ccd-config-manager`, and binary `ccd-config-manager`; Nx project
`ccd-chain-client`, npm package `@ccd-agent-kit/ccd-chain-client`, and sole binary
`ccd-chain-client-mcp`. They do not infer project or binary identities from scoped package names.

Tool release output bundles only private workspace libraries, is tree-shaken
without minification, and includes the package README and root Apache License 2.0 text as
`LICENSE`. Package-owned shared assets are copied beside the bundled binaries in their
expected runtime layout. The asset-only `ccd-skills` package contains no executable or runtime
dependency. See [release](./release.md) for artifact and ordering contracts.

When changing repository layout or automation, inspect root docs, package READMEs,
package docs, and `.github/workflows/`. Change reusable scripts before workflow wrappers.
