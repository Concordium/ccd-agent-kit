import { z } from 'zod';

/** Bare label grammar shared by protected public catalogs. */
export const CATALOG_LABEL_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,48}$/;

/** Label protection mode for protected public catalog metadata. */
export type CatalogLabelMode = 'hard' | 'soft';

/** Validated persisted hard/soft catalog-label representation. */
export type StoredCatalogLabel = string & { readonly __brandStoredCatalogLabel: 'StoredCatalogLabel' };

/** Stable catalog-label policy failure codes exposed by the config boundary. */
export type CatalogLabelErrorCode = 'DUPLICATE_LABEL' | 'LABEL_PROTECTED' | 'LABEL_REQUIRED';

/** A catalog-label policy failure with a stable producer-owned code. */
export class CatalogLabelError extends Error {
  /** Creates a catalog-label policy failure. */
  constructor(public readonly code: CatalogLabelErrorCode) {
    super(code);
    this.name = 'CatalogLabelError';
  }
}

/** A parsed persisted catalog label. Soft labels use the existing `@` marker. */
export interface ParsedCatalogLabel {
  /** Bare user-facing label. */
  label: string;
  /** Mutation protection applied to the label. */
  mode: CatalogLabelMode;
}

/** Mutation requested for one catalog target's optional label. */
export type CatalogLabelOperation = 'set' | 'remove';

/** Input to the shared, storage-independent catalog-label mutation policy. */
export interface PrepareCatalogLabelMutationInput {
  /** Existing persisted hard or soft label for the target, when present. */
  current?: string;
  /** Whether to set or remove the target's label. */
  operation: CatalogLabelOperation;
  /** New bare label; omission during `set` preserves an existing label's spelling. */
  label?: string;
  /** Requested protection mode; omission preserves an existing mode and defaults new labels to hard. */
  mode?: CatalogLabelMode;
  /** Restricts the caller to soft-label changes and exact hard-label no-ops. */
  softOnly?: boolean;
  /** Persisted labels belonging to other targets in the same catalog namespace and scope. */
  otherLabels?: Iterable<string | undefined>;
}

/** Trims and validates a bare protected-public-catalog label. */
export function normalizeCatalogLabel(label: string): string {
  const normalized = label.trim();
  if (!CATALOG_LABEL_PATTERN.test(normalized)) {
    throw new Error('Label must be 1-49 ASCII characters, start with a letter, and contain only letters, digits, underscores, or hyphens.');
  }
  return normalized;
}

/** Shared input schema for trimmed bare labels, preserving canonical casing. */
export const catalogLabelSchema = z.string().trim().regex(CATALOG_LABEL_PATTERN);

/** Explicit MCP label action; exactly one of a bare label or `remove: true` is required. */
export const catalogLabelActionSchema = z.strictObject({
  label: catalogLabelSchema.optional()
    .describe('Bare soft label to set or replace; cannot be combined with remove.'),
  remove: z.literal(true).optional()
    .describe('Explicitly remove the soft label; cannot be combined with label.'),
}).refine(input => (input.label !== undefined) !== (input.remove === true), {
  message: 'Provide exactly one of label or remove: true.',
});

/** Parser for validated persisted hard/soft catalog-label representations. */
export const storedCatalogLabel = {
  /** Returns the validated stored label, or `undefined` when the value is invalid. */
  from(value: unknown): StoredCatalogLabel | undefined {
    if (typeof value !== 'string') return undefined;
    const bare = value.startsWith('@') ? value.slice(1) : value;
    try {
      if (normalizeCatalogLabel(bare) !== bare) return undefined;
    } catch {
      return undefined;
    }
    return value as StoredCatalogLabel;
  },
  /** Returns the validated stored label or throws when the value is invalid. */
  require(value: unknown): StoredCatalogLabel {
    const parsed = storedCatalogLabel.from(value);
    if (parsed === undefined) throw new Error('Invalid stored catalog label.');
    return parsed;
  },
} as const;

/** Encodes a validated bare catalog label in its persisted hard/soft representation. */
export function encodeCatalogLabel(label: string, mode: CatalogLabelMode): StoredCatalogLabel {
  const normalized = normalizeCatalogLabel(label);
  return storedCatalogLabel.require(mode === 'soft' ? `@${normalized}` : normalized);
}

/** Parses an existing catalog label; unmarked legacy labels are always hard. */
export function parseCatalogLabel(stored: string): ParsedCatalogLabel {
  const validated = storedCatalogLabel.require(stored);
  const mode = validated.startsWith('@') ? 'soft' : 'hard';
  const label = mode === 'soft' ? validated.slice(1) : validated;
  return { label, mode };
}

