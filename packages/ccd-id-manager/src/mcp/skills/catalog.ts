import { readFileSync } from 'node:fs';

import { buildStaticSkillDefinition, parseSkillHeader } from '@ccd-agent-kit/mcp-utils';

const ASSET_DIRECTORY = new URL('./assets/id-manager/', import.meta.url);
const skillFiles = JSON.parse(readFileSync(new URL('catalog.json', ASSET_DIRECTORY), 'utf8')) as string[];
const skills = skillFiles.map((file) => {
  const text = readFileSync(new URL(file, ASSET_DIRECTORY), 'utf8');
  return buildStaticSkillDefinition({ frontmatter: parseSkillHeader(text), text });
});

/** Static identity-management skill served only by `ccd-id-manager`. */
export const CONCORDIUM_IDENTITY_MANAGEMENT_SKILL = skills.find(
  (skill) => skill.entry.frontmatter.name === 'ccd-identity-management',
)!;

/** Local skills served by `ccd-id-manager`; shared network discovery is intentionally excluded. */
export const CONCORDIUM_IDENTITY_MCP_SKILLS = skills;
