import { chmodSync } from 'node:fs';

for (const path of process.argv.slice(2)) {
  chmodSync(path, 0o755);
}
