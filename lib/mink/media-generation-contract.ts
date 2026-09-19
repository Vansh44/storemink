// ---------------------------------------------------------------------------
// Phase 9E - proposing a GENERATED image for the store's Media Library.
//
// 9D gave Mink pictures it can use and made the boundary explicit: a layout
// proposal may cite only a URL the store owns or one already on the page. That
// is the right rule and it leaves a real gap — a
// theme-seeded store keeps its artwork at `/themes/…`, in no Media Library, so
// a merchant asking for a hero gets a refusal and a homework assignment. 9E
// closes it by letting Mink create and keep an image for the merchant. Saving
// the generated asset immediately also lets a same-run layout proposal prove
// ownership without a manual hand-off.
//
// ★★ WHAT MAKES THIS SAFE IS STRUCTURAL, NOT A WORD FILTER. A generated
// picture must never be presented as the ORIGINAL catalogue photograph of
// goods the shop actually sells. That is guaranteed by the shape of the system
// rather than by inspecting prompts: **Mink has no tool that writes
// `products.images`**, and 9D means the only place a generated URL can land is
// a layout section the merchant separately approves. Generated campaign art
// may now be grounded in the authentic product image, but cannot overwrite or
// become that source. Keep it that way — adding a product-image write is what
// would turn this feature into a liability.
//
// ⚠ THE COROLLARY, AND IT IS NOT DECORATIVE: a keyword blocklist for brands or
// products would be security theatre. It would fail on every misspelling and
// every brand nobody listed, while reading like a guarantee. What IS enforced
// by the generation path is what can actually be enforced — bounded prompts, a
// fixed aspect per purpose, a validated always-applied Markdown grounding and
// output contract, exact current-store references, and no people at all — plus
// the structural rule above. This client-safe contract deliberately does not
// pretend to more.
//
// ★ PURE AND CLIENT-SAFE. The review card renders the purpose label and the
// exact prompt beside the image, so this module must not import `server-only`
// or `node:crypto` (the digest lives with the server contract, the split
// `storefront-design-contract.ts` already makes for the same reason).
// ---------------------------------------------------------------------------

export const MINK_MEDIA_GENERATION_SCHEMA_VERSION = 2 as const;

/**
 * What the image is FOR, which is the only thing that may pick its shape.
 *
 * ★ A PURPOSE RATHER THAN A FREE ASPECT RATIO. The merchant is going to place
 *   this in a storefront section whose renderer already has an opinion — a
 *   gallery tile is square, a hero is wide — so letting a model choose "9:16"
 *   produces an image that is then cropped through the middle of its subject.
 *   Naming the destination also makes the review card able to say where it is
 *   meant to go, which a bare ratio cannot.
 */
export const MINK_MEDIA_PURPOSES = [
  "hero",
  "gallery",
  "feature",
  "banner",
] as const;
export type MinkMediaPurpose = (typeof MINK_MEDIA_PURPOSES)[number];

export interface MinkMediaPurposeSpec {
  label: string;
  /** The image model's supported vocabulary; every value here is documented. */
  aspectRatio: "1:1" | "3:4" | "4:3" | "16:9" | "9:16";
  /** Where a merchant would place it, for the review card. */
  placement: string;
}

export const MINK_MEDIA_PURPOSE_SPECS: Record<
  MinkMediaPurpose,
  MinkMediaPurposeSpec
> = {
  hero: {
    label: "Hero banner",
    aspectRatio: "16:9",
    placement: "the wide image at the top of a page",
  },
  gallery: {
    label: "Gallery tile",
    aspectRatio: "1:1",
    placement: "one square tile in a gallery",
  },
  feature: {
    label: "Feature image",
    aspectRatio: "4:3",
    placement: "the picture beside a block of text",
  },
  banner: {
    label: "Promo banner",
    aspectRatio: "16:9",
    placement: "a full-width strip between sections",
  },
};

