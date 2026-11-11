import type { ToolAnnotations } from './toolTypes.js';

/** Annotations shared by all side-effect free read tools. */
export const READ_ANNOTATIONS: ToolAnnotations = { readOnlyHint: true, idempotentHint: true };

/** Annotations shared by sign-ready payload builders. */
export const BUILD_ANNOTATIONS: ToolAnnotations = { openWorldHint: false, idempotentHint: true };

/** Annotations shared by completion tools that may submit a block item to the network. */
export const SUBMISSION_ANNOTATIONS: ToolAnnotations = {
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

/** Annotations shared by tools that refresh shared local account-credential state. */
export const CACHE_REFRESH_ANNOTATIONS: ToolAnnotations = { openWorldHint: true, idempotentHint: false };
