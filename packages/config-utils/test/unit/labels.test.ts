import { describe, expect, it } from 'vitest';

import {
  CatalogLabelError,
  assertUniqueCatalogLabels,
  catalogLabelActionSchema,
  catalogLabelSchema,
  catalogLabelKey,
  findCatalogLabel,
  prepareCatalogLabelMutation,
} from '../../src/index.js';

interface CatalogEntry {
  id: string;
  label?: string;
}

function expectCatalogError(action: () => unknown, code: CatalogLabelError['code']): void {
  let error: unknown;
  try {
    action();
  } catch (caught) {
    error = caught;
  }

  expect(error).toBeInstanceOf(CatalogLabelError);
  expect(error).toMatchObject({ name: 'CatalogLabelError', code });
}

describe('shared catalog label policy', () => {
  describe('catalog label input schemas', () => {
    it('normalizes bare labels and enforces explicit, exclusive label actions', () => {
      expect(catalogLabelSchema.parse('  CanonicalCase  ')).toBe('CanonicalCase');
      expect(catalogLabelSchema.safeParse('@CanonicalCase').success).toBe(false);

      expect(catalogLabelActionSchema.parse({ label: '  Agent_Label  ' })).toEqual({ label: 'Agent_Label' });
      expect(catalogLabelActionSchema.parse({ remove: true })).toEqual({ remove: true });
      expect(catalogLabelActionSchema.safeParse({}).success).toBe(false);
      expect(catalogLabelActionSchema.safeParse({ label: 'Agent_Label', remove: true }).success).toBe(false);
      expect(catalogLabelActionSchema.safeParse({ remove: false }).success).toBe(false);
      expect(catalogLabelActionSchema.safeParse({ label: 'Agent', mode: 'soft' }).success).toBe(false);
    });
  });

  describe('catalogLabelKey', () => {
    it('creates a normalized transient key without accepting the persisted soft-label marker', () => {
      expect(catalogLabelKey('  Operator-A_1  ')).toBe('operator-a_1');
      expect(() => catalogLabelKey('@Operator-A_1')).toThrow();
    });
  });

  describe('findCatalogLabel', () => {
    const entries: CatalogEntry[] = [
      { id: 'native-one', label: 'PrimaryKey' },
      { id: 'native-two', label: '@Agent_Key' },
      { id: 'LooksLikeALabel' },
    ];

    it('finds hard and soft labels canonically while keeping native IDs outside label matching', () => {
      const hard = findCatalogLabel(entries, ' primarykey ', entry => entry.label);
      const soft = findCatalogLabel(entries, 'AGENT_key', entry => entry.label);
      const nativeIdCaseVariant = findCatalogLabel(entries, 'lookslikealabel', entry => entry.label);

      expect(hard).toBe(entries[0]);
      expect(hard?.label).toBe('PrimaryKey');
      expect(soft).toBe(entries[1]);
      expect(soft?.label).toBe('@Agent_Key');
      expect(nativeIdCaseVariant).toBeUndefined();
      expect(entries[2]?.id).toBe('LooksLikeALabel');
    });

    it('rejects a persisted marker in a bare selector before lookup', () => {
      expect(() => findCatalogLabel(entries, '@Agent_Key', entry => entry.label)).toThrow();
    });

    it('rejects malformed persisted labels instead of silently skipping them', () => {
      const malformed: CatalogEntry[] = [{ id: 'one', label: '@@invalid' }];

      expect(() => findCatalogLabel(malformed, 'valid', entry => entry.label)).toThrow();
      expect(malformed).toEqual([{ id: 'one', label: '@@invalid' }]);
    });

    it('reports an ambiguous catalog even when the selector targets an unrelated label', () => {
      const ambiguous = [...entries, { id: 'duplicate', label: '@PRIMARYkey' }];

      expectCatalogError(
        () => findCatalogLabel(ambiguous, 'Missing', entry => entry.label),
        'DUPLICATE_LABEL',
      );
      expect(ambiguous).toHaveLength(4);
    });
  });

  describe('assertUniqueCatalogLabels', () => {
    it('accepts one mixed hard/soft namespace without rewriting caller-owned labels', () => {
      const labels = ['HardCase', undefined, '@SoftCase', 'Other'] as const;

      expect(assertUniqueCatalogLabels(labels)).toBeUndefined();
      expect(labels).toEqual(['HardCase', undefined, '@SoftCase', 'Other']);
    });

    it('reports a case-insensitive collision across hard and soft storage forms', () => {
      const labels = ['Same', '@SAME'];

      expectCatalogError(() => assertUniqueCatalogLabels(labels), 'DUPLICATE_LABEL');
      expect(labels).toEqual(['Same', '@SAME']);
    });

    it('rejects malformed or noncanonical persisted labels rather than normalizing stored text', () => {
      expect(() => assertUniqueCatalogLabels(['@@invalid'])).toThrow();
      expect(() => assertUniqueCatalogLabels([' Valid '])).toThrow();
    });
  });

  describe('prepareCatalogLabelMutation', () => {
    it('supports an operator-managed label lifecycle with canonical text and mode preservation', () => {
      const created = prepareCatalogLabelMutation({ operation: 'set', label: ' NewLabel ' });
      const softened = prepareCatalogLabelMutation({ current: created!, operation: 'set', mode: 'soft' });
      const renamed = prepareCatalogLabelMutation({ current: softened!, operation: 'set', label: 'Renamed' });
      const preserved = prepareCatalogLabelMutation({ current: renamed!, operation: 'set' });
      const hardened = prepareCatalogLabelMutation({ current: preserved!, operation: 'set', mode: 'hard' });
      const removed = prepareCatalogLabelMutation({ current: hardened!, operation: 'remove' });

      expect(created).toBe('NewLabel');
      expect(softened).toBe('@NewLabel');
      expect(renamed).toBe('@Renamed');
      expect(preserved).toBe('@Renamed');
      expect(hardened).toBe('Renamed');
      expect(removed).toBeUndefined();
    });

    it('requires label text when creating a previously unlabeled target', () => {
      expectCatalogError(() => prepareCatalogLabelMutation({ operation: 'set' }), 'LABEL_REQUIRED');
    });

    it('keeps an agent-managed label soft throughout its lifecycle', () => {
      const created = prepareCatalogLabelMutation({
        operation: 'set', label: ' Agent ', mode: 'hard', softOnly: true,
      });
      const renamed = prepareCatalogLabelMutation({
        current: created!, operation: 'set', label: 'Next', mode: 'hard', softOnly: true,
      });
      const preserved = prepareCatalogLabelMutation({
        current: renamed!, operation: 'set', softOnly: true,
      });
      const removed = prepareCatalogLabelMutation({
        current: preserved!, operation: 'remove', softOnly: true,
      });

      expect(created).toBe('@Agent');
      expect(renamed).toBe('@Next');
      expect(preserved).toBe('@Next');
      expect(removed).toBeUndefined();
    });

    it('allows only exact hard-label no-ops to callers with soft-only authority', () => {
      const current = 'OperatorCase';
      const preserved = prepareCatalogLabelMutation({
        current, operation: 'set', label: ' OperatorCase ', softOnly: true,
      });

      expect(preserved).toBe(current);
      expect(prepareCatalogLabelMutation({ current, operation: 'set', softOnly: true })).toBe(current);
      expectCatalogError(() => prepareCatalogLabelMutation({
        current, operation: 'set', label: 'operatorcase', softOnly: true,
      }), 'LABEL_PROTECTED');
      expectCatalogError(() => prepareCatalogLabelMutation({
        current, operation: 'set', mode: 'soft', softOnly: true,
      }), 'LABEL_PROTECTED');
      expectCatalogError(() => prepareCatalogLabelMutation({
        current, operation: 'remove', softOnly: true,
      }), 'LABEL_PROTECTED');
    });

    it('reports cross-mode, case-insensitive collisions without changing comparison input', () => {
      const otherLabels: Array<string | undefined> = ['@OCCUPIED', undefined];
      const snapshot = [...otherLabels];

      expectCatalogError(() => prepareCatalogLabelMutation({
        current: '@Old',
        operation: 'set',
        label: 'occupied',
        softOnly: true,
        otherLabels,
      }), 'DUPLICATE_LABEL');
      expect(otherLabels).toEqual(snapshot);
    });

    it('validates the persisted label even when removing it', () => {
      expect(() => prepareCatalogLabelMutation({ current: '@@invalid', operation: 'remove' })).toThrow();
    });

    it('rejects a storage marker in requested bare label text', () => {
      expect(() => prepareCatalogLabelMutation({
        current: '@Current', operation: 'set', label: '@invalid',
      })).toThrow();
    });

    it('rejects malformed comparison labels instead of ignoring them during collision checks', () => {
      expect(() => prepareCatalogLabelMutation({
        current: '@Current', operation: 'set', label: 'Next', otherLabels: ['bad label'],
      })).toThrow();
    });
  });
});
