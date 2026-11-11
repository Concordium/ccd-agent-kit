import { describe,expect,it,vi } from 'vitest';

import { createIdentityProofService } from '../../src/core/identityProofs.js';

function request() {
  return {
    type: 'ConcordiumVerificationRequestV1',
    transactionRef: 'ab'.repeat(32),
    context: {
      type: 'ConcordiumUnfilledContextInformationV1',
      given: [{ label: 'ContextString', context: 'Authorize this exact action.' }],
      requested: ['BlockHash'],
    },
    subjectClaims: [{
      type: 'identity', source: ['identityCredential'],
      issuers: ['did:ccd:testnet:idp:7'],
      statements: [{ type: 'AttributeInSet', attributeTag: 'nationality', set: ['DK'] }],
    }],
  };
}

function fixture() {
  const unavailable = vi.fn(async () => { throw new Error('Unexpected protected operation'); });
  const resolveNetwork = vi.fn(() => ({ caip2: `ccd:${'12'.repeat(16)}`, sdkNetwork: 'Testnet' as const }));
  const verifyAnchor = vi.fn(async () => ({
    status: 'valid' as const, transactionHash: 'ab'.repeat(32), blockHash: 'cd'.repeat(32), account: 'registrant',
  }));
  const service = createIdentityProofService({
    resolveNetwork, verifyAnchor,
    listRecords: unavailable, loadIdentity: unavailable,
    loadLocalContext: unavailable, loadGenerationContext: unavailable,
    loadFinalizedCredentials: unavailable, loadCredentialRegistry: unavailable,
    listCachedCredentials: unavailable, withMaterial: unavailable,
  });
  return { service, resolveNetwork, verifyAnchor, unavailable };
}

