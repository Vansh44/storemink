import "server-only";

import { getCurrentStoreOrNull } from "@/lib/store/resolve";
import { isDemoStore } from "@/lib/store/launch";
import { DEMO_STORE_MESSAGE } from "@/lib/store/demo-copy";

// ---------------------------------------------------------------------------
// Theme demo stores are for LOOKING, not for doing.
//
// A demo store (`settings.demo`, which Theme Studio preview stores carry too)
// is a public showcase that themes.storemink.com opens as a live preview. It
// is reset on demand and nobody reads its inbox, so anything a visitor submits
// there is either lost or, worse, treated as real: an enquiry that is never
// answered, a newsletter consent nobody honours, a customer account and
// review attached to a shop that does not exist.
//
// placeOrder already refused (lib/store/launch.ts → isDemoStore). This is the
// same rule for every OTHER public storefront write, in one place so a new
// form does not have to rediscover it. Browsing, search, the cart and the
// checkout PAGE still work — they are what a preview is for — but nothing a
// visitor does is stored.
//
// ★ THE HOST DECIDES, never an argument: the store comes from the request, so
// a caller cannot claim to be on a different store to get past it.
// ---------------------------------------------------------------------------

export { DEMO_STORE_MESSAGE };

/** The refusal message when the current host is a demo store, else null. */
export async function demoStoreRefusal(): Promise<string | null> {
  const store = await getCurrentStoreOrNull();
  return isDemoStore(store) ? DEMO_STORE_MESSAGE : null;
}
