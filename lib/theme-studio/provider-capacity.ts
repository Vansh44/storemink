import { randomUUID, createHash } from "node:crypto";
import { abortable } from "./abortable";
import { sleepUnlessAborted } from "./rate-limit-backoff";

export interface CapacityLease {
  id: string;
  epoch: number;
}
export const PROVIDER_LEASE_MS = 120_000;
const EXPIRY_MARGIN_MS = 5_000;
export interface CapacityStore {
  claim(
    key: string,
    id: string,
  ): Promise<CapacityLease | { retryAfterMs: number } | null>;
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
 * a cooldown. Confirmed lease loss/expiry aborts transport; admission fails closed. */
export function coordinatedProviderCapacity(
  store: CapacityStore,
  key: string,
  options: {
    pollMs?: number;
    heartbeatMs?: number;
    /** Short clocks for expiry regressions; production uses the DB lease TTL. */
    leaseMs?: number;
    sleep?: typeof sleepUnlessAborted;
    onCleanupError?: (error: unknown) => void;
    onRenewalError?: (error: unknown) => void;
  } = {},
): ProviderCapacity {
  const sleep = options.sleep ?? sleepUnlessAborted;
  return {
    async run(operation, outer) {
      const id = randomUUID();
      let lease: CapacityLease | null = null;
      let claimedAt = 0;
      let waits = 0;
      while (!lease) {
        outer.throwIfAborted();
        // Observe a late DB claim and release it if the caller cancelled while
        // the transaction was committing. Never orphan a paid-call permit.
        const started = Date.now();
        const claim = store.claim(key, id);
        try {
          const admitted = await abortable(() => claim, outer);
          if (admitted && "id" in admitted) {
            lease = admitted;
            claimedAt = started;
          } else {
            const delay =
              admitted?.retryAfterMs ??
              Math.min(
                5000,
                (options.pollMs ?? 1000) * 2 ** Math.min(waits++, 3),
              );
            if (!(await sleep(Math.max(1, Math.min(120_000, delay)), outer)))
              outer.throwIfAborted();
          }
        } catch (error) {
          void claim
            .then((late) => {
              if (late && "id" in late) return store.release(key, late, false);
            })
            .catch(() => {});
          throw error;
        }
      }
      const held = lease;
      const lost = new AbortController();
      const signal = AbortSignal.any([outer, lost.signal]);
      let succeeded = false;
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let expiryTimer: ReturnType<typeof setTimeout> | undefined;
      let renewing: Promise<void> | undefined;
      const leaseMs = options.leaseMs ?? PROVIDER_LEASE_MS;
      const margin = Math.min(EXPIRY_MARGIN_MS, leaseMs / 10);
      const expireAt = (started: number) => {
        clearTimeout(expiryTimer);
        if (started + leaseMs - margin <= Date.now()) {
          lost.abort(new ProviderCapacityLost());
          return;
        }
        expiryTimer = setTimeout(
          () => lost.abort(new ProviderCapacityLost()),
          Math.max(0, started + leaseMs - margin - Date.now()),
        );
        expiryTimer.unref?.();
      };
      const heartbeat = (delay = options.heartbeatMs ?? 30_000) => {
        timer = setTimeout(() => {
          const started = Date.now();
          let next = options.heartbeatMs ?? 30_000;
          renewing = store
            .renew(key, held)
            .then((ok) => {
              if (!ok) lost.abort(new ProviderCapacityLost());
              else if (!stopped && !signal.aborted) expireAt(started);
            })
            .catch((error) => {
              // An exception is not evidence that our still-valid lease was lost.
              // Retry briefly; the independent expiry clock always fences transport.
              next = Math.min(5000, options.heartbeatMs ?? 30_000);
              options.onRenewalError?.(error);
            })
            .finally(() => {
              if (!stopped && !signal.aborted) heartbeat(next);
            });
        }, delay);
        timer.unref?.();
      };
      expireAt(claimedAt);
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
        clearTimeout(expiryTimer);
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
