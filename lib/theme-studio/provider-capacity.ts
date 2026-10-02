import { randomUUID, createHash } from "node:crypto";
import { abortable } from "./abortable";
import { sleepUnlessAborted } from "./rate-limit-backoff";

export interface CapacityLease {
  id: string;
  epoch: number;
}
export interface CapacityStore {
  claim(key: string, id: string): Promise<CapacityLease | null>;
  renew(key: string, lease: CapacityLease): Promise<boolean>;
  release(key: string, lease: CapacityLease, succeeded: boolean): Promise<void>;
  pause(key: string, delayMs: number): Promise<void>;
}
export interface ProviderPermit {
  signal: AbortSignal;
  succeeded(): void;
  rateLimited(delayMs: number): Promise<void>;
}
export interface ProviderCapacity {
  run<T>(
    operation: (permit: ProviderPermit) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T>;
}

export class ProviderCapacityLost extends Error {
  constructor() {
    super("Provider capacity lease lost");
  }
}

export function providerCapacityKey(
  project: string,
  location: string,
  model: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([project, location, model]))
    .digest("hex");
}

/** Admission is shared by DB leases. No transaction spans an SDK request or
 * a cooldown. A lost heartbeat aborts transport; DB failures fail closed. */
export function coordinatedProviderCapacity(
  store: CapacityStore,
  key: string,
  options: {
    pollMs?: number;
    heartbeatMs?: number;
    sleep?: typeof sleepUnlessAborted;
    onCleanupError?: (error: unknown) => void;
  } = {},
): ProviderCapacity {
  const sleep = options.sleep ?? sleepUnlessAborted;
  return {
    async run(operation, outer) {
      const id = randomUUID();
      let lease: CapacityLease | null = null;
      while (!lease) {
        outer.throwIfAborted();
        // Observe a late DB claim and release it if the caller cancelled while
        // the transaction was committing. Never orphan a paid-call permit.
        const claim = store.claim(key, id);
        try {
          lease = await abortable(() => claim, outer);
        } catch (error) {
          void claim
            .then((late) => late && store.release(key, late, false))
            .catch(() => {});
          throw error;
        }
        if (!lease && !(await sleep(options.pollMs ?? 1000, outer)))
          outer.throwIfAborted();
      }
      const held = lease;
      const lost = new AbortController();
      const signal = AbortSignal.any([outer, lost.signal]);
      let succeeded = false;
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let renewing: Promise<void> | undefined;
      const heartbeat = () => {
        timer = setTimeout(() => {
          renewing = store
            .renew(key, held)
            .then((ok) => {
              if (!ok) lost.abort(new ProviderCapacityLost());
            })
            .catch(() => lost.abort(new ProviderCapacityLost()))
            .finally(() => {
              if (!stopped && !signal.aborted) heartbeat();
            });
        }, options.heartbeatMs ?? 30_000);
        timer.unref?.();
      };
      heartbeat();
      try {
        return await abortable(
          () =>
            operation({
              signal,
              succeeded: () => {
                succeeded = true;
              },
              rateLimited: (delayMs) => store.pause(key, delayMs),
            }),
          signal,
        );
      } finally {
        stopped = true;
        clearTimeout(timer);
        // A cleanup outage must not discard an already paid provider response.
        // The lease expires conservatively and new admission still fails closed.
        await abortable(async () => {
          await renewing;
          await store.release(key, held, succeeded && !signal.aborted);
        }, AbortSignal.timeout(6000)).catch((error) =>
          options.onCleanupError?.(error),
        );
      }
    },
  };
}

/** Standalone evals have no DB. Production worker factories explicitly supply
 * the shared coordinator; test transports remain database independent. */
export const uncoordinatedProviderCapacity: ProviderCapacity = {
  run: (operation, signal) =>
    operation({ signal, succeeded() {}, async rateLimited() {} }),
};
