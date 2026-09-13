// The Cloud SQL data layer (GCP migration Phase 5). Replaces the Supabase
// client factories with Drizzle over a pg Pool, enforcing the 2A tenancy model:
// every query runs inside a transaction that SETs LOCAL the DB role (and, for
// user requests, the app.current_user_id GUC the RLS shim reads). Because
// SET LOCAL is transaction-scoped, identity can NEVER leak across pooled
// connections.
//
// Three scoped runners map 1:1 onto the old Supabase clients:
//   withService  → app_service (BYPASSRLS)  ~ createAdminClient()
//   withUser     → app_user + GUC (RLS)     ~ createClient() (cookie, signed-in)
//   withAnon     → app_user, no GUC (RLS)   ~ createPublicClient() (storefront)
//
// Connection config comes from env: locally DB_HOST=127.0.0.1:DB_PORT via the
// Cloud SQL Auth Proxy; on Cloud Run DB_HOST=/cloudsql/<INSTANCE_CONNECTION_NAME>
// (unix socket). Auth is the `app` login role (member of app_user + app_service).

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import * as schema from "../../drizzle/schema";
import * as relations from "../../drizzle/relations";
import { postgresStringTimestampTypes } from "./pg-types";

const fullSchema = { ...schema, ...relations };
export type Db = NodePgDatabase<typeof fullSchema>;

let _pool: Pool | undefined;

function getPool(): Pool {
  if (!_pool) {
    const host = process.env.DB_HOST;
    const isUnixSocket = host?.startsWith("/");
    _pool = new Pool({
      host,
      // Unix socket (Cloud Run) ignores port; TCP (local proxy) needs it.
      port: isUnixSocket ? undefined : Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      max: Number(process.env.DB_POOL_MAX ?? 10),
      // Keep the full PostgreSQL timestamp text. Converting through JS Date
      // would discard microseconds and break exact optimistic-lock predicates.
      types: postgresStringTimestampTypes,
      // The Auth Proxy / unix socket already provide a secure channel.
      ssl: false,
      // Keep sockets warm so an idle connection isn't silently dropped by the
      // Cloud SQL Auth Proxy — a dropped idle socket surfaces as ECONNRESET on
      // its next use.
      keepAlive: true,
    });
  }
  return _pool;
}

// The DB roles are fixed internal constants (never user input), so interpolating
// them into SET LOCAL ROLE — which cannot take a bind parameter — is safe.
type AppRole = "app_service" | "app_user";

// Transient connection errors worth a quick retry: on a flaky link (or when the
// Cloud SQL Auth Proxy recycles an idle socket) ACQUIRING a connection can fail
// with these before any statement has run.
const TRANSIENT_CONN_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  // PostgreSQL connection-class failures and server shutdown/recovery. These
  // can surface on the first query of an idle pooled socket rather than from
  // pool.connect(), so acquisition-only retry is not sufficient.
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
  "57P01",
  "57P02",
  "57P03",
]);
function isTransientConnError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && TRANSIENT_CONN_CODES.has(code);
}

// Acquire a pooled connection, retrying briefly on transient network errors.
// Retrying the ACQUIRE is safe (no statement has run yet); we never retry a
// statement or a whole transaction — that could double-apply a write.
async function acquireClient(retries = 2): Promise<PoolClient> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await getPool().connect();
    } catch (err) {
      if (attempt >= retries || !isTransientConnError(err)) throw err;
      await new Promise((r) => setTimeout(r, 120 * (attempt + 1)));
    }
  }
}

async function runScoped<T>(
  role: AppRole,
  identity: { uid?: string; email?: string } | null,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const client = await acquireClient();
    let callbackStarted = false;
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${role}`);
      if (identity?.uid) {
        // set_config(..., is_local => true) == SET LOCAL; value is parameterised.
        await client.query(
          "SELECT set_config('app.current_user_id', $1, true)",
          [identity.uid],
        );
      }
      if (identity?.email) {
        await client.query(
          "SELECT set_config('app.current_user_email', $1, true)",
          [identity.email],
        );
      }
      const db = drizzle(client, { schema: fullSchema });
      callbackStarted = true;
      const result = await fn(db);
      await client.query("COMMIT");
      client.release();
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      const retryableBeforeWork =
        !callbackStarted && attempt < 2 && isTransientConnError(err);
      // Passing true destroys a broken pooled socket instead of returning it
      // for the next request. Never retry after fn starts: it may have written,
      // and replaying an uncertain transaction could duplicate business work.
      if (isTransientConnError(err)) client.release(true);
      else client.release();
      if (!retryableBeforeWork) throw err;
      await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));
    }
  }
}

/**
 * Service-role scope: BYPASSRLS. Tenant scoping is the caller's responsibility
 * (explicit `.eq(store_id, …)`), exactly as the Supabase service client worked.
 */
export function withService<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  return runScoped("app_service", null, fn);
}

/**
 * A verified caller opening a user-scoped transaction. BOTH fields are
 * required (email may be null) — see withUser for why omitting the email is a
 * silent authorisation bug rather than a missing nicety.
 */
export interface UserIdentity {
  /** Verified uid → `app.current_user_id` → `auth.uid()`. */
  uid: string;
  /**
   * Verified email → `app.current_user_email` → `auth.email()`. Null only for
   * an account that genuinely has no email. Get it from `getServerUser()` or a
   * gate that returns an identity (`getManagerIdentity`) — never invent one.
   */
  email: string | null;
}

/**
 * Signed-in user scope: RLS enforced, with app.current_user_id AND
 * app.current_user_email set so `auth.uid()`/`auth.email()` both resolve
 * inside every policy.
 *
 * `email` is REQUIRED (nullable) on purpose. The store-admin RLS helper is
 *   is_store_admin(store) := is_platform_admin() OR <admins row for store>
 * and `is_platform_admin()` matches `platform_admins` BY EMAIL via
 * `auth.email()`. With no email GUC, `auth.email()` is NULL, that branch is
 * dead, and a StoreMink platform operator — who has god access at the app
 * layer but no `admins` row for the store they're managing — matches no
 * policy. Postgres then returns zero rows and reports NO error: reads look
 * empty and writes look successful. That is precisely how `/dashboard/orders`
 * came to show "No orders yet" for a store whose analytics page showed nine.
 * Making the field required means the compiler, not a future incident,
 * catches the omission.
 */
export function withUser<T>(
  identity: UserIdentity,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  return runScoped(
    "app_user",
    { uid: identity.uid, email: identity.email ?? undefined },
    fn,
  );
}

/**
 * Anonymous scope: RLS enforced with NO identity set, so only the public
 * (published/active) policy branches match — the storefront read path.
 */
export function withAnon<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  return runScoped("app_user", null, fn);
}

/** Close the pool (tests / graceful shutdown). */
export async function closePool(): Promise<void> {
  await _pool?.end();
  _pool = undefined;
}
