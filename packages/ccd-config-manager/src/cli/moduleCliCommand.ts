import type { Command } from 'commander';
import {
  SOFTWARE_SIGNER_MODULE_ID,
  YUBIKEY_IDENTITY_SOURCE_BACKEND,
  YUBIKEY_PIV_MODULE_ID,
  getSigningModuleEnabled,
  isIdentitySourceBackendEnabled,
  setIdentitySourceBackendPolicy,
  setSigningModulePolicy,
  type ModulePolicy,
} from '@ccd-agent-kit/config-utils';

interface ModuleDescriptor {
  id: string;
}

interface ConsumerDescriptor {
  command: string;
  description: string;
  modules: readonly ModuleDescriptor[];
  selector: string;
  enabled(id: string): boolean;
  setPolicy(id: string, policy: ModulePolicy): void;
}

interface RegisterModuleCliCommandOptions {
  program: Command;
  stdout: string[];
}

const CONSUMERS: readonly ConsumerDescriptor[] = [
  {
    command: 'signer',
    description: 'Manage signer module policy.',
    selector: 'module',
    modules: [
      { id: SOFTWARE_SIGNER_MODULE_ID },
      { id: YUBIKEY_PIV_MODULE_ID },
    ],
    enabled: getSigningModuleEnabled,
    setPolicy: (id, policy) => setSigningModulePolicy(id as typeof SOFTWARE_SIGNER_MODULE_ID | typeof YUBIKEY_PIV_MODULE_ID, policy),
  },
  {
    command: 'id-manager',
    description: 'Manage identity-manager policy and running instances.',
    selector: 'backend',
    modules: [{ id: YUBIKEY_IDENTITY_SOURCE_BACKEND }],
    enabled: isIdentitySourceBackendEnabled,
    setPolicy: setIdentitySourceBackendPolicy,
  },
];

/** Registers consumer module-policy commands on the configuration CLI. */
export function registerModuleCliCommand(options: RegisterModuleCliCommandOptions): void {
  for (const consumer of CONSUMERS) registerConsumer(options, consumer);
}

function registerConsumer(options: RegisterModuleCliCommandOptions, consumer: ConsumerDescriptor): void {
  const service = options.program.commands.find(command => command.name() === 'service')
    ?? options.program.command('service').description('Manage CCD services.');
  const parent = service.commands.find(command => command.name() === consumer.command)
    ?? service.command(consumer.command).description(consumer.description);
  const module = parent.command('module').description('List, inspect, enable, and disable persisted module policy.');
  module.command('list').description('List persisted module policy.')
    .action(() => render(options.stdout, consumer, consumer.modules));
  module.command('inspect').description('Show persisted module policy.')
    .requiredOption(`--${consumer.selector} <id>`, `Canonical ${consumer.selector} ID.`)
    .action((values: Record<string, string | undefined>, command: Command) => {
      const selector = values[consumer.selector];
      render(options.stdout, consumer, [resolve(consumer, selector!, command)]);
    });
  for (const [action, policy] of [['enable', 'enabled'], ['disable', 'disabled']] as const) {
    module.command(action).description(`${action} persisted module policy.`)
      .requiredOption(`--${consumer.selector} <id>`, `Canonical ${consumer.selector} ID or supported alias.`)
      .action((values: Record<string, string>, command: Command) => {
        const selected = resolve(consumer, values[consumer.selector]!, command);
        consumer.setPolicy(selected.id, policy);
        render(options.stdout, consumer, [selected]);
      });
  }
}

function resolve(consumer: ConsumerDescriptor, selector: string, command: Command): ModuleDescriptor {
  const selected = consumer.modules.find(module => module.id === selector);
  if (selected === undefined) command.error(`Unknown ${consumer.selector} '${selector}'.`);
  return selected;
}

function render(stdout: string[], consumer: ConsumerDescriptor, modules: readonly ModuleDescriptor[]): void {
  stdout.push(JSON.stringify({
    consumer: consumer.command,
    modules: modules.map(module => {
      const enabled = consumer.enabled(module.id);
      return { id: module.id, policy: enabled ? 'enabled' : 'disabled', enabled };
    }),
  }, null, 2));
}
