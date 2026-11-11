import {
  invalidMcpResourceUri,
  readStaticSkillFile,
  type BoundMcpResourceDefinition,
} from '@ccd-agent-kit/mcp-utils';
import { CONCORDIUM_SIGNER_MCP_SKILLS } from './catalog.js';

/** Returns MCP Skills extension resources served by the signer MCP server. */
export function skillResourceDefinitions(): BoundMcpResourceDefinition[] {
  return CONCORDIUM_SIGNER_MCP_SKILLS.map((skill) => ({
    name: skill.entry.frontmatter.name,
    uri: skill.entry.uri,
    title: skill.entry.frontmatter.name,
    description: skill.entry.frontmatter.description,
    mimeType: 'text/markdown',
    read: (uri) => {
      const file = readStaticSkillFile(uri, CONCORDIUM_SIGNER_MCP_SKILLS);
      if (file === undefined) throw invalidMcpResourceUri(uri);
      return { uri, text: file.text, mimeType: file.mimeType };
    },
    list: () => [{ uri: skill.entry.uri, name: skill.entry.frontmatter.name }],
  }));
}
