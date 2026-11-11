import { describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({
  accounts: [{ name: 'accounts', uri: 'test://accounts', read: vi.fn() }],
  keys: { name: 'keys', uri: 'test://keys' },
  networks: { name: 'networks', uri: 'test://networks' },
  readKeys: vi.fn(),
  readNetworks: vi.fn(),
  readSignerInstance: vi.fn(),
  signerInstance: { name: 'instance', uri: 'test://instance' },
  skillDefinitions: vi.fn(() => [{ name: 'skill', uri: 'test://skill', read: vi.fn() }]),
}));

vi.mock('../../../../src/mcp/resources/accountsResource.js', () => ({
  accountsResourceRegistration: { definitions: fakes.accounts },
}));
vi.mock('../../../../src/mcp/resources/keysResource.js', () => ({
  keysResource: fakes.keys,
  readKeysResource: fakes.readKeys,
}));
vi.mock('../../../../src/mcp/resources/networksResource.js', () => ({
  networksResource: fakes.networks,
  readNetworksResource: fakes.readNetworks,
}));
vi.mock('../../../../src/mcp/resources/signerInstanceResource.js', () => ({
  readSignerInstanceResource: fakes.readSignerInstance,
  signerInstanceResource: fakes.signerInstance,
}));
vi.mock('../../../../src/mcp/skills/resourceDefinitions.js', () => ({
  skillResourceDefinitions: fakes.skillDefinitions,
}));

import { signerResourceDefinitions } from '../../../../src/mcp/resources/resourceDefinitions.js';

describe('signerResourceDefinitions', () => {
  it('binds local readers and appends delegated resource definitions in registration order', () => {
    const resources = signerResourceDefinitions();

    expect(resources).toEqual([
      { ...fakes.networks, read: fakes.readNetworks },
      { ...fakes.keys, read: fakes.readKeys },
      { ...fakes.signerInstance, read: fakes.readSignerInstance },
      ...fakes.accounts,
      ...fakes.skillDefinitions.mock.results[0]!.value,
    ]);
    expect(fakes.skillDefinitions).toHaveBeenCalledOnce();
  });
});
