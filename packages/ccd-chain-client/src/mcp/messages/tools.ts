import { verifyMessageSignatureTool } from './tools/verifyMessageSignatureTool.js';

/** Messages-domain MCP tools in served order. */
export const messageTools = [verifyMessageSignatureTool] as const;
