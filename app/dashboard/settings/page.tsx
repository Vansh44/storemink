import Link from "next/link";
import { getActingStoreId, getViewerAccess } from "@/app/dashboard/lib/access";
import { SECTIONS } from "@/app/dashboard/lib/permissions";
import { navIcons } from "@/app/dashboard/nav-icons";
import { getStoreAnalyticsTimeZone } from "@/lib/analytics/settings";
import { BusinessTimeZoneForm } from "./business-time-zone-form";

export const metadata = { title: "Settings" };

/**
 * The Settings landing page.
 *
 * This used to `redirect("/dashboard/settings/account")`, which is why Settings
 * had no home of its own and every configuration area had to be its own
 * top-level sidebar entry — ten of them, which was most of what made the
 * sidebar unreadable. Now Settings is one entry that opens here.
 *
 * Areas are derived from the SAME permission catalog the sidebar reads and
 * filtered with the same `can()` call, so a card can never appear for something
 * the viewer cannot open. Adding a settings area is one entry in
 * lib/permissions.ts — it appears here and in the sidebar with no further work.
 */

// One line of plain English per area. Without these the page is a wall of
// two-word links and a merchant has to open each to find out what it does.
const BLURB: Record<string, string> = {
  account: "Your name, email and password.",
  admins: "Invite colleagues and control what each of them can reach.",
  roles: "Define what a role can see and change.",
  ai: "Your plan, invoices and Mink credits.",
  channels:
    "Connect your own payment gateway so money settles directly to you.",
  billing: "Tax rates, tax classes and how your invoices look.",
  notifications: "Choose what your team and your customers get told about.",
  activity: "Everything that happened, and every email sent about it.",
  policies: "Terms, refund, shipping and privacy pages for your store.",
  domain: "Use your own domain instead of the storemink.com address.",
  shipping: "Choose what delivery costs and dates customers see at checkout.",
  analytics:
    "Connect consent-aware Google Analytics 4 and Meta Pixel tracking.",
};

export default async function SettingsPage() {
  const access = await getViewerAccess();
  // The dashboard layout already handles the no-access and outage cases before
  // a page renders, so reaching here without access means there is nothing to
  // show rather than something to explain.
  if (!access) return null;

  const settings = SECTIONS.find((s) => s.key === "settings");

  // Pages that share the Settings permission itself (Account, Policies,
  // Domain). They are children, not sections, so they are gated by `settings`
  // rather than a key of their own.
  const own = access.can("settings", "view")
    ? (settings?.children ?? []).map((c) => ({
        key: c.href.split("/").pop() ?? c.href,
        label: c.label,
        href: c.href,
        icon: c.icon ?? ("settings" as const),
      }))
    : [];

  // Sections nested under Settings, each still carrying its own permission.
  const areas = SECTIONS.filter(
    (s) => s.parent === "settings" && access.can(s.key, "view"),
  ).map((s) => ({ key: s.key, label: s.label, href: s.href, icon: s.icon }));

  const cards = [...own, ...areas];
  const canManageStoreSettings = access.can("settings", "manage");
  const timeZone = canManageStoreSettings
    ? await getStoreAnalyticsTimeZone(await getActingStoreId())
    : null;

  if (!cards.length) {
    return (
      <div className="p-6">
        <h1 className="text-[22px] font-medium">Settings</h1>
        <p className="mt-2 text-[14px] text-[#6a6a6a]">
          You don&apos;t have access to any settings for this store. Ask an
          owner to grant you a section.
        </p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-[900px]">
      <h1 className="text-[22px] font-medium">Settings</h1>
      <p className="mt-1 text-[14px] text-[#6a6a6a]">
        Everything that configures this store.
      </p>

      {timeZone ? <BusinessTimeZoneForm timeZone={timeZone} /> : null}

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        {cards.map((c) => {
          const Icon = navIcons[c.icon];
          return (
            <Link
              key={c.href}
              href={c.href}
              className="flex items-start gap-3 rounded-[10px] border border-[#e5e5e5] bg-white p-4 transition-colors hover:border-[#c9c9c9]"
            >
              <span
                className="mt-0.5 shrink-0 text-[#4a4a4a]"
                aria-hidden="true"
              >
                <Icon className="h-[18px] w-[18px]" strokeWidth={2} />
              </span>
              <span className="min-w-0">
                <span className="block text-[14px] font-medium text-[#1a1a1a]">
                  {c.label}
                </span>
                {BLURB[c.key] ? (
                  <span className="mt-0.5 block text-[13px] leading-[1.5] text-[#6a6a6a]">
                    {BLURB[c.key]}
                  </span>
                ) : null}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
