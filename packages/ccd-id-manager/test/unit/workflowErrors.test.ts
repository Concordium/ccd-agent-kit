import { describe, expect, it } from 'vitest';
import { IdentityWorkflowError, workflowFailure } from '../../src/core/workflowErrors.js';

describe('workflow failure sanitization', () => {
  it('preserves local workflow classifications and replaces foreign failures', () => {
    expect(workflowFailure(new IdentityWorkflowError('IDENTITY_NOT_READY'), 'PROVIDER_FAILED').code)
      .toBe('IDENTITY_NOT_READY');
    expect(workflowFailure({ code: 'IDENTITY_NOT_READY' }, 'PROVIDER_FAILED').code)
      .toBe('PROVIDER_FAILED');
  });
});
