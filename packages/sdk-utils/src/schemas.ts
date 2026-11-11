import {
  Parameter,
  displayTypeSchemaTemplate,
  parseRawModuleSchema,
  serializeSchemaType,
  serializeTypeValue,
  deserializeTypeValue,
  type SchemaContractV1,
  type SchemaContractV2,
  type SchemaContractV3,
  type SchemaEnumVariant,
  type SchemaFields,
  type SchemaFunctionV2,
  type SchemaSizeLength,
  type SchemaType,
  type SmartContractTypeValues,
} from '@concordium/web-sdk';

import { toArrayBuffer } from './internal/bytes.js';
import { hexString, type HexString } from './keys.js';

/** JSON-safe value accepted or returned by SDK schema helper functions. */
export type JsonSafeValue = null | boolean | number | string | JsonSafeValue[] | { [key: string]: JsonSafeValue };

/** Summary of one schema-backed init or receive function surface. */
export interface SmartContractFunctionSchemaSummary {
  /** Whether a parameter schema is embedded for this function. */
  hasParameter: boolean;
  /** Whether a return-value schema is embedded for this function. */
  hasReturnValue: boolean;
  /** Whether an error schema is embedded for this function. */
  hasError: boolean;
  /** JSON template for parameters when available. */
  parameterTemplate?: JsonSafeValue;
  /** JSON template for return values when available. */
  returnValueTemplate?: JsonSafeValue;
  /** JSON template for errors when available. */
  errorTemplate?: JsonSafeValue;
}

/** Summary of one schema-backed receive entrypoint. */
export interface SmartContractReceiveSchemaSummary extends SmartContractFunctionSchemaSummary {
  /** Receive entrypoint name without the contract-name prefix. */
  name: string;
}

/** Summary of one contract type embedded in a module schema. */
export interface SmartContractSchemaSummary {
  /** Contract type name inside the module schema. */
  name: string;
  /** Whether the contract has an init schema entry. */
  hasInit: boolean;
  /** Whether the contract has an event schema. */
  hasEvent: boolean;
  /** Init schema summary when present. */
  init?: SmartContractFunctionSchemaSummary;
  /** Event JSON template when an event schema is present. */
  eventTemplate?: JsonSafeValue;
  /** Receive entrypoint schema summaries. */
  receive: SmartContractReceiveSchemaSummary[];
}

/** Parsed summary of a versioned smart-contract module schema. */
export interface SmartContractModuleSchemaSummary {
  /** Version of the embedded module schema. */
  schemaVersion: 0 | 1 | 2 | 3;
  /** Contract type summaries in the module schema. */
  contracts: SmartContractSchemaSummary[];
}

/** Length prefix integer type used by Concordium schema collection and string types. */
export type SmartContractSchemaSizeLength = SchemaSizeLength;

/** JSON-safe field representation for normalized smart-contract schemas. */
export type SmartContractJsonSchemaFields =
  | { kind: 'none' }
  | { kind: 'unnamed'; items: SmartContractJsonSchema[] }
  | { kind: 'named'; entries: Array<{ name: string; schema: SmartContractJsonSchema }> };

/** JSON-safe enum variant representation for normalized smart-contract schemas. */
export interface SmartContractJsonSchemaVariant {
  /** Variant name from the Concordium schema. */
  name: string;
  /** Variant fields from the Concordium schema. */
  fields: SmartContractJsonSchemaFields;
}

/** JSON-safe tagged enum variant representation for normalized smart-contract schemas. */
export interface SmartContractJsonSchemaTaggedVariant extends SmartContractJsonSchemaVariant {
  /** Numeric tag associated with this variant. */
  tag: number;
}

