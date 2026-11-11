import { CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';

import { commanderExitCode } from '../../src/index.js';

function commanderError(exitCode: number, code: string): CommanderError {
  return new CommanderError(exitCode, code, 'test error');
}

describe('commanderExitCode', () => {
  it.each([
    'commander.help',
    'commander.helpDisplayed',
    'commander.unknownCommand',
  ])('preserves zero as success for %s', (code) => {
    expect(commanderExitCode(commanderError(0, code))).toBe(0);
  });

  it.each([
    'commander.unknownCommand',
    'commander.missingMandatoryOptionValue',
  ])('normalizes nonzero Commander usage failures for %s', (code) => {
    expect(commanderExitCode(commanderError(1, code))).toBe(2);
  });

  it.each([1, 2, 7])('preserves command failure exit code %i', (exitCode) => {
    expect(commanderExitCode(commanderError(exitCode, 'ccd.commandFailed'))).toBe(exitCode);
  });

  it('treats a zero command failure exit code as success', () => {
    expect(commanderExitCode(commanderError(0, 'ccd.commandFailed'))).toBe(0);
  });
});
