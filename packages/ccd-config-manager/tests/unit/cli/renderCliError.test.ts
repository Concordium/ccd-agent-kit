import { describe, expect, it } from 'vitest';

import { renderCliError } from '../../../src/cli/renderCliError.js';

describe('renderCliError', () => {
  it('warns that an attempted but unconfirmed mutation is uncertain and preserves stage facts', () => {
    const error = Object.assign(new Error('APDU failed during verification'), {
      cause: new Error('native cause'), stage: 'post-write-verification',
      mutation: { attempted: true, confirmed: false, rebootFailed: false, restorationFailed: false },
    });
    expect(renderCliError(error).join('\n')).toMatch(/APDU failed.*hardware key change is uncertain.*inspect.*reconcile/is);
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.stage).toBe('post-write-verification');
    expect(error.mutation.confirmed).toBe(false);
  });

  it('reports a confirmed hardware change and each cleanup failure', () => {
    const error = Object.assign(new Error('cleanup failed'), {
      mutation: { attempted: true, confirmed: true, rebootFailed: true, restorationFailed: true },
    });
    const rendered = renderCliError(error).join('\n');
    expect(rendered).toMatch(/hardware key change was confirmed/i);
    expect(rendered).toMatch(/reboot failed/i);
    expect(rendered).toMatch(/PIN-state restoration failed/i);
    expect(rendered).toMatch(/manually replug/i);
  });

  it('does not emit mutation guidance for a pre-mutation guard failure', () => {
    const error = Object.assign(new Error('slot occupied'), {
      mutation: { attempted: false, confirmed: false, rebootFailed: false, restorationFailed: false },
    });
    expect(renderCliError(error)).toEqual(['slot occupied']);
  });
});
