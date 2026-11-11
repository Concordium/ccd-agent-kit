import { stdin as processStdin, stdout as processStdout } from 'node:process';
import { readHiddenLine } from '@ccd-agent-kit/cli-utils';

import type { YubiKeyInteractionProvider } from '@ccd-agent-kit/piv-utils';

/** Creates the interactive YubiKey callbacks used by local CLI signing commands. */
export function createCliYubiKeyInteraction(promptPin?: () => Promise<string>): Pick<YubiKeyInteractionProvider, 'promptPin'> {
  return {
    promptPin:
      promptPin ??
      (() => readHiddenLine(processStdin, processStdout, 'PIV PIN: ', 'YubiKey PIN entry requires an interactive terminal.')),
  };
}
