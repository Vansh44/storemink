"use client";

// "My notifications" — a staff member's own opt-outs.
//
// The counterpart to the console: the console is the STORE's configuration
// (what notifies, who it reaches, what it says), this is one person saying
// "not me" for a given event. It shows only what the store has switched on, so
// nobody is offered a toggle for something that never fires.

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Bell, Lock, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  saveMyNotificationPreferences,
  type MyPreferenceRow,
} from "@/app/actions/notification-actions";
import { useUnsavedChangesWarning } from "@/hooks/use-unsaved-changes-warning";

interface Draft {
  inApp: boolean;
  email: boolean;
}

function Toggle({
  on,
  disabled,
  onChange,
  label,
}: {
  on: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
        on ? "bg-emerald-500" : "bg-[rgba(17,24,39,0.18)]"
      } ${disabled ? "cursor-not-allowed opacity-45" : "cursor-pointer"}`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
          on ? "translate-x-5" : "translate-x-1"
        }`}
      />
    </button>
  );
}

export function MyNotificationsView({
  rows,
  error,
}: {
  rows: MyPreferenceRow[];
  error?: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const initial = useMemo(() => {
    const map: Record<string, Draft> = {};
    for (const row of rows)
      map[row.key] = { inApp: row.inApp, email: row.email };
    return map;
  }, [rows]);

  const [draft, setDraft] = useState<Record<string, Draft>>(initial);

  const dirtyKeys = Object.keys(draft).filter(
    (key) =>
      draft[key].inApp !== initial[key]?.inApp ||
      draft[key].email !== initial[key]?.email,
  );

  useUnsavedChangesWarning(dirtyKeys.length > 0);

  const set = (key: string, patch: Partial<Draft>) =>
    setDraft((d) => ({ ...d, [key]: { ...d[key], ...patch } }));

  const handleSave = () => {
    startTransition(async () => {
      const result = await saveMyNotificationPreferences(
        dirtyKeys.map((key) => ({
          eventKey: key,
          inApp: draft[key].inApp,
          email: draft[key].email,
        })),
      );
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success("Your notification settings are saved.");
      router.refresh();
    });
  };

  const groups = useMemo(() => {
    const byGroup = new Map<string, MyPreferenceRow[]>();
    for (const row of rows) {
      const bucket = byGroup.get(row.group);
      if (bucket) bucket.push(row);
      else byGroup.set(row.group, [row]);
    }
    return [...byGroup.entries()];
  }, [rows]);

  return (
    <div className="dash-page-enter flex flex-col gap-4">
      <header className="dash-page-header row">
        <div>
          <h1>My notifications</h1>
          <p>
            What you personally get told about. Your store&apos;s{" "}
            <Link
              href="/dashboard/settings/notifications"
              className="underline"
            >
              notification settings
            </Link>{" "}
            decide what&apos;s available here.
          </p>
        </div>
      </header>

      {error ? (
        <section className="dash-card">
          <div className="dash-card-body">
            <div className="dash-empty">
              <div className="dash-empty-title">
                Couldn&apos;t load your settings
              </div>
              <p className="dash-empty-text">{error}</p>
            </div>
          </div>
        </section>
      ) : rows.length === 0 ? (
        <section className="dash-card">
          <div className="dash-card-body">
            <div className="dash-empty">
              <Bell className="dash-empty-icon" />
              <div className="dash-empty-title">Nothing to configure</div>
              <p className="dash-empty-text">
                Your store hasn&apos;t switched on any notifications you can
                receive.
              </p>
            </div>
          </div>
        </section>
      ) : (
        groups.map(([group, groupRows]) => (
          <section className="dash-card" key={group}>
            <div className="dash-card-header">
              <div className="dash-card-title">{group}</div>
              <div className="flex items-center gap-6 pr-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--dash-text-3)]">
                <span className="flex items-center gap-1">
                  <Bell className="h-3.5 w-3.5" /> In-app
                </span>
                <span className="flex items-center gap-1">
                  <Mail className="h-3.5 w-3.5" /> Email
                </span>
              </div>
            </div>
            <div className="dash-card-body">
              <ul className="divide-y divide-[rgba(17,24,39,0.06)]">
                {groupRows.map((row) => {
                  const value = draft[row.key] ?? {
                    inApp: row.inApp,
                    email: row.email,
                  };
                  const locked = !row.configurable;
                  return (
                    <li
                      key={row.key}
                      className="flex items-start justify-between gap-6 py-3.5 first:pt-1 last:pb-1"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-[13.5px] font-semibold text-[var(--dash-text)]">
                          {row.label}
                          {locked && (
                            <span
                              className="dash-badge-grey inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium"
                              title="Security and billing alerts can't be switched off."
                            >
                              <Lock className="h-3 w-3" />
                              Always on
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 max-w-xl text-[12.5px] leading-relaxed text-[var(--dash-text-2)]">
                          {row.description}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-6 pt-1">
                        <Toggle
                          on={value.inApp}
                          disabled={locked || isPending}
                          label={`${row.label} — in-app`}
                          onChange={(next) => set(row.key, { inApp: next })}
                        />
                        <Toggle
                          on={value.email}
                          disabled={locked || isPending}
                          label={`${row.label} — email`}
                          onChange={(next) => set(row.key, { email: next })}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>
        ))
      )}

      {rows.length > 0 && (
        <div className="sticky bottom-4 flex items-center justify-end gap-3">
          {dirtyKeys.length > 0 && (
            <span className="text-[12.5px] text-[var(--dash-text-2)]">
              {dirtyKeys.length} change{dirtyKeys.length === 1 ? "" : "s"}
            </span>
          )}
          <Button
            onClick={handleSave}
            disabled={dirtyKeys.length === 0 || isPending}
          >
            {isPending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      )}
    </div>
  );
}
