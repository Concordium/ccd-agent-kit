import { readFileSync } from 'node:fs';
import { buildStaticSkillDefinition, parseSkillHeader } from '@ccd-agent-kit/mcp-utils';

const ASSET_DIRECTORY = new URL('./assets/shared/', import.meta.url);
const skillFiles = JSON.parse(readFileSync(new URL('catalog.json', ASSET_DIRECTORY), 'utf8')) as string[];
const skills = skillFiles.map((file) => {
  const text = readFileSync(new URL(file, ASSET_DIRECTORY), 'utf8');
  return buildStaticSkillDefinition({ frontmatter: parseSkillHeader(text), text });
});

/** Shared Concordium network discovery skill served by Concordium MCP servers. */
export const CONCORDIUM_NETWORK_DISCOVERY_SKILL = skills.find(
  (skill) => skill.entry.frontmatter.name === 'ccd-network-discovery',
)!;

/** Shared Concordium MCP skills that may be served by more than one server. */
export const SHARED_CONCORDIUM_MCP_SKILLS = skills;
