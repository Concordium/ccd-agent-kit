import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import {
  encodeCatalogLabel,
  findSignerInventoryKeyByLabel,
  forgetSignerInventoryKeyLocation,
  loadSignerInventory,
  reorderSignerInventoryKeyBackends,
  reorderSignerInventoryKeyLocations,
  setSignerInventoryKeyLabel,
  type PivDeviceLocator,
  type SignerInventory,
} from '@ccd-agent-kit/config-utils';
import { ed25519PublicKey } from '@ccd-agent-kit/sdk-utils';

import { registerSigningKeyCliCommand } from '../../../src/cli/signingKeyCliCommand.js';

vi.mock('@ccd-agent-kit/config-utils', async (importOriginal) => ({
  ...await importOriginal<typeof import('@ccd-agent-kit/config-utils')>(),
  loadSignerInventory: vi.fn(),
  findSignerInventoryKeyByLabel: vi.fn(),
  forgetSignerInventoryKeyLocation: vi.fn(),
  reorderSignerInventoryKeyBackends: vi.fn(),
  reorderSignerInventoryKeyLocations: vi.fn(),
  setSignerInventoryKeyLabel: vi.fn(),
}));

const PUBLIC_KEY = ed25519PublicKey.require('11'.repeat(32));
const KEY_REF = `ed25519:${PUBLIC_KEY}` as const;
const SECOND_PUBLIC_KEY = ed25519PublicKey.require('22'.repeat(32));
const SECOND_KEY_REF = `ed25519:${SECOND_PUBLIC_KEY}` as const;
const NOW = '2026-10-25T00:00:00.000Z';
const loadCatalog = vi.mocked(loadSignerInventory);
const findByLabel = vi.mocked(findSignerInventoryKeyByLabel);
const setLabel = vi.mocked(setSignerInventoryKeyLabel);
const forgetLocation = vi.mocked(forgetSignerInventoryKeyLocation);
const reorderBackends = vi.mocked(reorderSignerInventoryKeyBackends);
const reorderLocations = vi.mocked(reorderSignerInventoryKeyLocations);

function catalog(label?: string): SignerInventory {
  return {
    version: 1,
    updatedAt: NOW,
    keys: {
      [KEY_REF]: {
        scheme: 'Ed25519',
        backends: [{ signingModule: 'test', backend: { location: 'one' }, createdAt: NOW, updatedAt: NOW }],
        createdAt: NOW,
        updatedAt: NOW,
        ...(label === undefined ? {} : { label: encodeCatalogLabel(label, 'hard') }),
      },
    },
  };
}

function command() {
  const stdout: string[] = [];
  const program = new Command().exitOverride();
  registerSigningKeyCliCommand({ program, stdout, stderr: [] });
  return {
    stdout,
    run: (...args: string[]) => program.parseAsync(['signing-key', ...args], { from: 'user' }),
  };
}

