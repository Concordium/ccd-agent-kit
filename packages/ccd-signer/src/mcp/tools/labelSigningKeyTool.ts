import {
  CatalogLabelError,
  publicKeyFromEd25519SignerKeyRef,
  setSignerInventoryKeySoftLabel,
} from '@ccd-agent-kit/config-utils';
import { jsonTextToolResult, mcpTextToolErrorResult } from '@ccd-agent-kit/mcp-utils';
import { labelSigningKeyInputSchema } from './toolSchemas.js';
import type { SignerToolResult } from './toolTypes.js';
import type { z } from 'zod';

/** Stable MCP tool name for writing an agent-modifiable signing-key label. */
export const labelSigningKeyTool = { name: 'label_signing_key' } as const;

/** Updates or removes a soft public label, exposing only typed owner-protection failures. */
export async function executeLabelSigningKeyTool(
  input: z.input<typeof labelSigningKeyInputSchema>,
): Promise<SignerToolResult> {
  try {
    const parsedInput = labelSigningKeyInputSchema.parse(input);
    const publicKey = publicKeyFromEd25519SignerKeyRef(parsedInput.keyRef);
    if (publicKey === undefined) throw new Error('KEY_NOT_FOUND');
    const label = parsedInput.remove === true ? undefined : parsedInput.label;
    setSignerInventoryKeySoftLabel({ publicKey, label });
    const structuredContent = {
      keyRef: parsedInput.keyRef,
      ...(label === undefined ? {} : { label }),
    };
    return { ...jsonTextToolResult(structuredContent), structuredContent };
  } catch (error) {
    const { content, isError } = mcpTextToolErrorResult({
      message: error instanceof CatalogLabelError && error.code === 'LABEL_PROTECTED'
        ? 'LABEL_PROTECTED' : 'Signing key label update failed.',
    });
    return { content, isError };
  }
}
