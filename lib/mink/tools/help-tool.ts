import "server-only";

import sanitizeHtml from "sanitize-html";
import { fuseHelpRankings } from "@/lib/help/hybrid-ranking";
import {
  getPublishedHelpDocumentsForAssistant,
  searchHelpArticles,
} from "@/lib/help/queries";
import { searchHelpArticleChunksByMeaning } from "@/lib/help/vector-search";
import { HELP_URL } from "@/lib/site";
import { MinkToolInputError } from "../errors";
import type { MinkArtifact } from "../types";
import type { MinkTool } from "./registry";

const MAX_SOURCES = 5;
const MAX_SOURCE_CONTENT = 1_800;

function plainArticle(body: string | null): string {
  if (!body) return "";
  return sanitizeHtml(
    body.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|li|h[1-6])>/gi, "\n"),
    { allowedTags: [], allowedAttributes: {} },
  )
    .replace(/\s+/g, " ")
    .trim();
}

function sourceArtifact(output: Record<string, unknown>): MinkArtifact {
  const sources = Array.isArray(output.sources)
    ? output.sources.flatMap((source) => {
        if (!source || typeof source !== "object") return [];
        const row = source as Record<string, unknown>;
        if (typeof row.title !== "string" || typeof row.url !== "string")
          return [];
        return [
          {
            title: row.title,
            ...(typeof row.excerpt === "string"
              ? { excerpt: row.excerpt }
              : {}),
            url: row.url,
          },
        ];
      })
    : [];
  return {
    type: "sources",
    title: "StoreMink Help Centre",
    query: String(output.query ?? ""),
    sources,
  };
}

export const searchHelpCentreTool: MinkTool = {
  declaration: {
    name: "search_help_centre",
    description:
      "Search StoreMink's published Help Centre with lexical and semantic retrieval. Use only when the merchant is asking a how-to, navigation, setup, permissions, troubleshooting, or 'where do I configure' question. Never use Help Centre search to plan another declared tool call, discover a tool's input shape, or look up how to complete an action the merchant already requested; the tool declarations and returned store context are authoritative for that work. Cite only returned URLs.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 2,
          maxLength: 300,
          description: "A concise StoreMink help or navigation question.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  permission: { section: "dashboard", action: "view" },
  timeoutMs: 10_000,
  artifact: sourceArtifact,
  async execute(_actor, args) {
    if (typeof args.query !== "string") {
      throw new MinkToolInputError("query must be a string.");
    }
    const query = args.query.normalize("NFKC").replace(/\s+/g, " ").trim();
    if (query.length < 2 || query.length > 300) {
      throw new MinkToolInputError(
        "query must be between 2 and 300 characters.",
      );
    }
    const [lexical, semantic] = await Promise.all([
      searchHelpArticles(query, 10),
      searchHelpArticleChunksByMeaning(query, 20),
    ]);
    const fused = fuseHelpRankings(
      lexical.map((article) => ({
        articleId: article.id,
        articleSlug: article.slug,
      })),
      semantic.matches,
      { limit: MAX_SOURCES },
    );
    const slugs = fused
      .map((candidate) => candidate.articleSlug)
      .filter((slug): slug is string => Boolean(slug));
    const documents = await getPublishedHelpDocumentsForAssistant(slugs);
    const semanticBySlug = new Map(
      fused.map((candidate) => [candidate.articleSlug, candidate.vectorChunks]),
    );
    return {
      query,
      retrieval: {
        lexicalMatches: lexical.length,
        semanticStatus: semantic.status,
      },
      count: documents.length,
      sources: documents.map((document) => {
        const semanticText = (semanticBySlug.get(document.slug) ?? [])
          .slice(0, 2)
          .map((chunk) => chunk.content)
          .join(" ");
        return {
          title: document.title,
          excerpt: document.excerpt ?? undefined,
          content: (semanticText || plainArticle(document.body)).slice(
            0,
            MAX_SOURCE_CONTENT,
          ),
          updatedAt: document.updatedAt,
          url: `${HELP_URL}/help/${document.categorySlug}/${document.slug}`,
        };
      }),
    };
  },
};
