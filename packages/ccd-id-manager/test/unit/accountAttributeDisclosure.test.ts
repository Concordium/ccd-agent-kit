import { getAccountAddress } from '@concordium/web-sdk';
import { describe,expect,it,vi } from 'vitest';

import { createIdentityWorkflow } from '../../src/core/identityWorkflow.js';
import type { PrepareAccountInput } from '../../src/core/workflowTypes.js';
import {
ACCOUNT_OPENING_DISCLOSURE_WARNING,
DEFAULT_REVEALABLE_IDENTITY_ATTRIBUTES,
} from '../../src/core/workflowTypes.js';
import {
IDENTITY_ID,
NOW_MS,
PUBLIC_KEY,
credentialPayload,
readyRecord,
setup,
} from '../workflowFixtures.js';

const prepareBase = {
  identityId: IDENTITY_ID,
  credentialNumber: 0,
  publicKeys: { '0': PUBLIC_KEY }, credentialThreshold: 1,
  expirySeconds: NOW_MS / 1000 + 600,
};

const defaultAttributes = [
  'firstName',
  'lastName',
  'countryOfResidence',
  'nationality',
  'idDocType',
  'idDocIssuer',
  'idDocIssuedAt',
  'idDocExpiresAt',
  'lei',
  'legalName',
  'legalCountry',
  'registrationAuth',
] as const;

function seedReadyWithAttributes(fixture: ReturnType<typeof setup>, chosenAttributes: Record<string, unknown>) {
  const record = readyRecord();
  record.identity!.value.attributeList.chosenAttributes = chosenAttributes as never;
  fixture.store.records.set(IDENTITY_ID, record);
}

function mirrorSelectedPolicy(fixture: ReturnType<typeof setup>) {
  vi.mocked(fixture.crypto.credential).mockImplementation((input) => {
    const payload = credentialPayload();
    payload.unsignedCdi.policy.revealedAttributes = Object.fromEntries(
      input.revealedAttributes.map((name) => [name, input.idObject.attributeList.chosenAttributes[name]]),
    );
    return payload;
  });
}

