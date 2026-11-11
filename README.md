# CCD Agent Kit

Concordium CLI and MCP tools for operators and AI agents. Query the chain, build and sign
transactions, manage identities, and follow guided workflows.

## Public Packages

| Package                                                                      | Use it for                                                                             |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [`@ccd-agent-kit/ccd-config-manager`](packages/ccd-config-manager/README.md) | Configure networks, labels, signing-key storage, YubiKey devices, and runtime policy.  |
| [`@ccd-agent-kit/ccd-chain-client`](packages/ccd-chain-client/README.md)     | Query nodes, build and verify transactions, and explicitly submit completed artifacts. |
| [`@ccd-agent-kit/ccd-signer`](packages/ccd-signer/README.md)                 | Inspect and sign transactions or messages with locally controlled keys.                |
| [`@ccd-agent-kit/ccd-id-manager`](packages/ccd-id-manager/README.md)         | Issue and recover identities, create proofs, and prepare account openings.             |
| [`@ccd-agent-kit/ccd-skills`](packages/ccd-skills/README.md)                 | Add the packaged workflow skills to harnesses without MCP Skills extension support.    |

| Contents                            |
| ----------------------------------- |
| [Public Packages](#public-packages) |
| [Getting Started](#getting-started) |
| [Skills](#skills)                   |
| [Safety](#safety)                   |
| [License](#license)                 |
| [Development](#development)         |

## Getting Started

Build from source by following [Development](#development). To install a published release instead,
download the matching `.tgz` and `.tgz.sha256` assets from the project's
[GitHub Release](https://github.com/Concordium/ccd-agent-kit/releases), verify the checksum, and follow
[Installing Release Assets](docs/release.md#installing-release-assets). Packages are independently
versioned. npm publication under the `latest` tag is a separate,
manually approved operation described in the
[release guide](docs/release.md#manual-npm-publication).

Node.js `>=22.23.4` is required. Installing the config manager, signer, or identity manager also
requires native build tools and the PC/SC development support used by `pcsclite`; this applies to
config-manager and signer installations even when you plan to use software keys only. Hardware
operations additionally require a working PC/SC service and supported device. The chain client
does not use the native PC/SC stack.

1. Install the config manager from its downloaded release asset:

   ```sh
   npm install --global ./ccd-config-manager-<VERSION>.tgz
   ```

2. Use the [config-manager guide](packages/ccd-config-manager/README.md) to configure a network and
   provision the storage, keys, or devices needed by your workflow.
3. Install the independently versioned signer, chain-client, identity-manager, or skills assets
   you need.
4. Follow each package README for its quick start and CLI or MCP launch configuration.

## Skills

The `ccd-skills` package is only for harnesses that cannot consume the MCP Skills extension.
Harnesses with extension support should use the skills served by the MCP servers. In either case,
skills are workflow guidance: they still require access to the corresponding MCP tools and
resources and do not grant authority to perform an operation.

## Safety

- The signer is the only runtime that uses account-signing private material. Config manager may
  handle it transiently during explicit provisioning or import, but never signs.
- The chain client never holds private keys or reads signer storage. Submission is always an
  explicit step and is distinct from building or signing.
- Review the information disclosed by identity proofs and account openings before approving
  them. Account-opening preparation neither signs nor submits.
- MCP output excludes private keys, PINs, passwords, protected paths, and undisclosed identity
  data.

See the complete [security model](docs/security.md).

## License

Licensed under the [Apache License 2.0](LICENSE). Release tarballs include the license text.

## Development

Use Node.js `>=22.23.4` and pnpm:

```sh
pnpm install
pnpm build
pnpm verify:affected  # PR-style affected checks
pnpm verify           # full typecheck, lint, build, tests, coverage, and smoke checks
pnpm build && pnpm package:tools  # package all five public tarballs into .release/
```

Contributor references: [development](docs/development.md),
[architecture](docs/architecture.md), [codebase flows](docs/codebase-flows.md), and
[release](docs/release.md).
