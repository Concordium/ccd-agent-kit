import { readFileSync } from 'node:fs';
import { SHARED_CONCORDIUM_MCP_SKILLS } from '@ccd-agent-kit/mcp-skills';
import { assertUniqueStaticSkillUris, buildStaticSkillDefinition, parseSkillHeader } from '@ccd-agent-kit/mcp-utils';

const ASSET_DIRECTORY = new URL('./assets/signer/', import.meta.url);
const skillFiles = JSON.parse(readFileSync(new URL('catalog.json', ASSET_DIRECTORY), 'utf8')) as string[];

const SIGNER_CONCORDIUM_MCP_SKILLS = skillFiles.map((file) => {
  const text = readFileSync(new URL(file, ASSET_DIRECTORY), 'utf8');
  return buildStaticSkillDefinition({ frontmatter: parseSkillHeader(text), text });
});

/** Static Concordium discovery skills served by `ccd-signer`. */
export const CONCORDIUM_SIGNER_MCP_SKILLS = [...SHARED_CONCORDIUM_MCP_SKILLS, ...SIGNER_CONCORDIUM_MCP_SKILLS];

assertUniqueStaticSkillUris(CONCORDIUM_SIGNER_MCP_SKILLS);
