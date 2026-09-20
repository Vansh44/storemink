import { NextResponse } from "next/server";
import { deleteMediaAsset } from "@/app/actions/media-actions";
import { getMinkActorContext } from "@/lib/mink/actor-context";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import { readMinkBoundedJson } from "@/lib/mink/bounded-json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Discard an image the composer uploaded but never sent.
 *
 * ★★ IT EXISTS ONLY BECAUSE A SERVER ACTION CANNOT BE `keepalive`. An image is
 * uploaded the moment it is selected, so the merchant's Media Library gains a
 * row before they have committed to anything, and the cleanup ran as a
 * fire-and-forget `deleteMediaAsset` from React's unmount effect — which the
 * browser cancels when the page is actually unloading. Pick a photo, close the
 * tab, and the row and its GCS object survive with nothing marking them as chat
 * leftovers. `navigator.sendBeacon` survives unload; the action protocol has no
 * way to ask for that.
 *
 * ★ IT GRANTS NOTHING NEW. `deleteMediaAsset` is a `"use server"` export, so it
 * is ALREADY a publicly reachable endpoint, already gated on `media` manage and
 * already scoped to the acting store. This adds a transport, not authority —
 * which is why it delegates rather than reimplementing the delete.
 *
 * ★ SAME-ORIGIN AND ACTOR-RESOLVED like every sibling Mink route, so a
 * cross-site page cannot spend a merchant's session deleting their media.
 */
export async function POST(request: Request) {
  const foreign = rejectForeignMinkOrigin(request);
  if (foreign) return foreign;
  try {
    await getMinkActorContext(crypto.randomUUID());
    const body = await readMinkBoundedJson(
      request,
      1024,
      AbortSignal.timeout(5_000),
    );
    const id = (body as { id?: unknown }).id;
    if (typeof id !== "string" || !UUID.test(id))
      return NextResponse.json({ error: "Invalid item." }, { status: 400 });
    const result = await deleteMediaAsset(id);
    // ⚠ A failed discard is reported, never retried here: the caller is a page
    //   that is already unloading and has nowhere to show an error. The row
    //   stays visible in the Media Library, which is recoverable by hand.
    return NextResponse.json(
      { discarded: result.success === true },
      { status: 200, headers: { "Cache-Control": "no-store, private" } },
    );
  } catch {
    return NextResponse.json({ error: "Unavailable." }, { status: 503 });
  }
}
