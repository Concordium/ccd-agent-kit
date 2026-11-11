import { describe, expect, it } from 'vitest';
import { parseBlockReference } from '../../../../src/mcp/toolPlumbing/toolSchemas.js';
import {
  buildConfigureDelegationArgsSchema,
  buildTransferArgsSchema,
} from '../../../../src/mcp/transactions/internal/schemas.js';
import { contractAddressSchema, u64StringSchema } from '../../../../src/mcp/toolPlumbing/toolSchemas.js';

describe('u64StringSchema', () => {
  it('accepts the full u64 range as decimal strings', () => {
    expect(u64StringSchema.safeParse('0').success).toBe(true);
    expect(u64StringSchema.safeParse('18446744073709551615').success).toBe(true);
  });

  it('rejects non-decimal strings', () => {
    expect(u64StringSchema.safeParse('-1').success).toBe(false);
    expect(u64StringSchema.safeParse('1.5').success).toBe(false);
    expect(u64StringSchema.safeParse('abc').success).toBe(false);
    expect(u64StringSchema.safeParse('').success).toBe(false);
  });
});

describe('contractAddressSchema', () => {
  it('accepts contract instance identifiers as strings', () => {
    expect(contractAddressSchema.safeParse('9870,0').success).toBe(true);
    expect(contractAddressSchema.safeParse('9870.0').success).toBe(true);
    expect(contractAddressSchema.safeParse('my-contract').success).toBe(true);
  });

  it('rejects non-string contract identifiers', () => {
    expect(contractAddressSchema.safeParse({ index: '9870', subindex: '0' }).success).toBe(false);
  });
});

describe('parseBlockReference', () => {
  it('returns undefined for an omitted reference', () => {
    expect(parseBlockReference(undefined)).toBeUndefined();
  });

  it('maps the best literal', () => {
    expect(parseBlockReference('best')).toEqual({ type: 'best' });
  });

  it('maps the last_final literal', () => {
    expect(parseBlockReference('last_final')).toEqual({ type: 'last_final' });
  });

  it('maps a hex hash', () => {
    expect(parseBlockReference('aabbcc')).toEqual({ type: 'hash', hash: 'aabbcc' });
  });
});

describe('buildTransferArgsSchema', () => {
  it('requires sender, toAddress and amountMicroCcd', () => {
    expect(
      buildTransferArgsSchema.safeParse({
        sender: '3kBx2h5Y2veb4hZgAJWPrr8RyQESKm5TjzF3ti1QQ4VSvj6tF',
        toAddress: '4QkqdUnrjShrUrHpE96odLM6J77nWzEryifzqNnwNk4FYNge8a',
        amountMicroCcd: '5000000',
      }).success,
    ).toBe(true);
  });

  it('rejects a missing amount', () => {
    expect(
      buildTransferArgsSchema.safeParse({
        sender: '3kBx2h5Y2veb4hZgAJWPrr8RyQESKm5TjzF3ti1QQ4VSvj6tF',
        toAddress: '4QkqdUnrjShrUrHpE96odLM6J77nWzEryifzqNnwNk4FYNge8a',
      }).success,
    ).toBe(false);
  });
});

describe('buildConfigureDelegationArgsSchema', () => {
  const sender = '3kBx2h5Y2veb4hZgAJWPrr8RyQESKm5TjzF3ti1QQ4VSvj6tF';

  it('requires poolId when targeting a pool', () => {
    expect(buildConfigureDelegationArgsSchema.safeParse({ sender, delegationTarget: 'pool' }).success).toBe(false);
  });

  it('accepts poolId when targeting a pool', () => {
    expect(
      buildConfigureDelegationArgsSchema.safeParse({
        sender,
        delegationTarget: 'pool',
        poolId: '42',
      }).success,
    ).toBe(true);
  });

  it('rejects poolId when targeting passive delegation', () => {
    expect(
      buildConfigureDelegationArgsSchema.safeParse({
        sender,
        delegationTarget: 'passive',
        poolId: '42',
      }).success,
    ).toBe(false);
  });
});
