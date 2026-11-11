import * as config from '@ccd-agent-kit/config-utils';
import { readHiddenLine } from '@ccd-agent-kit/cli-utils';
import { ed25519PublicKey } from '@ccd-agent-kit/sdk-utils';
import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runKeyCommand } from '../../../src/cli/keyCommand.js';
import { registerSoftwareCliCommand } from '../../../src/cli/softwareCliCommand.js';
import { runStorageCommand } from '../../../src/cli/storageCommand.js';
import { registerYubiKeyCliCommand } from '../../../src/cli/yubikeyCliCommand.js';

vi.mock('@ccd-agent-kit/cli-utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@ccd-agent-kit/cli-utils')>()),
  readHiddenLine: vi.fn(async () => 'pw'),
}));

vi.mock('@ccd-agent-kit/config-utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@ccd-agent-kit/config-utils')>()),
  changeEncryptedFileStoragePassword: vi.fn(),
  adoptEncryptedFileKey: vi.fn(),
  checkEncryptedFileIntegrity: vi.fn(),
  generateLocalEd25519Key: vi.fn(),
  importLocalEd25519Key: vi.fn(),
  importSoftwareKeyFile: vi.fn(),
  initializeEncryptedFileStorage: vi.fn(),
  isEncryptedFileStorageConfigured: vi.fn(),
  isEncryptedFileStorageUnlocked: vi.fn(),
  isSoftwareStorageModuleEnabled: vi.fn(),
  lockEncryptedFileStorage: vi.fn(),
  parseSoftwareKeyStorageModule: vi.fn(),
  setSoftwareStorageModulePolicy: vi.fn(),
  unlockEncryptedFileStorage: vi.fn(),
}));

const PUBLIC_KEY = ed25519PublicKey.require('d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737');

