import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { signerResourceDefinitions } from '../../../../src/mcp/resources/resourceDefinitions.js';
import { makeTestTempDir } from '../../../helpers/tempDir.js';
import { useSignerSandbox } from '../../../helpers/sandbox.js';

useSignerSandbox();

describe('signerResourceDefinitions', () => {
  it('registers the public signer MCP resource catalog', () => {
    const resources = signerResourceDefinitions();

    expect(resources.filter(({ name }) => !name.startsWith('signer-accounts-')).map(({ name, uri }) => [name, uri]))
      .toEqual([
      ['ccd://networks', 'ccd://networks'],
      ['ccd://keys', 'ccd://keys'],
      ['ccd://signer/instance', 'ccd://signer/instance'],
      ['ccd-network-discovery', 'skill://ccd-network-discovery/SKILL.md'],
      ['ccd-signer-key-discovery', 'skill://ccd-signer-key-discovery/SKILL.md'],
    ]);
    expect(resources.map(({ uri }) => uri).filter((uri) => uri.includes('guidance'))).toEqual([]);
  });

  it('declares JSON metadata for each signer MCP resource', () => {
    const resources = signerResourceDefinitions();

    const ccdResources = resources.filter(
      (resource) => resource.uri.startsWith('ccd://'),
    );
    const skillResources = resources.filter(
      (resource) => resource.uri.startsWith('skill://'),
    );
    expect(ccdResources).not.toHaveLength(0);
    expect(skillResources).not.toHaveLength(0);
    expect(ccdResources.every((resource) => resource.mimeType === 'application/json')).toBe(true);
    expect(skillResources.every((resource) => resource.mimeType === 'text/markdown')).toBe(true);
    expect(resources.find((resource) => resource.uri === 'ccd://networks')).toMatchObject({
      title: 'Concordium Signer Networks',
      description: 'Configured Concordium networks and the active default network.',
    });
  });

  it('reads static resources through catalog callbacks', async () => {
    const resources = signerResourceDefinitions();
    const networksResource = resources.find((resource) => resource.uri === 'ccd://networks');
    const networkSkillResource = resources.find(
      (resource) => resource.uri === 'skill://ccd-network-discovery/SKILL.md',
    );
    const skillResource = resources.find(
      (resource) => resource.uri === 'skill://ccd-signer-key-discovery/SKILL.md',
    );

    const networksResult = await networksResource?.read('ccd://networks');
    const networkSkillResult = await networkSkillResource?.read('skill://ccd-network-discovery/SKILL.md');
    const skillResult = await skillResource?.read('skill://ccd-signer-key-discovery/SKILL.md');

    expect(networksResult?.uri).toBe('ccd://networks');
    expect(networksResult?.mimeType).toBe('application/json');
    expect(networkSkillResult?.mimeType).toBe('text/markdown');
    expect(networkSkillResult?.text).toContain('ccd://networks');
    expect(networkSkillResult?.text).not.toContain('management-guidance');
    expect(skillResult?.mimeType).toBe('text/markdown');
    expect(skillResult?.text).not.toContain('management-guidance');
  });
});

describe('signer instance resource', () => {
  let tempDir: string;
  let originalData: string | undefined;
  let originalState: string | undefined;

  beforeEach(() => {
    originalData = process.env.XDG_DATA_HOME;
    originalState = process.env.XDG_STATE_HOME;
    tempDir = makeTestTempDir('signer-instance-resource-test-');
    process.env.XDG_DATA_HOME = join(tempDir, 'private-data');
    process.env.XDG_STATE_HOME = join(tempDir, 'private-state');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    if (originalData !== undefined) process.env.XDG_DATA_HOME = originalData;
    else delete process.env.XDG_DATA_HOME;
    if (originalState !== undefined) process.env.XDG_STATE_HOME = originalState;
    else delete process.env.XDG_STATE_HOME;
  });

  it('exposes safe instance identity and lock guidance only', async () => {
    const resource = signerResourceDefinitions().find((candidate) => candidate.name === 'ccd://signer/instance');
    expect(resource).toBeDefined();

    const content = await resource?.read('ccd://signer/instance');
    expect(content).toMatchObject({
      uri: 'ccd://signer/instance',
      mimeType: 'application/json',
    });
    expect(content?.text).toEqual(expect.any(String));
    if (content?.text === undefined) return;

    const payload = JSON.parse(content.text) as Record<string, unknown>;
    const instanceId = payload['instanceId'];
    expect(instanceId).toEqual(expect.any(String));
    expect(payload['status']).toEqual(expect.stringMatching(/^(locked|unlocked)$/));
    expect(payload['unlockCommand']).toBe(`ccd-config-manager service signer unlock --instance ${String(instanceId)}`);

    const serialized = content.text;
    expect(serialized).not.toContain(join(tempDir, 'private-data'));
    expect(serialized).not.toContain(join(tempDir, 'private-state'));
    expect(serialized).not.toContain(process.cwd());
    expect(payload).not.toHaveProperty('displayName');
    expect(payload).not.toHaveProperty('path');
    expect(payload).not.toHaveProperty('filePath');
    expect(payload).not.toHaveProperty('socket');
    expect(payload).not.toHaveProperty('socketPath');
    expect(payload).not.toHaveProperty('token');
    expect(payload).not.toHaveProperty('cwd');
    expect(payload).not.toHaveProperty('workingDirectory');
  });
});
