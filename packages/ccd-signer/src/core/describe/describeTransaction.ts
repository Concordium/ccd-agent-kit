import type { ParsedTransaction } from '../model/parsedTransaction.js';
import { projectParsedOperation } from '../parser/parsedOperations.js';

/**
 * Renders a compact human-readable description, including the max energy budget for account transactions.
 *
 * @param transaction - The parsed transaction to describe.
 * @returns A compact text description suitable for CLI output.
 */
export function describeTransaction(transaction: ParsedTransaction): string {
  if (transaction.kind === 'credentialDeployment') {
    const lines = [`Type: credentialDeployment`, `Expiry: ${transaction.expiryDate ?? transaction.expiry}`];
    if (transaction.credential !== undefined) {
      lines.push(
        `Credential type: ${transaction.credential.deploymentType}`,
        `Credential keys: ${Object.keys(transaction.credential.credentialPublicKeys.keys).length}`,
        `Threshold: ${transaction.credential.credentialPublicKeys.threshold}`,
        `Identity provider: ${transaction.credential.identityProvider}`,
        `Anonymity revokers: ${transaction.credential.anonymityRevokerCount}`,
        `Valid to: ${transaction.credential.validToDate}`,
        `Created at: ${transaction.credential.createdAtDate}`,
        `Revealed attributes: ${terminalSafeJson(transaction.credential.revealedAttributes)}`,
      );
    }
    if (transaction.proofs !== undefined) {
      lines.push(`Ownership proof bytes: ${transaction.proofs.byteLength}`);
    }
    return lines.join('\n');
  }

  if (transaction.kind === 'credentialDeploymentSigning') {
    const revealedAttributes = Object.entries(transaction.credential.revealedAttributes).map(
      ([name, value]) => `Revealed attribute ${name}: ${terminalSafeJson(value)}`,
    );
    const target =
      transaction.target.type === 'new_account'
        ? [`Target: new account`, `Message expiry: ${transaction.target.messageExpiryDate ?? transaction.target.messageExpiry}`]
        : [`Target: existing account`, `Account: ${transaction.target.accountAddress}`];
    return [
      `Type: credentialDeploymentSigning`,
      ...target,
      `Credential keys: ${Object.keys(transaction.credentialPublicKeys.keys).length}`,
      `Threshold: ${transaction.credentialPublicKeys.threshold}`,
      `Revealed attributes: ${terminalSafeJson(transaction.credential.revealedAttributes)}`,
      ...revealedAttributes,
      `Ownership proof bytes: ${transaction.proofs.byteLength}`,
    ].join('\n');
  }

  const lines = [
    `Type: ${transaction.payloadType}`,
    `Version: v${transaction.version}`,
    `Sender: ${transaction.header.sender}`,
    `Nonce: ${transaction.header.nonce}`,
    `Max energy: ${transaction.header.energy}`,
  ];

  lines.push(...describePayloadSummary(transaction));

  if (transaction.header.sponsor !== undefined) {
    lines.push(`Sponsor: ${transaction.header.sponsor}`);
  }

  return lines.join('\n');
}

function terminalSafeJson(value: unknown): string | undefined {
  return JSON.stringify(value)?.replace(/[\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, (character) =>
    `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`,
  );
}

function describePayloadSummary(transaction: Extract<ParsedTransaction, { kind: 'accountTransaction' }>): string[] {
  switch (transaction.payloadSummary.kind) {
    case 'transfer':
      return [`Amount: ${transaction.payloadSummary.amount}`, `To: ${transaction.payloadSummary.toAddress}`];
    case 'transferWithMemo':
      return [
        `Amount: ${transaction.payloadSummary.amount}`,
        `To: ${transaction.payloadSummary.toAddress}`,
        `Memo: ${formatBinaryValue(transaction.payloadSummary.memo)}`,
      ];
    case 'registerData':
      return [`Data: ${formatBinaryValue(transaction.payloadSummary.data)}`];
    case 'deployModule':
      return [`Source: ${transaction.payloadSummary.source}`];
    case 'initContract':
      return [
        `Amount: ${transaction.payloadSummary.amount}`,
        `Init: ${transaction.payloadSummary.initName}`,
        `Module: ${transaction.payloadSummary.moduleRef}`,
        `Param: ${transaction.payloadSummary.param}`,
      ];
    case 'updateContract':
      return [
        `Amount: ${transaction.payloadSummary.amount}`,
        `Contract: ${transaction.payloadSummary.address.index}/${transaction.payloadSummary.address.subindex}`,
        `Receive: ${transaction.payloadSummary.receiveName}`,
        `Message: ${transaction.payloadSummary.message}`,
      ];
    case 'configureDelegation':
      return [
        `Stake: ${transaction.payloadSummary.stake ?? ''}`,
        `Restake: ${transaction.payloadSummary.restakeEarnings ?? ''}`,
        `Target: ${transaction.payloadSummary.delegationTarget?.delegateType ?? ''}`,
      ];
    case 'configureValidator':
      return [
        `Stake: ${transaction.payloadSummary.stake ?? ''}`,
        `Restake: ${transaction.payloadSummary.restakeEarnings ?? ''}`,
        `Open: ${transaction.payloadSummary.openForDelegation ?? ''}`,
        `Metadata: ${transaction.payloadSummary.metadataUrl ?? ''}`,
        `Commission: ${transaction.payloadSummary.transactionFeeCommission ?? ''}/${transaction.payloadSummary.bakingRewardCommission ?? ''}/${transaction.payloadSummary.finalizationRewardCommission ?? ''}`,
      ];
    case 'updateCredentials':
      return [
        `Threshold: ${transaction.payloadSummary.threshold}`,
        `New: ${transaction.payloadSummary.newCredentialCount}`,
        `Remove: ${transaction.payloadSummary.removeCredentialIds.length}`,
      ];
    case 'tokenUpdate':
      return [
        ...(transaction.payloadSummary.variant === 'scoped' ? [`Token: ${transaction.payloadSummary.tokenId}`] : []),
        'Operations:',
        JSON.stringify(transaction.payloadSummary.operations.map(projectParsedOperation), null, 2),
      ];
    case 'generic':
      return [];
  }
}

function formatBinaryValue(value: { hex: string; text?: string; cbor?: unknown }): string {
  if (value.text !== undefined) {
    return value.text;
  }

  if (value.cbor !== undefined) {
    return typeof value.cbor === 'string' ? value.cbor : JSON.stringify(value.cbor);
  }

  return value.hex;
}