describe('software key command orchestration', () => {
  const stderr: string[] = [];
  const stdout: string[] = [];

  beforeEach(() => {
    vi.resetAllMocks();
    stderr.length = 0;
    stdout.length = 0;
    vi.mocked(config.parseSoftwareKeyStorageModule).mockImplementation(value => {
      if (value === 'encrypted-file') return value;
      throw new Error('Storage module must be supported.');
    });
    vi.mocked(config.isEncryptedFileStorageConfigured).mockReturnValue(true);
    vi.mocked(config.importLocalEd25519Key).mockResolvedValue({ publicKey: PUBLIC_KEY, keyRef: 'key-ref' });
    vi.mocked(config.generateLocalEd25519Key).mockResolvedValue({ publicKey: PUBLIC_KEY, keyRef: 'key-ref' });
  });

  it('unlocks encrypted storage before requesting and importing a private key', async () => {
    const order: string[] = [];
    vi.mocked(config.unlockEncryptedFileStorage).mockImplementation(() => { order.push('unlock'); });
    vi.mocked(config.importLocalEd25519Key).mockImplementation(async () => {
      order.push('import');
      return { publicKey: PUBLIC_KEY, keyRef: 'key-ref' };
    });

    expect(await runKeyCommand({
      request: { action: 'import', label: ' key ' }, stderr, stdout,
      promptUnlockPassword: async () => { order.push('password'); return 'pw'; },
      promptPrivateKey: async () => { order.push('private-key'); return '11'.repeat(32); },
    })).toBe(0);

    expect(order).toEqual(['password', 'unlock', 'private-key', 'import']);
    expect(config.importLocalEd25519Key).toHaveBeenCalledWith({
      label: ' key ', privateKeyHex: '11'.repeat(32), storage: 'encrypted-file',
    });
    expect(stdout).toContain('Label: key');
  });

  it('fails storage preflight before requesting private material or mutating storage', async () => {
    vi.mocked(config.isEncryptedFileStorageConfigured).mockReturnValue(false);
    const promptUnlockPassword = vi.fn(async () => 'pw');
    const promptPrivateKey = vi.fn(async () => '11'.repeat(32));

    expect(await runKeyCommand({
      request: { action: 'import' }, stderr, stdout, promptUnlockPassword, promptPrivateKey,
    })).toBe(1);

    expect(promptUnlockPassword).not.toHaveBeenCalled();
    expect(promptPrivateKey).not.toHaveBeenCalled();
    expect(config.unlockEncryptedFileStorage).not.toHaveBeenCalled();
    expect(config.importLocalEd25519Key).not.toHaveBeenCalled();
    expect(stderr.join('\n')).toMatch(/storage init/i);
  });

  it('rejects an incorrect encrypted-file password before reading or importing the file', async () => {
    vi.mocked(config.unlockEncryptedFileStorage).mockImplementation(() => {
      throw new Error('incorrect storage password');
    });
    const promptPrivateKey = vi.fn(async () => 'unused');

    expect(await runKeyCommand({
      request: { action: 'import', file: 'protected-key.json', storage: 'encrypted-file' },
      stderr, stdout,
      promptUnlockPassword: async () => 'wrong',
      promptPrivateKey,
    })).toBe(1);

    expect(config.unlockEncryptedFileStorage).toHaveBeenCalledWith('wrong');
    expect(config.importSoftwareKeyFile).not.toHaveBeenCalled();
    expect(config.importLocalEd25519Key).not.toHaveBeenCalled();
    expect(promptPrivateKey).not.toHaveBeenCalled();
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(['incorrect storage password']);
  });

  it('dispatches file imports without requesting a private key and renders structured wallet results', async () => {
    vi.mocked(config.importSoftwareKeyFile).mockResolvedValue({
      kind: 'wallet-export', address: 'account-address', publicKeys: [PUBLIC_KEY],
    });
    const promptPrivateKey = vi.fn(async () => 'unused');

    expect(await runKeyCommand({
      request: { action: 'import', file: 'wallet.export', storage: 'encrypted-file', label: 'wallet' },
      stderr, stdout, promptPrivateKey,
    })).toBe(0);

    expect(config.importSoftwareKeyFile).toHaveBeenCalledWith({
      filePath: 'wallet.export', label: 'wallet', storage: 'encrypted-file',
    });
    expect(promptPrivateKey).not.toHaveBeenCalled();
    expect(stdout.join('\n')).toMatch(/Account: account-address.*Imported keys: 1.*account credentials refresh/s);
  });

  it('reports producer failures with a nonzero result and no success rendering', async () => {
    vi.mocked(config.importSoftwareKeyFile).mockRejectedValue(new Error('protected store rejected import'));

    expect(await runKeyCommand({
      request: { action: 'import', file: 'key.json', storage: 'encrypted-file' }, stderr, stdout,
    })).toBe(1);
    expect(stderr).toEqual(['protected store rejected import']);
    expect(stdout).toEqual([]);
  });

  it('unlocks encrypted storage before explicitly adopting a verified managed file', async () => {
    const order: string[] = [];
    vi.mocked(config.unlockEncryptedFileStorage).mockImplementation(() => { order.push('unlock'); });
    vi.mocked(config.adoptEncryptedFileKey).mockImplementation(() => { order.push('adopt'); });

    expect(await runKeyCommand({
      request: { action: 'adopt', publicKey: PUBLIC_KEY, label: 'restored' }, stderr, stdout,
      promptUnlockPassword: async () => { order.push('password'); return 'pw'; },
    })).toBe(0);

    expect(order).toEqual(['password', 'unlock', 'adopt']);
    expect(config.adoptEncryptedFileKey).toHaveBeenCalledWith({ publicKey: PUBLIC_KEY, label: 'restored' });
    expect(stdout).toEqual([JSON.stringify({ publicKey: PUBLIC_KEY }, null, 2)]);
  });

  it('does not mutate the inventory when the adoption password is rejected', async () => {
    vi.mocked(config.unlockEncryptedFileStorage).mockImplementation(() => { throw new Error('incorrect storage password'); });

    expect(await runKeyCommand({
      request: { action: 'adopt', publicKey: PUBLIC_KEY }, stderr, stdout,
      promptUnlockPassword: async () => 'wrong',
    })).toBe(1);

    expect(config.adoptEncryptedFileKey).not.toHaveBeenCalled();
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(['incorrect storage password']);
  });

  it('generates directly into encrypted-file when storage is omitted', async () => {
    expect(await runKeyCommand({
      request: { action: 'generate', label: ' generated ' }, stderr, stdout,
      promptUnlockPassword: async () => 'storage-password',
    })).toBe(0);

    expect(config.generateLocalEd25519Key).toHaveBeenCalledWith({
      label: ' generated ', storage: 'encrypted-file',
    });
    expect(config.unlockEncryptedFileStorage).toHaveBeenCalledWith('storage-password');
    expect(config.importLocalEd25519Key).not.toHaveBeenCalled();
    expect(stdout).toEqual([
      `Public key: ${PUBLIC_KEY}`,
      'Storage: encrypted-file',
      'Label: generated',
    ]);
    expect(stdout.join('\n')).not.toMatch(/private/i);
  });

  it('rejects a removed storage selector before reading or producing private material', async () => {
    const promptPrivateKey = vi.fn(async () => '11'.repeat(32));
    expect(await runKeyCommand({
      request: { action: 'import', file: 'removed.json', storage: 'removed-storage' as 'encrypted-file' },
      stderr, stdout, promptPrivateKey,
    })).toBe(1);
    expect(config.importSoftwareKeyFile).not.toHaveBeenCalled();
    expect(config.importLocalEd25519Key).not.toHaveBeenCalled();
    expect(config.generateLocalEd25519Key).not.toHaveBeenCalled();
    expect(promptPrivateKey).not.toHaveBeenCalled();
    expect(stderr.join('\n')).toMatch(/storage module.*supported/i);
  });

  it('dispatches parsed software options and propagates nested exit decisions', async () => {
    vi.mocked(config.importSoftwareKeyFile).mockResolvedValue({
      kind: 'local-key', publicKey: PUBLIC_KEY, keyRef: 'key-ref',
    });
    vi.mocked(config.isSoftwareStorageModuleEnabled).mockReturnValue(true);
    vi.mocked(config.isEncryptedFileStorageConfigured).mockReturnValue(true);
    const program = new Command().exitOverride();
    const exitCodes: number[] = [];
    registerYubiKeyCliCommand({
      program, stderr, stdout,
      runNested: async result => { exitCodes.push(await result); },
    });
    registerSoftwareCliCommand({
      program, stderr, stdout,
      runNested: async result => { exitCodes.push(await result); },
    });

    await program.parseAsync([
      'signing-key', 'import', '--backend', 'software', '--file', 'key.json', '--storage', 'encrypted-file', '--label', 'cli',
    ], { from: 'user' });
    await program.parseAsync(['storage', 'list'], { from: 'user' });

    expect(config.importSoftwareKeyFile).toHaveBeenCalledWith({
      filePath: 'key.json', label: 'cli', storage: 'encrypted-file',
    });
    expect(exitCodes).toEqual([0, 0]);
  });

  it('routes explicit encrypted-file adoption without hardware trust confirmation', async () => {
    const confirm = vi.fn(async () => true);
    const program = new Command().exitOverride();
    const exitCodes: number[] = [];
    registerYubiKeyCliCommand({
      program, stderr, stdout,
      interactionFactory: () => ({ promptPin: vi.fn(), promptManagementKey: vi.fn(), confirm }),
      runNested: async result => { exitCodes.push(await result); },
    });

    await program.parseAsync([
      'signing-key', 'adopt', '--backend', 'software', '--storage', 'encrypted-file',
      '--public-key', PUBLIC_KEY, '--label', 'recovered',
    ], { from: 'user' });

    expect(exitCodes).toEqual([0]);
    expect(config.adoptEncryptedFileKey).toHaveBeenCalledWith({ publicKey: PUBLIC_KEY, label: 'recovered' });
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each([
    ['missing storage', ['signing-key', 'adopt', '--backend', 'software', '--public-key', PUBLIC_KEY]],
    ['missing public key', ['signing-key', 'adopt', '--backend', 'software', '--storage', 'encrypted-file']],
    ['unsupported storage', [
      'signing-key', 'adopt', '--backend', 'software', '--storage', 'removed-storage', '--public-key', PUBLIC_KEY,
    ]],
    ['malformed public key', [
      'signing-key', 'adopt', '--backend', 'software', '--storage', 'encrypted-file', '--public-key', 'not-a-key',
    ]],
    ['hardware device', [
      'signing-key', 'adopt', '--backend', 'software', '--storage', 'encrypted-file', '--public-key', PUBLIC_KEY, '--device', '123',
    ]],
    ['hardware slot', [
      'signing-key', 'adopt', '--backend', 'software', '--storage', 'encrypted-file', '--public-key', PUBLIC_KEY, '--slot', '9c',
    ]],
  ] as const)('rejects software adoption with %s before unlock or catalog mutation', async (_case, args) => {
    const program = new Command().exitOverride();
    registerYubiKeyCliCommand({ program, stderr, stdout, runNested: async result => { await result; } });

    await expect(program.parseAsync([...args], { from: 'user' })).rejects.toMatchObject({ exitCode: 2 });

    expect(config.unlockEncryptedFileStorage).not.toHaveBeenCalled();
    expect(config.adoptEncryptedFileKey).not.toHaveBeenCalled();
    expect(readHiddenLine).not.toHaveBeenCalled();
  });

  it('rejects software-only adoption options for PIV before hardware inspection or trust confirmation', async () => {
    const inspectDevice = vi.fn();
    const confirm = vi.fn(async () => true);
    const program = new Command().exitOverride();
    registerYubiKeyCliCommand({
      program, stderr, stdout, runNested: async result => { await result; },
      serviceFactory: () => ({ inspectDevice, close: vi.fn() }) as never,
      interactionFactory: () => ({ promptPin: vi.fn(), promptManagementKey: vi.fn(), confirm }),
    });

    await expect(program.parseAsync([
      'signing-key', 'adopt', '--backend', 'yubikey-piv', '--device', '123', '--slot', '9c',
      '--storage', 'encrypted-file', '--public-key', PUBLIC_KEY,
    ], { from: 'user' })).rejects.toThrow(/software/i);

    expect(inspectDevice).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('software storage command orchestration', () => {
  const stderr: string[] = [];
  const stdout: string[] = [];

  beforeEach(() => {
    vi.resetAllMocks();
    stderr.length = 0;
    stdout.length = 0;
    vi.mocked(config.parseSoftwareKeyStorageModule).mockImplementation(value => {
      if (value === 'encrypted-file') return value;
      throw new Error('Storage module must be supported.');
    });
    vi.mocked(config.isEncryptedFileStorageConfigured).mockReturnValue(true);
    vi.mocked(config.isSoftwareStorageModuleEnabled).mockReturnValue(true);
  });

  it('lists the encrypted storage module with policy and readiness without mutation', async () => {
    const program = new Command().exitOverride();
    const exitCodes: number[] = [];
    registerSoftwareCliCommand({
      program, stderr, stdout,
      runNested: async result => { exitCodes.push(await result); },
    });

    await program.parseAsync(['storage', 'list'], { from: 'user' });

    expect(exitCodes).toEqual([0]);
    expect(JSON.parse(stdout[0]!)).toEqual({
      backends: {
        'encrypted-file': { policy: 'enabled', readiness: 'locked' },
      },
    });
    expect(config.setSoftwareStorageModulePolicy).not.toHaveBeenCalled();
  });

  it('inspects encrypted-file storage', async () => {
    const program = new Command().exitOverride();
    const exitCodes: number[] = [];
    registerSoftwareCliCommand({
      program, stderr, stdout,
      runNested: async result => { exitCodes.push(await result); },
    });

    await program.parseAsync(['storage', 'inspect', '--storage', 'encrypted-file'], { from: 'user' });

    expect(exitCodes).toEqual([0]);
    const rendered = stdout.join('\n');
    expect(rendered).toContain('encrypted-file');
    expect(rendered).toContain('locked');
  });

  it('rejects missing or removed storage inspection selectors without changing policy', async () => {
    const program = new Command().exitOverride();
    const exitCodes: number[] = [];
    registerSoftwareCliCommand({
      program, stderr, stdout,
      runNested: async result => { exitCodes.push(await result); },
    });

    await expect(program.parseAsync(['storage', 'inspect'], { from: 'user' }))
      .rejects.toThrow(/required option.*storage/i);
    await program.parseAsync(['storage', 'inspect', '--storage', 'unknown'], { from: 'user' });

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('\n')).toMatch(/supported|unknown/i);
    expect(config.setSoftwareStorageModulePolicy).not.toHaveBeenCalled();
    expect(stdout).toEqual([]);
  });

  it.each([
    ['enable', 'enabled'],
    ['disable', 'disabled'],
  ] as const)('%ss a parsed backend through the policy producer', async (action, policy) => {
    expect(await runStorageCommand({
      request: { action, backend: 'encrypted-file' }, stderr, stdout,
    })).toBe(0);
    expect(config.setSoftwareStorageModulePolicy).toHaveBeenCalledWith('encrypted-file', policy);
  });

  it('reports policy setter failures without success output', async () => {
    vi.mocked(config.setSoftwareStorageModulePolicy).mockImplementationOnce(() => { throw new Error('enable write failed'); });
    const result = await runStorageCommand({
      request: { action: 'enable', backend: 'encrypted-file' }, stderr, stdout,
    });
    expect(result).toBe(1);
    expect(stderr).toEqual(['enable write failed']);
    expect(stdout).toEqual([]);
  });

  it('dispatches parsed Commander policy mutations to the real storage runner', async () => {
    const program = new Command().exitOverride();
    const exitCodes: number[] = [];
    registerSoftwareCliCommand({
      program, stderr, stdout,
      runNested: async result => { exitCodes.push(await result); },
    });

    await program.parseAsync(['storage', 'enable', '--storage', 'encrypted-file'], { from: 'user' });
    await program.parseAsync(['storage', 'disable', '--storage', 'encrypted-file'], { from: 'user' });

    expect(exitCodes).toEqual([0, 0]);
    expect(config.setSoftwareStorageModulePolicy).toHaveBeenNthCalledWith(1, 'encrypted-file', 'enabled');
    expect(config.setSoftwareStorageModulePolicy).toHaveBeenNthCalledWith(2, 'encrypted-file', 'disabled');
  });

  it('requests new passwords in order and does not initialize after cancellation or mismatch', async () => {
    const prompts: string[] = [];
    const passwords = ['one', 'two'];
    expect(await runStorageCommand({
      request: { action: 'init', backend: 'encrypted-file' }, stderr, stdout,
      promptPassword: async prompt => { prompts.push(prompt); return passwords.shift() ?? ''; },
    })).toBe(1);

    expect(prompts).toEqual(['New encrypted-file password: ', 'Repeat new encrypted-file password: ']);
    expect(config.initializeEncryptedFileStorage).not.toHaveBeenCalled();
    expect(stderr.join('\n')).toMatch(/passwords do not match/i);
    expect(stdout).toEqual([]);

    stderr.length = 0;
    const cancelled = runStorageCommand({
      request: { action: 'init', backend: 'encrypted-file' }, stderr, stdout,
      promptPassword: async () => { throw new Error('cancelled'); },
    });
    await expect(cancelled).resolves.toBe(1);
    expect(config.initializeEncryptedFileStorage).not.toHaveBeenCalled();
    expect(stderr).toEqual(['cancelled']);
  });

  it('initializes encrypted storage after matching password prompts', async () => {
    const prompts: string[] = [];

    expect(await runStorageCommand({
      request: { action: 'init', backend: 'encrypted-file' }, stderr, stdout,
      promptPassword: async prompt => { prompts.push(prompt); return 'pw'; },
    })).toBe(0);

    expect(prompts).toEqual(['New encrypted-file password: ', 'Repeat new encrypted-file password: ']);
    expect(config.initializeEncryptedFileStorage).toHaveBeenCalledOnce();
    expect(config.initializeEncryptedFileStorage).toHaveBeenCalledWith('pw');
    expect(stdout).toEqual(['Encrypted-file storage initialized.']);
  });

  it('reports initialization failure without success output', async () => {
    vi.mocked(config.initializeEncryptedFileStorage).mockImplementation(() => { throw new Error('init failed'); });

    expect(await runStorageCommand({
      request: { action: 'init', backend: 'encrypted-file' }, stderr, stdout,
      promptPassword: async () => 'pw',
    })).toBe(1);

    expect(stderr).toEqual(['init failed']);
    expect(stdout).toEqual([]);
  });

  it('changes a password before locking and leaves storage unlocked on producer failure', async () => {
    const order: string[] = [];
    const passwords = ['old', 'new', 'new'];
    vi.mocked(config.changeEncryptedFileStoragePassword).mockImplementation(() => { order.push('change'); });
    vi.mocked(config.lockEncryptedFileStorage).mockImplementation(() => { order.push('lock'); });

    expect(await runStorageCommand({
      request: { action: 'change-password', backend: 'encrypted-file' }, stderr, stdout,
      promptPassword: async prompt => { order.push(prompt); return passwords.shift() ?? ''; },
    })).toBe(0);
    expect(order).toEqual([
      'Current encrypted-file password: ', 'New encrypted-file password: ',
      'Repeat new encrypted-file password: ', 'change', 'lock',
    ]);

    vi.mocked(config.changeEncryptedFileStoragePassword).mockImplementation(() => { throw new Error('change failed'); });
    vi.mocked(config.lockEncryptedFileStorage).mockClear();
    const retryPasswords = ['old', 'new', 'new'];
    expect(await runStorageCommand({
      request: { action: 'change-password', backend: 'encrypted-file' }, stderr, stdout,
      promptPassword: async () => retryPasswords.shift() ?? '',
    })).toBe(1);
    expect(config.lockEncryptedFileStorage).not.toHaveBeenCalled();
  });

  it('requires initialized encrypted storage before integrity prompts or work', async () => {
    vi.mocked(config.isEncryptedFileStorageConfigured).mockReturnValue(false);
    const promptPassword = vi.fn(async () => 'pw');

    expect(await runStorageCommand({
      request: { action: 'integrity', backend: 'encrypted-file', fix: false }, stderr, stdout, promptPassword,
    })).toBe(1);

    expect(stderr.join('\n')).toMatch(/not initialized.*storage init/i);
    expect(promptPassword).not.toHaveBeenCalled();
    expect(config.unlockEncryptedFileStorage).not.toHaveBeenCalled();
    expect(config.checkEncryptedFileIntegrity).not.toHaveBeenCalled();
    expect(stdout).toEqual([]);
  });

  it.each([
    [false, false, false, 'uninitialized', 0],
    [true, false, true, 'locked', 1],
    [true, true, true, 'ready', 1],
  ] as const)('reports configured=%s unlocked=%s enabled=%s as %s', async (configured, unlocked, enabled, readiness, unlockChecks) => {
    vi.mocked(config.isEncryptedFileStorageConfigured).mockReturnValue(configured);
    vi.mocked(config.isEncryptedFileStorageUnlocked).mockReturnValue(unlocked);
    vi.mocked(config.isSoftwareStorageModuleEnabled).mockReturnValue(enabled);

    expect(await runStorageCommand({ request: { action: 'status' }, stderr, stdout })).toBe(0);

    expect(JSON.parse(stdout[0]!)).toEqual({
      backends: {
        'encrypted-file': { policy: enabled ? 'enabled' : 'disabled', readiness },
      },
    });
    expect(config.isEncryptedFileStorageUnlocked).toHaveBeenCalledTimes(unlockChecks);
  });

  it.each(['enable', 'disable', 'init', 'change-password', 'integrity'] as const)(
    'validates the backend before prompting or mutation for %s',
    async action => {
      const promptPassword = vi.fn(async () => 'pw');
      expect(await runStorageCommand({
        request: { action, backend: 'unknown', fix: false }, stderr, stdout, promptPassword,
      })).toBe(1);
      expect(promptPassword).not.toHaveBeenCalled();
      expect(config.initializeEncryptedFileStorage).not.toHaveBeenCalled();
      expect(config.setSoftwareStorageModulePolicy).not.toHaveBeenCalled();
    },
  );

  it('renders a structured integrity result only after unlock and reports producer failure truthfully', async () => {
    const orphan = ed25519PublicKey.require('22'.repeat(32));
    vi.mocked(config.checkEncryptedFileIntegrity).mockResolvedValue({
      okReferences: [],
      missingReferences: [{ publicKey: PUBLIC_KEY }],
      invalidEntries: [], adoptableOrphans: [{ publicKey: orphan }],
      prunedMissingReferences: [{ publicKey: PUBLIC_KEY }],
    });
    expect(await runStorageCommand({
      request: { action: 'integrity', backend: 'encrypted-file', fix: true }, stderr, stdout,
      promptPassword: async () => 'pw',
    })).toBe(0);
    expect(config.unlockEncryptedFileStorage).toHaveBeenCalledWith('pw');
    expect(stdout.join('\n')).toMatch(/integrity repaired.*Pruned missing reference:/s);
    expect(stdout.join('\n')).toContain(`signing-key adopt --backend software --storage encrypted-file --public-key ${orphan}`);

    stdout.length = 0;
    vi.mocked(config.checkEncryptedFileIntegrity).mockRejectedValue(new Error('repair partially failed'));
    expect(await runStorageCommand({
      request: { action: 'integrity', backend: 'encrypted-file', fix: true }, stderr, stdout,
      promptPassword: async () => 'pw',
    })).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.at(-1)).toBe('repair partially failed');
  });
});
