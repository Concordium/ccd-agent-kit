import { describe, expect, it } from 'vitest';

import { skillResourceDefinitions } from '../../../../src/mcp/skills/resourceDefinitions.js';

const SIGNER_SKILL_NAME = 'ccd-signer-key-discovery';
const SIGNER_SKILL_URI = `skill://${SIGNER_SKILL_NAME}/SKILL.md`;

describe('signer skill resource callbacks', () => {
  it('lists and reads the signer key-discovery skill', () => {
    const resource = skillResourceDefinitions().find(({ name }) => name === SIGNER_SKILL_NAME);
    if (resource === undefined) throw new Error('Missing signer key-discovery skill');

    expect(resource.list?.()).toEqual([{ uri: SIGNER_SKILL_URI, name: SIGNER_SKILL_NAME }]);
    expect(resource.read(SIGNER_SKILL_URI)).toMatchObject({
      uri: SIGNER_SKILL_URI,
      mimeType: 'text/markdown',
      text: expect.stringContaining('Concordium Signer Key Discovery'),
    });
  });

  it('rejects an unknown URI through the public invalid-argument guard', () => {
    const resource = skillResourceDefinitions().find(({ name }) => name === SIGNER_SKILL_NAME);
    if (resource === undefined) throw new Error('Missing signer key-discovery skill');

    expect(() => resource.read('skill://unknown/SKILL.md')).toThrow(expect.objectContaining({
      kind: 'invalid-argument',
    }));
  });
});
