import { findAccountLabelInMap, loadAccountLabels, type AccountLabelMap } from '@ccd-agent-kit/config-utils';

import { projectParsedTransaction } from '../core/model/projectParsedTransaction.js';
import type {
  ParsedKnownOperation,
  ParsedOperation,
  ParsedTransaction,
} from '../core/model/parsedTransaction.js';
import type { CborAccountAddress } from '@concordium/web-sdk';

/** Network context used to enrich parsed transaction output with local account labels. */
export interface ParsedTransactionAnnotationContext {
  /** CAIP-2 reference for the network whose account-label map should be used. */
  caip2Ref: string;
}

/** Adds local account labels at protocol-defined participant paths and returns terminal wire output. */
export function annotateParsedTransactionAccounts(
  parsed: ParsedTransaction,
  context: ParsedTransactionAnnotationContext,
): Record<string, unknown> {
  if (parsed.kind !== 'accountTransaction') {
    return projectParsedTransaction(parsed);
  }
  const accountLabels = loadAccountLabels(context.caip2Ref);
  const senderAccountLabel = findAccountLabelInMap(parsed.header.sender, accountLabels);
  if (senderAccountLabel !== undefined) {
    parsed.header.senderAccountLabel = senderAccountLabel;
  }
  if (parsed.header.sponsor !== undefined) {
    const sponsorAccountLabel = findAccountLabelInMap(parsed.header.sponsor, accountLabels);
    if (sponsorAccountLabel !== undefined) {
      parsed.header.sponsorAccountLabel = sponsorAccountLabel;
    }
  }

  const summary = parsed.payloadSummary;
  if (summary.kind === 'transfer' || summary.kind === 'transferWithMemo') {
    const recipientAccountLabel = findAccountLabelInMap(summary.toAddress, accountLabels);
    if (recipientAccountLabel !== undefined) {
      summary.toAccountLabel = recipientAccountLabel;
    }
  } else if (summary.kind === 'tokenUpdate') {
    for (const operation of summary.operations) {
      annotateOperation(operation, accountLabels);
    }
  }

  return projectParsedTransaction(parsed);
}

function annotateOperation(operation: ParsedOperation, accountLabels: AccountLabelMap): void {
  if (operation.kind === 'knownOperation') annotateKnownOperation(operation, accountLabels);
}

function annotateKnownOperation(operation: ParsedKnownOperation, accountLabels: AccountLabelMap): void {
  const value = operation.operation;
  if ('transfer' in value) annotateAddress(value.transfer.recipient, operation, accountLabels);
  else if ('tokenTransfer' in value) annotateAddress(value.tokenTransfer.recipient, operation, accountLabels);
  else if ('addAllowList' in value) annotateAddress(value.addAllowList.target, operation, accountLabels);
  else if ('tokenAddAllowList' in value) annotateAddress(value.tokenAddAllowList.target, operation, accountLabels);
  else if ('removeAllowList' in value) annotateAddress(value.removeAllowList.target, operation, accountLabels);
  else if ('tokenRemoveAllowList' in value) annotateAddress(value.tokenRemoveAllowList.target, operation, accountLabels);
  else if ('addDenyList' in value) annotateAddress(value.addDenyList.target, operation, accountLabels);
  else if ('tokenAddDenyList' in value) annotateAddress(value.tokenAddDenyList.target, operation, accountLabels);
  else if ('removeDenyList' in value) annotateAddress(value.removeDenyList.target, operation, accountLabels);
  else if ('tokenRemoveDenyList' in value) annotateAddress(value.tokenRemoveDenyList.target, operation, accountLabels);
  else if ('assignAdminRoles' in value) annotateAddress(value.assignAdminRoles.account, operation, accountLabels);
  else if ('tokenAssignAdminRoles' in value)
    annotateAddress(value.tokenAssignAdminRoles.account, operation, accountLabels);
  else if ('revokeAdminRoles' in value) annotateAddress(value.revokeAdminRoles.account, operation, accountLabels);
  else if ('tokenRevokeAdminRoles' in value)
    annotateAddress(value.tokenRevokeAdminRoles.account, operation, accountLabels);
  else if ('lockCreate' in value) {
    const config = value.lockCreate.simpleV0;
    if (config.recipients !== 'any') {
      config.recipients.forEach((recipient) => annotateAddress(recipient, operation, accountLabels));
    }
    config.grants.forEach((grant) => annotateAddress(grant.account, operation, accountLabels));
  } else if ('lockSend' in value) {
    annotateAddress(value.lockSend.source, operation, accountLabels);
    annotateAddress(value.lockSend.recipient, operation, accountLabels);
  } else if ('lockRelease' in value) {
    annotateAddress(value.lockRelease.source, operation, accountLabels);
  }
}

function annotateAddress(
  address: CborAccountAddress.Type,
  operation: ParsedKnownOperation,
  accountLabels: AccountLabelMap,
): void {
  const accountLabel = findAccountLabelInMap(address.toJSON().address, accountLabels);
  if (accountLabel !== undefined) operation.participantLabels.set(address, accountLabel);
}
