import { accessSync, chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  findYubiKeyRegistrationNameForSerial,
  getYubiKeyRegistrationsPath,
  loadYubiKeyRegistrations,
  registerYubiKey,
  renameYubiKeyRegistration,
  renameYubiKeyRegistrationBySelector,
  resolveYubiKeyRegistration,
  saveYubiKeyRegistrations,
  unregisterYubiKey,
} from '../../src/index.js';
import { useConfigSandbox } from '../helpers/configSandbox.js';

const registry = {
  findYubiKeyRegistrationNameForSerial,
  getYubiKeyRegistrationsPath,
  loadYubiKeyRegistrations,
  registerYubiKey,
  renameYubiKeyRegistration,
  renameYubiKeyRegistrationBySelector,
  resolveYubiKeyRegistration,
  saveYubiKeyRegistrations,
  unregisterYubiKey,
};

describe('shared YubiKey label registry', () => {
  useConfigSandbox();

  it('moves only the path while preserving the existing version-1 JSON shape', () => {
    expect(registry.getYubiKeyRegistrationsPath()).toBe(join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'yubikeys.json'));

    registry.registerYubiKey({ name: 'primary.key', serial: '39713352' });

    expect(registry.loadYubiKeyRegistrations()).toEqual({
      version: 1,
      updatedAt: expect.any(String),
      devices: {
        'primary.key': {
          serial: '39713352',
          registeredAt: expect.any(String),
          updatedAt: expect.any(String),
        },
      },
    });
    expect(JSON.parse(readFileSync(registry.getYubiKeyRegistrationsPath(), 'utf8'))).toEqual(
      registry.loadYubiKeyRegistrations(),
    );
    expect(statSync(dirname(registry.getYubiKeyRegistrationsPath())).mode & 0o777).toBe(0o700);
    expect(statSync(registry.getYubiKeyRegistrationsPath()).mode & 0o777).toBe(0o600);
  });

  it('does not read, copy, rewrite, or delete the former signer path', () => {
    const oldPath = join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit', 'signer', 'yubikeys.json');
    const oldDocument = {
      version: 1,
      updatedAt: '2026-10-23T00:00:00.000Z',
      devices: {
        legacy: {
          serial: '12345678',
          registeredAt: '2026-10-23T00:00:00.000Z',
          updatedAt: '2026-10-23T00:00:00.000Z',
        },
      },
    };
    mkdirSync(dirname(oldPath), { recursive: true });
    chmodSync(join(process.env.XDG_DATA_HOME!, 'ccd-agent-kit'), 0o700);
    chmodSync(dirname(oldPath), 0o700);
    writeFileSync(oldPath, `${JSON.stringify(oldDocument)}\n`);

    expect(registry.loadYubiKeyRegistrations().devices).toEqual({});
    expect(() => accessSync(registry.getYubiKeyRegistrationsPath())).toThrow();
    expect(JSON.parse(readFileSync(oldPath, 'utf8'))).toEqual(oldDocument);
  });

  it('preserves both records when duplicate serials or labels and colliding renames are rejected', () => {
    registry.registerYubiKey({ name: 'primary', serial: '12345678' });
    registry.registerYubiKey({ name: 'backup', serial: '87654321' });
    const before = readFileSync(registry.getYubiKeyRegistrationsPath(), 'utf8');

    expect(() => registry.registerYubiKey({ name: 'primary', serial: '11111111' })).toThrow();
    expect(() => registry.registerYubiKey({ name: 'third', serial: '12345678' })).toThrow();
    expect(() => registry.renameYubiKeyRegistration({ currentName: 'primary', nextName: 'backup' })).toThrow();

    expect(readFileSync(registry.getYubiKeyRegistrationsPath(), 'utf8')).toBe(before);
  });

  it('keeps device labels on the original ordinary grammar with no soft-label prefix', () => {
    expect(() => registry.registerYubiKey({ name: '@agent', serial: '123' })).toThrow();
    expect(registry.loadYubiKeyRegistrations().devices).toEqual({});
  });

  it('removes only the selected registration', () => {
    registry.registerYubiKey({ name: 'same-label', serial: '12345678' });
    registry.registerYubiKey({ name: 'backup', serial: '87654321' });
    registry.unregisterYubiKey({ selector: '12345678' });

    expect(registry.loadYubiKeyRegistrations().devices).toEqual({
      backup: expect.objectContaining({ serial: '87654321' }),
    });
  });

  it('resolves, renames, and unregisters by both names and serial selectors', () => {
    registry.registerYubiKey({ name: 'primary', serial: '123' });
    expect(registry.resolveYubiKeyRegistration('primary')).toMatchObject({ serial: '123' });
    expect(registry.findYubiKeyRegistrationNameForSerial('123')).toBe('primary');
    expect(registry.findYubiKeyRegistrationNameForSerial('not-decimal')).toBeUndefined();
    registry.renameYubiKeyRegistration({ currentName: 'primary', nextName: 'renamed' });
    registry.renameYubiKeyRegistrationBySelector({ currentSelector: '123', nextName: 'serial-renamed' });
    registry.renameYubiKeyRegistrationBySelector({ currentSelector: 'serial-renamed', nextName: 'final' });
    expect(registry.resolveYubiKeyRegistration('final')).toMatchObject({ serial: '123' });
    registry.unregisterYubiKey({ selector: 'final' });
    registry.registerYubiKey({ name: 'again', serial: '123' });
    registry.unregisterYubiKey({ selector: '123' });
    expect(registry.loadYubiKeyRegistrations().devices).toEqual({});
  });

  it('rejects missing selectors and invalid serials without changing registrations', () => {
    registry.registerYubiKey({ name: 'primary', serial: '123' });
    const before = readFileSync(registry.getYubiKeyRegistrationsPath(), 'utf8');
    expect(() => registry.renameYubiKeyRegistration({ currentName: 'missing', nextName: 'next' })).toThrow();
    expect(() => registry.renameYubiKeyRegistrationBySelector({ currentSelector: '999', nextName: 'next' })).toThrow();
    expect(() => registry.unregisterYubiKey({ selector: 'missing' })).toThrow();
    expect(() => registry.registerYubiKey({ name: 'bad', serial: 'not-decimal' })).toThrow();
    expect(readFileSync(registry.getYubiKeyRegistrationsPath(), 'utf8')).toBe(before);
  });

  it('rejects malformed or overly permissive existing files without rewriting them', () => {
    const filename = registry.getYubiKeyRegistrationsPath();
    mkdirSync(dirname(filename), { recursive: true });
    const malformed = '{"version":1,"devices":';
    writeFileSync(filename, malformed, { mode: 0o600 });
    expect(() => registry.loadYubiKeyRegistrations()).toThrow();
    expect(() => registry.registerYubiKey({ name: 'primary', serial: '12345678' })).toThrow();
    expect(readFileSync(filename, 'utf8')).toBe(malformed);

    writeFileSync(filename, JSON.stringify({ version: 2, updatedAt: 'now', devices: {} }), { mode: 0o600 });
    expect(() => registry.loadYubiKeyRegistrations()).toThrow();

    const valid = { version: 1, updatedAt: 'now', devices: {} };
    writeFileSync(filename, JSON.stringify(valid));
    chmodSync(dirname(filename), 0o700);
    chmodSync(filename, 0o600);
    expect(registry.loadYubiKeyRegistrations()).toEqual(valid);
    chmodSync(filename, 0o644);
    expect(() => registry.loadYubiKeyRegistrations()).toThrow();
  });

  it.each([
    ['unknown top-level key', { version: 1, updatedAt: 'now', devices: {}, extra: true }],
    ['duplicate serials', { version: 1, updatedAt: 'now', devices: {
      first: { serial: '123', registeredAt: 'then', updatedAt: 'now' },
      second: { serial: '123', registeredAt: 'then', updatedAt: 'now' },
    } }],
  ])('rejects %s in persisted version-1 registries without rewriting', (_case, document) => {
    const filename = registry.getYubiKeyRegistrationsPath();
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    const original = `${JSON.stringify(document)}\n`;
    writeFileSync(filename, original, { mode: 0o600 });
    expect(() => registry.loadYubiKeyRegistrations()).toThrow();
    expect(readFileSync(filename, 'utf8')).toBe(original);
  });

  it('rejects null device records without rewriting the registry', () => {
    const filename = registry.getYubiKeyRegistrationsPath();
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    const original = `${JSON.stringify({ version: 1, updatedAt: 'now', devices: { broken: null } })}\n`;
    writeFileSync(filename, original, { mode: 0o600 });
    expect(() => registry.loadYubiKeyRegistrations()).toThrow();
    expect(readFileSync(filename, 'utf8')).toBe(original);
  });

  it('rejects a symlinked protected registry instead of following it', () => {
    const filename = registry.getYubiKeyRegistrationsPath();
    const outside = join(process.env.XDG_DATA_HOME!, 'outside.json');
    mkdirSync(dirname(filename), { recursive: true });
    writeFileSync(outside, JSON.stringify({ version: 1, updatedAt: 'now', devices: {} }), { mode: 0o600 });
    symlinkSync(outside, filename);

    expect(() => registry.loadYubiKeyRegistrations()).toThrow();
    expect(readFileSync(outside, 'utf8')).toContain('"devices"');
  });
});