/** One image per proposal. See `validateMinkMediaGenerationRequest`. */
export const MINK_MEDIA_IMAGES_PER_PROPOSAL = 1 as const;
export const MINK_MEDIA_PROMPT_MIN_CHARS = 12;
export const MINK_MEDIA_PROMPT_MAX_CHARS = 600;
export const MINK_MEDIA_ALT_MAX_CHARS = 180;
export const MINK_MEDIA_REFERENCE_MAX = 4;

export interface MinkMediaGenerationRequest {
  /**
   * ★★ ABSENT MEANS CURRENT, AND REQUIRING IT SHIPPED A FEATURE THAT COULD
   *    NEVER RUN ONCE. `generate_storefront_image` declares three parameters —
   *    purpose, prompt, alt — deliberately: a model has no business asserting
   *    a wire version, and `additionalProperties: false` means it could not
   *    send one even if it tried. So the only caller built a three-key object,
   *    the validator demanded a fourth, and EVERY generation was refused with
   *    "schemaVersion must be 1" before a provider call was ever made.
   *    ⚠ The rule, which is what generalises: a validator must not require a
   *    field no caller can supply. This one exists so a FUTURE wire format can
   *    be versioned, so a present-but-wrong value is still refused — what is
   *    dropped is only the demand that today's internal caller recite it.
   */
  schemaVersion: typeof MINK_MEDIA_GENERATION_SCHEMA_VERSION;
  purpose: MinkMediaPurpose;
  /** Exactly what is sent to the provider, after normalisation. */
  prompt: string;
  /** Exact current-store image URLs selected after the relevant read tools. */
  referenceImageUrls: string[];
  /**
   * Alt text, written now rather than later.
   *
   * ★ REQUIRED, and it is the one field a merchant would never go back and
   *   add. A decorative image with no alt text is a gap in the storefront's
   *   accessibility that nothing else in the product will ever prompt for, and
   *   the moment it is cheapest to write is while somebody is looking at the
   *   picture deciding whether to keep it.
   */
  alt: string;
}

export function validateMinkMediaGenerationRequest(
  input: unknown,
):
  | { ok: true; value: MinkMediaGenerationRequest }
  | { ok: false; issues: string[] } {
  const issues: string[] = [];
  if (!isRecord(input))
    return { ok: false, issues: ["Request must be an object."] };
  for (const key of Object.keys(input)) {
    if (
      ![
        "schemaVersion",
        "purpose",
        "prompt",
        "referenceImageUrls",
        "alt",
      ].includes(key)
    ) {
      issues.push(`${key} is not allowed.`);
    }
  }
  if (
    input.schemaVersion !== undefined &&
    input.schemaVersion !== MINK_MEDIA_GENERATION_SCHEMA_VERSION
  ) {
    issues.push(
      `schemaVersion must be ${MINK_MEDIA_GENERATION_SCHEMA_VERSION}.`,
    );
  }

  const purpose = MINK_MEDIA_PURPOSES.includes(
    input.purpose as MinkMediaPurpose,
  )
    ? (input.purpose as MinkMediaPurpose)
    : null;
  if (!purpose) {
    issues.push(
      `purpose must be one of ${MINK_MEDIA_PURPOSES.join(", ")} — it decides the image's shape.`,
    );
  }

  const prompt = normalizeText(input.prompt);
  if (prompt.length < MINK_MEDIA_PROMPT_MIN_CHARS) {
    // A two-word prompt produces something nobody asked for and still costs a
    // real image. Refusing is cheaper than generating and being discarded.
    issues.push(
      `prompt must describe the picture in at least ${MINK_MEDIA_PROMPT_MIN_CHARS} characters.`,
    );
  }
  if (prompt.length > MINK_MEDIA_PROMPT_MAX_CHARS) {
    issues.push(
      `prompt must be ${MINK_MEDIA_PROMPT_MAX_CHARS} characters or fewer.`,
    );
  }

  const referenceImageUrls = normalizeReferenceImageUrls(
    input.referenceImageUrls,
    issues,
  );

  const alt = normalizeText(input.alt);
  if (!alt) {
    issues.push(
      "alt must describe the image for a shopper using a screen reader.",
    );
  }
  if (alt.length > MINK_MEDIA_ALT_MAX_CHARS) {
    issues.push(`alt must be ${MINK_MEDIA_ALT_MAX_CHARS} characters or fewer.`);
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      schemaVersion: MINK_MEDIA_GENERATION_SCHEMA_VERSION,
      purpose: purpose as MinkMediaPurpose,
      prompt,
      referenceImageUrls,
      alt,
    },
  };
}

