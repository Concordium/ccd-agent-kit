import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ed25519PublicKey } from '@ccd-agent-kit/sdk-utils';

/** Synthetic test-only key material, not derived from any real wallet or local signer state. */
export const FAKE_SIGN_KEY_HEX = 'ab'.repeat(32);
export const FAKE_VERIFY_KEY_HEX = ed25519PublicKey.require('cd'.repeat(32));
export const FAKE_WALLET_CREDENTIAL_ID_HEX = 'aa'.repeat(32);

export const MAINNET_REF = '9dd9ca4d19e9393877d2c44b70f89acb';
export const TESTNET_REF = '4221332d34e1694168c2a0c0b3fd0f27';

/**
 * Builds a synthetic browser-wallet export fixture for tests.
 *
 * The returned object is fully synthetic and only intended for isolated test
 * scaffolding under temporary XDG directories.
 */
export function createSyntheticWalletExport(address: string): object {
  return {
    type: 'concordium-browser-wallet-account',
    v: 0,
    environment: 'mainnet',
    value: {
      address,
      credentials: { '0': FAKE_WALLET_CREDENTIAL_ID_HEX },
      accountKeys: {
        keys: {
          '0': {
            keys: {
              '0': {
                signKey: FAKE_SIGN_KEY_HEX,
                verifyKey: FAKE_VERIFY_KEY_HEX,
              },
            },
            threshold: 1,
          },
        },
        threshold: 1,
      },
    },
  };
}

export function writeSyntheticWalletExportFile(dir: string, address: string, fileName = 'account.export'): void {
  writeFileSync(join(dir, fileName), JSON.stringify(createSyntheticWalletExport(address)));
}
