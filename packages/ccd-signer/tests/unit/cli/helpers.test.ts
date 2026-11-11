import { describe, expect, it } from 'vitest';

import { parseRoleSeparatedSignatures } from '../../../src/cli/helpers.js';
import { CliUsageError } from '../../../src/cli/signCommand.js';

const usageError = (message: string) => new CliUsageError(message);

describe('cli helpers', () => {
  describe('parseRoleSeparatedSignatures', () => {
    const parseSignatures = (value: string) => parseRoleSeparatedSignatures(value, 'Invalid signatures.', usageError);

    it('returns validated sender and sponsor signature groups', () => {
      expect(parseSignatures('{"sender":{"0":{"0":"aa"}},"sponsor":{"1":{"0":"bb"}}}')).toEqual({
        sender: { '0': { '0': 'aa' } },
        sponsor: { '1': { '0': 'bb' } },
      });
    });

    it('maps invalid JSON and invalid signature data to usage errors', () => {
      expect(() => parseSignatures('{')).toThrowError(CliUsageError);
      expect(() => parseSignatures('{"sender":null}')).toThrowError(CliUsageError);
    });
  });
});