/**
 * Returns the transient ASCII case-insensitive comparison key for a bare label.
 *
 * The returned key is for in-memory comparison only and must not be persisted.
 */
export function catalogLabelKey(label: string): string {
  return normalizeCatalogLabel(label).toLowerCase();
}

/**
 * Finds an entry by a bare label selector, rejecting invalid or duplicate stored labels.
 *
 * Native identifiers are intentionally outside this lookup and retain their domain-specific
 * comparison semantics.
 *
 * @param entries - Entries in one catalog namespace and scope.
 * @param selector - Bare user-facing label selector.
 * @param storedLabel - Reads an entry's optional persisted hard or soft label.
 * @returns The matching entry, or `undefined` when no label matches.
 */
export function findCatalogLabel<T>(
  entries: Iterable<T>,
  selector: string,
  storedLabel: (entry: T) => string | undefined,
): T | undefined {
  const selectorKey = catalogLabelKey(selector);
  const catalog = Array.from(entries, entry => ({ entry, label: storedLabel(entry) }));
  assertUniqueCatalogLabels(catalog.map(item => item.label));
  return catalog.find(item => item.label !== undefined
    && catalogLabelKey(parseCatalogLabel(item.label).label) === selectorKey)?.entry;
}

/**
 * Validates optional persisted labels and rejects ASCII case-insensitive collisions.
 *
 * Hard and soft storage forms share one comparison namespace.
 *
 * @param labels - Persisted labels from one catalog namespace and scope.
 * @throws {CatalogLabelError} With `DUPLICATE_LABEL` when two labels collide.
 */
export function assertUniqueCatalogLabels(labels: Iterable<string | undefined>): void {
  const keys = new Set<string>();
  for (const stored of labels) {
    if (stored === undefined) continue;
    const key = catalogLabelKey(parseCatalogLabel(stored).label);
    if (keys.has(key)) throw new CatalogLabelError('DUPLICATE_LABEL');
    keys.add(key);
  }
}

/**
 * Resolves and validates a catalog-label mutation without changing caller-owned state.
 *
 * @param input - Current state, requested operation, caller authority, and labels on other targets.
 * @returns The canonical persisted label to write, or `undefined` to remove the label.
 * @throws {CatalogLabelError} When text is required, a label collides, or a hard label is protected.
 */
export function prepareCatalogLabelMutation(
  input: PrepareCatalogLabelMutationInput,
): StoredCatalogLabel | undefined {
  const current = input.current === undefined ? undefined : storedCatalogLabel.require(input.current);
  const currentParsed = current === undefined ? undefined : parseCatalogLabel(current);
  const otherLabels = [...(input.otherLabels ?? [])];
  assertUniqueCatalogLabels(otherLabels);

  if (input.operation === 'remove') {
    if (input.softOnly === true && currentParsed?.mode === 'hard') {
      throw new CatalogLabelError('LABEL_PROTECTED');
    }
    return undefined;
  }
  if (input.operation !== 'set') throw new Error('Invalid catalog label operation.');

  const requestedLabel = input.label === undefined ? currentParsed?.label : normalizeCatalogLabel(input.label);
  if (requestedLabel === undefined) throw new CatalogLabelError('LABEL_REQUIRED');

  if (input.softOnly === true && currentParsed?.mode === 'hard') {
    const unchangedLabel = requestedLabel === currentParsed.label;
    const unchangedMode = input.mode === undefined || input.mode === 'hard';
    if (!unchangedLabel || !unchangedMode) throw new CatalogLabelError('LABEL_PROTECTED');
    assertCatalogLabelAvailable(requestedLabel, otherLabels);
    return current;
  }

  const mode = input.softOnly === true
    ? 'soft'
    : input.mode ?? currentParsed?.mode ?? 'hard';
  if (mode !== 'hard' && mode !== 'soft') throw new Error('Invalid catalog label mode.');

  const result = encodeCatalogLabel(requestedLabel, mode);
  assertCatalogLabelAvailable(requestedLabel, otherLabels);
  return result;
}

function assertCatalogLabelAvailable(label: string, otherLabels: Iterable<string | undefined>): void {
  const key = catalogLabelKey(label);
  for (const other of otherLabels) {
    if (other !== undefined && catalogLabelKey(parseCatalogLabel(other).label) === key) {
      throw new CatalogLabelError('DUPLICATE_LABEL');
    }
  }
}
