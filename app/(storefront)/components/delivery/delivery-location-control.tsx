"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, LocateFixed, Loader2, MapPin } from "lucide-react";
import { useDeliveryLocation } from "./delivery-location-provider";
import styles from "./delivery-location.module.css";

export function DeliveryLocationControl({
  drawer = false,
}: {
  drawer?: boolean;
}) {
  const {
    location,
    locating,
    locationError,
    setPostalCode,
    useCurrentLocation,
  } = useDeliveryLocation();
  const [open, setOpen] = useState(false);
  const [postalCodeDraft, setPostalCodeDraft] = useState("");
  const [editingPostalCode, setEditingPostalCode] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const postalCode = editingPostalCode
    ? postalCodeDraft
    : (location?.postalCode ?? "");

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!/^\d{6}$/.test(postalCode)) return;
    setPostalCode(postalCode);
    setEditingPostalCode(false);
    setOpen(false);
  };

  return (
    <div
      ref={rootRef}
      className={`${styles.root}${drawer ? ` ${styles.drawerRoot}` : ""}`}
      // The header's fit check (use-header-fit.ts) finds it by this.
      data-delivery-control={drawer ? undefined : ""}
    >
      <button
        type="button"
        className={styles.trigger}
        onClick={() => {
          setOpen((current) => !current);
          setPostalCodeDraft(location?.postalCode ?? "");
          setEditingPostalCode(false);
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <MapPin size={18} aria-hidden />
        <span className={styles.triggerCopy}>
          <small>Deliver to</small>
          <strong>{location?.label ?? "Select location"}</strong>
        </span>
        <ChevronDown size={15} aria-hidden />
      </button>

      {open && (
        <div
          className={styles.panel}
          role="dialog"
          aria-label="Delivery location"
        >
          <strong className={styles.title}>Choose delivery location</strong>
          <p className={styles.help}>
            Enter a PIN code to see availability, charges and delivery time.
          </p>
          <form className={styles.form} onSubmit={submit}>
            <input
              value={postalCode}
              onChange={(event) => {
                setPostalCodeDraft(
                  event.target.value.replace(/\D/g, "").slice(0, 6),
                );
                setEditingPostalCode(true);
              }}
              inputMode="numeric"
              autoComplete="postal-code"
              placeholder="6-digit PIN code"
              aria-label="Delivery PIN code"
              autoFocus
            />
            <button type="submit" disabled={!/^\d{6}$/.test(postalCode)}>
              Apply
            </button>
          </form>
          <button
            type="button"
            className={styles.locate}
            onClick={useCurrentLocation}
            disabled={locating}
          >
            {locating ? (
              <Loader2 size={16} className={styles.spinner} aria-hidden />
            ) : (
              <LocateFixed size={16} aria-hidden />
            )}
            {locating ? "Finding your location…" : "Use my current location"}
          </button>
          {locationError && <p className={styles.error}>{locationError}</p>}
        </div>
      )}
    </div>
  );
}
