import { describe, expect, it, vi } from 'vitest';

const status = vi.hoisted(() => ({
  instanceId: 'signer-test-instance',
  status: 'locked' as 'locked' | 'unlocked',
  unlockCommand: 'ccd-config-manager service signer unlock --instance signer-test-instance',
}));

vi.mock('../../../../src/core/instance/signerInstance.js', () => ({
  getCurrentSignerInstanceStatus: () => status,
}));

import {
  formatSignerInstanceResource,
  readSignerInstanceResource,
} from '../../../../src/mcp/resources/signerInstanceResource.js';

describe('signer instance resource callbacks', () => {
  it('formats the public status DTO and reflects lock-state changes', () => {
    status.status = 'locked';

    expect(formatSignerInstanceResource()).toEqual({
      instanceId: 'signer-test-instance',
      status: 'locked',
      unlockCommand: 'ccd-config-manager service signer unlock --instance signer-test-instance',
    });

    status.status = 'unlocked';

    expect(formatSignerInstanceResource()).toMatchObject({
      instanceId: 'signer-test-instance',
      status: 'unlocked',
    });
  });

  it('serializes current public status with the requested resource URI', () => {
    status.status = 'locked';

    const content = readSignerInstanceResource('ccd://signer/instance');

    expect(content).toMatchObject({
      uri: 'ccd://signer/instance',
      mimeType: 'application/json',
    });
    expect(JSON.parse(content.text)).toEqual({
      instanceId: 'signer-test-instance',
      status: 'locked',
      unlockCommand: 'ccd-config-manager service signer unlock --instance signer-test-instance',
    });
  });
});
