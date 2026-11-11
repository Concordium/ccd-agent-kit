import {
  parseIdentityContextSnapshot,
  type IdentityContextSnapshot,
} from '@ccd-agent-kit/sdk-utils';

import { readJsonFile, writeJsonFile } from './jsonFile.js';
import { getIdentityContextSnapshotPathForNetwork } from './paths.js';

/** Loads a valid snapshot for an exact lowercase CAIP-2 reference, or returns `undefined`. */
export function getIdentityContextSnapshot(caip2Ref: string): IdentityContextSnapshot | undefined {
  const path = getIdentityContextSnapshotPathForNetwork(caip2Ref);
  return readJsonFile(path, (value) => {
    const snapshot = parseIdentityContextSnapshot(value);
    return snapshot.network.caip2 === `ccd:${caip2Ref}` ? snapshot : undefined;
  });
}

/** Writes a typed public identity-context snapshot after enforcing the requested network reference. */
export function setIdentityContextSnapshot(caip2Ref: string, snapshot: IdentityContextSnapshot): void {
  const path = getIdentityContextSnapshotPathForNetwork(caip2Ref);
  if (snapshot.network.caip2 !== `ccd:${caip2Ref}`) {
    throw new Error('Identity context snapshot does not match the requested network reference.');
  }
  writeJsonFile(path, snapshot);
}
