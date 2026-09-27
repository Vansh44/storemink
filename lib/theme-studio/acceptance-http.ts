import "server-only";

import http from "node:http";
import https from "node:https";

// ---------------------------------------------------------------------------
// Fetching a Theme Studio preview page from inside the server.
//
// The route gates need the storefront's REAL rendered HTML and status for a
// preview store. This process is the storefront, so it asks itself over the
// loopback interface with the preview store's Host header, rather than going
// out through DNS and the load balancer:
//
//   • it does not depend on `*.localhost` resolving (Node's resolver does not
//     treat subdomains of localhost specially) or on public DNS;
//   • in production it never leaves the container, so no egress rule, TLS
//     certificate or wildcard DNS entry is involved;
//   • the Host header is what the store resolver reads, so the request lands
//     on exactly the store an operator's browser would.
//
// ★ node:http, not fetch: the Fetch standard forbids setting Host, and a
// runtime that honours that rule would silently send the loopback address
// instead — resolving no store and "passing" nothing.
//
// Override the target with THEME_STUDIO_ACCEPTANCE_ORIGIN when the server is
// not reachable at 127.0.0.1:$PORT (a custom HOSTNAME binding, for example).
// ---------------------------------------------------------------------------

export interface InternalPage {
  status: number | null;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  error: string | null;
}

/** Bodies larger than this are truncated; the checks read markup, not media. */
const MAX_BODY_BYTES = 3 * 1024 * 1024;

export function acceptanceOrigin(): URL {
  const configured = process.env.THEME_STUDIO_ACCEPTANCE_ORIGIN?.trim();
  if (configured) return new URL(configured);
  return new URL(`http://127.0.0.1:${process.env.PORT || "3000"}`);
}

/**
 * Fetch, retrying ONCE when no response arrived at all (a reset or dropped
 * connection). A server busy compiling or recycling a socket is a transport
 * blip, not a broken page; an HTTP status — including a 404 or 500 — is an
 * answer and is never retried.
 */
export async function fetchInternalPageWithRetry(input: {
  host: string;
  path: string;
  cookies: Record<string, string>;
  timeoutMs: number;
}): Promise<InternalPage> {
  const first = await fetchInternalPage(input);
  if (first.status !== null || /No response within/.test(first.error ?? "")) {
    return first;
  }
  await new Promise((resolve) => setTimeout(resolve, 750));
  return fetchInternalPage(input);
}

export function fetchInternalPage(input: {
  host: string;
  path: string;
  cookies: Record<string, string>;
  timeoutMs: number;
}): Promise<InternalPage> {
  const origin = acceptanceOrigin();
  const client = origin.protocol === "https:" ? https : http;
  const cookie = Object.entries(input.cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (page: InternalPage) => {
      if (settled) return;
      settled = true;
      resolve(page);
    };
    const request = client.request(
      {
        protocol: origin.protocol,
        hostname: origin.hostname,
        port: origin.port || (origin.protocol === "https:" ? 443 : 80),
        path: input.path,
        method: "GET",
        // A fresh connection per request: a pooled keep-alive socket the
        // server has just closed fails as "socket hang up" with no response.
        agent: false,
        headers: {
          host: input.host,
          ...(cookie ? { cookie } : {}),
          accept: "text/html",
          "user-agent": "StoreMink-ThemeStudio-Acceptance/1",
          "x-forwarded-host": input.host,
        },
        timeout: input.timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          if (size < MAX_BODY_BYTES) chunks.push(chunk);
          size += chunk.length;
        });
        response.on("end", () =>
          finish({
            status: response.statusCode ?? null,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            error: null,
          }),
        );
        response.on("error", (error) =>
          finish({ status: null, headers: {}, body: "", error: error.message }),
        );
      },
    );
    request.on("timeout", () => {
      request.destroy();
      finish({
        status: null,
        headers: {},
        body: "",
        error: `No response within ${Math.round(input.timeoutMs / 1000)}s.`,
      });
    });
    request.on("error", (error) =>
      finish({ status: null, headers: {}, body: "", error: error.message }),
    );
    request.end();
  });
}
