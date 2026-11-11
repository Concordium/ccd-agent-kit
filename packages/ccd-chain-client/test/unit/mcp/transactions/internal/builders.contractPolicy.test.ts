import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeInitParameterJsonFromHex, serializeReceiveParameterJsonFromHex } from '@ccd-agent-kit/sdk-utils';
import { buildInitContract, buildUpdateContract } from '../../../../../src/mcp/transactions/internal/builders.js';
import { FakeConcordiumClient, makeContext } from '../../../../helpers/fakes.js';
import { MODULE_REF, SENDER, TO, ctx } from '../../../../mcp/transactions/internal/builders.fixtures.js';

vi.mock('@ccd-agent-kit/sdk-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ccd-agent-kit/sdk-utils')>();
  return {
    ...actual,
    serializeInitParameterJsonFromHex: vi.fn(() => '01'),
    serializeReceiveParameterJsonFromHex: vi.fn(() => '02'),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

function contractClient(overrides: ConstructorParameters<typeof FakeConcordiumClient>[0] = {}) {
  return new FakeConcordiumClient({
    sequenceNumbers: { [SENDER]: { sequenceNumber: '5', allFinal: true } },
    signingRequirements: {
      [SENDER]: { accountThreshold: 1, credentialSignThresholds: [1] },
      [TO]: { accountThreshold: 1, credentialSignThresholds: [1] },
    },
    ...overrides,
  });
}

describe('init contract energy and parameter policy', () => {
  it('uses default execution energy and zero amount', async () => {
    const result = await buildInitContract(ctx, {
      sender: SENDER,
      moduleRef: '0'.repeat(64),
      initName: 'init_demo',
    });

    expect(result.payload).toMatchObject({
      amount: { value: '0', decimals: 6, display: '0.000000' },
      executionEnergy: '10000',
      energySource: 'default',
    });
  });

  it('uses provided execution energy', async () => {
    const result = await buildInitContract(ctx, {
      sender: SENDER,
      moduleRef: '0'.repeat(64),
      initName: 'init_demo',
      energy: '321',
    });

    expect(result.payload).toMatchObject({ executionEnergy: '321', energySource: 'provided' });
  });

  it('fetches the module schema and passes init JSON to the serializer', async () => {
    const client = contractClient({ moduleSchemas: { [MODULE_REF]: 'schema-hex' } });
    const parameterJson = { enabled: true };

    const result = await buildInitContract(makeContext(client), {
      sender: SENDER,
      moduleRef: MODULE_REF,
      initName: 'init_demo',
      parameterJson,
    });

    expect(client.calls.getModuleSchema).toBe(1);
    expect(serializeInitParameterJsonFromHex).toHaveBeenCalledWith('schema-hex', 'init_demo', parameterJson);
    expect(result.payload).toMatchObject({ parameterHex: '01' });
  });

  it('rejects init JSON when the fetched module has no embedded schema', async () => {
    const client = contractClient();

    await expect(
      buildInitContract(makeContext(client), {
        sender: SENDER,
        moduleRef: MODULE_REF,
        initName: 'init_demo',
        parameterJson: { enabled: true },
      }),
    ).rejects.toMatchObject({ kind: 'invalid-argument', message: expect.stringContaining('embedded module schema') });
    expect(client.calls.getModuleSchema).toBe(1);
    expect(serializeInitParameterJsonFromHex).not.toHaveBeenCalled();
  });
});

describe('update contract energy and metadata policy', () => {
  it('uses provided energy without simulation', async () => {
    const client = contractClient();
    const result = await buildUpdateContract(makeContext(client), {
      sender: SENDER,
      contract: '12,0',
      receiveName: 'demo.receive',
      amountMicroCcd: '2500000',
      energy: '12345',
    });

    expect(result.payload).toMatchObject({
      amount: { value: '2500000', decimals: 6, display: '2.500000' },
      executionEnergy: '12345',
      energySource: 'provided',
    });
    expect(client.calls.estimateContractUpdateExecutionEnergy).toBeUndefined();
  });

  it('simulates energy with the resolved execution inputs when omitted', async () => {
    const client = contractClient({ contractUpdateExecutionEnergy: '777' });
    const result = await buildUpdateContract(makeContext(client), {
      sender: SENDER,
      contract: '12,0',
      receiveName: 'demo.receive',
      parameterHex: '00',
      amountMicroCcd: '2500000',
    });

    expect(result.payload).toMatchObject({
      executionEnergy: '777',
      energySource: 'simulated',
      simulatedExecutionEnergy: '777',
    });
    expect(client.lastEstimateContractUpdateExecutionEnergyParam).toEqual({
      contract: { index: 12n, subindex: 0n },
      method: 'demo.receive',
      parameterHex: '00',
      amountMicroCcd: 2500000n,
      invoker: SENDER,
    });
  });

  it('propagates sponsorship signature metadata with simulated energy', async () => {
    const client = contractClient({ contractUpdateExecutionEnergy: '888' });
    const result = await buildUpdateContract(makeContext(client), {
      sender: SENDER,
      sponsor: TO,
      senderNumSignatures: '2',
      sponsorNumSignatures: '3',
      contract: '12,0',
      receiveName: 'demo.receive',
    });

    expect(result.metadata).toMatchObject({
      senderNumSignatures: '2',
      sponsorNumSignatures: '3',
      totalSignatureCount: '5',
    });
  });

  it('reports simulation failures as invalid arguments', async () => {
    const client = contractClient({ contractUpdateExecutionEnergyError: { kind: 'node', message: 'Rejected' } });

    await expect(
      buildUpdateContract(makeContext(client), {
        sender: SENDER,
        contract: '12,0',
        receiveName: 'demo.receive',
      }),
    ).rejects.toMatchObject({ kind: 'invalid-argument', message: expect.stringContaining('Could not estimate') });
  });

  it('fetches the instance schema and passes receive JSON to the serializer before simulation', async () => {
    const client = contractClient({
      instances: {
        '12,0': {
          index: '12',
          subindex: '0',
          moduleRef: MODULE_REF,
          owner: SENDER,
          amount: '0',
          name: 'demo',
          methods: ['demo.receive'],
        },
      },
      moduleSchemas: { [MODULE_REF]: 'schema-hex' },
      contractUpdateExecutionEnergy: '456',
    });
    const parameterJson = { enabled: false };

    const result = await buildUpdateContract(makeContext(client), {
      sender: SENDER,
      contract: '12,0',
      receiveName: 'demo.receive',
      parameterJson,
    });

    expect(client.calls.getModuleSchema).toBe(1);
    expect(serializeReceiveParameterJsonFromHex).toHaveBeenCalledWith(
      'schema-hex',
      'demo',
      'demo.receive',
      parameterJson,
    );
    expect(client.lastEstimateContractUpdateExecutionEnergyParam).toMatchObject({ parameterHex: '02' });
    expect(result.payload).toMatchObject({ parameterHex: '02', executionEnergy: '456' });
  });

  it('rejects a missing receive schema before serialization or energy simulation', async () => {
    const client = contractClient({
      instances: {
        '12,0': {
          index: '12',
          subindex: '0',
          moduleRef: MODULE_REF,
          owner: SENDER,
          amount: '0',
          name: 'demo',
          methods: ['demo.receive'],
        },
      },
    });

    await expect(
      buildUpdateContract(makeContext(client), {
        sender: SENDER,
        contract: '12,0',
        receiveName: 'demo.receive',
        parameterJson: { enabled: false },
      }),
    ).rejects.toMatchObject({ kind: 'invalid-argument', message: expect.stringContaining('embedded module schema') });
    expect(serializeReceiveParameterJsonFromHex).not.toHaveBeenCalled();
    expect(client.calls.estimateContractUpdateExecutionEnergy).toBeUndefined();
  });
});
