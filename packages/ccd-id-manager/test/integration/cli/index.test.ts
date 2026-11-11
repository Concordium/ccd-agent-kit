import { describe, expect, it, vi } from 'vitest';

import { runCli, type IdentityCliDependencies } from '../../../src/cli/index.js';

function cliFixture() {
  const stdout = vi.fn<(text: string) => void>();
  const stderr = vi.fn<(text: string) => void>();
  const resolveProviderNetwork = vi.fn();
  const providerOperation = vi.fn();
  const sourceOperation = vi.fn();
  const workflowOperation = vi.fn();
  const deps: IdentityCliDependencies = {
    stdout,
    stderr,
    resolveProviderNetwork,
    providerService: new Proxy({}, { get: () => providerOperation }) as NonNullable<IdentityCliDependencies['providerService']>,
    sourceService: new Proxy({}, { get: () => sourceOperation }) as NonNullable<IdentityCliDependencies['sourceService']>,
    workflow: new Proxy({}, { get: () => workflowOperation }) as NonNullable<IdentityCliDependencies['workflow']>,
  };

  return { deps, stdout, stderr, resolveProviderNetwork, providerOperation, sourceOperation, workflowOperation };
}

describe('ccd-id-manager real Commander adapter', () => {
  it.each([
    [[], 'Usage: ccd-id-manager'],
    [['--help'], 'Usage: ccd-id-manager'],
    [['-h'], 'Usage: ccd-id-manager'],
    [['idp', '--help'], 'Usage: ccd-id-manager idp'],
    [['idp', '-h'], 'Usage: ccd-id-manager idp'],
    [['identity', 'label', '--help'], 'Usage: ccd-id-manager identity label'],
    [['identity', 'label', '-h'], 'Usage: ccd-id-manager identity label'],
  ] as const)('renders help successfully without resolving or invoking operations: %j', async (argv, usage) => {
    const h = cliFixture();

    expect(await runCli([...argv], h.deps)).toBe(0);
    expect(h.stdout.mock.calls.flat().join('')).toContain(usage);
    expect(h.stderr).not.toHaveBeenCalled();
    expect(h.resolveProviderNetwork).not.toHaveBeenCalled();
    expect(h.providerOperation).not.toHaveBeenCalled();
    expect(h.sourceOperation).not.toHaveBeenCalled();
    expect(h.workflowOperation).not.toHaveBeenCalled();
  });

  it.each([
    ['help'],
    ['help', 'idp'],
    ['idp', 'help'],
    ['identity', 'label', 'help'],
  ])('rejects generated help subcommands without invoking operations: %j', async (...argv) => {
    const h = cliFixture();

    expect(await runCli(argv, h.deps)).toBe(2);
    expect(h.stdout).not.toHaveBeenCalled();
    expect(h.stderr).toHaveBeenCalled();
    expect(h.resolveProviderNetwork).not.toHaveBeenCalled();
    expect(h.providerOperation).not.toHaveBeenCalled();
    expect(h.sourceOperation).not.toHaveBeenCalled();
    expect(h.workflowOperation).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown'],
    ['idp', 'inspect'],
  ])('keeps Commander usage failures at exit code 2 without invoking operations: %j', async (...argv) => {
    const h = cliFixture();

    expect(await runCli(argv, h.deps)).toBe(2);
    expect(h.stderr).toHaveBeenCalled();
    expect(h.resolveProviderNetwork).not.toHaveBeenCalled();
    expect(h.providerOperation).not.toHaveBeenCalled();
    expect(h.sourceOperation).not.toHaveBeenCalled();
    expect(h.workflowOperation).not.toHaveBeenCalled();
  });
});
