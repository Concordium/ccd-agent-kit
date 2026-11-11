import { accountsResourceRegistration } from './accountsResource.js';
import { keysResource, readKeysResource } from './keysResource.js';
import { networksResource, readNetworksResource } from './networksResource.js';
import { readSignerInstanceResource, signerInstanceResource } from './signerInstanceResource.js';
import { skillResourceDefinitions } from '../skills/resourceDefinitions.js';
import type { BoundMcpResourceDefinition } from '@ccd-agent-kit/mcp-utils';

/** Returns every public signer MCP resource definition in registration order. */
export function signerResourceDefinitions(): BoundMcpResourceDefinition[] {
  return [
    { ...networksResource, read: readNetworksResource },
    { ...keysResource, read: readKeysResource },
    { ...signerInstanceResource, read: readSignerInstanceResource },
    ...accountsResourceRegistration.definitions,
    ...skillResourceDefinitions(),
  ];
}
