import { labelContractInstanceTool } from './tools/labelContractInstanceTool.js';
import { simulateContractTool } from './tools/simulateContractTool.js';

/** Contract-domain MCP tools in served order. */
export const contractTools = [labelContractInstanceTool, simulateContractTool] as const;
