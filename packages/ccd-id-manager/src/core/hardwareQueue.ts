let hardwareTail = Promise.resolve();

/** Serialize identity hardware agreements and process-local authorization controls. */
export async function withIdentityHardwareQueue<T>(operation: () => Promise<T>): Promise<T> {
  const prior = hardwareTail;
  let release!: () => void;
  hardwareTail = new Promise<void>((resolve) => { release = resolve; });
  await prior;
  try { return await operation(); } finally { release(); }
}
