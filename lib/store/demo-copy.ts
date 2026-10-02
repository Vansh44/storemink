/** Shown wherever a theme demo store refuses something. Client-safe: the
 *  server guard (lib/store/demo-guard.ts) is server-only, and the storefront
 *  forms need the same sentence without importing the database. */
export const DEMO_STORE_MESSAGE =
  "This is a theme preview, so orders, accounts and forms are turned off.";
