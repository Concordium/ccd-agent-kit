import { Buffer } from 'node:buffer';
import * as webSdk from '@concordium/web-sdk';
import type { SchemaType } from '@concordium/web-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  contractSchemaInfoFromHex,
  eventSchemaFromHex,
  initParameterSchemaFromHex,
  moduleSchemaInfoFromHex,
  normalizeInitContractName,
  normalizeReceiveEntrypoint,
  parseReceiveErrorJsonFromHex,
  parseReceiveReturnJsonFromHex,
  receiveSchemaFromHex,
  schemaTypeToJsonSchema,
  serializeInitParameterJsonFromHex,
  serializeReceiveParameterJsonFromHex,
} from '../../src/index.js';

vi.mock('@concordium/web-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@concordium/web-sdk')>();
  return { ...actual, displayTypeSchemaTemplate: vi.fn(actual.displayTypeSchemaTemplate) };
});

const TYPE_BOOL = Buffer.from([1]);
const TYPE_U64 = Buffer.from([5]);
const TYPE_ACCOUNT = Buffer.from([11]);
const TYPE_STRING_U16 = Buffer.from([22, 1]);

function word32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value);
  return out;
}

function str(value: string): Buffer {
  return Buffer.concat([word32(Buffer.byteLength(value)), Buffer.from(value, 'utf8')]);
}

function option(value?: Buffer): Buffer {
  return value === undefined ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), value]);
}

function functionV2(tag: number, ...types: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from([tag]), ...types]);
}

function structNamed(entries: Array<[string, Buffer]>): Buffer {
  return Buffer.concat([Buffer.from([20, 0]), map(entries)]);
}

function enumType(entries: Array<[string, Buffer]>): Buffer {
  return Buffer.concat([Buffer.from([21]), map(entries)]);
}

function fieldsNone(): Buffer {
  return Buffer.from([2]);
}

function fieldsUnnamed(...fields: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from([1]), word32(fields.length), ...fields]);
}

function optionType(item: Buffer): Buffer {
  return enumType([
    ['None', fieldsNone()],
    ['Some', fieldsUnnamed(item)],
  ]);
}

function byteArray(size: number): Buffer {
  return Buffer.concat([Buffer.from([30]), word32(size)]);
}

function map(entries: Array<[string, Buffer]>): Buffer {
  return Buffer.concat([word32(entries.length), ...entries.flatMap(([key, value]) => [str(key), value])]);
}

function counterSchema(version: 0 | 1 | 2 | 3 = 3): Buffer {
  return Buffer.concat([
    ...(version === 0 ? [option()] : []),
    option(functionV2(0, TYPE_BOOL)),
    map([
      ['get', functionV2(1, TYPE_U64)],
      ['ping', functionV2(0, TYPE_BOOL)],
      ['set', functionV2(6, TYPE_U64, TYPE_BOOL, TYPE_BOOL)],
    ]),
    ...(version === 3 ? [option(TYPE_BOOL)] : []),
  ]);
}

function fixtureSchemaHex(): string {
  return moduleSchemaHex([['counter', counterSchema()]]);
}

function moduleSchemaHex(contracts: Array<[string, Buffer]>, version: 0 | 1 | 2 | 3 = 3): string {
  return Buffer.concat([Buffer.from([255, 255, version]), map(contracts)]).toString('hex');
}

function registrySchema(): Buffer {
  return Buffer.concat([
    option(
      functionV2(
        0,
        structNamed([
          ['admin', TYPE_ACCOUNT],
          ['name', TYPE_STRING_U16],
        ]),
      ),
    ),
    map([
      [
        'lookup',
        functionV2(
          6,
          optionType(TYPE_ACCOUNT),
          optionType(TYPE_STRING_U16),
          enumType([
            ['ParseParams', fieldsNone()],
            ['Unauthorized', fieldsNone()],
          ]),
        ),
      ],
    ]),
    option(
      enumType([
        ['Registered', fieldsUnnamed(byteArray(32))],
        ['Revoked', fieldsNone()],
      ]),
    ),
  ]);
}

