import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CliInputSourceError, loadCliInputSource, resolveCliInputSource } from '../../../src/cli/inputLoader.js';
import { makeTestTempDir } from '../../helpers/tempDir.js';

let scratchRoot: string;

beforeEach(() => {
  scratchRoot = makeTestTempDir('signer-cli-input-loader-');
});

afterEach(async () => {
  await rm(scratchRoot, { force: true, recursive: true });
});

describe('CLI input source loader', () => {
  it('rejects missing and conflicting sources before file IO', () => {
    expect(() => resolveCliInputSource({}, 'choose one')).toThrowError(new CliInputSourceError('choose one'));
    expect(() => resolveCliInputSource({ input: '' }, 'choose one')).toThrowError(new CliInputSourceError('choose one'));
    expect(() => resolveCliInputSource({ inputFile: '' }, 'choose one')).toThrowError(new CliInputSourceError('choose one'));
    expect(() => resolveCliInputSource({ input: 'abc', inputFile: join(scratchRoot, 'missing') }, 'choose one')).toThrowError(new CliInputSourceError('choose one'));
  });

  it('preserves direct, file, and injected empty stdin content exactly', async () => {
    const path = join(scratchRoot, 'input.txt');
    await writeFile(path, '  hello\n\n', 'utf8');

    await expect(loadCliInputSource(resolveCliInputSource({ input: '  hello\n' }, 'choose one'))).resolves.toBe('  hello\n');
    await expect(loadCliInputSource(resolveCliInputSource({ inputFile: path }, 'choose one'))).resolves.toBe('  hello\n\n');
    await expect(loadCliInputSource(resolveCliInputSource({ stdin: true }, 'choose one'), '')).resolves.toBe('');
  });
});
