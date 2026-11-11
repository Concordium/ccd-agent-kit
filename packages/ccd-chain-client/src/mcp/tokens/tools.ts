import { getCis2TokenBalanceTool } from './tools/getCis2TokenBalanceTool.js';

/** Token-domain MCP tools in served order. */
export const tokenTools = [getCis2TokenBalanceTool] as const;
