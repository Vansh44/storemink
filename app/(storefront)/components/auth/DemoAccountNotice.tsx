"use client";

import { useEffect } from "react";
import { useAuth } from "./AuthProvider";
import styles from "./AuthModal.module.css";

// Shown instead of the sign-in modal on a theme demo store. A preview keeps no
// customer accounts (lib/store/demo-guard.ts refuses the profile write on the
// server), so offering a phone number field would send a real OTP text for an
// account that can never be created. Same frame as AuthModal, so the theme's
// look is what the visitor sees either way.
export default function DemoAccountNotice() {
  const { closeAuthModal } = useAuth();

  useEffect(() => {
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeAuthModal();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
    };
  }, [closeAuthModal]);

  return (
    <div
      className={`${styles.overlay} ${styles.overlayVisible}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeAuthModal();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="demo-account-title"
    >
      <div className={styles.modal}>
        <div className={styles.content}>
          <div className={styles.step}>
            <h2 id="demo-account-title" className={styles.title}>
              This is a theme preview
            </h2>
            <p className={styles.subtitle}>
              Browse it as a shopper would. Accounts, checkout and forms are
              turned off, so nothing you enter here is saved or sent.
            </p>
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={closeAuthModal}
              autoFocus
            >
              Keep browsing
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
