"use client";

import { createContext, useContext } from "react";
import type { ThemeMeta } from "@/lib/themes/meta";

const SignupThemeCatalogContext = createContext<readonly ThemeMeta[] | null>(
  null,
);

export function SignupThemeCatalogProvider({
  themes,
  children,
}: {
  themes: ThemeMeta[];
  children: React.ReactNode;
}) {
  return (
    <SignupThemeCatalogContext.Provider value={themes}>
      {children}
    </SignupThemeCatalogContext.Provider>
  );
}

export function useSignupThemeCatalog(): readonly ThemeMeta[] {
  const themes = useContext(SignupThemeCatalogContext);
  if (!themes) {
    throw new Error("SignupThemeCatalogProvider is missing.");
  }
  return themes;
}
