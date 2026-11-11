import { describe, expect, it } from 'vitest';
import { skillResourceDefinitions } from '../../../../src/mcp/skills/resourceDefinitions.js';

describe('skill resource definitions', () => {
  it('routes only the definition URI to its packaged markdown', async () => {
    const resource = skillResourceDefinitions().find(({ uri }) => uri === 'skill://ccd-transfer/SKILL.md');
    if (resource === undefined) throw new Error('Missing CCD transfer skill');

    const read = await resource.read(resource.uri);
    expect(read).toMatchObject({
      mimeType: 'text/markdown',
      text: expect.stringContaining('build_transfer'),
    });
    await expect(resource.read('skill://missing/SKILL.md')).rejects.toMatchObject({ kind: 'invalid-argument' });
  });
});
