import { and, asc, eq, inArray } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { coupons, storeLocations } from "@/drizzle/schema";
import { requireSectionAccess, getActingStoreId } from "../lib/access";
import { listOffers, getOfferCapacity } from "@/app/actions/offer-actions";
import { OffersView } from "./offers-view";
import { loadOffersAutoApply } from "./data";

/**
 * Offers (docs/offers-plan.md).
 *
 * ★ THE PERMISSION SECTION IS `promotions`, though everything the merchant sees
 * says "Offers". Roles store the key, so renaming it would revoke the grant on
 * every saved role — the `navigation` precedent. That key previously pointed at
 * `/dashboard/promotions`, which had no route at all: every merchant granted
 * the section saw a sidebar link that 404'd.
 */
export default async function OffersPage() {
  // ★ Returns the viewer's access rather than a boolean — it REDIRECTS when
  // the section is denied, so reaching the next line already proves `view`.
  // `can(...,"manage")` is then the separate question of whether the controls
  // render, and the actions re-check it regardless: a hidden button is not a
  // permission.
  const access = await requireSectionAccess("promotions", "view");
  const canManage = access.can("promotions", "manage");
  const storeId = await getActingStoreId();

  const [{ offers, error }, capacity, autoApplyOn, locations] =
    await Promise.all([
      listOffers(),
      getOfferCapacity(),
      // ★ ONLY THE ONE SETTING THIS PAGE NEEDS. The whole Offers group used to
      // be loaded here to render a settings card below the table; that card is
      // its own page now (`offers/settings`), so all that is left is the
      // switch the "Not applying" badge depends on.
      loadOffersAutoApply(storeId),
      withService((db) =>
        db
          .select({ id: storeLocations.id, name: storeLocations.name })
          .from(storeLocations)
          .where(eq(storeLocations.storeId, storeId))
          .orderBy(asc(storeLocations.name)),
      ).catch(() => []),
    ]);

  // ★★ WHICH OFFERS CAN ACTUALLY BE EMAILED.
  //
  // Coupon email campaigns are keyed on a `coupons` ROW throughout
  // (`email_campaigns`, `lib/mink/campaign-*`); offers did not replace that, so
  // the send page reads `coupons` by id and 404s otherwise. A migrated coupon
  // shares its offer's primary key (migration 0059 inserts `SELECT c.id`) and
  // one Mink wrote has a coupons row of its own, but an offer created HERE has
  // none.
  //
  // So the action is offered for exactly the set that can be sent, rather than
  // rendered for every code offer and 404ing on half of them — §23's rule that
  // a control which always fails is worse than no control. One bounded
  // existence check over the ids already listed; a failed read simply offers
  // nothing.
  const emailableOfferIds = await withService((db) =>
    db
      .select({ id: coupons.id })
      .from(coupons)
      .where(
        and(
          eq(coupons.storeId, storeId),
          inArray(
            coupons.id,
            offers.map((o) => o.id),
          ),
        ),
      ),
  )
    .then((rows) => rows.map((r) => r.id))
    .catch(() => [] as string[]);

  return (
    <OffersView
      autoApplyOn={autoApplyOn}
      emailableOfferIds={emailableOfferIds}
      offers={offers}
      loadError={error}
      limit={capacity.limit}
      activeCount={capacity.active}
      locationCount={locations.length}
      canManage={canManage}
    />
  );
}
