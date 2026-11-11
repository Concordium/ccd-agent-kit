import { createIdentitySourceRegistry } from '@ccd-agent-kit/config-utils';
import { mkdir, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createIdentitySourceService } from '../../src/core/sources/service.js';
import { fakeSourceBackend, presentInspection, sourceRecord, useSourceScratch } from '../sourceHelpers.js';

const scratch = useSourceScratch('sources-service-integration-');

describe('identity-source service with protected catalog', () => {
  it('resolves a catalog-validated source and delegates pinned agreement creation', async () => {
    const registry = createIdentitySourceRegistry();
    const fake = fakeSourceBackend(presentInspection());
    const service = createIdentitySourceService({ registry, backends: [fake.backend], refresh: async () => undefined });
    const enrolled = await registry.enroll(sourceRecord());
    const persisted = (await registry.read()).sources[enrolled.id];

    expect(persisted).toMatchObject({ label: 'primary' });
    expect(persisted).not.toHaveProperty('name');

    await expect(service.inspect(enrolled.id)).resolves.toMatchObject({
      id: enrolled.id,
      label: 'primary',
      availability: 'unlocked',
    });
    await expect(service.createAgreement(enrolled.id)).resolves.toHaveProperty('agree');
    expect(fake.backend.createAgreement).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: enrolled.id,
      expectedPublicKey: Buffer.from(enrolled.rootPublicKey, 'hex'),
    }));
  });

  it('preserves a protected-catalog parse failure without hardware access', async () => {
    await mkdir(scratch.directory(), { recursive: true, mode: 0o700 });
    await writeFile(scratch.filename(), '{"version":1,"sources":{"bad":{}}}\n', { mode: 0o600 });
    const fake = fakeSourceBackend();
    const service = createIdentitySourceService({
      registry: createIdentitySourceRegistry(), backends: [fake.backend], refresh: async () => undefined,
    });

    await expect(service.list()).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(fake.backend.inspect).not.toHaveBeenCalled();
  });
});
