import { describe, expect, it, vi } from 'vitest';

import {
  NetworkResourceError,
  ResourceSubscriptionManager,
  registerNetworkResourceFamily,
  type NetworkResourceAdapter,
  type NetworkResourceFamily,
  type NetworkResourceNetwork,
} from '../../src/resources.js';

type TestNetwork = { id: string };
const MAINNET = network('mainnet', '9dd9ca4d19e9393877d2c44b70f89acb');
const TESTNET = network('testnet', '4221332d34e1694168c2a0c0b3fd0f27');

function network(name: string, reference: string): NetworkResourceNetwork<TestNetwork> {
  return { name, caip2: `ccd:${reference}`, value: { id: name } };
}

function adapter(initial: readonly NetworkResourceNetwork<TestNetwork>[] = [TESTNET, MAINNET]) {
  let configured = initial;
  let defaultNetwork = initial[0];
  const result: NetworkResourceAdapter<TestNetwork> & {
    set(next: readonly NetworkResourceNetwork<TestNetwork>[], nextDefault?: NetworkResourceNetwork<TestNetwork>): void;
  } = {
    list: () => configured,
    resolveDefault: () => defaultNetwork ?? failNetwork(),
    resolve: (selector) =>
      configured.find(({ name, caip2 }) => name === selector || caip2.slice(4) === selector) ?? failNetwork(),
    set: (next, nextDefault = next[0]) => {
      configured = next;
      defaultNetwork = nextDefault;
    },
  };
  return result;
}

function failNetwork(): never {
  throw new NetworkResourceError('NETWORK_NOT_FOUND', 'The selected network is not configured.');
}

function family(
  read: NetworkResourceFamily<TestNetwork, { items: string[] }>['read'] = async ({ network, parameters }) => ({
    items: [`${network.value.id}:${parameters.account ?? 'all'}`],
  }),
): NetworkResourceFamily<TestNetwork, { items: string[] }> {
  return { name: 'accounts', title: 'Accounts', description: 'Known accounts.', path: 'accounts/{account}', read };
}

function json(content: { text: string }): unknown {
  return JSON.parse(content.text);
}