describe('proof request guards before operational I/O', () => {
  const invalidRequests = [
    ['duplicate given context labels', () => {
      const input = request();
      input.context.given.push({ label: 'ContextString', context: 'A contradictory action.' });
      return input;
    }],
    ['duplicate requested labels', () => {
      const input = request(); input.context.requested.push('BlockHash'); return input;
    }],
    ['unfillable requested context', () => {
      const input = request(); input.context.requested = ['Nonce']; return input;
    }],
    ['already supplied requested block hash', () => {
      const input = request(); input.context.given.push({ label: 'BlockHash', context: 'cd'.repeat(32) }); return input;
    }],
    ['unknown issuer network', () => {
      const input = request(); input.subjectClaims[0]!.issuers = ['did:ccd:garbage:idp:7']; return input;
    }],
    ['out-of-range issuer index', () => {
      const input = request(); input.subjectClaims[0]!.issuers = ['did:ccd:testnet:idp:4294967296']; return input;
    }],
    ...['07', '+7', '-1'].map(index => [`noncanonical issuer index ${index}`, () => {
      const input = request(); input.subjectClaims[0]!.issuers = [`did:ccd:testnet:idp:${index}`]; return input;
    }] as [string, () => Record<string, unknown>]),
    ['extra statement fields', () => {
      const input = request(); Object.assign(input.subjectClaims[0]!.statements[0]!, { ignored: 'not anchored semantics' });
      return input;
    }],
    ['unknown attribute name', () => {
      const input = request(); input.subjectClaims[0]!.statements[0]!.attributeTag = '__proto__'; return input;
    }],
    ['raw identification-number disclosure', () => {
      const input: Record<string, unknown> = request();
      (input.subjectClaims as Array<{ statements: unknown[] }>)[0]!.statements = [
        { type: 'RevealAttribute', attributeTag: 'taxIdNo' },
      ];
      return input;
    }],
    ['excessive request size', () => {
      const input = request(); input.context.given[0]!.context = 'x'.repeat(1_048_576); return input;
    }],
    ['excessive claim groups', () => {
      const input = request(); input.subjectClaims = Array.from({ length: 65 }, () => structuredClone(input.subjectClaims[0]!));
      return input;
    }],
    ['excessive statements', () => {
      const input = request();
      input.subjectClaims[0]!.statements = Array.from({ length: 257 }, () => structuredClone(input.subjectClaims[0]!.statements[0]!));
      return input;
    }],
  ] satisfies Array<[string, () => Record<string, unknown>]>;

  it.each(invalidRequests)('rejects %s before config, node, storage, or hardware access', async (_name, makeRequest) => {
    const { service, resolveNetwork, verifyAnchor, unavailable } = fixture();
    const input = makeRequest();
    await expect(service.validateRequest({ request: input })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(service.findCandidates({ request: input })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(service.createProof({ request: input, subject: { type: 'identity', identityId: 'id' } }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(resolveNetwork).not.toHaveBeenCalled();
    expect(verifyAnchor).not.toHaveBeenCalled();
    expect(unavailable).not.toHaveBeenCalled();
  });

  it('preserves exact authorization text and permits the supported attribute-free identity group', async () => {
    const { service, unavailable } = fixture();
    const input = request();
    input.context.given[0]!.context = '  Authorize\n\u0000👋 e\u0301  ';
    input.subjectClaims[0]!.statements = [];
    await expect(service.validateRequest({ request: input, describe: true })).resolves.toMatchObject({
      description: { context: [{ label: 'ContextString', context: input.context.given[0]!.context }] },
    });
    expect(unavailable).not.toHaveBeenCalled();
  });

  it('does not infer domain authentication metadata from a requester-supplied resource identifier', async () => {
    const { service } = fixture();
    const input = request();
    input.context.given.push({ label: 'ResourceID', context: 'https://claimed.example/path?session=1' });
    const result = await service.validateRequest({ request: input, describe: true });
    expect(result.domainBinding).toEqual({ status: 'not_checked' });
    expect(result.description).toMatchObject({
      resource: [{ label: 'ResourceID', context: 'https://claimed.example/path?session=1' }],
    });
  });

  it.each([
    { type: 'RevealAttribute', attributeTag: 'nationality', extra: true },
    { type: 'AttributeNotInSet', attributeTag: 'nationality', set: ['SE'], extra: true },
    { type: 'AttributeInRange', attributeTag: 'dob', lower: '19000101', upper: '20000101', extra: true },
    { type: 'AttributeValue', attributeTag: 'nationality', attributeValue: 'DK' },
  ])('rejects unsupported or extra statement fields: %j', async statement => {
    const { service, resolveNetwork } = fixture();
    const input: Record<string, unknown> = request();
    (input.subjectClaims as Array<{ statements: unknown[] }>)[0]!.statements = [statement];
    await expect(service.validateRequest({ request: input })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(resolveNetwork).not.toHaveBeenCalled();
  });

  it('accepts the maximum issuer index and validates empty requests without inspecting identities', async () => {
    const { service, verifyAnchor, unavailable } = fixture();
    const input = request();
    input.subjectClaims[0]!.issuers = ['did:ccd:testnet:idp:4294967295'];
    await expect(service.validateRequest({ request: input })).resolves.toMatchObject({ anchor: { status: 'valid' } });
    input.subjectClaims = [];
    await expect(service.validateRequest({ request: input })).resolves.toMatchObject({ anchor: { status: 'valid' } });
    expect(verifyAnchor).toHaveBeenCalledTimes(2);
    expect(unavailable).not.toHaveBeenCalled();
  });

  it('bounds aggregate statements across groups rather than only each individual group', async () => {
    const { service } = fixture();
    const input = request();
    const group = input.subjectClaims[0]!;
    group.statements = ['firstName', 'lastName', 'nationality', 'countryOfResidence'].map(attributeTag => ({
      type: 'AttributeInSet', attributeTag, set: ['DK'],
    }));
    input.subjectClaims = Array.from({ length: 64 }, () => structuredClone(group));
    await expect(service.validateRequest({ request: input })).resolves.toMatchObject({ anchor: { status: 'valid' } });
    input.subjectClaims[0]!.statements.push({ type: 'AttributeInSet', attributeTag: 'idDocType', set: ['1'] });
    await expect(service.validateRequest({ request: input })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('accepts the exact byte-size limit and rejects one byte over it', async () => {
    const { service } = fixture();
    const input = request();
    input.context.given[0]!.context += 'x'.repeat(1_048_576 - Buffer.byteLength(JSON.stringify(input), 'utf8'));
    await expect(service.validateRequest({ request: input })).resolves.toMatchObject({ anchor: { status: 'valid' } });
    input.context.given[0]!.context += 'x';
    await expect(service.validateRequest({ request: input })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('sanitizes resolver failures without inspecting anchors or protected identity state', async () => {
    const { service, resolveNetwork, verifyAnchor, unavailable } = fixture();
    resolveNetwork.mockImplementation(() => { throw new Error('private /protected/network-state'); });
    await expect(service.validateRequest({ request: request() })).rejects.toMatchObject({
      name: 'IdentityProofError', code: 'NETWORK_FAILED',
    });
    expect(verifyAnchor).not.toHaveBeenCalled();
    expect(unavailable).not.toHaveBeenCalled();
  });
});
