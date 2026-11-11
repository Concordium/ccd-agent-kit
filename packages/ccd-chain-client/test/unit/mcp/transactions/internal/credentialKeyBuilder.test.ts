import { describe, expect, it } from 'vitest';
import { resolveCredentialTarget } from '../../../../../src/mcp/transactions/internal/credentialKeyBuilder.js';
import { buildUpdateCredentialKeysArgsSchema } from '../../../../../src/mcp/transactions/internal/schemas.js';
import { CREDENTIAL_PUBLIC_KEY, UPDATED_PUBLIC_KEY } from '../../../../helpers/keys.js';
import { SENDER } from '../../../../mcp/transactions/internal/builders.fixtures.js';

const credentialId = 'ab'.repeat(48);
const credentials = {
  '2': {
    credentialId,
    threshold: '1',
    keys: { '0': { scheme: 'Ed25519' as const, publicKey: CREDENTIAL_PUBLIC_KEY } },
  },
};

function args(selector: { credentialIndex?: string; credentialId?: string }) {
  return buildUpdateCredentialKeysArgsSchema.parse({
    sender: SENDER,
    ...selector,
    keys: { '0': { scheme: 'Ed25519', publicKey: UPDATED_PUBLIC_KEY } },
    threshold: 1,
  });
}

function captureThrown(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to throw.');
}

describe('credential key target resolution', () => {
  it('resolves finalized credentials by index or case-insensitive ID', () => {
    expect(resolveCredentialTarget(credentials, args({ credentialIndex: '2' }))).toMatchObject({
      index: '2',
      credentialId,
    });
    expect(resolveCredentialTarget(credentials, args({ credentialId: credentialId.toUpperCase() }))).toMatchObject({
      index: '2',
      credentialId,
    });
  });

  it('rejects observed entries that do not contain a credential ID', () => {
    let thrown: unknown;
    try {
      resolveCredentialTarget({ '2': { threshold: '1', keys: credentials['2'].keys } }, args({ credentialIndex: '2' }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ kind: 'invalid-argument' });
  });

  it('rejects a credential index absent from the finalized observation', () => {
    expect(captureThrown(() => resolveCredentialTarget(credentials, args({ credentialIndex: '9' })))).toMatchObject({
      kind: 'invalid-argument',
      message: expect.stringContaining('index 9'),
    });
  });

  it('rejects a credential ID absent from the finalized observation', () => {
    expect(
      captureThrown(() => resolveCredentialTarget(credentials, args({ credentialId: 'ef'.repeat(48) }))),
    ).toMatchObject({
      kind: 'invalid-argument',
      message: expect.stringContaining('Credential ID'),
    });
  });
});
