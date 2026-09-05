import type { CustomCodeConfig } from "@/lib/sections/registry";

export interface MinkStorefrontCodePreviewDto {
  id: string;
  draftVersion: number;
  title: string;
  destinationLabel: string;
  destinationPath: string;
  explanation: string;
  target: {
    pageSlug: string;
    sectionId: string;
    expectedPageVersion: string;
    expectedSectionDigest: string;
  };
  targetState: "current" | "stale" | "unavailable";
  targetMessage: string;
  patchDigest: string;
  beforeConfig: CustomCodeConfig;
  proposedConfig: CustomCodeConfig;
  changedFields: Array<"html" | "css" | "js" | "height">;
  validationChecks: string[];
  sandbox: {
    iframe: {
      sandboxAttribute: string;
      opaqueOrigin: boolean;
      sameOrigin: boolean;
      topNavigation: boolean;
    };
  };
  authority: {
    canPreview: true;
    canEditProposal: false;
    canSaveBuilderDraft: boolean;
    canPublish: false;
  };
}
