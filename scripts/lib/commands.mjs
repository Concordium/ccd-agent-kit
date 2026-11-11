import { spawn } from 'node:child_process';

export function run(command, args, options = {}) {
  const display = [command, ...args].join(' ');
  process.stdout.write(`\n> ${display}\n`);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });

    child.on('error', (error) => {
      reject(new Error(`Failed to start "${display}": ${error.message}`));
    });

    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      const reason = signal === null ? `exit code ${code}` : `signal ${signal}`;
      reject(new Error(`Command failed with ${reason}: ${display}`));
    });
  });
}
