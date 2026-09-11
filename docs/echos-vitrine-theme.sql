-- Switch ONE production store (`echos`) from the Studio preset to Vitrine.
--
-- ★★ THIS IS NOT A MIGRATION AND MUST NOT BE ENROLLED IN THE LEDGER. It is
-- environment-specific DATA about one merchant, it changes what a live
-- storefront looks like, and it wants a human reading the pre-flight before it
-- runs. Migrations are schema and published Help content; this is surgery on
-- one row. Same standing as docs/comped-plans-backfill.sql.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- ★★ WHY THIS IS NOT `applyTheme`, WHICH IS THE OBVIOUS TOOL AND THE WRONG ONE
--
-- `applyTheme(storeId, "vitrine", { publish: true })` is how a theme is
-- installed at SIGNUP, and it does far more than re-skin a store. It upserts,
-- keyed on (store_id, slug):
--
--   • store_pages   — the homepage sentinel ("") AND ~17 content pages
--   • store_menus   — header and footer navigation
--   • categories    — the preset's sample categories
--   • products      — the preset's sample products, and their variants
--
-- On a brand-new store those writes ARE the theme. On `echos`, which is a live
-- shop with its own homepage, its own pages and a real catalogue, they would
-- overwrite the merchant's content with a shoe shop's and seed sample products
-- into their storefront. `reset: true` is refused on non-demo stores, but the
-- ordinary upserts are not — they are exactly what "idempotent upsert keyed on
-- (store_id, slug)" means when the slug already exists and holds real content.
--
-- So this script writes ONLY `stores.settings`, which is the half of
-- `applyTheme` that actually decides how the storefront renders.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT DECIDES THE SKIN, AND THEREFORE WHAT THIS TOUCHES
--
-- app/(storefront)/layout.tsx, per request:
--   1. readThemeSelection(store.settings)  → `settings.theme.presetId` first,
--      falling back to the legacy `settings.template`. Both are set below so
--      old and new readers agree.
--   2. getThemeDefinition(id, version).preset.design → palette, fonts, shape.
--      ⚠ A version it cannot find falls back to that preset's current release,
--      so the pin is forgiving — but it is written truthfully anyway.
--   3. designToCssVars(design, brand.primaryColor) → the inline CSS custom
--      properties on .storefront-root. The accent comes from
--      `settings.brand.primaryColor`, which is why that is set too: Vitrine is
--      monochrome with one markdown red, and leaving Studio's blue #2542c7 as
--      the accent would put a blue button in a black-and-white shop.
--   4. resolveStorefrontAppearance(design.layout, chrome.appearance) →
--      ⚠ THE MERCHANT'S PUBLISHED BUILDER OVERRIDES WIN over the theme. See
--      STEP 1: any axis in store_chrome.published->'appearance' that is not
--      "theme" keeps its value and this script will NOT change it. That is
--      correct — it is a choice the merchant made — but it means the switch can
--      look partial. Clearing them is a separate, deliberate decision.
--
-- No deploy is needed: Vitrine's fonts (Jost, Instrument Serif) are already
-- registered in app/layout.tsx, and the definition ships in the running image.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT THE MERCHANT WILL SEE CHANGE
--
--   palette   Studio's warm editorial blues → monochrome, one markdown red
--   fonts     Inter + Fraunces              → Jost + Instrument Serif
--   shape     rounded                       → every corner 0px, hairline rules
--   header    centered                      → minimal
--   card      framed                        → classic, plus cardHoverImage
--   footer    minimal                       → rich
--   PDP/cart  editorial / compact           → unchanged
--
-- ⚠⚠ PRODUCT PHOTOGRAPHY IS THE ONE THING TO LOOK AT AFTERWARDS. Vitrine
-- renders product cards at 1:1 and its own assets are square (1000×1000);
-- Studio's are 4:3. Existing 4:3 photographs are not re-cropped by this
-- script — the card will CENTRE-CROP them, which on a tall product cuts
-- through it. Check a category grid before calling this done.
--
-- ⚠ `cardHoverImage` cross-fades a card to the product's SECOND photograph on
-- hover. Products with one image render no hover layer at all, so nothing
-- breaks; products whose second image is a size chart will show a size chart.
--
-- ⚠ TAGLINE AND BLURB ARE DELIBERATELY NOT TOUCHED, which is a considered
-- departure from `applyTheme`. That seeds the preset's marketing copy when a
-- store has none, because it is bootstrapping a brand-new shop. `echos` is a
-- live business; publishing "Shoes, bags and the season's edit" under their
-- name is content, not a theme, and is not this script's decision to make.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- HOW TO RUN IT
--
--   Terminal 1:  npm run db:proxy          # Cloud SQL Auth Proxy → :6543
--   Terminal 2:
--     PGPASSWORD="$(gcloud secrets versions access latest \
--       --secret=CLOUDSQL_PROD_POSTGRES_PW --project=storemink-prod)" \
--     psql -h 127.0.0.1 -p 6543 -U postgres -d storemink \
--          -v ON_ERROR_STOP=1 -f docs/echos-vitrine-theme.sql
--
-- ⚠ DATABASE `storemink`, NOT `storemink_staging`. They are two databases in
-- one instance and the proxy reaches both; the -d is the only thing separating
-- production from dev here.
--
-- ⚠ RUN AS `postgres`. `stores` has RLS and the `app` login does not bypass it,
-- so as `app` the UPDATE silently matches zero rows rather than failing.
--
-- ⚠⚠ THE STOREFRONT WILL NOT CHANGE FOR UP TO 5 MINUTES, AND THAT IS NOT A
-- FAILED RUN. lib/store/resolve.ts caches the host→store lookup with
-- `unstable_cache` (tag STORE_TAG, 300s revalidate), per Cloud Run instance. A
-- raw SQL write cannot call `updateTag`, so every warm instance keeps serving
-- the old settings until its entry expires. Wait it out; a hard refresh, a new
-- private window and a cache-busting query string all make no difference.
-- ═════════════════════════════════════════════════════════════════════════════


