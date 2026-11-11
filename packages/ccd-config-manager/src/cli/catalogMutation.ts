const IDENTITY_ROOT_CATALOG_FAILURE =
  'Identity root remains on hardware, but the catalog update did not complete and may be partially applied. Inspect the root and reconcile the catalog; do not regenerate it.';

/**
 * Runs a catalog write after hardware changed and reports failures as partial
 * completion instead of implying that the hardware mutation was rolled back.
 */
export async function catalogAfterHardwareMutation<T>(write: () => T | Promise<T>, message: string): Promise<T> {
  try {
    return await write();
  } catch (error) {
    throw new Error(message, { cause: error });
  }
}

/** Persists an observed hardware identity root with truthful partial-completion errors. */
export function catalogIdentityRoot<T>(writeCatalog: () => T | Promise<T>): Promise<T> {
  return catalogAfterHardwareMutation(writeCatalog, IDENTITY_ROOT_CATALOG_FAILURE);
}