describe('signing-key CLI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    forgetLocation.mockReset();
    loadCatalog.mockReturnValue(catalog('Primary'));
    findByLabel.mockReturnValue([KEY_REF, catalog('Primary').keys[KEY_REF]!]);
  });

  it.each([
    ['inspect'],
    ['inspect', '--signing-key', 'gg'.repeat(32)],
  ])('rejects a missing or invalid inspection selector without loading or writing: %j', async (...args) => {
    await expect(command().run(...args)).rejects.toThrow();
    expect(loadCatalog).not.toHaveBeenCalled();
    expect(setLabel).not.toHaveBeenCalled();
  });

  it.each([
    '22'.repeat(32),
    'Unknown',
  ])('rejects an unknown inspection selector without writing: %s', async (selector) => {
    if (selector === 'Unknown') findByLabel.mockReturnValueOnce(undefined);
    await expect(command().run('inspect', '--signing-key', selector)).rejects.toThrow(/not found/i);
    if (selector === 'Unknown') expect(loadCatalog).not.toHaveBeenCalled();
    else expect(loadCatalog).toHaveBeenCalledOnce();
    expect(setLabel).not.toHaveBeenCalled();
  });

  it.each([
    { option: '--public-key', args: ['label', 'set', '--public-key', PUBLIC_KEY, '--label', 'New'] },
    { option: '--label', args: ['forget', '--label', 'Primary'] },
  ])('rejects the legacy $option selector before mutation', async ({ args }) => {
    await expect(command().run(...args)).rejects.toThrow();
    expect(setLabel).not.toHaveBeenCalled();
    expect(forgetLocation).not.toHaveBeenCalled();
  });

  it('delegates case-insensitive label selection and preserves stored spelling in inspect output', async () => {
    const result = command();
    await result.run('inspect', '--signing-key', '  primary  ');
    expect(findByLabel).toHaveBeenCalledWith('primary');
    expect(loadCatalog).not.toHaveBeenCalled();
    expect(JSON.parse(result.stdout[0]!)).toEqual({
      keyRef: KEY_REF,
      scheme: 'Ed25519',
      backends: [{ signingModule: 'test', backend: { location: 'one' }, createdAt: NOW, updatedAt: NOW }],
      createdAt: NOW,
      updatedAt: NOW,
      label: { label: 'Primary', mode: 'hard' },
    });
  });

  it('lists only ordered backend IDs while inspect preserves the full signing-key record', async () => {
    const inventory = catalog('Primary');
    inventory.keys[KEY_REF]!.backends.push({ ...inventory.keys[KEY_REF]!.backends[0]!, signingModule: 'future-hsm' });
    inventory.keys[SECOND_KEY_REF] = catalog().keys[KEY_REF]!;
    loadCatalog.mockReturnValue(inventory);
    const result = command();

    await result.run('list');
    await result.run('inspect', '--signing-key', PUBLIC_KEY);

    expect(JSON.parse(result.stdout[0]!)).toEqual({
      signingKeys: [
        { keyRef: KEY_REF, label: { label: 'Primary', mode: 'hard' }, scheme: 'Ed25519', backends: ['test', 'future-hsm'] },
        { keyRef: SECOND_KEY_REF, scheme: 'Ed25519', backends: ['test'] },
      ],
    });
    expect(JSON.parse(result.stdout[1]!)).toEqual({ keyRef: KEY_REF, ...inventory.keys[KEY_REF], label: { label: 'Primary', mode: 'hard' } });
  });

  it('lists an empty signing-key catalog with the stable envelope', async () => {
    loadCatalog.mockReturnValue({ version: 1, updatedAt: NOW, keys: {} });
    const result = command();

    await result.run('list');

    expect(JSON.parse(result.stdout[0]!)).toEqual({ signingKeys: [] });
  });

  it('rejects malformed set options before catalog access or writes', async () => {
    for (const args of [
      ['label', 'set', '--signing-key', 'bad label', '--mode', 'hard', '--label', 'valid'],
      ['label', 'set', '--signing-key', PUBLIC_KEY, '--mode', 'other', '--label', 'valid'],
      ['label', 'set', '--signing-key', PUBLIC_KEY, '--mode', 'hard', '--label', '@invalid'],
    ]) {
      await expect(command().run(...args)).rejects.toThrow();
    }
    expect(loadCatalog).not.toHaveBeenCalled();
    expect(setLabel).not.toHaveBeenCalled();
  });

  it('selects by the old label while normalizing the new label assignment', async () => {
    const result = command();
    setLabel.mockReturnValueOnce({ label: 'StoredAgent', mode: 'hard' });
    await result.run('label', 'set', '--signing-key', ' primary ', '--mode', 'soft', '--label', '  Agent_1  ');
    expect(findByLabel).toHaveBeenCalledWith('primary');
    expect(setLabel).toHaveBeenCalledWith({ publicKey: PUBLIC_KEY, label: 'Agent_1', mode: 'soft' });
    expect(JSON.parse(result.stdout[0]!)).toEqual({ publicKey: PUBLIC_KEY, label: 'StoredAgent', mode: 'hard' });

    setLabel.mockReturnValueOnce({ label: 'Operator', mode: 'hard' });
    await result.run('label', 'set', '--signing-key', PUBLIC_KEY, '--label', 'Operator');
    expect(setLabel).toHaveBeenLastCalledWith({ publicKey: PUBLIC_KEY, label: 'Operator' });
  });

  it('delegates omitted label text for mode conversion without reading the inventory', async () => {
    setLabel.mockReturnValueOnce({ label: 'Primary', mode: 'soft' });
    await command().run('label', 'set', '--signing-key', PUBLIC_KEY, '--mode', 'soft');
    expect(setLabel).toHaveBeenCalledWith({ publicKey: PUBLIC_KEY, mode: 'soft' });
    expect(loadCatalog).not.toHaveBeenCalled();
  });

  it('removes a label and preserves the public JSON shape', async () => {
    const result = command();
    await result.run('label', 'remove', '--signing-key', ' primary ');
    expect(findByLabel).toHaveBeenCalledWith('primary');
    expect(setLabel).toHaveBeenCalledWith({ publicKey: PUBLIC_KEY, operation: 'remove' });
    expect(JSON.parse(result.stdout[0]!)).toEqual({ publicKey: PUBLIC_KEY });
  });

  it('propagates producer failures without emitting success or retrying', async () => {
    const producerError = new Error('duplicate label');
    setLabel.mockImplementationOnce(() => { throw producerError; });
    const result = command();
    await expect(result.run('label', 'set', '--signing-key', PUBLIC_KEY, '--mode', 'hard', '--label', 'Taken'))
      .rejects.toBe(producerError);
    expect(result.stdout).toEqual([]);
    expect(setLabel).toHaveBeenCalledOnce();
  });

  it('forgets a signing key selected by normalized public key or label and reports each success', async () => {
    const result = command();

    await result.run('forget', '--signing-key', PUBLIC_KEY);
    await result.run('forget', '--signing-key', '  primary  ');

    expect(findByLabel).toHaveBeenCalledWith('primary');
    expect(forgetLocation).toHaveBeenNthCalledWith(1, PUBLIC_KEY, 'all');
    expect(forgetLocation).toHaveBeenNthCalledWith(2, PUBLIC_KEY, 'all');
    expect(result.stdout.map(output => JSON.parse(output))).toEqual([
      { publicKey: PUBLIC_KEY },
      { publicKey: PUBLIC_KEY },
    ]);
  });

  it('propagates signing-key forget producer failure without emitting success or retrying', async () => {
    const producerError = new Error('inventory write failed');
    forgetLocation.mockImplementationOnce(() => { throw producerError; });
    const result = command();

    await expect(result.run('forget', '--signing-key', PUBLIC_KEY)).rejects.toBe(producerError);

    expect(result.stdout).toEqual([]);
    expect(forgetLocation).toHaveBeenCalledOnce();
  });

  it('routes backend and canonical raw-location ordering through catalog producers', async () => {
    const locations = [
      { kind: 'yubikey', serial: '123', slot: '9c', lastSeenAt: NOW },
      { kind: 'yubikey', serial: '456', slot: '82' },
    ] satisfies PivDeviceLocator[];

    await command().run(
      'backend', 'order', '--signing-key', PUBLIC_KEY,
      '--backends', 'yubikey-piv,software-signer',
    );
    expect(reorderBackends).toHaveBeenCalledWith({
      publicKey: PUBLIC_KEY, backends: ['yubikey-piv', 'software-signer'],
    });
    expect(loadCatalog).not.toHaveBeenCalled();

    await command().run(
      'locations', 'order', '--signing-key', ' primary ', '--backend', 'yubikey-piv',
      '--locations', JSON.stringify(locations),
    );
    expect(findByLabel).toHaveBeenLastCalledWith('primary');
    expect(reorderLocations).toHaveBeenCalledWith({
      publicKey: PUBLIC_KEY, signingModule: 'yubikey-piv', locations,
    });

    await command().run(
      'locations', 'order', '--signing-key', PUBLIC_KEY, '--backend', 'yubikey-piv',
      '--locations', JSON.stringify(locations),
    );
    expect(reorderLocations).toHaveBeenLastCalledWith({
      publicKey: PUBLIC_KEY, signingModule: 'yubikey-piv', locations,
    });
  });

  it.each([
    {
      selector: ['--signing-key', 'Primary'], backend: 'yubikey-piv',
      location: { kind: 'yubikey', serial: '123', slot: '9c', lastSeenAt: NOW },
    },
    {
      selector: ['--signing-key', PUBLIC_KEY], backend: 'software-signer',
      location: { storageModule: 'encrypted-file', keyRef: 'keys/primary' },
    },
  ])('forgets exactly one JSON location under $backend', async ({ selector, backend, location }) => {
    await command().run(
      'locations', 'forget', ...selector, '--backend', backend,
      '--location', JSON.stringify(location),
    );
    expect(forgetLocation).toHaveBeenCalledWith(PUBLIC_KEY, { backend, location });
  });

  it.each([
    ['forget'],
    ['forget', '--signing-key', 'bad label'],
    ['locations', 'forget', '--signing-key', PUBLIC_KEY, '--backend', 'yubikey-piv'],
    ['locations', 'forget', '--signing-key', PUBLIC_KEY, '--backend', 'yubikey-piv', '--location', '[]'],
    ['locations', 'forget', '--signing-key', PUBLIC_KEY, '--backend', 'future-hsm', '--location', '{}'],
    ['locations', 'order', '--signing-key', PUBLIC_KEY, '--backend', 'yubikey-piv', '--locations', '{}'],
    ['locations', 'order', '--signing-key', PUBLIC_KEY, '--backend', 'future-hsm', '--locations', '[]'],
    ['backend', 'order', '--signing-key', PUBLIC_KEY, '--backends', 'yubikey-piv,yubikey-piv'],
  ])('rejects malformed ordering/forget syntax before catalog mutation: %j', async (...args) => {
    const result = command();
    await expect(result.run(...args)).rejects.toThrow();
    expect(result.stdout).toEqual([]);
    expect(forgetLocation).not.toHaveBeenCalled();
    expect(reorderBackends).not.toHaveBeenCalled();
    expect(reorderLocations).not.toHaveBeenCalled();
  });

  it.each([
    ['forget', '--signing-key', 'Unknown'],
    ['backend', 'order', '--signing-key', PUBLIC_KEY, '--backends', 'yubikey-piv,'],
    ['locations', 'order', '--signing-key', PUBLIC_KEY, '--backend', 'yubikey-piv', '--locations', '[null]'],
    ['locations', 'forget', '--signing-key', PUBLIC_KEY, '--backend', 'yubikey-piv', '--location', 'null'],
  ])('rejects unresolved selectors and structurally invalid ordering values: %j', async (...args) => {
    if (args.includes('Unknown')) findByLabel.mockReturnValueOnce(undefined);

    const result = command();
    await expect(result.run(...args)).rejects.toThrow();

    expect(result.stdout).toEqual([]);
    expect(forgetLocation).not.toHaveBeenCalled();
    expect(reorderBackends).not.toHaveBeenCalled();
    expect(reorderLocations).not.toHaveBeenCalled();
  });
});
