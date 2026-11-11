import { describe, expect, it } from 'vitest';
import {
  chainCapabilitiesForProtocol,
  resolveChainCapabilities,
  resolveProtocolCapabilities,
} from '../../../src/concordium/protocol.js';
import { FakeConcordiumClient } from '../../helpers/fakes.js';

describe('resolveProtocolCapabilities', () => {
  it('returns protocol 10 token-update capabilities', async () => {
    await expect(resolveProtocolCapabilities(new FakeConcordiumClient({ protocolVersion: 10 }))).resolves.toEqual({
      networkProtocolVersion: 10,
      effectiveProtocolVersion: 10,
      supportsLocks: false,
      pltWriteMode: 'scoped',
      requiresGovernanceForNonTransferPltOps: true,
    });
  });

  it('returns protocol 11 unscoped token-update capabilities', async () => {
    await expect(resolveProtocolCapabilities(new FakeConcordiumClient({ protocolVersion: 11 }))).resolves.toEqual({
      networkProtocolVersion: 11,
      effectiveProtocolVersion: 11,
      supportsLocks: true,
      pltWriteMode: 'unscoped',
      requiresGovernanceForNonTransferPltOps: false,
    });
  });

  it('clamps newer protocols to the latest known behavior', async () => {
    await expect(resolveProtocolCapabilities(new FakeConcordiumClient({ protocolVersion: 12 }))).resolves.toEqual({
      networkProtocolVersion: 12,
      effectiveProtocolVersion: 11,
      supportsLocks: true,
      pltWriteMode: 'unscoped',
      requiresGovernanceForNonTransferPltOps: false,
    });
  });
});

describe('chainCapabilitiesForProtocol', () => {
  it('returns only positive protocol 10 chain capabilities', () => {
    expect(chainCapabilitiesForProtocol(10)).toEqual([
      'ccd.transfer',
      'ccd.registerData',
      'staking.query',
      'staking.configure',
      'contract.info',
      'contract.invoke',
      'contract.update',
      'plt.list',
      'plt.info',
      'plt.balance',
      'plt.transfer',
      'plt.mint',
      'plt.burn',
      'plt.allowList.update',
      'plt.denyList.update',
      'plt.pause',
      'plt.metadata.update',
    ]);
  });

  it('adds lock capabilities for protocol 11+', () => {
    expect(chainCapabilitiesForProtocol(11)).toEqual(
      expect.arrayContaining(['lock.list', 'lock.info', 'plt.lock.create', 'plt.lock.release']),
    );
  });

  it('labels the resolved capability list with network and reported protocol', async () => {
    await expect(
      resolveChainCapabilities(new FakeConcordiumClient({ protocolVersion: 12 }), 'testnet'),
    ).resolves.toMatchObject({
      network: 'testnet',
      protocolVersion: 12,
      capabilities: expect.arrayContaining(['lock.info']),
    });
  });
});
