import { Buffer } from 'node:buffer';
import { schemaFunction, schemaMap, schemaOption } from '../../../helpers/schema.js';
import { FakeConcordiumClient, makeContext } from '../../../helpers/fakes.js';

export const SENDER = '4StnMEQCKtfDRuHJfsY6eZL9KJWqdYoqRVRoDSSAz35LsmHcmg';
export const TO = '4soVbMFX1vu7evzS4mhLTh1qscPiCgJFztNnHTTKF3yydvKMEm';
export const MAINNET_REF = '9dd9ca4d19e9393877d2c44b70f89acb';
export const MODULE_REF = 'ab'.repeat(32);

const TYPE_BOOL = Buffer.from([1]);

export function fixtureSchemaHex(): string {
  const contract = Buffer.concat([
    schemaOption(schemaFunction(0, TYPE_BOOL)),
    schemaMap([['receive', schemaFunction(0, TYPE_BOOL)]]),
    schemaOption(),
  ]);
  return Buffer.concat([Buffer.from([255, 255, 3]), schemaMap([['demo', contract]])]).toString('hex');
}

export function schemaMessages(result: { success: boolean; error?: { issues: Array<{ message: string }> } }): string[] {
  return result.success ? [] : (result.error?.issues.map((issue) => issue.message) ?? []);
}

export const ctx = makeContext(
  new FakeConcordiumClient({
    sequenceNumbers: { [SENDER]: { sequenceNumber: '5', allFinal: true } },
    signingRequirements: {
      [SENDER]: { accountThreshold: 1, credentialSignThresholds: [1] },
      [TO]: { accountThreshold: 1, credentialSignThresholds: [1] },
    },
    contractUpdateExecutionEnergy: '10000',
  }),
);

export function makePltContext(
  options: { protocolVersion: number; governanceAccount?: string; senderAddress?: string } = {
    protocolVersion: 11,
  },
) {
  const senderAddress = options.senderAddress ?? SENDER;
  return makeContext(
    new FakeConcordiumClient({
      protocolVersion: options.protocolVersion,
      sequenceNumbers: { [senderAddress]: { sequenceNumber: '5', allFinal: true } },
      tokenInfos: {
        IMT: {
          tokenId: 'IMT',
          moduleRef: 'module-ref',
          decimals: 6,
          'total supply': { value: '1234567890', decimals: 6, display: '1234.567890' },
          name: 'I am Token',
          metadataUrl: undefined,
          governanceAccount: options.governanceAccount ?? SENDER,
          allowList: true,
          denyList: false,
          mintable: true,
          burnable: true,
          paused: false,
        },
        tDKK: {
          tokenId: 'tDKK',
          moduleRef: 'module-ref',
          decimals: 3,
          'total supply': { value: '7654321000', decimals: 3, display: '7654321.000' },
          name: 'Token DKK',
          metadataUrl: undefined,
          governanceAccount: options.governanceAccount ?? SENDER,
          allowList: true,
          denyList: true,
          mintable: true,
          burnable: true,
          paused: false,
        },
      },
      signingRequirements: {
        [senderAddress]: { accountThreshold: 1, credentialSignThresholds: [1] },
        [TO]: { accountThreshold: 1, credentialSignThresholds: [2] },
      },
      accounts: {
        [senderAddress]: {
          address: senderAddress,
          'CCD Balance': { value: '81905031995', decimals: 6, display: '81905.031995 CCD' },
          sequenceNumber: '5',
          index: '57',
          accountType: 'Delegator',
          keys: { threshold: 1, credentialCount: 1, credentialIds: [] },
          PLTs: [],
        },
      },
    }),
  );
}
