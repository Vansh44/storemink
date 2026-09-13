import { notFound } from "next/navigation";
import { getActingStoreId, requireSectionAccess } from "../../../lib/access";
import { getStorePlanContext } from "@/lib/plans/entitlements";
import { getOffer } from "@/app/actions/offer-actions";
import { OfferForm } from "../../offer-form";
import { loadOfferScopes, loadOffersAutoApply } from "../../data";

export default async function EditOfferPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireSectionAccess("promotions", "manage");
  const { id } = await params;
  const storeId = await getActingStoreId();

  const [
    { offer, locationIds, groupIds, productIds, variantIds, categoryIds },
    { limits },
    { locations, groups, products, categories },
    autoApplyOn,
  ] = await Promise.all([
    getOffer(id),
    getStorePlanContext(storeId),
    loadOfferScopes(storeId),
    loadOffersAutoApply(storeId),
  ]);

  // `getOffer` is already store-scoped, so a missing row means it belongs to
  // another store or does not exist — both are a 404, never someone else's
  // offer rendered into this dashboard.
  if (!offer) notFound();

  return (
    <OfferForm
      offer={offer}
      locations={locations}
      groups={groups}
      products={products}
      categories={categories}
      initialLocationIds={locationIds}
      initialGroupIds={groupIds}
      initialProductIds={productIds}
      initialVariantIds={variantIds}
      initialCategoryIds={categoryIds}
      allowsGroups={limits.customerGroups}
      autoApplyOn={autoApplyOn}
    />
  );
}
