import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  CONCORDIUM_IDENTITY_MANAGEMENT_SKILL,
  CONCORDIUM_IDENTITY_MCP_SKILLS,
} from '../../src/mcp/skills/catalog.js';

const SKILL_URI = 'skill://ccd-identity-management/SKILL.md';

describe('identity manager skill catalog', () => {
  it('exports one local identity-management skill with canonical frontmatter', () => {
    const text = CONCORDIUM_IDENTITY_MANAGEMENT_SKILL.files[SKILL_URI]?.text;
    expect(text).toBeDefined();
    expect(CONCORDIUM_IDENTITY_MCP_SKILLS).toEqual([CONCORDIUM_IDENTITY_MANAGEMENT_SKILL]);
    expect(CONCORDIUM_IDENTITY_MANAGEMENT_SKILL.entry).toEqual({
      uri: SKILL_URI,
      frontmatter: {
        name: 'ccd-identity-management',
        description: 'Use when checking Concordium identity readiness or managing issuance, recovery, discovery, account opening, or identity proofs.',
      },
      resources: [{
        uri: SKILL_URI,
        digest: `sha256:${createHash('sha256').update(Buffer.from(text!, 'utf8')).digest('hex')}`,
        size: Buffer.byteLength(text!, 'utf8'),
      }],
    });
  });

  it('serves the Markdown workflow at the canonical URI without shared network discovery', () => {
    const file = CONCORDIUM_IDENTITY_MANAGEMENT_SKILL.files[SKILL_URI];

    expect(file).toMatchObject({ mimeType: 'text/markdown' });
    expect(file?.text).toMatch(/^---\nname: ccd-identity-management\ndescription: Use when checking Concordium identity readiness or managing issuance, recovery, discovery, account opening, or identity proofs\.\n---\n/);
    expect(file?.text).toContain('prepare_account_opening');
    expect(file?.text).toContain('reconcile_account_opening');
    expect(file?.text).toContain('create_identity_proof');
    expect(file?.text).toContain('ccd://{network}/identities');
    expect(file?.text).toContain('Read candidates from `.result.identities`');
    expect(file?.text).toContain("wrapper's `network` as the canonical configured name");
    expect(file?.text).not.toContain('list_identities');
    expect(file?.text).toMatch(/signing and submission remain separate/i);
    expect(CONCORDIUM_IDENTITY_MCP_SKILLS.map(skill => skill.entry.uri)).not.toContain(
      'skill://ccd-network-discovery/SKILL.md',
    );
  });
});
