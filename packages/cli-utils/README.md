# CLI utilities

`@ccd-agent-kit/cli-utils` provides shared terminal, CLI-input boundary, executable-launch, and
Commander help-tree and exit-code interpretation helpers.

Its public exports are:

- `validateCliOptions` for converting Zod validation failures to user-facing errors;
- `parseJsonCliValue` and `UsageErrorFactory` for parsing JSON command values;
- `readProcessStdin` for collecting UTF-8 standard input;
- `readHiddenLine` for guarded, non-echoing interactive input;
- `disableHelpCommands(command: Command): void` for recursively calling
  `addHelpCommand(false)` on a fully registered Commander root and each registered child. Root
  help-command configuration is not inherited, so callers invoke this once after constructing the
  complete tree. It disables generated `help [command]` subcommands without changing `-h`,
  `--help`, aliases, parsing, actions, output, or no-argument behavior;
- `commanderExitCode(error: CommanderError): number` for mapping Commander `exitCode` `0` to `0`,
  preserving the original status of `ccd.commandFailed`, and mapping every other Commander
  error to usage status `2`; and
- `runCliEntrypoint(isMain: boolean, run: (argv: string[]) => Promise<number>): Promise<void>`
  for inert imports and process-level launch behavior. When `isMain` is true, it awaits
  `run(process.argv.slice(2))` and assigns the returned status to `process.exitCode`; when false,
  it does not invoke the runner or change the exit code. Runner failures propagate without
  replacing the existing exit code.

This package does not provide a shared Commander program, parser, or CLI runner. Each CLI adapter
retains tree construction, its `instanceof CommanderError` guard, output flushing,
command-specific results, and non-Commander domain-error rendering.
