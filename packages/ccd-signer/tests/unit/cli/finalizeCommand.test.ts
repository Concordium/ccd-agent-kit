import { describe, expect, it } from 'vitest';

import { createFinalizeCommandRequest } from '../../../src/cli/finalizeCommand.js';
import { transactionFixtures } from '../../helpers/transactionFixtures.js';

const SENDER_REQUIREMENTS = JSON.stringify({ senderNumSignatures: '1', totalSignatureCount: '1' });

describe('runFinalizeCommand', () => {
  it('rejects conflicting detached signature sources', () => {
    expect(() => {
      createFinalizeCommandRequest(finalizeInput({ signatures: '{"sender":{},"sponsor":{}}', signaturesFile: 'signatures.json' }));
    }).toThrowError('Detached signatures are required via --signatures or --signatures-file.');
  });

  it('rejects syntactically invalid signature requirement metadata before finalization', () => {
    for (const signatureRequirements of ['null', '[]', '{"senderNumSignatures":"1.5"}', '{"senderNumSignatures":"9007199254740992"}', '{"senderNumSignatures":"1","extra":"0"}']) {
      expect(() => createFinalizeCommandRequest({
        ...finalizeInput({ signatures: JSON.stringify({ sender: {}, sponsor: {} }) }),
        signatureRequirements,
      })).toThrowError();
    }
  });
});

function finalizeInput(overrides: Parameters<typeof createFinalizeCommandRequest>[0]): Parameters<typeof createFinalizeCommandRequest>[0] {
  return { input: transactionFixtures.unsignedTransferWithMemoHex, signatureRequirements: SENDER_REQUIREMENTS, ...overrides };
}