function fixtureSchemaWithStructuredTypesHex(): string {
  return moduleSchemaHex([['registry', registrySchema()]]);
}

function fixtureSchemaWithMultipleContractsHex(): string {
  return moduleSchemaHex([
    ['registry', registrySchema()],
    ['counter', counterSchema()],
  ]);
}

function fixtureSchemaWithoutEventHex(): string {
  const contract = Buffer.concat([option(functionV2(0, TYPE_BOOL)), map([['get', functionV2(1, TYPE_U64)]]), option()]);
  return moduleSchemaHex([['counter', contract]]);
}

function fixtureSchemaWithoutInitHex(): string {
  const contract = Buffer.concat([option(), map([['get', functionV2(1, TYPE_U64)]]), option(TYPE_BOOL)]);
  return moduleSchemaHex([['counter', contract]]);
}

function expectedCounterReceiveSummaries() {
  return [
    { name: 'get', hasParameter: false, hasReturnValue: true, hasError: false },
    { name: 'ping', hasParameter: true, hasReturnValue: false, hasError: false },
    {
      name: 'set',
      hasParameter: true,
      hasReturnValue: true,
      hasError: true,
      parameterTemplate: '<UInt64>',
      returnValueTemplate: '<Bool>',
      errorTemplate: '<Bool>',
    },
  ];
}

