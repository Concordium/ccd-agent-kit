import {
  encodeCatalogLabel, parseCatalogLabel,
} from '@ccd-agent-kit/config-utils';
import { IdentityWorkflowError } from './workflowErrors.js';

/** Return the visible, network-scoped selector without its optional ownership marker. */
export function identityLabelValue(label: string): string {
  return parseCatalogLabel(label).label;
}

/** Recognize an operator-protected or agent-modifiable label using the shared letter-first grammar. */
export function isIdentityLabel(value: string): boolean {
  try { parseCatalogLabel(value); return true; } catch { return false; }
}

/** Validate one exact stored label without trimming or changing its ownership. */
export function parseIdentityLabel(value: string): string {
  if (!isIdentityLabel(value)) throw new IdentityWorkflowError('INVALID_INPUT');
  return value;
}

/** Mark a bare label as agent-modifiable; callers cannot create operator-protected labels through this operation. */
export function agentIdentityLabel(value: string): `@${string}` {
  return encodeCatalogLabel(value, 'soft') as `@${string}`;
}

/** Build the ordinary default label from the source ID payload and immutable derivation selectors. */
export function defaultIdentityLabel(sourceId: string, identityProviderIndex: number, identityIndex: number): `@${string}` {
  return agentIdentityLabel(`ID-${sourceId.slice(3)}-${identityProviderIndex}-${identityIndex}`);
}
