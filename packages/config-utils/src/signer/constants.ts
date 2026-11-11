/** Stable module identifier for the built-in software signing module. */
export const SOFTWARE_SIGNER_MODULE_ID = 'software-signer' as const;
/** Stable module identifier for the YubiKey PIV signing module. */
export const YUBIKEY_PIV_MODULE_ID = 'yubikey-piv' as const;
/** Stable signer inventory scheme for Ed25519 keys. */
export const ED25519_SCHEME = 'Ed25519' as const;
/** Stable storage module identifier for encrypted software key files. */
export const ENCRYPTED_FILE_STORAGE_MODULE_ID = 'encrypted-file' as const;

/** Supported first-party signing module identifiers. */
export type SigningModuleId = typeof SOFTWARE_SIGNER_MODULE_ID | typeof YUBIKEY_PIV_MODULE_ID;
/** Supported software key-storage module identifiers. */
export type SoftwareKeyStorageModuleId = typeof ENCRYPTED_FILE_STORAGE_MODULE_ID;
/** Supported software signing schemes. */
export type SoftwareSignerScheme = typeof ED25519_SCHEME;
