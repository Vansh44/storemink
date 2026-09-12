import { describe, expect, it } from "vitest";
import type { MinkActorContext, MinkToolDeclaration } from "../types";
import { minkReadToolRegistry } from "./read-tools";

// ---------------------------------------------------------------------------
// A REAL Vertex call, skipped unless RUN_VERTEX_SCHEMA_CHECK=1. It is a tool
// for answering ONE question by hand, not a unit test:
//
//   does Vertex accept the tool declarations we actually send?
//
// ★★ WHY THIS IS CHEAP, AND WHY IT IS WORTH A FILE. A declaration Vertex will
// not accept is rejected as 400 INVALID_ARGUMENT at request validation —
// BEFORE any generation. So it needs no store, no session cookie, no seeded
// data, and burns effectively no tokens, while the alternative (noticing in a
// live Echos session) costs a whole rollout and looks like a model failure
// rather than a schema one.
//
// ★ THE SHAPE UNDER TEST is Phase 9C's nullable union — `type: ["string",
// "null"]` on the palette tokens and `null` inside the typeface enum — which
// is what makes "put this back to the theme" expressible at all. It is
// standard JSON Schema and the SDK field is literally `parametersJsonSchema`,
// but no live provider call has ever exercised it. If Vertex refuses the
// union, `propose_storefront_design` fails on EVERY call, and the documented
// fallback is plain types: the contract, the prompt and the card already treat
// an ABSENT key exactly as they treat `null`, so nothing else changes.
//
//   gcloud auth application-default login
//   GCP_PROJECT_ID=storemink-prod RUN_VERTEX_SCHEMA_CHECK=1 \
//     npx vitest run lib/mink/tools/vertex-schema.integration --coverage=false
//
// ⚠ REQUIRES APPLICATION DEFAULT CREDENTIALS, not just `gcloud auth login`,
// and `roles/aiplatform.user` on that identity. Without ADC every call fails
// `invalid_grant / invalid_rapt`, which the client maps to
// `provider_auth_failed` — a SETUP problem, deliberately distinguished below
// from `provider_request_rejected`, which is the verdict this file exists for.
// ---------------------------------------------------------------------------

const RUN = process.env.RUN_VERTEX_SCHEMA_CHECK === "1";
const d = RUN ? describe : describe.skip;

/**
 * The widest actor, so ONE call validates every declaration at once.
 *
 * ★ THE WHOLE SET GOES TO VERTEX TOGETHER on every step of every run, so
 *   checking them one at a time would cost more and prove less. A superadmin
 *   with drafting on is what surfaces the draft, layout, code and design tools
 *   alongside the reads.
 */
const ACTOR: MinkActorContext = {
  storeId: "00000000-0000-4000-8000-000000000000",
  adminId: "schema-check",
  email: "schema-check@storemink.com",
  roleSlug: "superadmin",
  permissions: {},
  isSuperadmin: true,
  effectivePlan: "pro",
  locationIds: null,
  analyticsTimeZone: "Asia/Kolkata",
  currency: "INR",
  defaultLowStockThreshold: 5,
  requestId: "schema-check",
  draftingEnabled: true,
};

function designDeclaration(
  declarations: MinkToolDeclaration[],
): MinkToolDeclaration {
  const found = declarations.find(
    (tool) => tool.name === "propose_storefront_design",
  );
  if (!found) throw new Error("propose_storefront_design is not declared");
  return found;
}

/** Every `type` value anywhere in a schema, so a union cannot hide at depth. */
function typeValues(schema: unknown, out: unknown[] = []): unknown[] {
  if (!schema || typeof schema !== "object") return out;
  if (Array.isArray(schema)) {
    for (const entry of schema) typeValues(entry, out);
    return out;
  }
  for (const [key, value] of Object.entries(schema)) {
    if (key === "type") out.push(value);
    typeValues(value, out);
  }
  return out;
}

