import { completeTransaction } from '../transactions/internal/completeTransactionTool.js';
import { completeAccountOpening } from './completeAccountOpeningTool.js';
import { jsonTool } from '../toolPlumbing/toolHandlers.js';

/** Handles explicit transaction completion and submission without signing. */
export const completeTransactionHandler = jsonTool(completeTransaction);

/** Handles verified account-opening credential completion and optional submission without signing. */
export const completeAccountOpeningHandler = jsonTool(completeAccountOpening);
