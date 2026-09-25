/* eslint-disable @next/next/no-img-element */
"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import styles from "./Header.module.css";
import Image from "next/image";
import { useBrand } from "@/app/(storefront)/components/brand-provider";
import { useChrome } from "@/app/(storefront)/components/chrome-provider";
import { useAuth } from "@/app/(storefront)/components/auth/AuthProvider";
import { useCart } from "@/app/(storefront)/components/cart/CartProvider";
import { DeliveryLocationControl } from "@/app/(storefront)/components/delivery/delivery-location-control";
import { DesktopNav } from "./desktop-nav";
import { DrawerNav } from "./drawer-nav";
import {
  User,
  Package,
  FileText,
  MessageSquare,
  LogOut,
  Bell,
  ChevronRight,
} from "lucide-react";
import { getMyCustomerUnreadCount } from "@/app/actions/customer-notification-actions";

export default function Header() {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  // Bumped on every open so the drawer's menu remounts at its top level.
  const [drawerKey, setDrawerKey] = useState(0);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);
  const [customerUnread, setCustomerUnread] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const router = useRouter();
  const profileRef = useRef(null);
  const profileButtonRef = useRef(null);
  const closeTimerRef = useRef(null);
  const { user, customer, loading, openAuthModal, signOut } = useAuth();
  const { totalItems, hydrated: cartHydrated, openCart } = useCart();
  const brand = useBrand();
  // The header config the merchant edits in the website builder: which links
  // appear, and whether the search box, account and cart show at all. A
  // catalogue-only (enquiry-led B2B) store turns the cart off entirely.
  const { header: headerCfg } = useChrome();
  const navLinks = headerCfg.links;

  const isLoggedIn = !!user && !!customer;

  // Unread badge for the shopper's notification centre. Polls only while
  // signed in AND the tab is visible — the same shape as the dashboard bell
  // (Supabase Realtime went with the Cloud SQL migration, so there is no push).
  useEffect(() => {
    // Signed out: nothing to poll. The badge is derived from isLoggedIn at
    // render time rather than being zeroed here, so the effect never sets
    // state synchronously.
    if (!isLoggedIn) return;
    let cancelled = false;
    const check = async () => {
      try {
        const n = await getMyCustomerUnreadCount();
        if (!cancelled) setCustomerUnread(n);
      } catch {
        // A failed poll isn't worth surfacing to a shopper.
      }
    };
    void check();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void check();
    }, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isLoggedIn]);

  // Lock body scroll when mobile menu is open
  useEffect(() => {
    if (isMenuOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [isMenuOpen]);

  // Track scroll position for header styling
  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 20);
    };

    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  // Clean up any pending close timer on unmount
  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  // Close after a short grace period so the cursor can travel through the
  // account panel without making it linger after pointer use.
  const scheduleCloseProfile = () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => setIsProfileOpen(false), 160);
  };

  const handleSignOut = async () => {
    setIsProfileOpen(false);
    await signOut();
  };

  // Header search → the shop grid, filtered by ?q=. Empty submits just go
  // to the shop.
  const submitSearch = (e) => {
    e.preventDefault();
    const q = searchQuery.trim();
    setIsMenuOpen(false);
    router.push(q ? `/shop?q=${encodeURIComponent(q)}` : "/shop");
  };

  const displayName = customer
    ? `${customer.first_name}${customer.last_name ? " " + customer.last_name : ""}`
    : user?.phone || "Account";

  const initials = customer?.first_name
    ? customer.first_name.charAt(0).toUpperCase()
    : "?";

  return (
    <header
      className={`${styles.header} ${isScrolled ? styles.headerScrolled : ""}`}
    >
      <div className={styles.headerLeft}>
        <Link href="/" className={styles.logo}>
          {brand.logoUrl && (
            <img
              src={brand.logoUrl}
              alt={`${brand.name} logo`}
              style={{
                height: "32px",
                width: "auto",
                maxWidth: "160px",
                objectFit: "contain",
              }}
            />
          )}
          <span className={styles.brandNameText}>{brand.name}</span>
        </Link>

        <DesktopNav links={navLinks} />
      </div>

      <div className={styles.headerRight}>
        <DeliveryLocationControl />
        {/* Search Bar - Now exclusively in the main header */}
        {headerCfg.showSearch && (
          <form
            className={styles.searchBar}
            onSubmit={submitSearch}
            role="search"
          >
            <input
              type="text"
              placeholder="Search products..."
              className={styles.searchInput}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search products"
            />
            <button
              type="submit"
              className={styles.searchIcon}
              aria-label="Search"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="8"></circle>
                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
              </svg>
            </button>
          </form>
        )}

        <div className={styles.iconGroup}>
          {/* Profile Button with Dropdown */}
          <div
            className={styles.profileWrapper}
            ref={profileRef}
            onMouseLeave={scheduleCloseProfile}
            onKeyDown={(event) => {
              if (event.key === "Escape" && isProfileOpen) {
                event.preventDefault();
                setIsProfileOpen(false);
                profileButtonRef.current?.focus();
              }
            }}
          >
            <button
              ref={profileButtonRef}
              className={`${styles.userIcon} ${isLoggedIn ? styles.userIconLoggedIn : ""}`}
              onClick={() => {
                if (!loading) setIsProfileOpen((open) => !open);
              }}
              aria-label={isLoggedIn ? "Open profile menu" : "Sign in"}
              aria-haspopup="menu"
              aria-expanded={isProfileOpen}
              aria-controls={isProfileOpen ? "profile-dropdown" : undefined}
              id="header-profile-btn"
            >
              {isLoggedIn ? (
                <span className={styles.avatarBubble}>{initials}</span>
              ) : (
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                  <circle cx="12" cy="7" r="4"></circle>
                </svg>
              )}
            </button>

            {/* Profile Dropdown — opens on hover */}
            {isProfileOpen && !loading && (
              <div
                className={styles.profileDropdown}
                id="profile-dropdown"
                role="menu"
              >
                {isLoggedIn ? (
                  <div className={styles.profileDropdownHeader}>
                    <span className={styles.profileDropdownAvatar}>
                      {initials}
                    </span>
                    <div className={styles.profileDropdownInfo}>
                      <span className={styles.profileDropdownName}>
                        {displayName}
                      </span>
                      {user?.phone && (
                        <span className={styles.profileDropdownPhone}>
                          {user.phone}
                        </span>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className={styles.profileDropdownLogin}>
                    <div className={styles.profileDropdownLoginText}>
                      <span className={styles.profileDropdownLoginSub}>
                        Sign in to access your profile, orders, and more!
                      </span>
                    </div>
                    <button
                      className={styles.profileDropdownLoginBtn}
                      onClick={() => {
                        setIsProfileOpen(false);
                        openAuthModal();
                      }}
                    >
                      Login/Sign Up
                    </button>
                  </div>
                )}
                <div className={styles.profileDropdownDivider} />
                <Link
                  href="/profile"
                  className={styles.profileDropdownItem}
                  role="menuitem"
                  onClick={() => setIsProfileOpen(false)}
                >
                  <User size={18} strokeWidth={1.75} />
                  My Profile
                  <ChevronRight size={16} className={styles.profileItemArrow} />
                </Link>
                {isLoggedIn && (
                  <>
                    <Link
                      href="/orders"
                      className={styles.profileDropdownItem}
                      role="menuitem"
                      onClick={() => setIsProfileOpen(false)}
                    >
                      <Package size={18} strokeWidth={1.75} />
                      My Orders
                      <ChevronRight
                        size={16}
                        className={styles.profileItemArrow}
                      />
                    </Link>
                    <Link
                      href="/notifications"
                      className={styles.profileDropdownItem}
                      role="menuitem"
                      onClick={() => setIsProfileOpen(false)}
                    >
                      <Bell size={18} strokeWidth={1.75} />
                      Notifications
                      {isLoggedIn && customerUnread > 0 && (
                        <span className={styles.profileItemBadge}>
                          {customerUnread > 9 ? "9+" : customerUnread}
                        </span>
                      )}
                      <ChevronRight
                        size={16}
                        className={styles.profileItemArrow}
                      />
                    </Link>
                  </>
                )}
                <Link
                  href="/track-order"
                  className={styles.profileDropdownItem}
                  role="menuitem"
                  onClick={() => setIsProfileOpen(false)}
                >
                  <Package size={18} strokeWidth={1.75} />
                  Track Order
                  <ChevronRight size={16} className={styles.profileItemArrow} />
                </Link>
                <Link
                  href="/blogs/my-submissions"
                  className={styles.profileDropdownItem}
                  role="menuitem"
                  onClick={() => setIsProfileOpen(false)}
                >
                  <FileText size={18} strokeWidth={1.75} />
                  My Blogs
                  <ChevronRight size={16} className={styles.profileItemArrow} />
                </Link>
                <Link
                  href="/enquiries"
                  className={styles.profileDropdownItem}
                  role="menuitem"
                  onClick={() => setIsProfileOpen(false)}
                >
                  <MessageSquare size={18} strokeWidth={1.75} />
                  Enquiries
                  <ChevronRight size={16} className={styles.profileItemArrow} />
                </Link>
                <div className={styles.profileDropdownDivider} />
                {isLoggedIn ? (
                  <button
                    className={styles.profileDropdownItem}
                    role="menuitem"
                    onClick={handleSignOut}
                    id="profile-logout-btn"
                  >
                    <LogOut size={18} strokeWidth={1.75} />
                    Log out
                  </button>
                ) : null}
              </div>
            )}
          </div>

          {/* Cart Button */}
          {headerCfg.showCart && (
            <button
              type="button"
              onClick={openCart}
              className={styles.cartBtn}
              aria-label="Open cart"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="9" cy="21" r="1"></circle>
                <circle cx="20" cy="21" r="1"></circle>
                <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path>
              </svg>
              {cartHydrated && totalItems > 0 && (
                <span className={styles.cartBadge}>{totalItems}</span>
              )}
            </button>
          )}
        </div>

        {/* Mobile Hamburger Button */}
        <button
          className={styles.hamburgerBtn}
          onClick={() => {
            setDrawerKey((k) => k + 1);
            setIsMenuOpen(true);
          }}
          aria-label="Open Menu"
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="3" y1="12" x2="21" y2="12"></line>
            <line x1="3" y1="6" x2="21" y2="6"></line>
            <line x1="3" y1="18" x2="21" y2="18"></line>
          </svg>
        </button>
      </div>

      {/* Mobile Drawer Menu */}
      <div
        className={`${styles.mobileDrawer} ${isMenuOpen ? styles.drawerOpen : ""}`}
      >
        <div className={styles.drawerHeader}>
          <Link
            href="/"
            className={styles.logo}
            onClick={() => setIsMenuOpen(false)}
          >
            {brand.logoUrl && (
              <Image
                src={brand.logoUrl}
                alt={`${brand.name} logo`}
                width={120}
                height={40}
                style={{ height: "auto", maxWidth: "100px", maxHeight: "30px" }}
              />
            )}
            <span className={styles.brandNameText}>{brand.name}</span>
          </Link>
          <button
            className={styles.closeBtn}
            onClick={() => setIsMenuOpen(false)}
            aria-label="Close Menu"
          >
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <div className={styles.drawerSearch}>
          <form
            className={styles.drawerSearchBar}
            onSubmit={submitSearch}
            role="search"
          >
            <button
              type="submit"
              className={styles.searchIcon}
              aria-label="Search"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="8"></circle>
                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
              </svg>
            </button>
            <input
              type="text"
              placeholder="Search products..."
              className={styles.searchInput}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search products"
            />
          </form>
        </div>

        <DeliveryLocationControl drawer />

        <DrawerNav
          key={drawerKey}
          links={navLinks}
          onNavigate={() => setIsMenuOpen(false)}
        />

        {/* Mobile auth section in drawer */}
        <div className={styles.drawerAuth}>
          {isLoggedIn ? (
            <>
              <div className={styles.drawerAuthUser}>
                <span className={styles.drawerAuthAvatar}>{initials}</span>
                <span className={styles.drawerAuthName}>{displayName}</span>
              </div>
              <Link
                href="/profile"
                className={styles.drawerAuthBtn}
                onClick={() => setIsMenuOpen(false)}
                style={{ marginBottom: "12px", display: "block" }}
              >
                Profile
              </Link>
              <button
                className={styles.drawerAuthBtn}
                onClick={() => {
                  setIsMenuOpen(false);
                  handleSignOut();
                }}
              >
                Log out
              </button>
            </>
          ) : (
            <button
              className={styles.drawerAuthBtn}
              onClick={() => {
                setIsMenuOpen(false);
                openAuthModal();
              }}
            >
              Sign in
            </button>
          )}
        </div>
      </div>

      {/* Drawer Overlay Backdrop */}
      <div
        className={`${styles.drawerOverlay} ${isMenuOpen ? styles.overlayVisible : ""}`}
        onClick={() => setIsMenuOpen(false)}
      />
    </header>
  );
}
