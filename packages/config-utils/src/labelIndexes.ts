import { caip2Reference } from '@ccd-agent-kit/sdk-utils';

import { isStringRecord, readJsonFile, writeJsonFile } from './jsonFile.js';
import { getActiveNetwork, loadNetworks } from './networks.js';

/** Internal structural shape for label-based indexes. */
export type LabelIndex<TLabels> = { version: 1; networks: Record<string, { labels: TLabels }> };

/** Resolves an omitted label-store scope through the active network at call time. */
export function resolveActiveCaip2Ref(caip2Ref?: string): string {
  return caip2Ref ?? caip2Reference(getActiveNetwork().config.caip2);
}

function parseLabelIndex<TLabels>(
  value: unknown,
  parseLabels: (value: unknown) => TLabels | undefined,
  preserveStoredFields: boolean,
): LabelIndex<TLabels> | undefined {
  if (!isStringRecord(value) || value.version !== 1 || !isStringRecord(value.networks)) return undefined;

  const networkEntries: Array<[string, { labels: TLabels }]> = [];
  for (const [network, entry] of Object.entries(value.networks)) {
    if (!isStringRecord(entry)) return undefined;
    const labels = parseLabels(entry.labels);
    if (labels === undefined) return undefined;
    networkEntries.push([network, preserveStoredFields ? { ...entry, labels } : { labels }]);
  }

  return {
    ...(preserveStoredFields ? value : {}),
    version: 1,
    networks: Object.fromEntries(networkEntries),
  };
}

/** Loads a validated index, using the caller's domain field-retention policy and corruption fallback. */
export function loadLabelIndex<TLabels>(
  filePath: string,
  parseLabels: (value: unknown) => TLabels | undefined,
  preserveStoredFields: boolean,
): LabelIndex<TLabels> {
  return readJsonFile(filePath, (value) => parseLabelIndex(value, parseLabels, preserveStoredFields)) ?? { version: 1, networks: {} };
}

/** Synchronizes one network entry; empty mappings remove it without rebuilding other networks. */
export function updateLabelIndexForNetwork<TLabels extends Record<string, unknown>>(
  filePath: string,
  caip2Ref: string,
  labels: TLabels,
  parseLabels: (value: unknown) => TLabels | undefined,
  preserveStoredFields: boolean,
): void {
  const index = loadLabelIndex(filePath, parseLabels, preserveStoredFields);
  if (Object.keys(labels).length === 0) delete index.networks[caip2Ref];
  else index.networks[caip2Ref] = { labels };
  writeJsonFile(filePath, index);
}

/** Rebuilds derived state from nonempty authoritative maps of configured networks only. */
export function rebuildLabelIndex<TLabels extends Record<string, unknown>>(
  loadLabels: (caip2Ref: string) => TLabels,
  saveIndex: (index: LabelIndex<TLabels>) => void,
): LabelIndex<TLabels> {
  const index: LabelIndex<TLabels> = { version: 1, networks: {} };
  for (const config of Object.values(loadNetworks().networks)) {
    const caip2Ref = caip2Reference(config.caip2);
    const labels = loadLabels(caip2Ref);
    if (Object.keys(labels).length > 0) index.networks[caip2Ref] = { labels };
  }
  saveIndex(index);
  return index;
}

/** Collects domain-specific matches in configured network order. */
export function findLabelScopes<TMatch>(matcher: (caip2Ref: string, network: string) => TMatch | undefined): TMatch[] {
  const matches: TMatch[] = [];
  for (const [network, config] of Object.entries(loadNetworks().networks)) {
    const caip2Ref = caip2Reference(config.caip2);
    const match = matcher(caip2Ref, network);
    if (match !== undefined) matches.push(match);
  }
  return matches;
}
