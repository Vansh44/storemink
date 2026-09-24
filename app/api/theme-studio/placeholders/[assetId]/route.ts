import {
  getThemeStudioPlaceholderBytes,
  isUuid,
} from "@/lib/theme-studio/repository";

// Serve one Theme Studio PLACEHOLDER image, publicly.
//
// ★ Public because it has to be: a preview store is rendered by the real
// storefront, whose images go through next/image, and Next's optimizer fetches
// a local image without the viewer's cookies — a gated route would render
// every picture in a preview broken.
//
// ★ Safe to be public because of what a placeholder is: a solid-colour WebP the
// server drew itself (lib/theme-studio/placeholders.ts), holding no operator
// text, no reference pixels and no model output. The id is a random UUID
// nothing lists, and the lookup is restricted to purpose = 'placeholder', so a
// reference's id — someone else's website — finds nothing here.
//
// A placeholder never changes (assets are immutable), so it caches forever.
export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ assetId: string }> },
) {
  const { assetId } = await params;
  if (!isUuid(assetId)) return new Response("Not found", { status: 404 });
  const asset = await getThemeStudioPlaceholderBytes(assetId);
  if (!asset) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(asset.bytes), {
    status: 200,
    headers: {
      "Content-Type": asset.mediaType,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": "inline",
      "X-Robots-Tag": "noindex",
    },
  });
}
