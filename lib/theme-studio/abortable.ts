/** Bound the whole operation, including SDK authentication, retries and body
 * decoding. Passing a signal to an SDK alone does not bound all those stages.
 * The operation still receives the signal so its network work can stop too.
 * Late settlement is observed but never returned to a worker that lost time. */
export function abortable<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return operation();
      })
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener("abort", aborted);
      });
  });
}
