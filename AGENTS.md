# AGENTS

## Communication

- Lead with the outcome, blocker, risk, or decision; keep updates concise and factual.
- At handoff, report net production, test, and documentation line changes; explain disproportionate growth.

## Change Economy

- Design from caller needs and the smallest clear API. Justify new functions, types, or layers against reusing existing operations; variations alone do not warrant separate APIs.
- Shared helpers must replace duplicated caller logic. Remove superseded paths and dead code; simplify responsibilities and branches, not formatting.
- Ask before adding unrequested compatibility layers, migration fallbacks, alternate paths, or other complexity.
- Use specialized subagents when practical: `docs-agent` for design, `tests-agent` before implementation, `implementation-agent` after design/tests, and `review-agent` before verification/handoff. Reviewers must reject unjustified APIs, abstractions, and repeated test matrices even when tests pass.

## Design And Documentation

- `docs/architecture.md` is canonical for boundaries, ownership, and invariants; update it before changing package boundaries, public API responsibilities, tool contracts, config formats, releases, or security. Keep it consistent with source types, manifests, and executable contracts; supporting package notes must not contradict it.
- CLI help owns command syntax/options; READMEs provide focused usage examples. Do not copy command trees or exhaustive reference material into architecture docs or repeat it across documents.
- Before implementation, update TSDoc for new/changed exported classes, interfaces, functions, CLI commands, tools, resources, and shared APIs.
- When assessing repository layout, automation, or documentation consistency, inspect `.github/workflows/`, root `docs/*.md`, package READMEs, and package-specific docs before concluding.

## Tests And Coverage

- Define changed behaviour in tests before implementation. Reuse existing tests for behaviour-preserving refactors; change expectations only when the contract changes.
- Each new test must cover a distinct behaviour or risk, including positive paths, guards, and failures—not each implementation branch. Avoid tautological, type-system, and dependency tests.
- Test shared policy thoroughly in its owning package; consumer tests cover wiring and consumer-specific behaviour, not a repeated policy matrix. Reuse fixtures and helpers without elaborate mock scaffolding.
- Assert stable errors (class, code/kind, exit status, `isError`, or state preservation). Match exact text only when wording is contractual; otherwise prefer key UX substrings.
- Keep unit/integration suites physically separate and independently runnable. Coverage measures units only, excluding deterministic integrations and opt-in live tests.
- Classify by component boundary: own filesystem storage, pure crypto/SDK helpers/codecs/direct bytes, and native orchestration with fake card/transport collaborators are units. Cross-component CLI/catalog, protocol-server, IPC, and real transport/APDU pipelines are integrations even with fake external endpoints, cards, or PC/SC.
- Coverage must not regress before PR/merge. Investigate redundant code before adding focused behaviour tests. Never use repetitive tests, coverage exclusions, relaxed gates, or misleading reclassification to improve coverage. Boundary-only measurements do not authorize filling unit gaps; require a separately accepted coverage objective.

### Scratch Space

- Use uniquely prefixed per-test directories under ignored `process.cwd()/.test-tmp/`; clean up in `afterEach` or `finally`. Keep `.test-tmp/` in `.gitignore`; path-format-only tests use deterministic paths there.
- Unit/coverage scratch must not use arbitrary paths, `tmpdir()`, `/tmp`, `/var/folders`, `$HOME`, or real XDG locations. Redirect `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `XDG_STATE_HOME` into per-test scratch. Real CCD/XDG state access requires explicit opt-in integration/manual tests.

## Tooling And Verification

- Use Node `>=22.23.4`, pnpm for packages/scripts, and Nx for project graph, affected tasks, and releases; never Changesets.
- Keep verification in `scripts/`; GitHub workflows are thin wrappers. Use CI entry points, not manually reconstructed typecheck/lint/build/test/coverage/smoke sequences except to debug a failing step.
- Run `pnpm verify` for non-trivial work/full pre-merge confidence: typecheck, lint, build, coverage tests, and public binary smoke tests. For small changes, run the affected subset and explain skipped full verification.
- Before requesting review, use `pnpm verify:affected` for CI-style checks (`NX_BASE`/`NX_HEAD` in CI, local Nx detection otherwise). TypeScript changes require affected typecheck, lint, build, and tests.
- For Markdown-only changes, check links, headings, and fences. For release automation, dry-run package graph/version rules when possible. Prefer MCP tools for live chain operations unless debugging below the tool layer.

## Releases And Pull Requests

- Use Conventional Commits for merged commits and PR titles; commits must pass commitlint. Prefer package scopes; breaking changes use `!` or a `BREAKING CHANGE:` footer. Limit commit headers and body lines to 160 characters; footer limits remain unchanged.
- Nx infers release bumps from commits and affected artifacts from graph/changed files. Public packages version/publish independently; private shared packages version independently without publication.
- One commit per PR unless explicitly requested otherwise. Fold review, CI, and coverage fixes into that commit before updating the PR; no unsolicited follow-up commits.
- Before commits/PRs, inspect `git status --short --branch` and `git branch --show-current`. Create a feature branch before committing on `main`/`master` unless explicitly authorized in this task; never open PRs from those branches. Keep `main` for fast-forward pulls after merge.
- If local `main` differs from `origin/main` during PR setup/cleanup (ahead, behind, or diverged), stop and explain before reset, rebase, merge, or non-fast-forward updates.
- After merge, switch to `main`, fast-forward pull, delete the merged local feature branch, prune deleted remote-tracking branches, and confirm a clean worktree.

## Security Boundaries

- Only signer performs runtime account/credential-deployment signing. Config CLI provisions material and may transiently import signing keys through shared protected storage/PIV primitives, but exposes no signing. Public catalogs are shared; identity objects/secrets and ECDH root derivation belong to identity-manager (`docs/security.md`).
- `ccd-chain-client` must never hold private keys or sign transactions.
- MCP tools must not expose private keys, passwords, wallet file paths, or sensitive local paths.
- Treat XDG config/data/state as protected local state containing sensitive operational metadata.
