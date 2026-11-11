import { syncAccountCredentialsTool } from './tools/syncAccountCredentialsTool.js';
import { labelAccountTool } from './tools/labelAccountTool.js';

/** Account-domain MCP tools in served order. */
export const accountTools = [labelAccountTool, syncAccountCredentialsTool] as const;
