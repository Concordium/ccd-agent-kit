interface MutationFacts {
  attempted: boolean;
  confirmed: boolean;
  rebootFailed: boolean;
  restorationFailed: boolean;
}

/** Renders an error without replacing it, surfacing native hardware mutation and cleanup facts when present. */
export function renderCliError(error: unknown): string[] {
  const message = error instanceof Error ? error.message : String(error);
  const mutation = mutationFacts(error);
  if (mutation?.attempted !== true) return [message];
  const change = mutation.confirmed
    ? 'Hardware key change was confirmed.'
    : 'Hardware key change is uncertain because mutation was attempted but not confirmed.';
  const cleanup = mutation.rebootFailed || mutation.restorationFailed
    ? `Cleanup outcomes: device reboot ${mutation.rebootFailed ? 'failed' : 'did not fail'}; PIN-state restoration ${mutation.restorationFailed ? 'failed' : 'did not fail or was not required'}.`
    : 'Cleanup outcomes: no device reboot or PIN-state restoration failure was reported.';
  const guidance = mutation.rebootFailed || mutation.restorationFailed
    ? 'Manually replug the device, then inspect it and reconcile the catalog before continuing. Do not retry the mutation automatically.'
    : 'Inspect the device and reconcile the catalog before continuing. Do not retry the mutation automatically.';
  return [message, change, cleanup, guidance];
}

function mutationFacts(error: unknown): MutationFacts | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = (error as { mutation?: unknown }).mutation;
  if (typeof value !== 'object' || value === null) return undefined;
  const facts = value as Record<string, unknown>;
  if (typeof facts.attempted !== 'boolean' || typeof facts.confirmed !== 'boolean'
    || typeof facts.rebootFailed !== 'boolean' || typeof facts.restorationFailed !== 'boolean') return undefined;
  return facts as unknown as MutationFacts;
}
