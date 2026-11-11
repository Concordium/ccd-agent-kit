# @ccd-agent-kit/ccd-skills

Public asset-only distribution of the workflow skills served by the CCD MCP servers.

This package is needed **only** by agent harnesses that cannot consume the MCP Skills extension.
Harnesses with MCP Skills extension support should use the skills served directly by
`ccd-chain-client-mcp`, `ccd-signer-mcp`, and `ccd-id-manager-mcp` instead.

| Contents                                          |
| ------------------------------------------------- |
| [Included skills](#included-skills)               |
| [Installation and setup](#installation-and-setup) |
| [Source and license](#source-and-license)         |

## Included Skills

Each skill is packaged as `skills/<name>/SKILL.md`. The corresponding MCP resource URI is
listed below to make the relationship to server-served skills explicit.

| Skill / MCP resource URI                              | What it guides you through                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `skill://ccd-network-discovery/SKILL.md`              | Find the active default Concordium network or list configured networks.                                 |
| `skill://ccd-account-label-discovery/SKILL.md`        | Find configured account labels and understand their network scope.                                      |
| `skill://ccd-transfer/SKILL.md`                       | Transfer CCD using the separated build, sign, and submit workflow.                                      |
| `skill://ccd-plt-transfer/SKILL.md`                   | Transfer protocol-level tokens using MCP tools.                                                         |
| `skill://ccd-sponsored-multisig-transaction/SKILL.md` | Coordinate sponsored or multi-signature account transactions.                                           |
| `skill://ccd-signer-key-discovery/SKILL.md`           | Find cataloged public signing keys or accounts the signer can sign for.                                 |
| `skill://ccd-identity-management/SKILL.md`            | Check identity readiness and manage issuance, recovery, discovery, account opening, or identity proofs. |

The package contains `skills/<name>/SKILL.md` assets only. It has no binary, runtime dependency,
native code, install hook, harness installer, adapter, or MCP server. A skill is workflow guidance,
not an implementation of its operations: using it still requires access to the corresponding MCP
tools and resources and the authority required by those operations.

## Installation And Setup

Follow
[Installing Release Assets](https://github.com/Concordium/ccd-agent-kit/blob/main/docs/release.md#installing-release-assets)
for checksum verification and installation of the `ccd-skills` release tarball.

Copy or symlink the desired directories from `skills/` into the skill directory configured for
your harness, following that harness's discovery instructions. Installing the npm package alone
does not register the skills with a harness.

## Source And License

The packaged skills are generated from the same JSON catalogs and Markdown sources used by the
servers. See the canonical
[architecture](https://github.com/Concordium/ccd-agent-kit/blob/main/docs/architecture.md#skill-assets-and-catalogs)
for source ownership, naming, build, and release contracts.

The package includes the repository's
[Apache License 2.0](https://github.com/Concordium/ccd-agent-kit/blob/main/LICENSE) as `LICENSE`.