describe('account-opening identity attribute disclosure', () => {
  it('exports the complete default allowlist without high-risk identity attributes', () => {
    expect(DEFAULT_REVEALABLE_IDENTITY_ATTRIBUTES).toEqual(defaultAttributes);
    expect(ACCOUNT_OPENING_DISCLOSURE_WARNING).toBe(
      'These identity attributes will become public on-chain if this account opening is submitted.',
    );
    expect(DEFAULT_REVEALABLE_IDENTITY_ATTRIBUTES).not.toEqual(expect.arrayContaining([
      'sex', 'dob', 'idDocNo', 'nationalIdNo', 'taxIdNo', 'businessNumber',
    ]));
  });

  it('deduplicates selectors in SDK tag order and returns only the exact serialized disclosure preview', async () => {
    const fixture = setup();
    const allowedValues = {
      firstName: 'Ada',
      lastName: 'Lovelace',
      countryOfResidence: 'GB',
      nationality: 'GB',
      idDocType: '1',
      idDocIssuer: 'GB',
      idDocIssuedAt: '18430101',
      idDocExpiresAt: '20430101',
      lei: 'TEST-LEI',
      legalName: 'Analytical Engines Ltd',
      legalCountry: 'GB',
      registrationAuth: 'TEST-REGISTRY',
    };
    seedReadyWithAttributes(fixture, {
      ...allowedValues,
      dob: '18151210',
      idDocNo: 'NOT-A-REAL-DOCUMENT',
    });
    mirrorSelectedPolicy(fixture);

    const result = await createIdentityWorkflow(fixture.deps).prepareAccount({
      ...prepareBase,
      revealAttributes: [...defaultAttributes].reverse().concat('firstName'),
    });

    expect(vi.mocked(fixture.crypto.credential).mock.calls[0]![0].revealedAttributes).toEqual(defaultAttributes);
    expect(vi.mocked(fixture.crypto.credential).mock.calls[0]![0].credentialPublicKeys).toEqual({
      keys: { 0: { schemeId: 'Ed25519', verifyKey: PUBLIC_KEY } }, threshold: 1,
    });
    expect(result).toMatchObject({
      accountAddress: getAccountAddress(credentialPayload().unsignedCdi.credId).address,
      revealedAttributes: allowedValues,
      disclosureWarning: ACCOUNT_OPENING_DISCLOSURE_WARNING,
    });
    expect(JSON.stringify(result)).not.toContain('18151210');
    expect(JSON.stringify(result)).not.toContain('NOT-A-REAL-DOCUMENT');
  });

  it.each([
    'sex', 'dob', 'idDocNo', 'nationalIdNo', 'taxIdNo', 'businessNumber', 'unknownAttribute',
  ])('rejects unsupported selector %s before network, context, hardware, or state effects', async (attribute) => {
    const fixture = setup();
    await expect(createIdentityWorkflow(fixture.deps).prepareAccount({
      ...prepareBase,
      revealAttributes: [attribute],
    } as unknown as PrepareAccountInput)).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    expect(fixture.deps.resolveNetwork).not.toHaveBeenCalled();
    expect(fixture.deps.loadContext).not.toHaveBeenCalled();
    expect(fixture.sources.createAgreement).not.toHaveBeenCalled();
    expect(fixture.crypto.credential).not.toHaveBeenCalled();
    expect(fixture.store.saveCredentials).not.toHaveBeenCalled();
  });

  it.each([
    ['non-array', 'firstName'],
    ['null', null],
    ['sparse/non-string entry', ['firstName', 7]],
  ])('rejects malformed disclosure selection: %s', async (_label, revealAttributes) => {
    const fixture = setup();
    await expect(createIdentityWorkflow(fixture.deps).prepareAccount({
      ...prepareBase,
      revealAttributes,
    } as unknown as PrepareAccountInput)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fixture.deps.resolveNetwork).not.toHaveBeenCalled();
    expect(fixture.store.saveCredentials).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', {}],
    ['non-string', { firstName: 7 }],
  ])('fails the whole request when a selected attribute is %s', async (_label, chosenAttributes) => {
    const fixture = setup();
    seedReadyWithAttributes(fixture, chosenAttributes);

    await expect(createIdentityWorkflow(fixture.deps).prepareAccount({
      ...prepareBase,
      revealAttributes: ['firstName'],
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fixture.crypto.credential).not.toHaveBeenCalled();
    expect(fixture.store.saveCredentials).not.toHaveBeenCalled();
  });

  it.each([
    ['missing requested value', {}],
    ['wrong requested value', { firstName: 'Grace' }],
    ['unselected extra value', { firstName: 'Ada', dob: '18151210' }],
  ])('fails closed when the exact serialized handoff has %s', async (_label, revealedAttributes) => {
    const fixture = setup();
    seedReadyWithAttributes(fixture, { firstName: 'Ada', lastName: 'Lovelace' });
    vi.mocked(fixture.crypto.credential).mockImplementation(() => {
      const payload = credentialPayload();
      payload.unsignedCdi.policy.revealedAttributes = revealedAttributes;
      return payload;
    });

    await expect(createIdentityWorkflow(fixture.deps).prepareAccount({
      ...prepareBase,
      revealAttributes: ['firstName'],
    })).rejects.toMatchObject({ code: 'CRYPTO_FAILED' });
    expect(fixture.store.saveCredentials).not.toHaveBeenCalled();
  });

  it('rejects unexpected SDK disclosure even when the requested selection is empty', async () => {
    const fixture = setup();
    seedReadyWithAttributes(fixture, { dob: '18151210' });
    vi.mocked(fixture.crypto.credential).mockImplementation(() => {
      const payload = credentialPayload();
      payload.unsignedCdi.policy.revealedAttributes = { dob: '18151210' };
      return payload;
    });

    await expect(createIdentityWorkflow(fixture.deps).prepareAccount({
      ...prepareBase,
      revealAttributes: [],
    })).rejects.toMatchObject({ code: 'CRYPTO_FAILED' });
    expect(fixture.store.saveCredentials).not.toHaveBeenCalled();
  });

  it.each([undefined, []] as const)('keeps the legacy private output shape for selection %j', async (revealAttributes) => {
    const fixture = setup();
    seedReadyWithAttributes(fixture, {
      firstName: 'Ada', lastName: 'Lovelace', dob: '18151210', idDocNo: 'NOT-A-REAL-DOCUMENT',
    });

    const result = await createIdentityWorkflow(fixture.deps).prepareAccount({
      ...prepareBase,
      ...(revealAttributes === undefined ? {} : { revealAttributes }),
    });
    expect(result).not.toHaveProperty('revealedAttributes');
    expect(result).not.toHaveProperty('disclosureWarning');
    expect(JSON.stringify(result)).not.toContain('18151210');
    expect(JSON.stringify(result)).not.toContain('NOT-A-REAL-DOCUMENT');
  });
});
