import { abortable } from "./abortable";

/** Shared across the two worker lanes in one HTTP execution. Without this,
 * each theme's three image lanes would double the same Vertex quota load.
 * Run leases fence duplicate work across instances; this is a process-local
 * concurrency bound, not a claim about the provider's available quota. */
export class ImageRequestPool {
  private active = 0;
  private waiting: (() => void)[] = [];
  private cooldowns = new Set<Promise<unknown>>();
  private capacityEpoch = 0;
  private recoveringLimit: number;
  private successes = 0;

  constructor(private readonly limit = 3) {
    this.recoveringLimit = limit;
  }

  /** Pause queued requests together after a provider 429. The wait belongs to
   * its caller's abort signal and consumes no active request permit. */
  coolDown(wait: Promise<unknown>): void {
    this.capacityEpoch++;
    this.recoveringLimit = 1;
    this.successes = 0;
    this.cooldowns.add(wait);
    const resume = () => {
      this.cooldowns.delete(wait);
      this.pump();
    };
    void wait.then(resume, resume);
  }

  /** Three successful probes restore one permit. Responses already in flight
   * when the rate limit happened cannot prematurely declare recovery. */
  recovered(epoch: number): void {
    if (epoch !== this.capacityEpoch || this.recoveringLimit >= this.limit)
      return;
    if (++this.successes >= 3) {
      this.successes = 0;
      this.recoveringLimit++;
    }
  }

  private pump(): void {
    while (
      !this.cooldowns.size &&
      this.active < this.recoveringLimit &&
      this.waiting.length
    ) {
      this.waiting.shift()!();
    }
  }

  async run<T>(
    operation: (epoch: number) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
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
      this.waiting.push(enter);
      signal.addEventListener("abort", abort, { once: true });
      this.pump();
    });
    try {
      const epoch = this.capacityEpoch;
      return await abortable(() => operation(epoch), signal);
    } finally {
      this.active--;
      this.pump();
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
