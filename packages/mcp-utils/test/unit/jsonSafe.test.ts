import { describe, expect, it } from 'vitest';

import {
  assertNoBigInt,
  assertUniqueStaticSkillUris,
  jsonResourceContent,
  jsonTextContent,
  jsonTextToolResult,
  buildStaticSkillDefinition,
  getStaticSkill,
  hexStringSchema,
  invalidMcpResourceUri,
  isMcpInvalidArgumentError,
  listStaticSkills,
  mcpInvalidArgument,
  mcpJsonValueSchema,
  mcpTextToolErrorResult,
  parseSkillHeader,
  readStaticSkillFile,
  roleSeparatedSignaturesSchema,
  serializeJsonFile,
  signatureRequirementsSchema,
  signatureMapSchema,
  stringifyBigInt,
} from '../../src/index.js';

describe('stringifyBigInt', () => {
  it('converts bigint values to decimal strings recursively', () => {
    expect(stringifyBigInt({ amount: 123n, nested: [{ nonce: 7n }] })).toEqual({
      amount: '123',
      nested: [{ nonce: '7' }],
    });
  });

  it('preserves JSON-safe primitives', () => {
    expect(stringifyBigInt({ text: 'ok', count: 1, enabled: true, value: null })).toEqual({
      text: 'ok',
      count: 1,
      enabled: true,
      value: null,
    });
  });
});

describe('serializeJsonFile', () => {
  it.each([
    ['null', null, 'null\n'],
    ['boolean', true, 'true\n'],
    ['number', 7, '7\n'],
    ['string', 'value', '"value"\n'],
    ['array', ['value', 7], '[\n  "value",\n  7\n]\n'],
    ['object', { value: 7, nested: { enabled: true } }, '{\n  "value": 7,\n  "nested": {\n    "enabled": true\n  }\n}\n'],
  ])('serializes a %s as pretty JSON with one trailing newline', (_label, value, expected) => {
    expect(serializeJsonFile(value)).toBe(expected);
  });

  it.each([
    ['undefined', undefined],
    ['function', () => undefined],
    ['symbol', Symbol('value')],
  ])('rejects an unserializable %s root instead of silently writing no JSON', (_label, value) => {
    expect(() => serializeJsonFile(value)).toThrow(TypeError);
  });

  it('propagates circular-reference and bigint serialization errors without conversion', () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(() => serializeJsonFile(circular)).toThrow(TypeError);
    expect(() => serializeJsonFile({ amount: 1n })).toThrow(TypeError);
  });
});

describe('assertNoBigInt', () => {
  it('throws when a bigint remains in a DTO', () => {
    expect(() => assertNoBigInt({ amount: 1n })).toThrow('bigint value found in MCP DTO');
  });

  it('accepts JSON-safe values', () => {
    expect(() => assertNoBigInt({ amount: '1', nested: [true, null] })).not.toThrow();
  });
});

