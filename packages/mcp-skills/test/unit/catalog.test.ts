import { describe, expect, it } from 'vitest';

import { CONCORDIUM_NETWORK_DISCOVERY_SKILL, SHARED_CONCORDIUM_MCP_SKILLS } from '../../src/index.js';

describe('shared Concordium MCP skills', () => {
  it('exports the shared network discovery skill definition', () => {
    expect(CONCORDIUM_NETWORK_DISCOVERY_SKILL.entry).toMatchObject({
      uri: 'skill://ccd-network-discovery/SKILL.md',
      frontmatter: {
        name: 'ccd-network-discovery',
      },
    });
    expect(CONCORDIUM_NETWORK_DISCOVERY_SKILL.files['skill://ccd-network-discovery/SKILL.md']?.text).toContain(
      'ccd://networks',
    );
  });

  it('lists shared skills in served order', () => {
    expect(SHARED_CONCORDIUM_MCP_SKILLS.map((skill) => skill.entry.frontmatter.name)).toEqual([
      'ccd-network-discovery',
    ]);
  });
});
