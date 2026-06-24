const MAX_ATTEMPTS = 5;

function isBusyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err.code === 'SQLITE_BUSY' || err.code === 'SQLITE_BUSY_SNAPSHOT')
  );
}

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

export function withRetry<T>(fn: () => T): T {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return fn();
    } catch (err) {
      if (!isBusyError(err) || attempt === MAX_ATTEMPTS - 1) {
        throw err;
      }

      const backoff = 50 * 2 ** attempt + Math.floor(Math.random() * 26);
      sleepSync(backoff);
    }
  }

  throw new Error('unreachable retry state');
}
