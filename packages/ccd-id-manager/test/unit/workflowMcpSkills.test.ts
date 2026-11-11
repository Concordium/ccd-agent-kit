import { beforeEach, describe, expect, it } from 'vitest';

import { identityProviderServiceFixture } from '../helpers.js';
import { identityWorkflowFixture } from '../mcpTestHelpers.js';
import {
  captureIdentityMcpAdapter,
  requestHandler,
  resource,
} from './mcpAdapterHarness.js';

const SKILL_NAME = 'ccd-identity-management';
const SKILL_URI = `skill://${SKILL_NAME}/SKILL.md`;

describe('identity manager MCP skill adapter', () => {
  beforeEach(async () => {
    await captureIdentityMcpAdapter({
      workflow: identityWorkflowFixture(),
      sources: {
        refresh: async () => undefined,
        resolve: async () => { throw new Error('not used'); },
        list: async () => [],
        records: async () => [],
        inspect: async () => { throw new Error('not used'); },
        createAgreement: async () => { throw new Error('not used'); },
      },
      providers: identityProviderServiceFixture(),
    });
  });

  it('lists, gets, and reads the complete static skill', async () => {
    await expect(resource(SKILL_NAME)(new URL(SKILL_URI))).resolves.toMatchObject({
      contents: [{ uri: SKILL_URI, mimeType: 'text/markdown' }],
    });
    await expect(requestHandler('skills/list')({})).resolves.toMatchObject({
      resultType: 'complete', skills: [{ uri: SKILL_URI, resources: [expect.objectContaining({ uri: SKILL_URI })] }],
      ttlMs: 300_000, cacheScope: 'public',
    });
    await expect(requestHandler('skills/get')({ uri: SKILL_URI })).resolves.toMatchObject({
      resultType: 'complete', skill: { uri: SKILL_URI }, ttlMs: 300_000, cacheScope: 'public',
    });
  });

  it('rejects unknown extension and resource URIs as invalid parameters', async () => {
    await expect(requestHandler('skills/get')({ uri: 'skill://missing/SKILL.md' })).rejects.toMatchObject({
      code: -32602,
    });
    await expect(resource(SKILL_NAME)(new URL('skill://missing/SKILL.md'))).rejects.toMatchObject({
      code: -32602,
    });
  });
});
