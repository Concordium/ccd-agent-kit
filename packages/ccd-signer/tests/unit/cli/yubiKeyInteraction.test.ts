import { describe, expect, it, vi } from 'vitest';

vi.mock('@ccd-agent-kit/cli-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ccd-agent-kit/cli-utils')>();
  return {
    ...actual,
    readHiddenLine: vi.fn(async () => '123456'),
  };
});

import { readHiddenLine } from '@ccd-agent-kit/cli-utils';

import { createCliYubiKeyInteraction } from '../../../src/cli/yubiKeyInteraction.js';

describe('createCliYubiKeyInteraction', () => {
  it('uses injected PIN prompts when provided', async () => {
    const promptPin = vi.fn(async () => '654321');

    await expect(createCliYubiKeyInteraction(promptPin).promptPin()).resolves.toBe('654321');
    expect(promptPin).toHaveBeenCalledOnce();
    expect(readHiddenLine).not.toHaveBeenCalled();
  });

  it('falls back to the hidden terminal PIN prompt', async () => {
    await expect(createCliYubiKeyInteraction().promptPin()).resolves.toBe('123456');

    expect(readHiddenLine).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'PIV PIN: ',
      'YubiKey PIN entry requires an interactive terminal.',
    );
  });
});