-- ═══ STEP 1 — PRE-FLIGHT. Read every column before running STEP 2. ══════════
-- `effective_preset` is what the storefront is rendering right now, resolved
-- the same way readThemeSelection does: the pin first, then the legacy id.
select s.slug,
       s.settings ->> 'template'                as legacy_template,
       s.settings -> 'theme'  ->> 'presetId'    as pinned_preset,
       s.settings -> 'theme'  ->> 'presetVersion' as pinned_version,
       coalesce(s.settings -> 'theme' ->> 'presetId',
                s.settings ->> 'template')      as effective_preset,
       s.settings -> 'brand'  ->> 'primaryColor' as brand_color,
       s.settings -> 'brand'  ->> 'tagline'      as brand_tagline,
       s.settings ->> 'demo'                     as is_demo,
       -- ⚠ Anything here that is not "theme" survives the switch and keeps
       -- overriding Vitrine on that axis. NULL means no published chrome row,
       -- i.e. the theme is followed on every axis.
       c.published -> 'appearance'               as chrome_overrides
  from stores s
  left join store_chrome c on c.store_id = s.id
 where s.slug = 'echos';
-- EXPECT exactly 1 row, effective_preset = 'studio'.
-- If chrome_overrides shows e.g. {"header":"classic",...}, decide about those
-- SEPARATELY — this script will not silently discard a merchant's choice.


-- ═══ STEP 2 — THE SWITCH. One row, one transaction, fully guarded. ══════════
begin;

update stores s
   set settings = s.settings
       -- Shallow jsonb merge, so every other key (business, features, brand's
       -- own name/logo, demo, launched…) is carried through untouched.
       || jsonb_build_object(
            -- `template` stays for old readers and old stores; `theme` is the
            -- pinned installation contract a future catalog release must not
            -- silently rewrite. applyTheme writes both; so does this.
            'template', 'vitrine',
            'theme', jsonb_build_object(
              'presetId',      'vitrine',
              'presetVersion', '0.1.0',
              'engineId',      'storefront-classic',
              'engineVersion', 1,
              -- Same shape as applyTheme's new Date().toISOString().
              'appliedAt', to_char(now() at time zone 'utc',
                                   'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            ),
            -- Only the accent. The merchant's name, logo, tagline and blurb
            -- are preserved by merging INTO the existing brand object.
            'brand', coalesce(s.settings -> 'brand', '{}'::jsonb)
                     || jsonb_build_object('primaryColor', '#2a211f')
          )
 where s.slug = 'echos'
   -- ★ THE GUARD. If the store is not on Studio, it is not the row this was
   -- written for: it may have been switched already, or be on something else
   -- entirely. Match zero rows and stop rather than guess. Do NOT loosen this
   -- to make the statement fire.
   and coalesce(s.settings -> 'theme' ->> 'presetId',
                s.settings ->> 'template') = 'studio'
returning s.slug,
          s.settings -> 'theme' ->> 'presetId'     as now_preset,
          s.settings -> 'theme' ->> 'presetVersion' as now_version,
          s.settings ->> 'template'                 as now_template,
          s.settings -> 'brand' ->> 'primaryColor'  as now_brand_color;
-- EXPECT EXACTLY 1 ROW: vitrine / 0.1.0 / vitrine / #2a211f.
-- 0 rows → STOP, roll back, and re-read STEP 1.
-- ⚠ The previous accent was #2542c7 (Studio's). It is recorded here and in the
-- rollback below; note it now if the merchant had set a custom colour, because
-- after COMMIT this statement is the only place it was written down.


-- ═══ STEP 3 — PROVE IT, IN THE SAME TRANSACTION. ════════════════════════════
-- Every key that must have survived the merge, and the one that must have moved.
select s.slug,
       coalesce(s.settings -> 'theme' ->> 'presetId',
                s.settings ->> 'template') = 'vitrine'  as renders_vitrine,
       s.settings -> 'brand' ->> 'name'      is not null as kept_brand_name,
       s.settings -> 'brand' ->> 'tagline'   as kept_tagline,
       s.settings ? 'business'                          as kept_business,
       s.settings ? 'features'                          as kept_features,
       s.settings ->> 'launched'                        as kept_launched
  from stores s
 where s.slug = 'echos';
-- renders_vitrine must be true; every kept_* must match what STEP 1 showed.

-- Then, and only then:
-- commit;
-- (Typed by hand, deliberately. `rollback;` if anything above surprised you.)


-- ═══ ROLLBACK — back to Studio, if the merchant does not like it. ═══════════
-- Mirror of STEP 2, guarded the other way. Restores Studio's accent; if the
-- merchant had a custom colour, substitute the value STEP 2 returned.
--
-- begin;
-- update stores s
--    set settings = s.settings
--        || jsonb_build_object(
--             'template', 'studio',
--             'theme', jsonb_build_object(
--               'presetId',      'studio',
--               'presetVersion', '0.1.0',
--               'engineId',      'storefront-editorial',
--               'engineVersion', 1,
--               'appliedAt', to_char(now() at time zone 'utc',
--                                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
--             ),
--             'brand', coalesce(s.settings -> 'brand', '{}'::jsonb)
--                      || jsonb_build_object('primaryColor', '#2542c7')
--           )
--  where s.slug = 'echos'
--    and coalesce(s.settings -> 'theme' ->> 'presetId',
--                 s.settings ->> 'template') = 'vitrine'
-- returning s.slug, s.settings -> 'theme' ->> 'presetId' as now_preset;
-- commit;
