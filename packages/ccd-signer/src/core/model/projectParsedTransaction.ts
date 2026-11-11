import type { ParsedTransaction } from './parsedTransaction.js';
import { projectParsedOperation } from '../parser/parsedOperations.js';

/**
 * Projects the internal typed inspection model to its stable public wire shape.
 * Opaque operation wrappers are removed here and nowhere else.
 */
export function projectParsedTransaction(transaction: ParsedTransaction): Record<string, unknown> {
  if (
    transaction.kind !== 'accountTransaction' ||
    transaction.payloadSummary.kind !== 'tokenUpdate'
  ) {
    return { ...transaction };
  }

  return {
    ...transaction,
    payloadSummary: {
      ...transaction.payloadSummary,
      operations: transaction.payloadSummary.operations.map(projectParsedOperation),
    },
  };
}
