import { homedir } from 'node:os';
import { join } from 'node:path';

const APP_QUALIFIER = 'ccd-agent-kit';

function xdgDir(envVar: string, fallback: string): string {
  return process.env[envVar] || join(homedir(), fallback);
}

/** Returns `$XDG_CONFIG_HOME/ccd-agent-kit` or `~/.config/ccd-agent-kit`. */
export function getConfigDir(): string {
  return join(xdgDir('XDG_CONFIG_HOME', '.config'), APP_QUALIFIER);
}

/** Returns `$XDG_DATA_HOME/ccd-agent-kit` or `~/.local/share/ccd-agent-kit`. */
export function getDataDir(): string {
  return join(xdgDir('XDG_DATA_HOME', join('.local', 'share')), APP_QUALIFIER);
}

/** Returns `$XDG_STATE_HOME/ccd-agent-kit` or `~/.local/state/ccd-agent-kit`. */
export function getStateDir(): string {
  return join(xdgDir('XDG_STATE_HOME', join('.local', 'state')), APP_QUALIFIER);
}

/** Returns the network registry file path. */
export function getNetworksFilePath(): string {
  return join(getConfigDir(), 'networks.json');
}

/** Returns the `ccd-agent-kit/chain-client.json` ccd-chain-client configuration path. */
export function getChainClientConfigPath(): string {
  return join(getConfigDir(), 'chain-client.json');
}

/** Returns the derived all-network account-label index path. */
export function getAccountLabelsPath(): string {
  return join(getStateDir(), 'account-labels.json');
}

/** Returns the authoritative network-specific account-label path for a CAIP-2 reference. */
export function getAccountLabelsPathForNetwork(caip2Ref: string): string {
  return join(getDataDir(), 'account-labels', `${caip2Ref}.json`);
}

/** Returns the derived all-network contract-instance-label index path. */
export function getContractInstanceLabelsPath(): string {
  return join(getStateDir(), 'contract-instance-labels.json');
}

/** Returns the authoritative network-specific contract-instance-label path. */
export function getContractInstanceLabelsPathForNetwork(caip2Ref: string): string {
  return join(getDataDir(), 'contract-instance-labels', `${caip2Ref}.json`);
}

/** Returns the network-specific account credential observation file path for a CAIP-2 reference. */
export function getAccountCredentialsPathForNetwork(caip2Ref: string): string {
  return join(getStateDir(), 'account-credentials', `${caip2Ref}.json`);
}

/** Returns the public identity-context snapshot path for an exact lowercase CAIP-2 reference. */
export function getIdentityContextSnapshotPathForNetwork(caip2Ref: string): string {
  if (!/^[0-9a-f]{32}$/.test(caip2Ref)) {
    throw new Error('Invalid CAIP-2 reference: expected exactly 32 lowercase hex characters.');
  }
  return join(getStateDir(), 'identity-context', `${caip2Ref}.json`);
}

/** Returns the signer-specific data directory. */
export function getSignerDataDir(): string {
  return join(getDataDir(), 'signer');
}

/** Returns the signer-specific configuration directory. */
export function getSignerConfigDir(): string {
  return join(getConfigDir(), 'signer');
}

/** Returns the signer module configuration path. */
export function getSignerConfigPath(): string {
  return join(getSignerConfigDir(), 'config.json');
}

/** Returns the signer YubiKey defaults configuration path. */
export function getSignerYubiKeyConfigPath(): string {
  return join(getSignerConfigDir(), 'yubikey.json');
}

/** Returns the signer network-specific data directory for a CAIP-2 reference. */
export function getSignerNetworkDir(caip2Ref: string): string {
  return join(getSignerDataDir(), caip2Ref);
}

/** Returns the durable signer inventory path. */
export function getSignerInventoryPath(): string {
  return join(getSignerDataDir(), 'inventory.json');
}

/** Returns the durable signer key-storage metadata directory. */
export function getSignerKeyStorageDir(): string {
  return join(getSignerDataDir(), 'key-storage');
}

/** Returns the shared durable YubiKey registration path. */
export function getYubiKeyRegistrationsPath(): string {
  return join(getDataDir(), 'yubikeys.json');
}

/** Returns the protected global identity-source catalog path. */
export function getIdentitySourcesPath(): string {
  return join(getDataDir(), 'id-manager', 'sources.json');
}
