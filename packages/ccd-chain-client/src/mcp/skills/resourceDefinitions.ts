import { invalidMcpResourceUri, readStaticSkillFile, type BoundMcpResourceDefinition } from '@ccd-agent-kit/mcp-utils';
import { CONCORDIUM_MCP_SKILLS } from './catalog.js';

/** Returns MCP Skills extension resources served by the chain MCP server. */
export function skillResourceDefinitions(): BoundMcpResourceDefinition[] {
  return CONCORDIUM_MCP_SKILLS.map((skill) => ({
    name: skill.entry.uri,
    uri: skill.entry.uri,
    title: skill.entry.frontmatter.name,
    description: skill.entry.frontmatter.description,
    mimeType: 'text/markdown',
    read: async (uri) => {
      const file = readStaticSkillFile(uri, CONCORDIUM_MCP_SKILLS);
      if (file === undefined) throw invalidMcpResourceUri(uri);
      return { uri, text: file.text, mimeType: file.mimeType };
    },
    list: async () => [{ uri: skill.entry.uri, name: skill.entry.frontmatter.name }],
  }));
}
