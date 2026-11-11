import { jsonTool } from '../../toolPlumbing/toolHandlers.js';
import {
  buildConfigureBaker,
  buildConfigureDelegation,
  buildInitContract,
  buildPlt,
  buildRegisterData,
  buildTransfer,
  buildUpdateContract,
  buildUpdateCredentialKeys,
} from './builders.js';
import { verifyTransactionSignature } from './verifyTransactionSignatureTool.js';

export const buildTransferHandler = jsonTool(buildTransfer);
export const buildRegisterDataHandler = jsonTool(buildRegisterData);
export const buildConfigureDelegationHandler = jsonTool(buildConfigureDelegation);
export const buildConfigureBakerHandler = jsonTool(buildConfigureBaker);
export const buildUpdateCredentialKeysHandler = jsonTool(buildUpdateCredentialKeys);
export const buildInitContractHandler = jsonTool(buildInitContract);
export const buildUpdateContractHandler = jsonTool(buildUpdateContract);
export const buildPltHandler = jsonTool(buildPlt);
export const verifyTransactionSignatureHandler = jsonTool(verifyTransactionSignature);
