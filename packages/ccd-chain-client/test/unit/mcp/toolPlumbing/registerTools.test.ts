import { describe, expect, it } from 'vitest';
import { TOOL_CATALOG } from '../../../../src/mcp/toolPlumbing/registerTools.js';

describe('TOOL_CATALOG', () => {
  it('keeps unique tool names in served order', () => {
    const names = TOOL_CATALOG.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([
      'label_account',
      'sync_account_credentials',
      'label_contract_instance',
      'simulate_contract',
      'get_cis2_token_balance',
      'build_transfer',
      'build_register_data',
      'build_configure_delegation',
      'build_configure_baker',
      'build_update_credential_keys',
      'build_init_contract',
      'build_update_contract',
      'build_plt',
      'verify_transaction_signature',
      'verify_message_signature',
      'complete_transaction',
      'complete_account_opening',
    ]);
  });
});
