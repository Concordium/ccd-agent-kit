import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DEFAULT_SIGN_KEY = 'ab'.repeat(32) + '11'.repeat(32);
const DEFAULT_VERIFY_KEY = 'cd'.repeat(32) + '22'.repeat(32);

export interface WalletExportKeyOverrides {
  signKey?: string;
  verifyKey?: string;
}

export function createWalletExport(address: string, overrides: WalletExportKeyOverrides = {}): object {
  return {
    type: 'concordium-browser-wallet-account',
    v: 0,
    environment: 'mainnet',
    value: {
      address,
      credentials: { '0': 'aa'.repeat(32) },
      accountKeys: {
        keys: {
          '0': {
            keys: {
              '0': {
                signKey: overrides.signKey ?? DEFAULT_SIGN_KEY,
                verifyKey: overrides.verifyKey ?? DEFAULT_VERIFY_KEY,
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

export function createWalletExportJson(address: string, overrides: WalletExportKeyOverrides = {}): string {
  return JSON.stringify(createWalletExport(address, overrides));
}

export function writeWalletExport(
  dir: string,
  address: string,
  filename: string,
  overrides: WalletExportKeyOverrides = {},
): string {
  const filePath = join(dir, filename);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, createWalletExportJson(address, overrides));
  return filePath;
}
