import { getThemeStudioActor } from "@/lib/theme-studio/access";
import {
  getThemeStudioReferenceBytes,
  isUuid,
} from "@/lib/theme-studio/repository";

// Serve one sanitized reference to a superadmin, and to nobody else.
//
// ★ References are private: they are someone else's website, and they are
// never published. So there is no public URL and no CDN copy — every read
// comes through this gate, is `private, no-store`, and is locked down so the
// bytes cannot be interpreted as anything but the WebP they were re-encoded
// into (nosniff, a CSP that forbids everything, and an inline disposition).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ assetId: string }> },
) {
  const actor = await getThemeStudioActor();
  if (!actor) return new Response("Not found", { status: 404 });
  const { assetId } = await params;
  if (!isUuid(assetId)) return new Response("Not found", { status: 404 });
  const asset = await getThemeStudioReferenceBytes(assetId);
  if (!asset) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(asset.bytes), {
    status: 200,
    headers: {
      "Content-Type": asset.mediaType,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": "inline",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Robots-Tag": "noindex",
    },
  });
}
