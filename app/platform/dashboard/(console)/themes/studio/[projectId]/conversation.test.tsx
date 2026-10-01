// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ThemeStudioProjectDetail,
  ThemeStudioRunView,
  ThemeStudioVersionView,
} from "@/lib/theme-studio/repository";

const actions = vi.hoisted(() => ({
  queueThemeStudioGenerationAction: vi.fn(async () => ({ ok: true })),
  reviseThemeStudioVersionAction: vi.fn(async () => ({
    ok: true,
    error: undefined as string | undefined,
  })),
  submitThemeStudioDetailsAction: vi.fn(async () => ({ ok: true })),
  removeThemeStudioReferenceAction: vi.fn(async () => ({ ok: true })),
}));
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/app/actions/theme-studio-actions", () => actions);
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
import { ThemeConversation } from "./conversation";

const version: ThemeStudioVersionView = {
  id: "v1",
  versionNumber: 1,
  parentVersionId: null,
  runId: "r1",
  origin: "run",
  editedSlots: [],
  intentDigest: "i",
  packageDigest: "digest-v1",
  summary: "A warm grocery theme.",
  assumptions: [],
  hasPackage: true,
  qaStatus: "passed",
  qaIteration: 0,
  packageSummary: null,
  createdAt: "2026-09-29T10:01:00Z",
};
const project: ThemeStudioProjectDetail = {
  id: "project",
  themeId: "crave",
  name: "Crave",
  status: "ready",
  modelKey: "gemini-3.8-flash",
  industries: ["food-and-drink"],
  catalogSizes: ["small"],
  requiredFeatures: [],
  baseThemeId: null,
  draftBrief: "Build a warm grocery theme.",
  currentVersionId: version.id,
  revision: 3,
  createdByEmail: "op@test.dev",
  createdAt: "2026-09-29T10:00:00Z",
  updatedAt: "2026-09-29T10:01:00Z",
  references: Array.from({ length: 10 }, (_, i) => ({
    id: `old-${i}`,
    width: 100,
    height: 100,
    byteSize: 100,
    originalByteSize: 100,
    originalMediaType: "image/png",
    createdAt: "2026-09-29T10:00:00Z",
    cited: true,
  })),
  messages: [
    {
      id: "m1",
      kind: "brief",
      body: "Build a grocery theme",
      referenceCount: 10,
      referenceAssetIds: ["old-0"],
      automatic: false,
      createdAt: "2026-09-29T10:00:00Z",
    },
  ],
  runs: [],
  versions: [version],
  previews: [],
  events: [],
};
const props = {
  project,
  generationEnabled: true,
  referenceLimit: 10,
  target: version,
  canRevise: true,
  onSelectVersion: vi.fn(),
  composerRef: createRef<HTMLTextAreaElement>(),
};
const message = () =>
  screen.getByRole("textbox", { name: "Message Theme Studio" });
