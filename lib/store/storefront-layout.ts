import { getCurrentStoreOrNull } from "./resolve";
import { resolveInstalledThemeDefinition } from "@/lib/themes/runtime-registry";
import { readThemeSelection } from "@/lib/themes/meta";
import { getStoreChrome } from "@/lib/chrome/queries";
import {
  resolveStorefrontAppearance,
  type ResolvedStorefrontAppearance,
} from "@/lib/chrome/types";

// Resolve the current host store's pinned theme defaults plus its published
// builder overrides. Server components use this when a variant changes markup
// (grocery cards/PDP/cart); CSS-only variants use the same resolved values via
// the `sm-*` root classes emitted by the storefront layout.
//
// getCurrentStoreOrNull is unstable_cache-backed, so this dedupes with the
// layout's own store resolution within a request. An absent theme resolves to
// the classic appearance, so a store with no real theme is untouched.
export async function getStorefrontLayout(): Promise<ResolvedStorefrontAppearance> {
  const store = await getCurrentStoreOrNull();
  const selection = readThemeSelection(store?.settings);
  const themeLayout = (await resolveInstalledThemeDefinition(selection))?.preset
    .design.layout;
  const appearance = store
    ? (await getStoreChrome(store.id)).appearance
    : undefined;
  return resolveStorefrontAppearance(themeLayout, appearance);
}
