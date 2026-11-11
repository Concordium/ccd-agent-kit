import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogLabelError, type setSignerInventoryKeySoftLabel } from '@ccd-agent-kit/config-utils';

const { writeLabel } = vi.hoisted(() => ({ writeLabel: vi.fn<typeof setSignerInventoryKeySoftLabel>() }));
vi.mock('@ccd-agent-kit/config-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ccd-agent-kit/config-utils')>()),
  setSignerInventoryKeySoftLabel: writeLabel,
}));

import { executeLabelSigningKeyTool } from '../../../../src/mcp/tools/labelSigningKeyTool.js';

const publicKey = 'ab'.repeat(32);
const keyRef = `ed25519:${publicKey}`;

describe('signing-key soft labels', () => {
  beforeEach(() => {
    writeLabel.mockReset();
  });

  it('writes a bare soft label and projects no custody metadata', async () => {
    const result = await executeLabelSigningKeyTool({ keyRef, label: '  Spending  ' });
    expect(writeLabel).toHaveBeenCalledWith({ publicKey, label: 'Spending' });
    expect(result.structuredContent).toEqual({ keyRef, label: 'Spending' });
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  });

  it('permits removing a soft label without removing its key', async () => {
    const result = await executeLabelSigningKeyTool({ keyRef, remove: true });
    expect(writeLabel).toHaveBeenCalledWith({ publicKey, label: undefined });
    expect(result.structuredContent).toEqual({ keyRef });
  });

  it('returns an MCP error when a hard label is protected', async () => {
    writeLabel.mockImplementation(() => {
      throw new CatalogLabelError('LABEL_PROTECTED');
    });
    const result = await executeLabelSigningKeyTool({ keyRef, label: 'Spending' });
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain('LABEL_PROTECTED');
  });

  it('does not disclose path-bearing catalog errors', async () => {
    writeLabel.mockImplementation(() => {
      throw new Error('EACCES: open /protected/device-location/inventory.json');
    });
    const result = await executeLabelSigningKeyTool({ keyRef, label: 'Spending' });
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).not.toMatch(/protected|device-location|inventory\.json|EACCES/);
  });

  it('does not report a label collision as hard-label protection', async () => {
    writeLabel.mockImplementation(() => { throw new CatalogLabelError('DUPLICATE_LABEL'); });
    const result = await executeLabelSigningKeyTool({ keyRef, label: 'Spending' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/DUPLICATE_LABEL|LABEL_PROTECTED/);
  });

  it('rejects invalid key references without writing', async () => {
    const result = await executeLabelSigningKeyTool({ keyRef: 'device-slot', label: 'Spending' });
    expect(result).toMatchObject({ isError: true });
    expect(writeLabel).not.toHaveBeenCalled();
  });

  it('validates omitted actions in the direct executor', async () => {
    const result = await executeLabelSigningKeyTool({ keyRef });
    expect(result).toMatchObject({ isError: true });
    expect(writeLabel).not.toHaveBeenCalled();
  });

});