d("Vertex tool-declaration schemas (live)", () => {
  it("still sends the nullable union this check exists to exercise", () => {
    // ★★ WITHOUT THIS ASSERTION THE LIVE CALL BELOW PROVES NOTHING. If someone
    //    replaces the union with plain types, the request starts passing and a
    //    green run would read as "Vertex accepts the union" when the union was
    //    no longer in the payload. Pin the risky shape, then send it.
    const declarations = minkReadToolRegistry.declarationsFor(ACTOR);
    const design = designDeclaration(declarations);
    const types = typeValues(design.parametersJsonSchema);
    const unions = types.filter(
      (value) => Array.isArray(value) && value.includes("null"),
    );
    expect(
      unions.length,
      "propose_storefront_design no longer declares a nullable union; either the fallback to plain types has landed (delete this file) or a token lost its ability to say 'inherit the theme'",
    ).toBeGreaterThan(0);
  });

  it("is accepted by Vertex for the whole permitted declaration set", async () => {
    const { getMinkConfig } = await import("../config");
    const { createVertexMinkSession } = await import("../vertex-client");
    const config = getMinkConfig();
    expect(
      config.projectId,
      "set GCP_PROJECT_ID; Mink's Vertex client refuses without it",
    ).toBeTruthy();

    const declarations = minkReadToolRegistry.declarationsFor(ACTOR);
    // Sanity: this is only meaningful while the set is the real one.
    expect(declarations.length).toBeGreaterThan(10);

    // ★ THE REAL CLIENT, NOT A MIRROR OF IT. Reconstructing GoogleGenAI here
    //   would be a second copy of the session options, and a check that drifts
    //   from the thing it checks is worse than no check — it would keep
    //   passing after the real path broke.
    const session = createVertexMinkSession(config, ACTOR, declarations, {
      history: [],
    });

    try {
      // A trivial prompt: the ANSWER is irrelevant. Request validation happens
      // before generation, so acceptance is the entire result.
      const turn = await session.sendUserMessage("Reply with the word ok.");
      expect(turn).toBeTruthy();
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "provider_auth_failed") {
        throw new Error(
          "Vertex rejected the CREDENTIALS, not the schema. Run `gcloud auth application-default login` and confirm roles/aiplatform.user. This is a setup failure and says nothing about the declarations.",
        );
      }
      if (code === "provider_unavailable") {
        throw new Error(
          "Vertex was unavailable (5xx/429/network). Inconclusive — re-run rather than treating this as a schema verdict.",
        );
      }
      if (code !== "provider_request_rejected") throw error;

      // ★★ THE VERDICT, and the one branch worth explaining. The client maps a
      //    4xx to a merchant-safe sentence and DISCARDS Vertex's own message,
      //    which is right for a dashboard and useless here — so re-send just
      //    the design declaration raw to surface what Vertex actually said.
      //    Drift does not matter for this call: it produces diagnostic text,
      //    never the verdict.
      let detail = "(raw diagnostic call failed to produce a message)";
      try {
        const { GoogleGenAI } = await import("@google/genai");
        const ai = new GoogleGenAI({
          enterprise: true,
          project: config.projectId as string,
          location: config.location,
          apiVersion: "v1",
          httpOptions: { retryOptions: { attempts: 1 } },
        });
        const design = designDeclaration(declarations);
        await ai.models.generateContent({
          model: config.model,
          contents: "ok",
          config: {
            tools: [
              {
                functionDeclarations: [
                  {
                    name: design.name,
                    description: design.description,
                    parametersJsonSchema: design.parametersJsonSchema,
                  },
                ],
              },
            ],
          },
        });
        detail =
          "the design declaration ALONE was accepted — the rejection is in another tool's schema, not 9C's union";
      } catch (raw) {
        detail = raw instanceof Error ? raw.message : String(raw);
      }
      throw new Error(
        `Vertex REJECTED the declaration set (provider_request_rejected).\n\n${detail}\n\nIf the union is the cause, fall back to plain types in storefront-design-tools.ts: the contract, the prompt and the review card already treat an absent key exactly as they treat null, so nothing else changes (CODEBASE.md, Mink Phase 9C).`,
      );
    }
  }, 180_000);
});
