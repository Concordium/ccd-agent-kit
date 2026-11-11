import { accountTools } from '../accounts/tools.js';
import { blockTools } from '../blocks/tools.js';
import { contractTools } from '../contracts/tools.js';
import { lockTools } from '../locks/tools.js';
import { messageTools } from '../messages/tools.js';
import { networkTools } from '../networks/tools.js';
import { stakingTools } from '../staking/tools.js';
import { submissionTools } from '../submissions/tools.js';
import { tokenTools } from '../tokens/tools.js';
import { transactionTools } from '../transactions/tools.js';

/** Full Concordium MCP tool catalog in served order. */
export const TOOL_CATALOG = [
  ...accountTools,
  ...blockTools,
  ...networkTools,
  ...lockTools,
  ...contractTools,
  ...stakingTools,
  ...tokenTools,
  ...transactionTools,
  ...messageTools,
  ...submissionTools,
] as const;
