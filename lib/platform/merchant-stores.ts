import { sql } from "drizzle-orm";
import { stores } from "@/drizzle/schema";

// ---------------------------------------------------------------------------
// Which `stores` rows are MERCHANTS, for the operator console.
//
// Two kinds of store row are platform plumbing, not sellers:
//   • Theme Studio preview stores (`settings.studioPreview`), created and
//     removed while an operator reviews a theme;
//   • theme demo stores (`settings.demo`), the showcases themes.storemink.com
//     opens as a live preview. They are seeded by the platform, have no owner
//     and are managed from Themes, not Stores.
//
// Listing either as a store reported signups nobody made ("8 stores on the
// platform" when four were demos) and put a showcase one click from the
// suspend and plan controls. ONE predicate, shared by the list and the counts,
// so the two cannot disagree about how many stores there are.
//
// ⚠ `settings -> 'demo' IS DISTINCT FROM 'true'` rather than a ->> cast:
// a row whose demo key holds anything but JSON true is a real store, and a
// boolean cast would throw on a stray string instead of keeping it listed.
// ---------------------------------------------------------------------------

const PREDICATE =
  "not (settings ? 'studioPreview') and (settings -> 'demo') is distinct from 'true'::jsonb";

/** For Drizzle `where` clauses over `stores` (column-qualified for joins). */
export const merchantStoreCondition = sql`not (${stores.settings} ? 'studioPreview') and (${stores.settings} -> 'demo') is distinct from 'true'::jsonb`;

/** The same rule as a CTE, for raw statements that count merchants. */
export const MERCHANT_STORES_CTE = sql.raw(
  `with merchant_stores as (select * from stores where ${PREDICATE})`,
);
