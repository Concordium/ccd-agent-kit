import { createIdentityYubiKeyService,createPivTransport } from '@ccd-agent-kit/piv-utils';
import { createECDH } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { describe,expect,it } from 'vitest';
import { deriveIdentityRoot } from '../../src/core/identityRoot.js';
import { ROOT_CONTEXT,SEED_HEX } from '../identityCryptoFixtures.js';

describe('identity root through the shared PIV transport', () => {
  it('derives the pinned vector over shared APDUs without provisioning or prompting', async () => {
    const device = createECDH('prime256v1');
    const key = Buffer.alloc(32);
    key[31] = 1;
    device.setPrivateKey(key);
    key.fill(0);
    const publicKey = device.getPublicKey(undefined, 'uncompressed');
    const commands: Buffer[] = [];
    const modes: number[] = [];
    const disconnects: number[] = [];
    const secretResponses: Buffer[] = [];
    let contextCloses = 0;
    let readerCloses = 0;
    const context = Object.assign(new EventEmitter(), { close() { contextCloses++; } });
    const reader = Object.assign(new EventEmitter(), {
      name: 'software PIV test device',
      close() { readerCloses++; },
      connect(options: { share_mode?: number }, callback: (error: Error | null, protocol: number) => void) {
        modes.push(options.share_mode!);
        callback(null, 1);
      },
      disconnect(disposition: number, callback: (error: Error | null) => void) {
        disconnects.push(disposition);
        callback(null);
      },
      transmit(command: Buffer, _length: number, _protocol: number, callback: (error: Error | null, data: Buffer) => void) {
        commands.push(Buffer.from(command));
        let data: Buffer;
        switch (command[1]) {
          case 0xa4:
            data = Buffer.alloc(0);
            break;
          case 0xf8:
            data = Buffer.from('00bc614e', 'hex'); // 12345678
            break;
          case 0xf7:
            if (command[3] !== 0x9d) throw new Error('Unexpected slot');
            data = Buffer.concat([Buffer.from('0101110202010103010104438641', 'hex'), publicKey]);
            break;
          case 0x87: {
            if (command[2] !== 0x11 || command[3] !== 0x9d) throw new Error('Unexpected agreement');
            const secret = device.computeSecret(command.subarray(11, 76));
            data = Buffer.concat([Buffer.from('7c228220', 'hex'), secret]);
            secret.fill(0);
            break;
          }
          default:
            throw new Error('Unexpected hardware operation');
        }
        const response = Buffer.concat([data, Buffer.from('9000', 'hex')]);
        data.fill(0);
        if (command[1] === 0x87) secretResponses.push(response);
        callback(null, response);
      },
    });
    const transport = createPivTransport({
      discoveryWaitMs: 1,
      factoryLoader: async () => () => {
        process.nextTick(() => context.emit('reader', reader));
        return context;
      },
    });
    const service = createIdentityYubiKeyService(transport);
    const root = await deriveIdentityRoot({
      ...ROOT_CONTEXT,
      expectedPublicKey: publicKey,
      agreement: service.createAgreement({ serial: '12345678', expectedPublicKey: publicKey }),
    });
    try {
      expect(root.toString('hex')).toBe(SEED_HEX);
      expect(modes).toEqual([2]);
      expect(commands.filter(command => command[1] === 0x87)).toHaveLength(1);
      expect(commands.filter(command => command[1] === 0xf7)).toHaveLength(2);
      expect(commands.some(command => [0x20, 0x47, 0xfe].includes(command[1]!))).toBe(false);
      expect(secretResponses).toHaveLength(1);
      expect(secretResponses[0]!.subarray(0, -2)).toEqual(Buffer.alloc(36));
      expect(disconnects).toEqual([0]);
      expect(readerCloses).toBe(1);
      expect(contextCloses).toBe(1);
    } finally {
      root.fill(0);
    }
  });
});
