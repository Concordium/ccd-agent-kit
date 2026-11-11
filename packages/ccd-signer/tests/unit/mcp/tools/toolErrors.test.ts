import { describe, expect, it } from 'vitest';

import { mcpInvalidArgument } from '@ccd-agent-kit/mcp-utils';
import {
  messageFromUnknown,
  renderSignerMcpToolError,
  signerMcpErrorResult,
  signerMcpToolMessages,
} from '../../../../src/mcp/tools/toolErrors.js';

describe('signer MCP tool error rendering', () => {
  it('redacts quoted absolute local paths from unknown errors', () => {
    const message = messageFromUnknown(
      new Error("ENOENT: no such file or directory, open '/Users/alice/.local/share/key.json'"),
    );

    expect(message).toContain('[redacted local path]');
    expect(message).not.toContain('/Users/alice');
  });

  it('preserves shared invalid-argument messages', () => {
    expect(messageFromUnknown(mcpInvalidArgument("Network 'unknown' not found."))).toBe("Network 'unknown' not found.");
  });

  it.each([
    ['signing-failed', 'Failed to read "/Volumes/GitHub/project/.test-tmp/signing-key.json".',
      'Signing failed: Failed to read "[redacted local path]".'],
    ['credential-deployment-signing-failed', "Failed to read '/Users/alice/.ccd/credential.json'.",
      "Credential deployment signing failed: Failed to read '[redacted local path]'."],
  ] as const)('renders sanitized %s messages', (kind, message, expected) => {
    const rendered = renderSignerMcpToolError({ kind, message });
    expect(rendered).toBe(expected);
    expect(rendered).not.toMatch(/\/Users\/alice|\/Volumes\/GitHub/);
  });

  it('returns the public MCP error result shape', () => {
    expect(signerMcpErrorResult({ kind: 'signing-failed', message: 'invalid transaction' })).toEqual({
      content: [{ type: 'text', text: signerMcpToolMessages.signingFailed('invalid transaction') }],
      isError: true,
    });
  });
});
