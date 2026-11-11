import { IdentitySourceError } from '@ccd-agent-kit/config-utils';
import { describe, expect, it, vi } from 'vitest';
import { withIdentityMaterial } from '../../src/core/identityMaterialSession.js';
import type { IdentitySourceService } from '../../src/core/sources/types.js';
import { selection } from '../workflowFixtures.js';

describe('identity material session source failures', () => {
  it('preserves the catalog producer classification without entering derivation', async () => {
    const sourceError = new IdentitySourceError('SOURCE_NOT_FOUND');
    const sources = {
      createAgreement: vi.fn(async () => { throw sourceError; }),
    } as unknown as IdentitySourceService;
    const callback = vi.fn();

    await expect(withIdentityMaterial({ selection: selection(), sourceId: 'missing', sources }, callback))
      .rejects.toBe(sourceError);
    expect(callback).not.toHaveBeenCalled();
  });
});
