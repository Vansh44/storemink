import {
  getThemeStudioSlotImageBytes,
  isUuid,
} from "@/lib/theme-studio/repository";

// Serve one operator-uploaded Theme Studio SLOT IMAGE, publicly.
//
// ★ Public for the placeholder route's reason: a preview store renders through
// next/image, whose optimizer fetches local images without cookies.
//
// ★ Safe to be public because of what a slot image is: an image an operator
// uploaded FOR a storefront slot, declared operator-owned or licensed, and
// re-encoded by the server (lib/theme-studio/slot-images.ts). The lookup is
// restricted to purpose = 'image', so a reference's id — someone else's
// website — finds nothing here, and the id is a random UUID nothing lists.
//
// Assets are immutable, so a response caches forever.
export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ assetId: string }> },
) {
  const { assetId } = await params;
  if (!isUuid(assetId)) return new Response("Not found", { status: 404 });
  const asset = await getThemeStudioSlotImageBytes(assetId);
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
