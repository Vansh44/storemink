"use client";

import dynamic from "next/dynamic";
import { useAuth } from "./AuthProvider";
import DemoAccountNotice from "./DemoAccountNotice";

// Phone auth brings Firebase's reCAPTCHA flow, the international phone input,
// and country metadata. None of that belongs in an anonymous storefront's
// initial bundle, so load the modal only after the account control is used.
const AuthModal = dynamic(() => import("./AuthModal"), { ssr: false });

export default function AuthModalLoader({
  demoStore = false,
}: {
  /** A theme demo store keeps no accounts: explain instead of signing in. */
  demoStore?: boolean;
}) {
  const { isAuthModalOpen } = useAuth();
  if (!isAuthModalOpen) return null;
  return demoStore ? <DemoAccountNotice /> : <AuthModal />;
}
