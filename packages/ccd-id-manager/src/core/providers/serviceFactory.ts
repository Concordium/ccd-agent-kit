import { resolveNetwork } from '@ccd-agent-kit/config-utils';
import { createIdentityProviderRegistry } from './registry.js';
import { IdentityProviderError } from './error.js';
import { readFinalizedIdentityProviderContext } from './node.js';
import { createIdentityProviderService } from './service.js';
import type { CanonicalNetwork, IdentityProviderService } from './types.js';

/** Resolve shared network selector precedence into the config package's canonical provider namespace. */
export function resolveProviderNetwork(selector?: string): CanonicalNetwork {
  try {
    const { config } = resolveNetwork(selector);
    return { caip2: config.caip2, genesisHash: config.genesisHash };
  } catch { throw new IdentityProviderError('INVALID_NETWORK'); }
}

/** Create the default provider service without loading node state until an operation requires it. */
export function createDefaultIdentityProviderService(): IdentityProviderService {
  return createIdentityProviderService({
    registry: createIdentityProviderRegistry(),
    readNodeContext: readFinalizedIdentityProviderContext,
  });
}