/** The aspect the purpose pins. Never taken from the caller. */
export function aspectRatioFor(purpose: MinkMediaPurpose): string {
  return MINK_MEDIA_PURPOSE_SPECS[purpose].aspectRatio;
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.normalize("NFKC").trim() : "";
}

function normalizeReferenceImageUrls(
  value: unknown,
  issues: string[],
): string[] {
  if (!Array.isArray(value)) {
    issues.push(
      "referenceImageUrls must be an array populated from the relevant current-store image reads, or an empty array when those reads found no suitable image.",
    );
    return [];
  }
  if (value.length > MINK_MEDIA_REFERENCE_MAX) {
    issues.push(
      `referenceImageUrls must contain at most ${MINK_MEDIA_REFERENCE_MAX} images.`,
    );
  }
  const urls: string[] = [];
  for (const entry of value.slice(0, MINK_MEDIA_REFERENCE_MAX)) {
    if (
      typeof entry !== "string" ||
      entry.length > 2_048 ||
      !entry.startsWith("https://")
    ) {
      issues.push("Every reference image URL must be an HTTPS URL.");
      continue;
    }
    if (!urls.includes(entry)) urls.push(entry);
  }
  return urls;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Where every generated object lives, under the store's own GCS prefix. */
export const MINK_GENERATED_MEDIA_FOLDER = "mink-generated";

export class MinkMediaContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MinkMediaContentError";
  }
}

export interface StoredGeneratedImage {
  url: string;
  path: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  purpose: MinkMediaPurpose;
  prompt: string;
  alt: string;
}

/**
 * Re-read one stored generated-image draft, refusing anything that does not
 * describe an object this store owns.
 *
 * ★★ THE PATH IS CHECKED AGAINST THE STORE PREFIX AND THE URL AGAINST THE
 * PATH. The save writes `media_assets.url` verbatim and 9D's ownership check
 * trusts that column completely, so a row whose url and path disagree would
 * put an arbitrary address into the one table the layout guard consults.
 */
export function readStoredGeneratedImage(
  storeId: string,
  content: Record<string, string | undefined>,
): StoredGeneratedImage {
  const path = (content.storage_path ?? "").trim();
  const url = (content.url ?? "").trim();
  const expectedPrefix = `stores/${storeId}/${MINK_GENERATED_MEDIA_FOLDER}/`;
  if (!path.startsWith(expectedPrefix) || path.includes("..")) {
    throw new MinkMediaContentError(
      "This image no longer refers to a file in this store.",
    );
  }
  if (!url.endsWith(`/${path}`)) {
    throw new MinkMediaContentError(
      "This image failed its storage integrity check.",
    );
  }
  const purpose = (content.purpose ?? "") as MinkMediaPurpose;
  if (!(purpose in MINK_MEDIA_PURPOSE_SPECS)) {
    throw new MinkMediaContentError("This image has no usable placement.");
  }
  const sizeBytes = Number(content.size_bytes);
  return {
    url,
    path,
    filename: (content.filename ?? "").slice(0, 255),
    contentType:
      content.content_type === "image/png" ? "image/png" : "image/jpeg",
    sizeBytes: Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : 0,
    purpose,
    prompt: content.prompt ?? "",
    alt: content.alt ?? "",
  };
}