describe('MCP JSON helpers', () => {
  it('validates MCP-compatible JSON values', () => {
    expect(mcpJsonValueSchema.safeParse({ value: null, nested: [true, 1, 'ok'] }).success).toBe(true);
    expect(mcpJsonValueSchema.safeParse(() => true).success).toBe(false);
    expect(mcpJsonValueSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
  });

  it('renders JSON text content with bigint values converted to strings', () => {
    expect(jsonTextContent({ amount: 5n })).toEqual({
      type: 'text',
      text: '{\n  "amount": "5"\n}',
    });
  });

  it('builds text tool results with structured content from the same normalized read', () => {
    let reads = 0;
    const value = {
      get amount() {
        reads += 1;
        return BigInt(reads);
      },
      nested: [undefined, 2n],
    };

    const result = jsonTextToolResult(value);

    expect(reads).toBe(1);
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    expect(result.structuredContent).toEqual({ amount: '1', nested: [null, '2'] });
  });

  it('builds text tool error results with optional structured content', () => {
    expect(mcpTextToolErrorResult({ message: 'bad input' })).toEqual({
      content: [{ type: 'text', text: 'bad input' }],
      isError: true,
    });
    expect(mcpTextToolErrorResult({ message: 'bad input', structuredContent: { amount: 5n } })).toEqual({
      content: [{ type: 'text', text: 'bad input' }],
      isError: true,
      structuredContent: { amount: '5' },
    });
  });

  it('builds JSON resource content', () => {
    expect(jsonResourceContent('ccd://resource', { amount: 5n })).toEqual({
      uri: 'ccd://resource',
      mimeType: 'application/json',
      text: '{\n  "amount": "5"\n}',
    });
  });
});

describe('shared MCP errors', () => {
  it('builds and detects shared MCP invalid-argument errors', () => {
    expect(mcpInvalidArgument('bad')).toEqual({ kind: 'invalid-argument', message: 'bad' });
    expect(invalidMcpResourceUri('ccd://missing')).toEqual({
      kind: 'invalid-argument',
      message: 'The resource URI is invalid.',
    });
    expect(isMcpInvalidArgumentError(mcpInvalidArgument('bad'))).toBe(true);
    expect(isMcpInvalidArgumentError(new Error('bad'))).toBe(false);
    expect(isMcpInvalidArgumentError({ kind: 'invalid-argument' })).toBe(false);
  });
});

describe('MCP-served skills helpers', () => {
  const exampleSkillText = `---
name: example-skill
description: Use for testing static skill helpers.
---

# Example Skill

Use this workflow in tests.
`;

  const exampleSkill = buildStaticSkillDefinition({
    frontmatter: parseSkillHeader(exampleSkillText),
    text: exampleSkillText,
  });

  it('parses strict skill headers', () => {
    expect(parseSkillHeader(exampleSkillText)).toEqual({
      name: 'example-skill',
      description: 'Use for testing static skill helpers.',
    });
    expect(parseSkillHeader(`\uFEFF${exampleSkillText.replaceAll('\n', '\r\n')}`)).toEqual({
      name: 'example-skill',
      description: 'Use for testing static skill helpers.',
    });
  });

  it('rejects invalid skill headers', () => {
    expect(() => parseSkillHeader('# Missing header')).toThrow('frontmatter header');
    expect(() => parseSkillHeader('---\ndescription: y\n---\n')).toThrow('requires name');
    expect(() => parseSkillHeader('---\nname: x\n---\n')).toThrow('requires description');
    expect(() => parseSkillHeader('---\nname: x\nunknown: y\n---\n')).toThrow('Unsupported skill header field');
    expect(() => parseSkillHeader('---\nname x\ndescription: y\n---\n')).toThrow('Invalid skill header line');
    expect(() => parseSkillHeader('---\nname: x\ndescription: \n---\n')).toThrow('must not be empty');
    expect(() => parseSkillHeader('---\nname: bad/skill\ndescription: y\n---\n')).toThrow('URI-safe slug');
  });

  it('builds deterministic manifests for static skills', () => {
    const result = listStaticSkills([exampleSkill]);
    expect(result).toMatchObject({ resultType: 'complete', ttlMs: 300_000, cacheScope: 'public' });
    expect(result.skills.map((skill) => skill.frontmatter.name)).toEqual(['example-skill']);

    for (const skill of result.skills) {
      expect(skill.uri).toBe(`skill://${skill.frontmatter.name}/SKILL.md`);
      expect(skill.resources).toHaveLength(1);
      const [resource] = skill.resources as Array<{ uri: string; digest: string; size: number }>;
      const file = readStaticSkillFile(resource.uri, [exampleSkill])!;
      expect(resource.uri).toBe(skill.uri);
      expect(resource.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(resource.size).toBe(Buffer.byteLength(file.text, 'utf8'));
      expect(file.text).toContain(`name: ${skill.frontmatter.name}`);
      expect(file.text).toContain(`description: ${skill.frontmatter.description}`);
    }
  });

  it('gets and reads skills by URI', () => {
    const uri = 'skill://example-skill/SKILL.md';
    expect(getStaticSkill(uri, [exampleSkill])?.skill.frontmatter.name).toBe('example-skill');
    expect(readStaticSkillFile(uri, [exampleSkill])).toMatchObject({ uri, mimeType: 'text/markdown' });
    expect(readStaticSkillFile(uri, [exampleSkill])?.text).toContain('Use this workflow in tests.');
    expect(getStaticSkill('skill://missing/SKILL.md', [exampleSkill])).toBeUndefined();
    expect(readStaticSkillFile('skill://missing/SKILL.md', [exampleSkill])).toBeUndefined();
  });

  it('rejects duplicate static skill URIs', () => {
    expect(() => assertUniqueStaticSkillUris([exampleSkill])).not.toThrow();
    expect(() => assertUniqueStaticSkillUris([exampleSkill, exampleSkill])).toThrow('Duplicate static skill URI');
  });
});

describe('signatureMapSchema', () => {
  const validSignature = 'aabb';
  const invalidIndexes = ['x', '01', '00', '256', '-1', '1e1', '0x10', ' 1', '1 ', '1\n', '1\r\n', ''];

  it('validates even-length hex strings', () => {
    expect(hexStringSchema.parse('aabb')).toBe('aabb');
    expect(() => hexStringSchema.parse('abc')).toThrow();
    expect(() => hexStringSchema.parse('zz')).toThrow();
  });

  it.each([
    ['lower bound indexes', { '0': { '0': validSignature } }],
    ['upper bound indexes', { '255': { '255': validSignature } }],
    ['empty signature map', {}],
    ['empty credential signature map', { '0': {} }],
  ])('accepts canonical decimal %s', (_label, signatures) => {
    expect(signatureMapSchema.parse(signatures)).toEqual(signatures);
  });

  it('rejects non-canonical or out-of-range credential and key indexes', () => {
    for (const index of invalidIndexes) {
      expect(() => signatureMapSchema.parse({ [index]: { '0': validSignature } })).toThrow();
      expect(() => signatureMapSchema.parse({ '0': { [index]: validSignature } })).toThrow();
    }
  });

  it('rejects objects containing indexes that would collide after numeric coercion', () => {
    expect(() => signatureMapSchema.parse({ '1': { '0': validSignature }, '01': { '0': validSignature } })).toThrow();
    expect(() => signatureMapSchema.parse({ '0': { '1': validSignature, '01': validSignature } })).toThrow();
  });

  it('retains non-empty even-length hex signature semantics', () => {
    expect(signatureMapSchema.parse({ '0': { '0': 'AABB' } })).toEqual({ '0': { '0': 'AABB' } });
    expect(() => signatureMapSchema.parse({ '0': { '0': '' } })).toThrow();
    expect(() => signatureMapSchema.parse({ '0': { '0': 'abc' } })).toThrow();
    expect(() => signatureMapSchema.parse({ '0': { '0': 'zz' } })).toThrow();
  });
});

describe('roleSeparatedSignaturesSchema', () => {
  const sender = { '0': { '0': 'aa'.repeat(64) } };
  const sponsor = { '1': { '0': 'bb'.repeat(64) } };

  it.each([
    ['empty envelope', {}, { sender: {}, sponsor: {} }],
    ['sender only', { sender }, { sender, sponsor: {} }],
    ['sponsor only', { sponsor }, { sender: {}, sponsor }],
    ['both roles', { sender, sponsor }, { sender, sponsor }],
  ])('normalizes %s', (_name, input, expected) => {
    expect(roleSeparatedSignaturesSchema.parse(input)).toEqual(expected);
  });

  it.each([
    ['null envelope', null],
    ['array envelope', []],
    ['null sender', { sender: null }],
    ['array sender', { sender: [] }],
    ['unknown role', { sender: {}, cosigner: {} }],
    ['numeric envelope key', { 0: { 0: 'aa'.repeat(64) } }],
  ])('rejects %s', (_name, input) => {
    expect(() => roleSeparatedSignaturesSchema.parse(input)).toThrow();
  });
});

it('validates optional signature requirements counts', () => {
  const counts = {
    senderNumSignatures: '0',
    sponsorNumSignatures: '2',
    totalSignatureCount: `${Number.MAX_SAFE_INTEGER}`,
  };

  for (const input of [{}, ...Object.entries(counts).map(([key, value]) => ({ [key]: value })), counts]) {
    expect(signatureRequirementsSchema.parse(input)).toEqual(input);
  }
  for (const input of [
    null,
    [],
    { senderNumSignatures: '1', cosignerNumSignatures: '1' },
    { senderNumSignatures: 1 },
    { senderNumSignatures: null },
    { senderNumSignatures: ['1'] },
    { senderNumSignatures: '-1' },
    { senderNumSignatures: '1.5' },
    { senderNumSignatures: `${Number.MAX_SAFE_INTEGER + 1}` },
    { senderNumSignatures: '0x10' },
  ]) {
    expect(() => signatureRequirementsSchema.parse(input)).toThrow();
  }
});