describe('registerNetworkResourceFamily', () => {
  it('derives default, configured-name, bare-reference, and wildcard routes', async () => {
    const registration = registerNetworkResourceFamily(adapter(), family());
    expect(registration.definitions.map(({ uri }) => uri)).toEqual(
      expect.arrayContaining([
        'ccd://accounts/{account}',
        'ccd://{network}/accounts/{account}',
        'ccd://*/accounts/{account}',
      ]),
    );
    await expect(registration.read('ccd://accounts/alice').then(json)).resolves.toEqual({
      network: 'testnet',
      caip2: TESTNET.caip2,
      result: { items: ['testnet:alice'] },
    });
    for (const uri of ['ccd://mainnet/accounts/alice', `ccd://${MAINNET.caip2.slice(4)}/accounts/alice`]) {
      await expect(registration.read(uri).then(json)).resolves.toEqual({
        network: 'mainnet',
        caip2: MAINNET.caip2,
        result: { items: ['mainnet:alice'] },
      });
    }
  });

  it('keeps wildcard parameters, empty snapshots, and per-network failures exact', async () => {
    const registration = registerNetworkResourceFamily(
      adapter(),
      family(async ({ network, parameters }) => {
        if (network.name === 'testnet') return { items: [parameters.account!] };
        throw new NetworkResourceError('NODE_REQUEST_FAILED', 'The network is unavailable.');
      }),
    );
    await expect(registration.read('ccd://*/accounts/alice').then(json)).resolves.toEqual({
      networks: {
        testnet: { network: 'testnet', caip2: TESTNET.caip2, result: { items: ['alice'] } },
        mainnet: {
          network: 'mainnet',
          caip2: MAINNET.caip2,
          error: {
            code: 'NODE_REQUEST_FAILED',
            message: 'The network is unavailable.',
          },
        },
      },
    });
    await expect(
      registerNetworkResourceFamily(adapter([]), family()).read('ccd://*/accounts/alice').then(json),
    ).resolves.toEqual({ networks: {} });
  });

  it('completes one sorted snapshot with deduplicated names and bare references', async () => {
    const registration = registerNetworkResourceFamily(
      adapter([TESTNET, network('archive', MAINNET.caip2.slice(4)), MAINNET]),
      family(),
    );
    await expect(registration.complete('network')).resolves.toEqual(
      [TESTNET.caip2.slice(4), MAINNET.caip2.slice(4), 'archive', 'mainnet', 'testnet'].sort(),
    );
    await expect(registration.complete('account')).resolves.toEqual([]);
  });

  it('rejects malformed paths and URIs without exposing supplied fragments', async () => {
    for (const path of [
      '',
      '/accounts',
      'accounts/',
      'accounts/%encoded',
      'accounts/{bad-name}',
      'accounts/{id}/{id}',
    ]) {
      expect(() => registerNetworkResourceFamily(adapter(), { ...family(), path })).toThrow();
    }
    const registration = registerNetworkResourceFamily(adapter(), family());
    for (const uri of [
      'http://mainnet/accounts/alice',
      'ccd://user:secret@mainnet/accounts/alice',
      'ccd://mainnet/accounts/alice?token=secret',
      'ccd://mainnet/accounts/%2e%2e',
      'ccd://mainnet/accounts/.',
      'ccd://mainnet/accounts/alice/',
      'ccd://mainnet/accounts/alice/extra',
    ]) {
      const error = await registration.read(uri).catch((caught) => caught);
      expect(error).toMatchObject({ kind: 'invalid-argument', message: 'The resource URI is invalid.' });
    }
  });

  it('preserves approved errors and sanitizes unknown read failures', async () => {
    const approved = registerNetworkResourceFamily(
      adapter(),
      family(async () => {
        throw new NetworkResourceError('RESOURCE_NOT_FOUND', 'The account was not found.');
      }),
    );
    await expect(approved.read('ccd://accounts/alice')).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    const unknown = registerNetworkResourceFamily(
      adapter(),
      family(async () => {
        throw new Error('/Users/operator/.config/ccd/secret.json');
      }),
    );
    await expect(unknown.read('ccd://accounts/alice')).rejects.toMatchObject({
      code: 'RESOURCE_READ_FAILED',
      message: 'The resource could not be read.',
    });
  });
});

