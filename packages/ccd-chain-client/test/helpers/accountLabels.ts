import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTestTempDir } from './tempDir.js';

export function installAccountLabelsFixture(
  networkReference: string,
  labels: Record<string, string>,
  prefix = 'ccd-account-labels-test',
): () => void {
  return installLabelsFixture('account-labels', networkReference, labels, prefix);
}

export function installContractInstanceLabelsFixture(
  networkReference: string,
  labels: Record<string, { index: string; subindex: string }>,
  prefix = 'ccd-contract-instance-labels-test',
): () => void {
  return installLabelsFixture('contract-instance-labels', networkReference, labels, prefix);
}

function installLabelsFixture(directory: string, networkReference: string, labels: unknown, prefix: string): () => void {
  const previousConfig = process.env.XDG_CONFIG_HOME;
  const previousData = process.env.XDG_DATA_HOME;
  const previousState = process.env.XDG_STATE_HOME;
  const root = makeTestTempDir(`${prefix}-`);
  const dataRoot = join(root, 'data');
  mkdirSync(join(dataRoot, 'ccd-agent-kit', directory), { recursive: true });
  writeFileSync(
    join(dataRoot, 'ccd-agent-kit', directory, `${networkReference}.json`),
    `${JSON.stringify(labels, null, 2)}\n`,
    'utf8',
  );
  process.env.XDG_CONFIG_HOME = join(root, 'config');
  process.env.XDG_DATA_HOME = dataRoot;
  process.env.XDG_STATE_HOME = join(root, 'state');
  return () => {
    if (previousConfig === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previousConfig;
    }
    if (previousData === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previousData;
    }
    if (previousState === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = previousState;
    }
    rmSync(root, { recursive: true, force: true });
  };
}
