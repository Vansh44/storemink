import { abortable } from "./abortable";

/** Shared across the two worker lanes in one HTTP execution. Without this,
 * each theme's three image lanes would double the same Vertex quota load.
 * Run leases fence duplicate work across instances; this is a process-local
 * concurrency bound, not a claim about the provider's available quota. */
export class ImageRequestPool {
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(private readonly limit = 3) {}

  async run<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        this.waiting = this.waiting.filter((entry) => entry !== enter);
        reject(signal.reason);
      };
      const enter = () => {
        signal.removeEventListener("abort", abort);
        this.active++;
        resolve();
      };
      if (this.active < this.limit) enter();
      else {
        this.waiting.push(enter);
        signal.addEventListener("abort", abort, { once: true });
      }
    });
    try {
      return await abortable(operation, signal);
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

const pools = new Map<string, ImageRequestPool>();

export function imageRequestPool(
  project: string,
  location: string,
  model: string,
): ImageRequestPool {
  const key = JSON.stringify([project, location, model]);
  let pool = pools.get(key);
  if (!pool) {
    pool = new ImageRequestPool();
    pools.set(key, pool);
  }
  return pool;
}
