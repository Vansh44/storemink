import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  conversationTitle,
  minkConversationPrunePredicate,
  MINK_CONVERSATION_LIMIT,
} from "./persistence";

describe("Mink persistence", () => {
  it("keeps the product retention contract at ten conversations", () => {
    expect(MINK_CONVERSATION_LIMIT).toBe(10);
  });

  it("normalises whitespace and caps titles without splitting the suffix", () => {
    expect(conversationTitle("  How   are my products?  ")).toBe(
      "How are my products?",
    );
    const title = conversationTitle("a".repeat(100));
    expect(title).toHaveLength(78);
    expect(title.endsWith("…")).toBe(true);
  });

  it("excludes conversations whose drafts hold protected publication or action evidence", () => {
    const storeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const conversationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const query = new PgDialect().sqlToQuery(
      minkConversationPrunePredicate({ storeId, adminId: "owner" }, [
        conversationId,
      ]),
    );

    expect(query.sql).toContain("not exists");
    expect(query.sql).toContain('from "mink_runs"');
    expect(query.sql).toContain('inner join "mink_drafts"');
    expect(query.sql).toContain('inner join "mink_blog_publications"');
    expect(query.sql).toContain('inner join "mink_action_approvals"');
    expect(query.sql).toContain('inner join "mink_action_audit"');
    expect(query.sql.match(/not exists/g)).toHaveLength(2);
    expect(query.params).toEqual([
      storeId,
      "owner",
      conversationId,
      storeId,
      storeId,
    ]);
  });
});
