import { buildTransferTool } from './tools/buildTransferTool.js';
import { buildRegisterDataTool } from './tools/buildRegisterDataTool.js';
import { buildConfigureDelegationTool } from './tools/buildConfigureDelegationTool.js';
import { buildConfigureBakerTool } from './tools/buildConfigureBakerTool.js';
import { buildUpdateCredentialKeysTool } from './tools/buildUpdateCredentialKeysTool.js';
import { buildInitContractTool } from './tools/buildInitContractTool.js';
import { buildUpdateContractTool } from './tools/buildUpdateContractTool.js';
import { buildPltTool } from './tools/buildPltTool.js';
import { verifyTransactionSignatureTool } from './tools/verifyTransactionSignatureTool.js';

/** Transaction-domain MCP tools in served order. */
export const transactionTools = [
  buildTransferTool,
  buildRegisterDataTool,
  buildConfigureDelegationTool,
  buildConfigureBakerTool,
  buildUpdateCredentialKeysTool,
  buildInitContractTool,
  buildUpdateContractTool,
  buildPltTool,
  verifyTransactionSignatureTool,
] as const;
