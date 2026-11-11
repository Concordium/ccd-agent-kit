/** Executable tool entries for binary smoke checks; asset-only packages have no entry. */
export const publicBins = [
  {
    projectName: 'ccd-id-manager',
    path: 'packages/ccd-id-manager/dist/bin/ccd-id-manager.js',
    args: ['--help'],
  },
  {
    projectName: 'ccd-id-manager',
    path: 'packages/ccd-id-manager/dist/bin/ccd-id-manager-mcp.js',
    args: ['--help'],
  },
  {
    projectName: 'ccd-signer',
    path: 'packages/ccd-signer/dist/bin/ccd-signer.js',
    args: ['--help'],
  },
  {
    projectName: 'ccd-signer',
    path: 'packages/ccd-signer/dist/bin/ccd-signer-mcp.js',
    args: ['--help'],
  },
  {
    projectName: 'ccd-chain-client',
    path: 'packages/ccd-chain-client/dist/bin/ccd-chain-client-mcp.js',
    args: ['--help'],
  },
  {
    projectName: 'ccd-config-manager',
    path: 'packages/ccd-config-manager/dist/bin/ccd-config-manager.js',
    args: ['--help'],
  },
];
