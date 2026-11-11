import { describeTransactionTool, executeDescribeTransactionTool } from './describeTransactionTool.js';
import { executeSignMessageTool, signMessageTool } from './signMessageTool.js';
import { executeSignCredentialDeploymentTool, signCredentialDeploymentTool } from './signCredentialDeploymentTool.js';
import { executeSignTransactionTool, signTransactionTool } from './signTransactionTool.js';
import { executeLabelSigningKeyTool, labelSigningKeyTool } from './labelSigningKeyTool.js';
import {
  describeTransactionToolInputSchema,
  describeTransactionToolOutputSchema,
  signedMessageOutputSchema,
  signCredentialDeploymentInputSchema,
  signCredentialDeploymentOutputSchema,
  signMessageInputSchema,
  signTransactionInputSchema,
  signTransactionOutputSchema,
  labelSigningKeyInputSchema,
  labelSigningKeyOutputSchema,
} from './toolSchemas.js';
import type { SignerToolRegistry } from './toolRegistry.js';
import type { YubiKeyService } from '@ccd-agent-kit/piv-utils';

/**
 * Registers every public signer MCP tool in catalog order.
 *
 * @param registry - Registry that receives the public tool definitions.
 * @param yubiKeyService - Process-shared hardware service.
 */
export function registerAllSignerTools(
  registry: SignerToolRegistry,
  yubiKeyService?: YubiKeyService,
): SignerToolRegistry {
  registry.register({
    name: labelSigningKeyTool.name,
    description: 'Provide label to set a soft signing-key label or remove: true to remove it without changing hard labels or exposing custody data.',
    inputSchema: labelSigningKeyInputSchema,
    outputSchema: labelSigningKeyOutputSchema,
    handler: executeLabelSigningKeyTool,
  });

  registry.register({
    name: describeTransactionTool.name,
    description: 'Decode Concordium transaction or block item hex so a user can review what it contains.',
    inputSchema: describeTransactionToolInputSchema,
    outputSchema: describeTransactionToolOutputSchema,
    handler: executeDescribeTransactionTool,
  });

  registry.register({
    name: signTransactionTool.name,
    description: 'Add sender or sponsor signatures to an unsigned Concordium transaction using available signer keys.',
    inputSchema: signTransactionInputSchema,
    outputSchema: signTransactionOutputSchema,
    handler: args => executeSignTransactionTool(args, yubiKeyService),
  });

  registry.register({
    name: signCredentialDeploymentTool.name,
    description: 'Sign a credential deployment handoff for opening an account or adding a credential.',
    inputSchema: signCredentialDeploymentInputSchema,
    outputSchema: signCredentialDeploymentOutputSchema,
    handler: args => executeSignCredentialDeploymentTool(args, yubiKeyService),
  });

  registry.register({
    name: signMessageTool.name,
    description: 'Sign a message with an account this signer can sign for and return a detached signature.',
    inputSchema: signMessageInputSchema,
    outputSchema: signedMessageOutputSchema,
    handler: args => executeSignMessageTool(args, yubiKeyService),
  });

  return registry;
}
