"use client";

import { useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";

export function HomepageMobileNav({
  posUrl,
  themesUrl,
  anchorBase = "",
}: {
  posUrl: string;
  themesUrl: string;
  /** "" on the homepage, "/" anywhere the sections are on another route. */
  anchorBase?: string;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <div className="smh-mobile-menu">
      <button
        type="button"
        aria-label={open ? "Close navigation" : "Open navigation"}
        aria-expanded={open}
        aria-controls="smh-mobile-navigation"
        onClick={() => setOpen((current) => !current)}
      >
        {open ? <X size={22} /> : <Menu size={23} />}
      </button>
      {open && (
        <div className="smh-mobile-menu-panel" id="smh-mobile-navigation">
          <a href={`${anchorBase}#platform`} onClick={close}>
            Platform
          </a>
          <Link href={posUrl} onClick={close}>
            Point of Sale
          </Link>
          <a href={themesUrl} onClick={close}>
            Themes
          </a>
          <a href={`${anchorBase}#pricing`} onClick={close}>
            Pricing
          </a>
          <a href="https://help.storemink.com" onClick={close}>
            Help Centre
          </a>
          <Link href="/login" onClick={close}>
            Log in
          </Link>
          <Link
            href="/signup"
            className="smh-button smh-button-dark"
            onClick={close}
          >
            Start free
          </Link>
        </div>
      )}
    </div>
  );
}
