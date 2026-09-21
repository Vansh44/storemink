import type { MinkProductActionStatus } from "./product-action-types";

export type MinkBlogPublicationValues = Record<string, string | null>;
export type MinkBlogPublicationJobStatus =
  | "scheduled"
  | "published"
  | "conflicted"
  | "cancelled";

export interface MinkBlogPublicationApproval {
  id: string;
  sourceApprovalId: null;
  toolName: "publish_blog";
  operation: "apply";
  status: MinkProductActionStatus;
  draftId: string;
  draftVersion: number;
  resource: {
    type: "blog";
    id: string | null;
    label: string;
    dashboardPath: string;
  };
  before: MinkBlogPublicationValues;
  after: MinkBlogPublicationValues;
  expiresAt: string;
  executedAt: string | null;
}

export interface MinkBlogPublicationResult {
  approval: MinkBlogPublicationApproval;
  auditId: string | null;
  repeated: boolean;
  publication: {
    id: string;
    mode: "publish_now" | "schedule";
    status: MinkBlogPublicationJobStatus;
    scheduledFor: string | null;
    publishedAt: string | null;
  };
}

export interface MinkBlogPublicationExecutionResult extends MinkBlogPublicationResult {
  /** Server-only notification hint; stripped before browser JSON. */
  notifyPublication: boolean;
  /** Server-only, database-derived path component; stripped before JSON. */
  publishedSlug: string | null;
}

export const MINK_BLOG_PUBLICATION_FIELDS = [
  "publication_status",
  "publish_at",
  "title",
  "excerpt",
  "content",
  "cover_image_url",
  "seo_title",
  "seo_description",
] as const;

export const MINK_BLOG_PUBLICATION_FIELD_LABELS: Record<string, string> = {
  publication_status: "Publication",
  publish_at: "Publish at",
  title: "Title",
  excerpt: "Excerpt",
  content: "Content",
  cover_image_url: "Cover image",
  seo_title: "SEO title",
  seo_description: "SEO description",
};