describe('contract schema helpers', () => {
  it('summarizes versioned module schemas', () => {
    const summary = moduleSchemaInfoFromHex(fixtureSchemaHex());
    expect(summary.schemaVersion).toBe(3);
    expect(summary.contracts).toHaveLength(1);
    expect(summary.contracts[0]).toMatchObject({
      name: 'counter',
      hasInit: true,
      hasEvent: true,
      init: { hasParameter: true, hasReturnValue: false, hasError: false, parameterTemplate: '<Bool>' },
      eventTemplate: '<Bool>',
      receive: expectedCounterReceiveSummaries(),
    });
  });

  it('summarizes multiple contracts in a stable order', () => {
    expect(
      moduleSchemaInfoFromHex(fixtureSchemaWithMultipleContractsHex()).contracts.map((contract) => contract.name),
    ).toEqual(['counter', 'registry']);
  });

  it.each([0, 1, 2])('preserves version %i schemas without an event field', (version) => {
    const contract = Buffer.concat([
      ...(version === 0 ? [option()] : []),
      option(functionV2(0, TYPE_BOOL)),
      map([['get', functionV2(1, TYPE_U64)]]),
    ]);
    const hex = Buffer.concat([Buffer.from([255, 255, version]), map([['counter', contract]])]).toString('hex');
    expect(contractSchemaInfoFromHex(hex, 'counter')).toMatchObject({ hasInit: true, hasEvent: false });
    expect(initParameterSchemaFromHex(hex, 'counter')).toEqual({ kind: 'primitive', type: 'Bool' });
    expect(receiveSchemaFromHex(hex, 'counter', 'get')).toMatchObject({
      returnValue: { kind: 'primitive', type: 'U64' },
    });
    expect(() => eventSchemaFromHex(hex, 'counter')).toThrow('Event schema not found');
  });

  it('returns a scoped contract summary without unrelated contracts', () => {
    const summary = contractSchemaInfoFromHex(fixtureSchemaWithMultipleContractsHex(), 'init_counter');
    expect(summary).toMatchObject({
      name: 'counter',
      hasInit: true,
      hasEvent: true,
      init: { hasParameter: true, parameterTemplate: '<Bool>' },
      eventTemplate: '<Bool>',
      receive: expectedCounterReceiveSummaries(),
    });
    expect(summary.receive.map((entrypoint) => entrypoint.name)).not.toContain('lookup');
  });

  it('summarizes missing init and event schemas without fabricating templates', () => {
    const withoutInit = contractSchemaInfoFromHex(fixtureSchemaWithoutInitHex(), 'counter');
    const withoutEvent = contractSchemaInfoFromHex(fixtureSchemaWithoutEventHex(), 'counter');
    expect(withoutInit).not.toHaveProperty('init');
    expect(withoutEvent).not.toHaveProperty('eventTemplate');
    expect(withoutInit).toMatchObject({
      name: 'counter',
      hasInit: false,
      hasEvent: true,
      eventTemplate: '<Bool>',
      receive: [{ name: 'get', hasParameter: false, hasReturnValue: true, hasError: false }],
    });
    expect(withoutEvent).toMatchObject({
      name: 'counter',
      hasInit: true,
      hasEvent: false,
      init: { hasParameter: true, parameterTemplate: '<Bool>' },
    });
  });

  it('preserves SDK display templates that are not JSON', () => {
    vi.mocked(webSdk.displayTypeSchemaTemplate).mockReturnValueOnce('<Custom template>');
    expect(contractSchemaInfoFromHex(fixtureSchemaWithoutEventHex(), 'counter').init?.parameterTemplate).toBe(
      '<Custom template>',
    );
  });

  it('returns normalized machine schemas for init, events, and receive entrypoints', () => {
    const schemaHex = fixtureSchemaWithStructuredTypesHex();
    expect(initParameterSchemaFromHex(schemaHex, 'init_registry')).toEqual({
      kind: 'struct',
      fields: {
        kind: 'named',
        entries: [
          { name: 'admin', schema: { kind: 'primitive', type: 'AccountAddress' } },
          { name: 'name', schema: { kind: 'string', sizeLength: 'U16' } },
        ],
      },
    });

    expect(receiveSchemaFromHex(schemaHex, 'registry', 'registry.lookup')).toEqual({
      name: 'lookup',
      parameter: {
        kind: 'option',
        value: { kind: 'primitive', type: 'AccountAddress' },
        encoding: { kind: 'enum', noneVariant: 'None', someVariant: 'Some' },
      },
      returnValue: {
        kind: 'option',
        value: { kind: 'string', sizeLength: 'U16' },
        encoding: { kind: 'enum', noneVariant: 'None', someVariant: 'Some' },
      },
      error: {
        kind: 'enum',
        variants: [
          { name: 'ParseParams', fields: { kind: 'none' } },
          { name: 'Unauthorized', fields: { kind: 'none' } },
        ],
      },
    });

    expect(eventSchemaFromHex(schemaHex, 'registry')).toEqual({
      kind: 'enum',
      variants: [
        { name: 'Registered', fields: { kind: 'unnamed', items: [{ kind: 'byteArray', size: 32 }] } },
        { name: 'Revoked', fields: { kind: 'none' } },
      ],
    });
  });

  it('serializes contract parameter JSON with embedded schemas', () => {
    const schemaHex = fixtureSchemaHex();
    expect(serializeInitParameterJsonFromHex(schemaHex, 'init_counter', true)).toBe('01');
    expect(serializeReceiveParameterJsonFromHex(schemaHex, 'counter', 'counter.ping', false)).toBe('00');
    expect(() => serializeInitParameterJsonFromHex(schemaHex, 'init_counter', null)).toThrow(/Bool|boolean/i);
    expect(() => serializeReceiveParameterJsonFromHex(schemaHex, 'counter', 'counter.ping', null)).toThrow(
      /Bool|boolean/i,
    );
  });

  it.each([
    [0, false],
    [1, false],
    [2, true],
    [3, true],
  ] as const)('uses schema version %i codec bytes', (version, hasReturnAndError) => {
    const schemaHex = moduleSchemaHex([['counter', counterSchema(version)]], version);

    expect(serializeInitParameterJsonFromHex(schemaHex, 'init_counter', true)).toBe('01');
    expect(serializeReceiveParameterJsonFromHex(schemaHex, 'counter', 'counter.ping', false)).toBe('00');
    if (hasReturnAndError) {
      expect(parseReceiveReturnJsonFromHex(schemaHex, 'counter', 'set', '01')).toBe(true);
      expect(parseReceiveErrorJsonFromHex(schemaHex, 'counter', 'set', '00')).toBe(false);
    }
  });

  it.each([
    ['get', { name: 'get', returnValue: { kind: 'primitive', type: 'U64' } }],
    ['ping', { name: 'ping', parameter: { kind: 'primitive', type: 'Bool' } }],
    [
      'set',
      {
        name: 'set',
        parameter: { kind: 'primitive', type: 'U64' },
        returnValue: { kind: 'primitive', type: 'Bool' },
        error: { kind: 'primitive', type: 'Bool' },
      },
    ],
  ] as const)('returns only schemas present on receive entrypoint %s', (entrypoint, expected) => {
    const schemaHex = fixtureSchemaHex();
    expect(receiveSchemaFromHex(schemaHex, 'counter', entrypoint)).toEqual(expected);
  });

  it.each([
    ['one variant', [{ name: 'Only', fields: { type: 'None' } }]],
    [
      'non-None first variant',
      [
        { name: 'Missing', fields: { type: 'None' } },
        { name: 'Some', fields: { type: 'Unnamed', fields: [{ type: 'Bool' }] } },
      ],
    ],
    [
      'non-Some second variant',
      [
        { name: 'None', fields: { type: 'None' } },
        { name: 'Present', fields: { type: 'Unnamed', fields: [{ type: 'Bool' }] } },
      ],
    ],
    [
      'Some variant with multiple fields',
      [
        { name: 'None', fields: { type: 'None' } },
        { name: 'Some', fields: { type: 'Unnamed', fields: [{ type: 'Bool' }, { type: 'U8' }] } },
      ],
    ],
  ] satisfies Array<[string, Extract<SchemaType, { type: 'Enum' }>['variants']]>)(
    'keeps non-option enum shape for %s',
    (_caseName, variants) => {
      expect(schemaTypeToJsonSchema({ type: 'Enum', variants })).toMatchObject({ kind: 'enum' });
    },
  );

  it.each([
    [
      'Pair',
      { type: 'Pair', first: { type: 'Bool' }, second: { type: 'U8' } },
      { kind: 'pair', first: { kind: 'primitive', type: 'Bool' }, second: { kind: 'primitive', type: 'U8' } },
    ],
    [
      'List',
      { type: 'List', sizeLength: 'U8', item: { type: 'U16' } },
      { kind: 'list', sizeLength: 'U8', item: { kind: 'primitive', type: 'U16' } },
    ],
    [
      'Set',
      { type: 'Set', sizeLength: 'U16', item: { type: 'U32' } },
      { kind: 'set', sizeLength: 'U16', item: { kind: 'primitive', type: 'U32' } },
    ],
    [
      'Map',
      { type: 'Map', sizeLength: 'U32', key: { type: 'String', sizeLength: 'U16' }, value: { type: 'Bool' } },
      {
        kind: 'map',
        sizeLength: 'U32',
        key: { kind: 'string', sizeLength: 'U16' },
        value: { kind: 'primitive', type: 'Bool' },
      },
    ],
    [
      'Array',
      { type: 'Array', size: 3, item: { type: 'I8' } },
      { kind: 'array', size: 3, item: { kind: 'primitive', type: 'I8' } },
    ],
    ['ContractName', { type: 'ContractName', sizeLength: 'U16' }, { kind: 'contractName', sizeLength: 'U16' }],
    ['ReceiveName', { type: 'ReceiveName', sizeLength: 'U32' }, { kind: 'receiveName', sizeLength: 'U32' }],
    ['ULeb128', { type: 'ULeb128', maxByteSize: 5 }, { kind: 'uLeb128', maxByteSize: 5 }],
    ['ILeb128', { type: 'ILeb128', maxByteSize: 9 }, { kind: 'iLeb128', maxByteSize: 9 }],
    ['ByteList', { type: 'ByteList', sizeLength: 'U8' }, { kind: 'byteList', sizeLength: 'U8' }],
    [
      'TaggedEnum',
      { type: 'TaggedEnum', variants: new Map([[7, { name: 'Lucky', fields: { type: 'None' } }]]) },
      { kind: 'taggedEnum', variants: [{ tag: 7, name: 'Lucky', fields: { kind: 'none' } }] },
    ],
    [
      'Enum',
      {
        type: 'Enum',
        variants: [
          { name: 'None', fields: { type: 'None' } },
          { name: 'Some', fields: { type: 'Unnamed', fields: [{ type: 'Bool' }, { type: 'U8' }] } },
        ],
      },
      {
        kind: 'enum',
        variants: [
          { name: 'None', fields: { kind: 'none' } },
          {
            name: 'Some',
            fields: {
              kind: 'unnamed',
              items: [
                { kind: 'primitive', type: 'Bool' },
                { kind: 'primitive', type: 'U8' },
              ],
            },
          },
        ],
      },
    ],
  ] satisfies Array<[string, SchemaType, ReturnType<typeof schemaTypeToJsonSchema>]>)(
    'normalizes SDK schema type variant %s without display-template placeholders',
    (_caseName, schema, expected) => {
      expect(schemaTypeToJsonSchema(schema)).toEqual(expected);
    },
  );

  it('throws stable errors for missing schema entries', () => {
    const schemaHex = fixtureSchemaHex();
    expect(() => contractSchemaInfoFromHex(schemaHex, 'missing')).toThrow('Contract schema not found: missing');
    expect(() => initParameterSchemaFromHex(fixtureSchemaWithoutEventHex(), 'missing')).toThrow(
      'Contract schema not found: missing',
    );
    expect(() => initParameterSchemaFromHex(fixtureSchemaWithoutInitHex(), 'counter')).toThrow(
      'Init parameter schema not found: counter',
    );
    expect(() => serializeInitParameterJsonFromHex(fixtureSchemaWithoutInitHex(), 'counter', true)).toThrow(
      'Init parameter schema not found: counter',
    );
    expect(() => serializeReceiveParameterJsonFromHex(schemaHex, 'counter', 'get', true)).toThrow(
      'Receive parameter schema not found: counter.get',
    );
    expect(() => receiveSchemaFromHex(schemaHex, 'counter', 'missing')).toThrow(
      'Receive schema not found: counter.missing',
    );
    expect(() => parseReceiveReturnJsonFromHex(schemaHex, 'counter', 'counter.ping', '00')).toThrow(
      'Receive return-value schema not found: counter.ping',
    );
    expect(() => parseReceiveErrorJsonFromHex(schemaHex, 'counter', 'get', '00')).toThrow(
      'Receive error schema not found: counter.get',
    );
    expect(() => eventSchemaFromHex(fixtureSchemaWithoutEventHex(), 'counter')).toThrow(
      'Event schema not found: counter',
    );
    expect(() => moduleSchemaInfoFromHex('not-hex')).toThrow('Invalid hex string');
  });

  it('normalizes init and receive names', () => {
    expect(normalizeInitContractName('init_counter')).toBe('counter');
    expect(normalizeInitContractName('counter')).toBe('counter');
    expect(normalizeReceiveEntrypoint('counter.set', 'counter')).toBe('set');
    expect(normalizeReceiveEntrypoint('set', 'counter')).toBe('set');
    expect(normalizeReceiveEntrypoint('other.set', 'counter')).toBe('other.set');
    expect(normalizeReceiveEntrypoint('counter.set')).toBe('counter.set');
  });
});
