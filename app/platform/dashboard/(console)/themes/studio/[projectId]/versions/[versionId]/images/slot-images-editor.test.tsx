// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThemeStudioSlotView } from "@/lib/theme-studio/slot-images";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
const queue = vi.fn();
vi.mock("@/app/actions/theme-studio-actions", () => ({
  queueThemeStudioImagesAction: (...args: unknown[]) => queue(...args),
  replaceThemeStudioSlotImagesAction: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { SlotImagesEditor, historyLine } from "./slot-images-editor";

afterEach(() => cleanup());

const slot = (over: Partial<ThemeStudioSlotView>): ThemeStudioSlotView => ({
  id: "slot",
  path: "theme-asset://slot",
  kind: "product",
  width: 1280,
  height: 1600,
  alt: "Alt",
  source: "generated",
  licenseNote: null,
  placeholder: false,
  catalogPreview: false,
  catalogScreenshot: false,
  usage: [],
  url: null,
  redrawable: true,
  brief: null,
  history: null,
  ...over,
});

const history = (
  over: Partial<NonNullable<ThemeStudioSlotView["history"]>>,
): NonNullable<ThemeStudioSlotView["history"]> => ({
  runId: "r",
  createdAt: "2026-09-27",
  status: "generated",
  attempts: 1,
  review: "passed",
  problems: [],
  note: "",
  reason: null,
  costMicroUsd: 103_000,
  redraw: false,
  ...over,
});

const slots: ThemeStudioSlotView[] = [
  slot({
    id: "home-hero",
    kind: "hero",
    brief: {
      purpose: "Homepage hero",
      subject: "Stoneware on linen",
      artDirection: "Soft window light.",
      aspectRatio: "16:9",
    },
    history: history({ attempts: 2 }),
  }),
  slot({
    id: "product-photo--mug",
    placeholder: true,
    brief: {
      purpose: "Product photography",
      subject: "Speckled mug",
      artDirection: "",
      aspectRatio: "4:5",
    },
  }),
  slot({
    id: "category-bowls",
    kind: "category",
    source: "operator-owned",
    redrawable: false,
  }),
];

function renderEditor(
  over: Partial<Parameters<typeof SlotImagesEditor>[0]> = {},
) {
  render(
    <SlotImagesEditor
      projectId="p"
      versionId="v"
      versionNumber={2}
      nextVersionNumber={3}
      packageDigest={"d".repeat(64)}
      revision={5}
      canEdit
      blockedReason={null}
      slots={slots}
      anchorReusable
      prices={{ imageUsd: 0.1, reviewUsd: 0.003 }}
      {...over}
    />,
  );
  // Show generated images as well as placeholders.
  fireEvent.click(screen.getByLabelText("Show only slots with a placeholder"));
}

const card = (id: string) => screen.getByText(id).closest("li")!;

describe("each slot", () => {
  it("says how its image came to be, what it cost, and what was asked for", () => {
    renderEditor();
    const hero = within(card("home-hero"));
    expect(hero.getByText("Drawn and checked after a redraw.")).toBeTruthy();
    expect(hero.getByText(/~\$0\.10 estimated/)).toBeTruthy();
    expect(hero.getByText("What the image model is asked for")).toBeTruthy();
    expect(hero.getByText("Stoneware on linen")).toBeTruthy();
    expect(hero.getByText("Soft window light.")).toBeTruthy();
    expect(hero.getByText("16:9")).toBeTruthy();
  });

  it("offers a redraw only for a placeholder or generated image", () => {
    renderEditor();
    expect(within(card("home-hero")).getByLabelText("Redraw")).toBeTruthy();
    expect(
      within(card("product-photo--mug")).getByLabelText("Draw"),
    ).toBeTruthy();
    expect(within(card("category-bowls")).queryByRole("checkbox")).toBeNull();
  });
});

describe("redrawing", () => {
  it("states the cost before anything is queued, then sends the chosen slots in page order", async () => {
    queue.mockResolvedValue({ ok: true, id: "run" });
    renderEditor();
    fireEvent.click(within(card("product-photo--mug")).getByLabelText("Draw"));
    fireEvent.click(within(card("home-hero")).getByLabelText("Redraw"));
    expect(
      screen.getByText(
        "2 images, about $0.21, at most $0.41 if each needs a redraw.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Redraw 2 images" }));
    expect(queue).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm redraw" }));
    await vi.waitFor(() =>
      expect(push).toHaveBeenCalledWith("/dashboard/themes/studio/p"),
    );
    expect(queue).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p",
        versionId: "v",
        expectedRevision: 5,
        expectedPackageDigest: "d".repeat(64),
        slotIds: ["home-hero", "product-photo--mug"],
      }),
    );
  });

  it("says when a new art-direction image is needed, and that the test provider is free", () => {
    renderEditor({ anchorReusable: false });
    fireEvent.click(within(card("home-hero")).getByLabelText("Redraw"));
    expect(
      screen.getByText(
        "2 images (with a new art-direction image), about $0.21, at most $0.41 if each needs a redraw.",
      ),
    ).toBeTruthy();
    cleanup();
    renderEditor({ prices: null });
    fireEvent.click(within(card("home-hero")).getByLabelText("Redraw"));
    expect(
      screen.getByText("The test provider redraws at no cost."),
    ).toBeTruthy();
  });

  it("cannot be ticked or started while the project cannot draw", () => {
    renderEditor({ canEdit: false, blockedReason: "Wait for the run." });
    expect(
      (within(card("home-hero")).getByLabelText("Redraw") as HTMLInputElement)
        .disabled,
    ).toBe(true);
  });
});

describe("the history line", () => {
  it("names what the check found, and says when a placeholder was kept", () => {
    expect(
      historyLine(
        history({
          review: "flagged",
          attempts: 2,
          problems: ["staging_mismatch"],
          note: "Different backdrop.",
        }),
      ),
    ).toEqual({
      text: "Drawn after a redraw; kept with a different setup from the other products — Different backdrop.",
      tone: "warn",
    });
    expect(
      historyLine(
        history({
          status: "rejected",
          attempts: 2,
          review: null,
          problems: ["text_or_logo", "person"],
          note: "",
        }),
      ),
    ).toEqual({
      text: "Failed its check twice (lettering or a logo, a person). The placeholder was kept.",
      tone: "bad",
    });
    expect(
      historyLine(history({ status: "refused", reason: "IMAGE_SAFETY" })).text,
    ).toBe("The image model refused it (IMAGE_SAFETY).");
    expect(
      historyLine(history({ status: "failed", reason: "rate_limited" })).text,
    ).toBe("Not drawn (rate_limited).");
    expect(historyLine(history({ review: "unreviewed" }))).toEqual({
      text: "Drawn; not checked.",
      tone: "warn",
    });
  });
});
