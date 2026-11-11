import { describe,expect,it,vi } from 'vitest';
import { withIdentityHardwareQueue } from '../../src/core/hardwareQueue.js';

describe('identity hardware queue', () => {
  it('serializes controls with agreements and releases after failures', async () => {
    const events: string[] = [];
    let release!: () => void;
    const blocked = withIdentityHardwareQueue(async () => {
      events.push('agreement-start');
      await new Promise<void>((resolve) => { release = resolve; });
      events.push('agreement-end');
    });
    const control = withIdentityHardwareQueue(async () => { events.push('control'); });
    await vi.waitFor(() => expect(events).toEqual(['agreement-start']));
    release();
    await Promise.all([blocked, control]);
    expect(events).toEqual(['agreement-start', 'agreement-end', 'control']);

    await expect(withIdentityHardwareQueue(async () => { throw new Error('failed'); })).rejects.toThrow('failed');
    await withIdentityHardwareQueue(async () => { events.push('after-failure'); });
    expect(events.at(-1)).toBe('after-failure');
  });
});
