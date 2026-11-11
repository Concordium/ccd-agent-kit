declare module 'pcsclite' {
  import type { EventEmitter } from 'node:events';

  interface PcscLite extends EventEmitter {
    close(): void;
  }

  export default function pcsclite(): PcscLite;
}
