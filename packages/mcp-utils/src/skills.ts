import { createHash } from 'node:crypto';
import type { TextResourceContent } from './resources.js';

const SKILL_CACHE_TTL_MS = 300_000;

/** MCP Skills extension capability name advertised by servers that serve skills. */
export const MCP_SKILLS_EXTENSION = 'io.modelcontextprotocol/skills';

/** MCP method name used to list served skills. */
export const MCP_SKILLS_LIST_METHOD = 'skills/list';

/** MCP method name used to read one served skill entry. */
export const MCP_SKILLS_GET_METHOD = 'skills/get';

/** Capability fragment for servers that implement the MCP Skills extension. */
export const MCP_SKILLS_CAPABILITIES = {
  extensions: {
    [MCP_SKILLS_EXTENSION]: {},
  },
};

/** A file belonging to an MCP-served skill. */
export interface SkillResourceDto {
  /** Resource URI of the file. */
  uri: string;
  /** SHA-256 digest in `sha256:{hex}` format. */
  digest: string;
  /** Raw UTF-8 byte length. */
  size: number;
}

/** Frontmatter exposed for an MCP-served skill. */
export interface SkillFrontmatterDto {
  /** Agent Skills name. */
  name: string;
  /** Agent Skills description. */
  description: string;
}

/** MCP Skills extension skill entry. */
export interface SkillEntryDto {
  /** Resource URI of the skill's `SKILL.md`. */
  uri: string;
  /** Strict parsed `name` and `description` frontmatter. */
  frontmatter: SkillFrontmatterDto;
  /** Complete file manifest. */
  resources: SkillResourceDto[] | 'dynamic';
}

/** Static skill file served through `resources/read`. */
export interface StaticSkillFile {
  /** Resource URI. */
  uri: string;
  /** MIME type. */
  mimeType: 'text/markdown';
  /** Exact UTF-8 content served for this file. */
  text: string;
}

/** Static MCP-served skill with manifest entry and files. */
export interface StaticSkillDefinition {
  /** Skill entry returned by `skills/list` and `skills/get`. */
  entry: SkillEntryDto;
  /** Files keyed by URI. */
  files: Record<string, StaticSkillFile>;
}

/** Throws if a static skill catalogue contains duplicate skill resource URIs. */
export function assertUniqueStaticSkillUris(skills: readonly StaticSkillDefinition[]): void {
  const seen = new Set<string>();
  for (const skill of skills) {
    if (seen.has(skill.entry.uri)) throw new Error(`Duplicate static skill URI: ${skill.entry.uri}`);
    seen.add(skill.entry.uri);
  }
}

/** Cache fields required by MCP Skills extension results. */
export interface CacheableCompleteResultDto {
  [key: string]: unknown;
  /** Result completeness marker. */
  resultType: 'complete';
  /** Freshness hint in milliseconds. */
  ttlMs: number;
  /** Cache scope. */
  cacheScope: 'public' | 'private';
}

/** Result returned by `skills/list`. */
export interface ListSkillsResultDto extends CacheableCompleteResultDto {
  /** Served skills. */
  skills: SkillEntryDto[];
  /** Optional pagination cursor. */
  nextCursor?: string;
}

/** Result returned by `skills/get`. */
export interface GetSkillResultDto extends CacheableCompleteResultDto {
  /** Requested skill. */
  skill: SkillEntryDto;
}

/** Parses the strict `name`/`description` header supported by MCP-served skill markdown. */
export function parseSkillHeader(text: string): SkillFrontmatterDto {
  const normalizedText = text.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalizedText);
  if (match === null) throw new Error('Skill markdown must start with a frontmatter header.');
  const fields: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    if (line.trim() === '') continue;
    const separator = line.indexOf(':');
    if (separator <= 0) throw new Error(`Invalid skill header line: ${line}`);
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key !== 'name' && key !== 'description') throw new Error(`Unsupported skill header field: ${key}`);
    if (value === '') throw new Error(`Skill header field ${key} must not be empty.`);
    fields[key] = value;
  }
  if (fields.name === undefined) throw new Error('Skill header requires name.');
  if (fields.description === undefined) throw new Error('Skill header requires description.');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(fields.name)) {
    throw new Error('Skill header name must be a lowercase URI-safe slug.');
  }
  return { name: fields.name, description: fields.description };
}

/** Builds a static skill definition from already-loaded markdown text. */
export function buildStaticSkillDefinition(input: {
  frontmatter: SkillFrontmatterDto;
  text: string;
}): StaticSkillDefinition {
  const uri = `skill://${input.frontmatter.name}/SKILL.md`;
  const file = { uri, mimeType: 'text/markdown', text: input.text } satisfies StaticSkillFile;
  return {
    entry: {
      uri,
      frontmatter: input.frontmatter,
      resources: [{ uri, digest: sha256Digest(input.text), size: Buffer.byteLength(input.text, 'utf8') }],
    },
    files: { [uri]: file },
  };
}

/** Returns a cacheable `skills/list` result for a static skill catalogue. */
export function listStaticSkills(skills: readonly StaticSkillDefinition[]): ListSkillsResultDto {
  return {
    resultType: 'complete',
    skills: skills.map((skill) => skill.entry),
    ttlMs: SKILL_CACHE_TTL_MS,
    cacheScope: 'public',
  };
}

/** Returns a cacheable `skills/get` result for a static skill URI. */
export function getStaticSkill(uri: string, skills: readonly StaticSkillDefinition[]): GetSkillResultDto | undefined {
  const skill = skills.find((candidate) => candidate.entry.uri === uri);
  return skill === undefined
    ? undefined
    : {
        resultType: 'complete',
        skill: skill.entry,
        ttlMs: SKILL_CACHE_TTL_MS,
        cacheScope: 'public',
      };
}

/** Reads a static skill file as text resource content. */
export function readStaticSkillFile(
  uri: string,
  skills: readonly StaticSkillDefinition[],
): TextResourceContent | undefined {
  for (const skill of skills) {
    const file = skill.files[uri];
    if (file !== undefined) return file;
  }
  return undefined;
}

function sha256Digest(text: string): string {
  return `sha256:${createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')}`;
}