describe('ResourceSubscriptionManager', () => {
  it('publishes key lock and runtime-status invalidations only to ccd://keys', async () => {
    const notify = vi.fn().mockRejectedValueOnce(new Error('client closed')).mockResolvedValue(undefined);
    const manager = new ResourceSubscriptionManager({
      registrations: [],
      globals: [{ name: 'keys', uri: 'ccd://keys' }],
      notify,
    });
    await manager.subscribe('ccd://keys');
    await manager.subscribe('ccd://keys');

    manager.invalidate({ resourceName: 'keys' }); // software lock change
    manager.invalidate({ resourceName: 'keys' }); // observed hardware/runtime status change
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
    await manager.unsubscribe('ccd://keys');
    manager.invalidate({ resourceName: 'keys' });
    await Promise.resolve();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('pins default, explicit, and wildcard identity scopes for issued and failed terminal events', async () => {
    const networks = adapter();
    const identities = registerNetworkResourceFamily(networks, {
      ...family(),
      name: 'identities',
      path: 'identities',
      subscribable: true,
    });
    const notify = vi.fn();
    const manager = new ResourceSubscriptionManager({ registrations: [identities], globals: [], notify });
    const uris = ['ccd://identities', `ccd://${MAINNET.caip2.slice(4)}/identities`, 'ccd://*/identities'];
    for (const uri of uris) await manager.subscribe(uri);
    networks.set([network('newnet', '11'.repeat(16))]);

    manager.invalidate({ resourceName: 'identities', network: 'testnet' }); // background terminal issued
    manager.invalidate({ resourceName: 'identities', network: 'mainnet' }); // background terminal failed
    manager.invalidate({ resourceName: 'identities', network: 'newnet' });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(4));
    expect(notify.mock.calls.map(([uri]) => uri).sort()).toEqual(
      [
        'ccd://*/identities',
        'ccd://*/identities',
        'ccd://identities',
        `ccd://${MAINNET.caip2.slice(4)}/identities`,
      ].sort(),
    );
    notify.mockClear();
    manager.invalidate({ resourceName: 'identities' });
    await Promise.resolve();
    expect(notify).not.toHaveBeenCalled();
  });

  it('reads subscribed identity URIs from their pinned snapshot and unsubscribed URIs fresh', async () => {
    const networks = adapter();
    const identities = registerNetworkResourceFamily(networks, {
      ...family(),
      name: 'identities',
      path: 'identities',
      subscribable: true,
    });
    const manager = new ResourceSubscriptionManager({ registrations: [identities], globals: [], notify: vi.fn() });
    const uris = ['ccd://identities', 'ccd://mainnet/identities', 'ccd://*/identities'];
    for (const uri of uris) await manager.subscribe(uri);
    const newnet = network('newnet', '11'.repeat(16));
    networks.set([TESTNET, MAINNET, newnet], newnet);

    for (const [uri, expected] of [
      [uris[0], { network: 'testnet' }],
      [uris[1], { network: 'mainnet' }],
      [uris[2], { networks: { testnet: {}, mainnet: {} } }],
    ] as const) {
      await expect(manager.read(uri).then(json)).resolves.toMatchObject(expected);
    }
    await manager.unsubscribe(uris[0]);
    await expect(manager.read(uris[0]).then(json)).resolves.toMatchObject({ network: 'newnet' });
    await expect(manager.read('ccd://unknown')).rejects.toMatchObject({ kind: 'invalid-argument' });
  });

  it('rejects a pinned network whose canonical identity changes', async () => {
    let current = MAINNET;
    const mutableAdapter: NetworkResourceAdapter<TestNetwork> = {
      list: () => [current],
      resolveDefault: () => current,
      resolve: () => current,
    };
    const identities = registerNetworkResourceFamily(mutableAdapter, {
      ...family(),
      path: 'identities',
      subscribable: true,
    });
    const manager = new ResourceSubscriptionManager({ registrations: [identities], globals: [], notify: vi.fn() });
    await manager.subscribe('ccd://mainnet/identities');
    current = network('mainnet', '11'.repeat(16));

    await expect(manager.read('ccd://mainnet/identities')).rejects.toMatchObject({ code: 'NETWORK_NOT_FOUND' });
  });

  it('rejects unknown and unflagged resources and clears exact subscriptions', async () => {
    const unflagged = registerNetworkResourceFamily(adapter(), { ...family(), path: 'accounts' });
    const notify = vi.fn();
    const manager = new ResourceSubscriptionManager({
      registrations: [unflagged],
      globals: [{ name: 'keys', uri: 'ccd://keys' }],
      notify,
    });
    await expect(manager.subscribe('ccd://accounts')).rejects.toMatchObject({ kind: 'invalid-argument' });
    await expect(manager.subscribe('ccd://missing')).rejects.toMatchObject({ kind: 'invalid-argument' });
    await expect(manager.subscribe('ccd://accounts/%2e%2e')).rejects.toMatchObject({ kind: 'invalid-argument' });
    await manager.subscribe('ccd://keys');
    manager.invalidate({ resourceName: 'other', network: 'testnet' });
    await Promise.resolve();
    expect(notify).not.toHaveBeenCalled();
    await manager.close();
    manager.invalidate({ resourceName: 'keys' });
    await Promise.resolve();
    await Promise.resolve();
    expect(notify).not.toHaveBeenCalled();
    await manager.subscribe('ccd://keys');
    manager.invalidate({ resourceName: 'keys' });
    await Promise.resolve();
    expect(notify).not.toHaveBeenCalled();
  });
});
