import {
  IdentitySourceError, parseCatalogLabel, resolveIdentitySource,
  type IdentitySourceRecord,
} from '@ccd-agent-kit/config-utils';
import type { IdentityRootAgreement } from '../identityRoot.js';
import type {
  IdentitySourceBackend, IdentitySourceInspectionResult,
  IdentitySourceService, IdentitySourceServiceOptions,
} from './types.js';

/** Create backend-neutral inspection, resolution, and agreement operations. */
export function createIdentitySourceService(options: IdentitySourceServiceOptions): IdentitySourceService {
  const backends = new Map(options.backends.map((backend) => [backend.backend, backend]));
  const isEnabled = options.isBackendEnabled ?? (() => true);
  const inspectRecord = async (
    id: string,
    record: IdentitySourceRecord,
    defaultSourceId?: string,
  ): Promise<IdentitySourceInspectionResult> => {
    const publicRecord: Omit<IdentitySourceRecord, 'label'> = {
      backends: structuredClone(record.backends), rootPublicKey: record.rootPublicKey,
      rootPublicKeyFingerprint: record.rootPublicKeyFingerprint, recipeVersion: record.recipeVersion,
    };
    const base = {
      id, ...publicRecord,
      ...(record.label === undefined ? {} : { label: parseCatalogLabel(record.label).label }),
      isDefault: id === defaultSourceId,
    };
    let selected: Extract<Awaited<ReturnType<IdentitySourceBackend['inspect']>>, { status: 'present' }> | undefined;
    let unavailableReason: IdentitySourceInspectionResult['reason'] = 'UNSUPPORTED_BACKEND';
    select: for (const reference of record.backends) {
      if (!isEnabled(reference.backend)) continue;
      const backend = backends.get(reference.backend);
      if (backend === undefined) continue;
      for (const location of reference.locations) {
        if (!isEnabled(reference.backend)) break;
        const observation = await backend.inspect(structuredClone(location), {
          sourceId: id, expectedPublicKey: Buffer.from(record.rootPublicKey, 'hex'),
        });
        if (!isEnabled(reference.backend)) {
          unavailableReason = 'UNSUPPORTED_BACKEND';
          break;
        }
        if (observation.status === 'unavailable') {
          unavailableReason = observation.reason;
          continue;
        }
        if (observation.rootPublicKey !== record.rootPublicKey) {
          unavailableReason = 'ROOT_MISMATCH';
          continue;
        }
        selected = observation;
        break select;
      }
    }
    if (selected === undefined) return { ...base, availability: 'unavailable', reason: unavailableReason };
    return {
      ...base, availability: selected.authorization,
      ...(selected.pinPolicy === undefined ? {} : { pinPolicy: selected.pinPolicy }),
      ...(selected.touchPolicy === undefined ? {} : { touchPolicy: selected.touchPolicy }),
    };
  };

  return {
    async refresh() {
      await options.refresh();
    },
    async list() {
      await options.prepare?.();
      const document = await options.registry.read();
      const output = [];
      for (const [id, record] of Object.entries(document.sources).sort((a, b) => {
        const left = a[1].label === undefined ? a[0] : parseCatalogLabel(a[1].label).label;
        const right = b[1].label === undefined ? b[0] : parseCatalogLabel(b[1].label).label;
        return left.localeCompare(right);
      })) {
        const inspected = await inspectRecord(id, record, document.defaultSourceId);
        output.push({
          id: inspected.id, ...(inspected.label === undefined ? {} : { label: inspected.label }),
          isDefault: inspected.isDefault, availability: inspected.availability,
        });
      }
      return output;
    },
    async records() {
      const document = await options.registry.read();
      return Object.entries(document.sources).map(([id, record]) => ({ id, ...structuredClone(record) }));
    },
    async inspect(source) {
      await options.prepare?.();
      const document = await options.registry.read();
      const [id, record] = resolveIdentitySource(document, source);
      return inspectRecord(id, record, document.defaultSourceId);
    },
    async resolve(source) {
      const document = await options.registry.read();
      const [id, record] = resolveIdentitySource(document, source);
      return { id, ...structuredClone(record) };
    },
    async createAgreement(source, agreementOptions = {}) {
      await options.prepare?.();
      const document = await options.registry.read();
      const [sourceId, record] = resolveIdentitySource(document, source);
      const expectedPublicKey = Buffer.from(record.rootPublicKey, 'hex');
      const agreements: IdentityRootAgreement[] = [];
      for (const reference of record.backends) {
        if (!isEnabled(reference.backend)) continue;
        const backend = backends.get(reference.backend);
        if (backend === undefined) continue;
        for (const locator of reference.locations) {
          if (!isEnabled(reference.backend)) break;
          const observation = await backend.inspect(structuredClone(locator), { sourceId, expectedPublicKey });
          if (observation.status !== 'present' || observation.rootPublicKey !== record.rootPublicKey) continue;
          if (observation.authorization === 'locked' && agreementOptions.promptPin === undefined) continue;
          if (!isEnabled(reference.backend)) break;
          const agreement = backend.createAgreement({
            sourceId, locator: structuredClone(locator), expectedPublicKey,
            ...(agreementOptions.promptPin === undefined ? {} : { promptPin: agreementOptions.promptPin }),
          });
          agreements.push({
            agree(peerPublicKey) {
              if (!isEnabled(reference.backend)) throw new IdentitySourceError('INVALID_SOURCE');
              return agreement.agree(peerPublicKey);
            },
          });
        }
      }
      if (agreements.length === 0) throw new IdentitySourceError('INVALID_SOURCE');
      return {
        async agree(peerPublicKey) {
          let lastError: unknown;
          for (const agreement of agreements) {
            try { return await agreement.agree(peerPublicKey); }
            catch (error) { lastError = error; }
          }
          throw lastError instanceof Error ? lastError : new IdentitySourceError('INVALID_SOURCE');
        },
      };
    },
    ...(options.close === undefined ? {} : { close: options.close }),
  };
}