/** Machine-readable JSON-safe projection of Concordium SDK schema types. */
export type SmartContractJsonSchema =
  | {
      kind: 'primitive';
      type:
        | 'Unit'
        | 'Bool'
        | 'U8'
        | 'U16'
        | 'U32'
        | 'U64'
        | 'U128'
        | 'I8'
        | 'I16'
        | 'I32'
        | 'I64'
        | 'I128'
        | 'Amount'
        | 'AccountAddress'
        | 'ContractAddress'
        | 'Timestamp'
        | 'Duration';
    }
  | { kind: 'pair'; first: SmartContractJsonSchema; second: SmartContractJsonSchema }
  | { kind: 'list'; sizeLength: SmartContractSchemaSizeLength; item: SmartContractJsonSchema }
  | { kind: 'set'; sizeLength: SmartContractSchemaSizeLength; item: SmartContractJsonSchema }
  | {
      kind: 'map';
      sizeLength: SmartContractSchemaSizeLength;
      key: SmartContractJsonSchema;
      value: SmartContractJsonSchema;
    }
  | { kind: 'array'; size: number; item: SmartContractJsonSchema }
  | { kind: 'struct'; fields: SmartContractJsonSchemaFields }
  | { kind: 'enum'; variants: SmartContractJsonSchemaVariant[] }
  | {
      kind: 'option';
      value: SmartContractJsonSchema;
      encoding: { kind: 'enum'; noneVariant: 'None'; someVariant: 'Some' };
    }
  | { kind: 'string'; sizeLength: SmartContractSchemaSizeLength }
  | { kind: 'contractName'; sizeLength: SmartContractSchemaSizeLength }
  | { kind: 'receiveName'; sizeLength: SmartContractSchemaSizeLength }
  | { kind: 'uLeb128'; maxByteSize: number }
  | { kind: 'iLeb128'; maxByteSize: number }
  | { kind: 'byteList'; sizeLength: SmartContractSchemaSizeLength }
  | { kind: 'byteArray'; size: number }
  | { kind: 'taggedEnum'; variants: SmartContractJsonSchemaTaggedVariant[] };

/** Aggregated machine-readable schemas for one receive entrypoint. */
export interface SmartContractReceiveJsonSchemas {
  /** Receive entrypoint name without the contract-name prefix. */
  name: string;
  /** Parameter schema when present. */
  parameter?: SmartContractJsonSchema;
  /** Return-value schema when present. */
  returnValue?: SmartContractJsonSchema;
  /** Error schema when present. */
  error?: SmartContractJsonSchema;
}

type SchemaContractLike = SchemaContractV1 | SchemaContractV2 | SchemaContractV3;

/** Normalizes an init function or contract name to the contract name expected by schema APIs. */
export function normalizeInitContractName(initNameOrContractName: string): string {
  return initNameOrContractName.replace(/^init_/, '');
}

/** Normalizes a receive name to the entrypoint name expected by schema APIs. */
export function normalizeReceiveEntrypoint(receiveName: string, contractName?: string): string {
  const prefix = contractName === undefined ? undefined : `${contractName}.`;
  return prefix !== undefined && receiveName.startsWith(prefix) ? receiveName.slice(prefix.length) : receiveName;
}

