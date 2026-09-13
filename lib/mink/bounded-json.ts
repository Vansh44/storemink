import { MinkRequestError } from "./errors";

export async function readMinkBoundedBytes(
  request: Request,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (!request.body)
    throw new MinkRequestError("invalid_request", "Empty request.", 400);
  const reader = request.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    signal?.throwIfAborted();
    for (;;) {
      const part = await reader.read();
      signal?.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new MinkRequestError(
          "request_too_large",
          "Request is too large.",
          413,
        );
      }
      chunks.push(part.value);
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export async function readMinkBoundedJson(
  request: Request,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!request.body)
    throw new MinkRequestError("invalid_request", "Empty request.", 400);
  const reader = request.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    signal?.throwIfAborted();
    for (;;) {
      const part = await reader.read();
      signal?.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new MinkRequestError(
          "request_too_large",
          "Request is too large.",
          413,
        );
      }
      chunks.push(part.value);
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new MinkRequestError("invalid_request", "Invalid JSON request.", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new MinkRequestError(
      "invalid_request",
      "Request body must be a JSON object.",
      400,
    );
  return body as Record<string, unknown>;
}
