import { getCredentialDeploymentSignDigest } from '@concordium/web-sdk';
import { createHash } from 'node:crypto';
import { describe,expect,it,vi } from 'vitest';
import { runCli } from '../../src/cli/index.js';
import { createIdentityWorkflow } from '../../src/core/identityWorkflow.js';
import { createIdentityProviderClient } from '../../src/core/workflowInfrastructure.js';
import { identityProviderServiceFixture,TEST_CANONICAL_NETWORK } from '../helpers.js';
import { IDENTITY_ID,identityObject,NOW_MS,PUBLIC_KEY,selection,setup,SOURCE_ID } from '../workflowFixtures.js';

function startArgs(operation: 'request' | 'recover') {
  const input = selection();
  return ['identity',operation,'--network',input.network,'--source',SOURCE_ID,
    '--idp',String(input.identityProviderIndex),
    '--identity-index',String(input.identityIndex)];
}

const cliProviders = () => identityProviderServiceFixture({ resolve: vi.fn(async () => ({
  index: selection().identityProviderIndex,
  issuanceUrl: 'https://issuer.example.test/issue', recoveryUrl: 'https://issuer.example.test/recover', issuanceMethod: 'GET' as const,
})) });
const cliNetwork = () => TEST_CANONICAL_NETWORK;

describe('CLI through shared workflow and HTTP adapter', () => {
  it('completes browser issuance, resumes pending retrieval, and produces a public signer handoff', async () => {
    const fixture = setup();
    let retrieval = 0;
    const fetcher = vi.fn<typeof fetch>(async (url) => new URL(String(url)).pathname.endsWith('/recover')
      ? Response.json({ code: 404, message: 'ID object not found in database' }, { status: 404 })
      : Response.json(++retrieval === 1
        ? {status:'pending',token:null} : {status:'done',token:{identityObject:identityObject()}}));
    const workflow = createIdentityWorkflow({...fixture.deps,provider:createIdentityProviderClient(fetcher)});
    const stdout: string[] = []; const stderr: string[] = [];
    const run = async (args: string[]) => {
      stdout.length = 0;
      stderr.length = 0;
      expect(await runCli(args,{workflow,providerService:cliProviders(),resolveProviderNetwork:cliNetwork,stdout:text => stdout.push(text),stderr:text => stderr.push(text)})).toBe(0);
      expect(stderr).toEqual([`Network: ${TEST_CANONICAL_NETWORK.caip2}\n`]);
      return JSON.parse(stdout.join(''));
    };
    const request = await run(startArgs('request'));
    expect(request.status).toBe('pending');
    expect(new URL(request.authorizationUrl).searchParams.get('redirect_uri')).toBe(`ccd-id-manager://identity/${IDENTITY_ID}`);
    const callback = `ccd-id-manager://identity/${IDENTITY_ID}#code_uri=${encodeURIComponent('https://issuer.example.test/result')}`;
    expect((await run(['identity','status','--identity',IDENTITY_ID,'--callback-url',callback])).status).toBe('pending');
    expect((await run(['identity','status','--identity',IDENTITY_ID])).status).toBe('issued');
    const prepared = await run([
      'account', 'prepare', '--identity', IDENTITY_ID, '--credential-number', '0',
      '--public-keys', JSON.stringify({ 0: PUBLIC_KEY }), '--credential-threshold', '1',
      '--expiry-seconds', String(NOW_MS / 1000 + 600),
    ]);
    expect(prepared.network).toBe(selection().network);
    expect(prepared.accountAddress).toBeTruthy();
    expect(prepared.credDeploymentHex).toMatch(/^00[0-9a-f]+$/);
    const bytes = Buffer.from(prepared.credDeploymentHex,'hex');
    const digest = createHash('sha256').update(bytes.subarray(9)).update(bytes.subarray(0,9)).digest();
    expect(digest).toEqual(Buffer.from(getCredentialDeploymentSignDigest(fixture.payload)));
    expect(JSON.stringify(prepared)).not.toMatch(/chosenAttributes|idCredSec|randomness|Lovelace/);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fixture.device.agree).toHaveBeenCalledTimes(5);
    expect(fixture.device.transferred.every(secret => secret.every(byte => byte === 0))).toBe(true);
  });

  it('does not turn missing recovery into issuance or persist partial identity state', async () => {
    const fixture = setup();
    const fetcher = vi.fn<typeof fetch>(async () => new Response('private provider diagnostics',{status:404}));
    const workflow = createIdentityWorkflow({...fixture.deps,provider:createIdentityProviderClient(fetcher)});
    const stdout: string[] = []; const stderr: string[] = [];
    expect(await runCli(startArgs('recover'),{workflow,providerService:cliProviders(),resolveProviderNetwork:cliNetwork,stdout:text => stdout.push(text),stderr:text => stderr.push(text)})).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toContain(`Network: ${TEST_CANONICAL_NETWORK.caip2}\n`);
    expect(stderr.join('')).not.toContain('private provider diagnostics');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fixture.crypto.request).not.toHaveBeenCalled();
    expect(fixture.store.records.size).toBe(0);
  });
});
