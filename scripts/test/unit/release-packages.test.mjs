import assert from 'node:assert/strict';
import test from 'node:test';
import { createDistributionManifest } from '../../lib/release-packages.mjs';

test('createDistributionManifest preserves npm package metadata', () => {
  const metadata = {
    repository: {
      type: 'git',
      url: 'git+https://github.com/Concordium/ccd-agent-kit.git',
      directory: 'packages/ccd-config-manager',
    },
    homepage: 'https://github.com/Concordium/ccd-agent-kit#readme',
    bugs: { url: 'https://github.com/Concordium/ccd-agent-kit/issues' },
  };
  const source = { name: '@ccd-agent-kit/ccd-config-manager', version: '0.0.1', ...metadata };
  const manifest = createDistributionManifest(source, {});
  assert.equal(manifest.name, source.name);
  assert.equal(manifest.version, source.version);
  assert.equal(manifest.license, 'Apache-2.0');
  assert.deepEqual(manifest.repository, metadata.repository);
  assert.equal(manifest.homepage, metadata.homepage);
  assert.deepEqual(manifest.bugs, metadata.bugs);
});