/** Parses a hex-encoded versioned smart-contract module schema into a JSON-safe summary. */
export function moduleSchemaInfoFromHex(schemaHex: string): SmartContractModuleSchemaSummary {
  const parsed = parseRawModuleSchema({ type: 'versioned', buffer: hexToArrayBuffer(hexString.require(schemaHex)) });
  return {
    schemaVersion: parsed.version,
    contracts: [...parsed.module.contracts.entries()]
      .map(([name, contract]) => summarizeContract(String(name), contract))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

/** Returns one contract schema summary from a hex-encoded versioned module schema. */
export function contractSchemaInfoFromHex(schemaHex: string, contractName: string): SmartContractSchemaSummary {
  const contract = rawContractSchemaFromHex(schemaHex, contractName);
  return summarizeContract(contract.name, contract.schema);
}

/** Returns the normalized init parameter schema for a contract schema. */
export function initParameterSchemaFromHex(schemaHex: string, contractName: string): SmartContractJsonSchema {
  const contract = rawContractSchemaFromHex(schemaHex, contractName);
  if (contract.schema.init?.parameter === undefined)
    throw new Error(`Init parameter schema not found: ${contract.name}`);
  return schemaTypeToJsonSchema(contract.schema.init.parameter);
}

/** Serializes an init parameter JSON value against an embedded module schema and returns parameter bytes as hex. */
export function serializeInitParameterJsonFromHex(
  schemaHex: string,
  contractName: string,
  parameterJson: JsonSafeValue,
): string {
  const contract = rawContractSchemaFromHex(schemaHex, contractName);
  if (contract.schema.init?.parameter === undefined)
    throw new Error(`Init parameter schema not found: ${contract.name}`);
  const parameter = serializeTypeValue(parameterJson, serializedSchemaType(contract.schema.init.parameter), true);
  return Buffer.from(Parameter.toBuffer(parameter)).toString('hex');
}

/** Returns normalized machine-readable schemas for one receive entrypoint. */
export function receiveSchemaFromHex(
  schemaHex: string,
  contractName: string,
  receiveName: string,
): SmartContractReceiveJsonSchemas {
  const receive = rawReceiveSchemaFromHex(schemaHex, contractName, receiveName);
  return {
    name: receive.entrypoint,
    ...(receive.schema.parameter !== undefined ? { parameter: schemaTypeToJsonSchema(receive.schema.parameter) } : {}),
    ...(receive.schema.returnValue !== undefined
      ? { returnValue: schemaTypeToJsonSchema(receive.schema.returnValue) }
      : {}),
    ...(receive.schema.error !== undefined ? { error: schemaTypeToJsonSchema(receive.schema.error) } : {}),
  };
}

/** Serializes a receive parameter JSON value against an embedded module schema and returns parameter bytes as hex. */
export function serializeReceiveParameterJsonFromHex(
  schemaHex: string,
  contractName: string,
  receiveName: string,
  parameterJson: JsonSafeValue,
): string {
  const receive = rawReceiveSchemaFromHex(schemaHex, contractName, receiveName);
  if (receive.schema.parameter === undefined)
    throw new Error(`Receive parameter schema not found: ${receive.contractName}.${receive.entrypoint}`);
  const parameter = serializeTypeValue(parameterJson, serializedSchemaType(receive.schema.parameter), true);
  return Buffer.from(Parameter.toBuffer(parameter)).toString('hex');
}

/** Returns the normalized event schema for a contract schema. */
export function eventSchemaFromHex(schemaHex: string, contractName: string): SmartContractJsonSchema {
  const contract = rawContractSchemaFromHex(schemaHex, contractName);
  const event = contractEventSchema(contract.schema);
  if (event === undefined) throw new Error(`Event schema not found: ${contract.name}`);
  return schemaTypeToJsonSchema(event);
}

/** Decodes receive return bytes as JSON using an embedded module schema. */
export function parseReceiveReturnJsonFromHex(
  schemaHex: string,
  contractName: string,
  receiveName: string,
  returnValueHex: string,
): SmartContractTypeValues {
  const receive = rawReceiveSchemaFromHex(schemaHex, contractName, receiveName);
  if (receive.schema.returnValue === undefined)
    throw new Error(`Receive return-value schema not found: ${receive.contractName}.${receive.entrypoint}`);
  return deserializeTypeValue(
    hexToArrayBuffer(hexString.require(returnValueHex, { allowEmpty: true })),
    serializedSchemaType(receive.schema.returnValue),
    true,
  );
}

/** Decodes receive error bytes as JSON using an embedded module schema. */
export function parseReceiveErrorJsonFromHex(
  schemaHex: string,
  contractName: string,
  receiveName: string,
  errorHex: string,
): SmartContractTypeValues {
  const receive = rawReceiveSchemaFromHex(schemaHex, contractName, receiveName);
  if (receive.schema.error === undefined)
    throw new Error(`Receive error schema not found: ${receive.contractName}.${receive.entrypoint}`);
  return deserializeTypeValue(
    hexToArrayBuffer(hexString.require(errorHex, { allowEmpty: true })),
    serializedSchemaType(receive.schema.error),
    true,
  );
}

/** Converts a Concordium SDK schema type to a stable JSON-safe schema AST. */
export function schemaTypeToJsonSchema(schemaType: SchemaType): SmartContractJsonSchema {
  switch (schemaType.type) {
    case 'Unit':
    case 'Bool':
    case 'U8':
    case 'U16':
    case 'U32':
    case 'U64':
    case 'U128':
    case 'I8':
    case 'I16':
    case 'I32':
    case 'I64':
    case 'I128':
    case 'Amount':
    case 'AccountAddress':
    case 'ContractAddress':
    case 'Timestamp':
    case 'Duration':
      return { kind: 'primitive', type: schemaType.type };
    case 'Pair':
      return {
        kind: 'pair',
        first: schemaTypeToJsonSchema(schemaType.first),
        second: schemaTypeToJsonSchema(schemaType.second),
      };
    case 'List':
      return { kind: 'list', sizeLength: schemaType.sizeLength, item: schemaTypeToJsonSchema(schemaType.item) };
    case 'Set':
      return { kind: 'set', sizeLength: schemaType.sizeLength, item: schemaTypeToJsonSchema(schemaType.item) };
    case 'Map':
      return {
        kind: 'map',
        sizeLength: schemaType.sizeLength,
        key: schemaTypeToJsonSchema(schemaType.key),
        value: schemaTypeToJsonSchema(schemaType.value),
      };
    case 'Array':
      return { kind: 'array', size: schemaType.size, item: schemaTypeToJsonSchema(schemaType.item) };
    case 'Struct':
      return { kind: 'struct', fields: schemaFieldsToJsonSchema(schemaType.fields) };
    case 'Enum': {
      const option = optionValueSchema(schemaType.variants);
      if (option !== undefined) {
        return {
          kind: 'option',
          value: option,
          encoding: { kind: 'enum', noneVariant: 'None', someVariant: 'Some' },
        };
      }
      return {
        kind: 'enum',
        variants: schemaType.variants.map((variant) => ({
          name: variant.name,
          fields: schemaFieldsToJsonSchema(variant.fields),
        })),
      };
    }
    case 'String':
      return { kind: 'string', sizeLength: schemaType.sizeLength };
    case 'ContractName':
      return { kind: 'contractName', sizeLength: schemaType.sizeLength };
    case 'ReceiveName':
      return { kind: 'receiveName', sizeLength: schemaType.sizeLength };
    case 'ULeb128':
      return { kind: 'uLeb128', maxByteSize: schemaType.maxByteSize };
    case 'ILeb128':
      return { kind: 'iLeb128', maxByteSize: schemaType.maxByteSize };
    case 'ByteList':
      return { kind: 'byteList', sizeLength: schemaType.sizeLength };
    case 'ByteArray':
      return { kind: 'byteArray', size: schemaType.size };
    case 'TaggedEnum':
      return {
        kind: 'taggedEnum',
        variants: [...schemaType.variants.entries()].map(([tag, variant]) => ({
          tag,
          name: variant.name,
          fields: schemaFieldsToJsonSchema(variant.fields),
        })),
      };
  }
}

function rawContractSchemaFromHex(
  schemaHex: string,
  contractName: string,
): { name: string; schema: SchemaContractLike } {
  const parsed = parseRawModuleSchema({ type: 'versioned', buffer: hexToArrayBuffer(hexString.require(schemaHex)) });
  const normalized = normalizeInitContractName(contractName);
  const schema = parsed.module.contracts.get(normalized);
  if (schema === undefined) throw new Error(`Contract schema not found: ${normalized}`);
  return { name: normalized, schema };
}

function rawReceiveSchemaFromHex(
  schemaHex: string,
  contractName: string,
  receiveName: string,
): { contractName: string; entrypoint: string; schema: SchemaFunctionV2 } {
  const contract = rawContractSchemaFromHex(schemaHex, contractName);
  const entrypoint = normalizeReceiveEntrypoint(receiveName, contract.name);
  const receive = contract.schema.receive.get(entrypoint);
  if (receive === undefined) throw new Error(`Receive schema not found: ${contract.name}.${entrypoint}`);
  return { contractName: contract.name, entrypoint, schema: receive };
}

function schemaFieldsToJsonSchema(fields: SchemaFields): SmartContractJsonSchemaFields {
  switch (fields.type) {
    case 'None':
      return { kind: 'none' };
    case 'Unnamed':
      return { kind: 'unnamed', items: fields.fields.map(schemaTypeToJsonSchema) };
    case 'Named':
      return {
        kind: 'named',
        entries: fields.fields.map((field) => ({ name: field.name, schema: schemaTypeToJsonSchema(field.field) })),
      };
  }
}

function optionValueSchema(variants: SchemaEnumVariant[]): SmartContractJsonSchema | undefined {
  if (variants.length !== 2) return undefined;
  const [none, some] = variants;
  if (none?.name !== 'None' || none.fields.type !== 'None') return undefined;
  if (some?.name !== 'Some' || some.fields.type !== 'Unnamed' || some.fields.fields.length !== 1) return undefined;
  return schemaTypeToJsonSchema(some.fields.fields[0]!);
}

function summarizeContract(name: string, contract: SchemaContractLike): SmartContractSchemaSummary {
  const init = contract.init === undefined ? undefined : summarizeFunction(contract.init);
  const event = contractEventSchema(contract);
  const eventTemplate = event === undefined ? undefined : templateForSchemaType(event);
  return {
    name,
    hasInit: init !== undefined,
    hasEvent: eventTemplate !== undefined,
    ...(init !== undefined ? { init } : {}),
    ...(eventTemplate !== undefined ? { eventTemplate } : {}),
    receive: [...contract.receive.entries()]
      .map(([name, receive]) => ({ name: String(name), ...summarizeFunction(receive) }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

function contractEventSchema(contract: SchemaContractLike): SchemaType | undefined {
  return 'event' in contract ? contract.event : undefined;
}

function summarizeFunction(fn: SchemaFunctionV2): SmartContractFunctionSchemaSummary {
  const parameterTemplate = fn.parameter === undefined ? undefined : templateForSchemaType(fn.parameter);
  const returnValueTemplate = fn.returnValue === undefined ? undefined : templateForSchemaType(fn.returnValue);
  const errorTemplate = fn.error === undefined ? undefined : templateForSchemaType(fn.error);
  return {
    hasParameter: parameterTemplate !== undefined,
    hasReturnValue: returnValueTemplate !== undefined,
    hasError: errorTemplate !== undefined,
    ...(parameterTemplate !== undefined ? { parameterTemplate } : {}),
    ...(returnValueTemplate !== undefined ? { returnValueTemplate } : {}),
    ...(errorTemplate !== undefined ? { errorTemplate } : {}),
  };
}

function templateForSchemaType(schemaType: SchemaType): JsonSafeValue {
  const template = displayTypeSchemaTemplate(serializedSchemaType(schemaType));
  try {
    return JSON.parse(template) as JsonSafeValue;
  } catch {
    return template;
  }
}

function serializedSchemaType(schemaType: SchemaType): ArrayBuffer {
  return toArrayBuffer(serializeSchemaType(schemaType));
}

function hexToArrayBuffer(hex: HexString): ArrayBuffer {
  return toArrayBuffer(Buffer.from(hex, 'hex'));
}