const send = () => screen.getByRole("button", { name: "Send message" });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Theme Studio conversation", () => {
  it("opens acceptance findings as an editable draft and sends only after operator review", async () => {
    render(
      <ThemeConversation
        {...props}
        initialBody="Fix contrast in version 1: .shop-card-base"
      />,
    );
    expect((message() as HTMLTextAreaElement).value).toContain(
      ".shop-card-base",
    );
    expect(actions.reviseThemeStudioVersionAction).not.toHaveBeenCalled();
    fireEvent.change(message(), {
      target: { value: "Fix contrast; preserve the golden header." },
    });
    fireEvent.click(screen.getByLabelText("Attach screenshot 1"));
    fireEvent.click(send());
    await waitFor(() =>
      expect(actions.reviseThemeStudioVersionAction).toHaveBeenCalledWith(
        expect.objectContaining({
          versionId: "v1",
          expectedPackageDigest: "digest-v1",
          body: "Fix contrast; preserve the golden header.",
          referenceAssetIds: ["old-0"],
        }),
      ),
    );
  });

  it("attaches a new screenshot after ten historical references and sends only the selected image with the revision", async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      json: async () => ({ id: "new-image" }),
    }));
    vi.stubGlobal("fetch", fetcher);
    render(<ThemeConversation {...props} />);
    expect(
      screen.getByRole("link", { name: "Preview version 1" }),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Upload screenshots"), {
      target: {
        files: [
          new File(["image"], "broken-header.png", { type: "image/png" }),
        ],
      },
    });
    await screen.findByAltText("Screenshot 1 to send");
    fireEvent.change(message(), {
      target: { value: "Fix the header as shown in my screenshot" },
    });
    fireEvent.click(send());
    await waitFor(() =>
      expect(actions.reviseThemeStudioVersionAction).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "project",
          versionId: "v1",
          expectedRevision: 3,
          expectedPackageDigest: "digest-v1",
          body: "Fix the header as shown in my screenshot",
          referenceAssetIds: ["new-image"],
        }),
      ),
    );
    expect(actions.queueThemeStudioGenerationAction).not.toHaveBeenCalled();
    expect((send() as HTMLButtonElement).disabled).toBe(true);
  });

  it.each(["paste", "drop"])("accepts screenshots via %s", async (method) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ id: "pasted" }) })),
    );
    render(<ThemeConversation {...props} />);
    const files = [new File(["image"], "screen.png", { type: "image/png" })];
    if (method === "paste")
      fireEvent.paste(message(), { clipboardData: { files } });
    else fireEvent.drop(message(), { dataTransfer: { files } });
    await screen.findByAltText("Screenshot 1 to send");
  });

  it("retains the message and attachments when sending fails and reuses its idempotency key", async () => {
    actions.reviseThemeStudioVersionAction.mockResolvedValueOnce({
      ok: false,
      error: "Try again",
    });
    render(<ThemeConversation {...props} />);
    fireEvent.click(screen.getByLabelText("Attach screenshot 1"));
    fireEvent.change(message(), { target: { value: "Fix spacing" } });
    fireEvent.click(send());
    await waitFor(() =>
      expect(actions.reviseThemeStudioVersionAction).toHaveBeenCalledTimes(1),
    );
    expect((message() as HTMLTextAreaElement).value).toBe("Fix spacing");
    expect(screen.getByAltText("Screenshot 1 to send")).toBeTruthy();
    fireEvent.click(send());
    await waitFor(() =>
      expect(actions.reviseThemeStudioVersionAction).toHaveBeenCalledTimes(2),
    );
    expect(actions.reviseThemeStudioVersionAction.mock.calls[0]).toEqual(
      actions.reviseThemeStudioVersionAction.mock.calls[1],
    );
  });

  it("sends the edited initial brief through the same composer", async () => {
    render(
      <ThemeConversation
        {...props}
        canRevise={false}
        target={null}
        project={{ ...project, status: "draft", messages: [], versions: [] }}
      />,
    );
    fireEvent.change(message(), { target: { value: "Build a bakery theme" } });
    fireEvent.click(send());
    await waitFor(() =>
      expect(actions.queueThemeStudioGenerationAction).toHaveBeenCalledWith(
        expect.objectContaining({
          body: "Build a bakery theme",
          referenceAssetIds: [],
        }),
      ),
    );
  });

  it("answers clarification questions with the selected screenshots instead of starting a separate revision", async () => {
    const run = {
      id: "r1",
      questions: ["Which header is the reference?"],
      status: "succeeded",
      createdAt: "2026-09-29T10:02:00Z",
      finishedAt: "2026-09-29T10:03:00Z",
    } as ThemeStudioRunView;
    render(
      <ThemeConversation
        {...props}
        canRevise={false}
        project={{ ...project, status: "blocked", runs: [run] }}
      />,
    );
    expect(screen.getByText("Which header is the reference?")).toBeTruthy();
    fireEvent.change(message(), { target: { value: "Use this header" } });
    fireEvent.click(send());
    await waitFor(() =>
      expect(actions.submitThemeStudioDetailsAction).toHaveBeenCalledWith(
        expect.objectContaining({
          body: "Use this header",
          referenceAssetIds: ["old-0"],
        }),
      ),
    );
    expect(actions.reviseThemeStudioVersionAction).not.toHaveBeenCalled();
  });

  it("removes attachments from the next message without deleting screenshot history", async () => {
    render(<ThemeConversation {...props} />);
    fireEvent.click(screen.getByLabelText("Attach screenshot 1"));
    fireEvent.click(
      screen.getByRole("button", { name: "Remove screenshot 1 from message" }),
    );
    expect(screen.queryByLabelText("Message attachments")).toBeNull();
    expect(screen.getByAltText("Attached screenshot 1")).toBeTruthy();
    expect(actions.removeThemeStudioReferenceAction).not.toHaveBeenCalled();
  });

  it("blocks a second request while generation is running and hides automatic repair prompts", () => {
    render(
      <ThemeConversation
        {...props}
        canRevise={false}
        project={{
          ...project,
          status: "generating",
          messages: [
            ...project.messages,
            {
              ...project.messages[0],
              id: "internal",
              body: "internal repair prompt",
              automatic: true,
            },
          ],
        }}
      />,
    );
    expect((message() as HTMLTextAreaElement).disabled).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: /Attach screenshots/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.queryByText("internal repair prompt")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(
      "running acceptance",
    );
  });
});
