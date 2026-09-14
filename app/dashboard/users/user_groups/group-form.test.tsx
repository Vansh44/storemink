// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";

const { push, refresh } = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

vi.mock("next/link", () => ({
  default: ({ children, ...p }: any) => <a {...p}>{children}</a>,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/app/actions/user-group-actions", () => ({
  createUserGroup: vi.fn(),
  updateUserGroup: vi.fn(),
}));

import { GroupForm } from "./group-form";
import { toast } from "sonner";
import {
  createUserGroup,
  updateUserGroup,
} from "@/app/actions/user-group-actions";
import type { UserGroup } from "./shared";

const EXISTING: UserGroup = {
  id: "grp-1",
  name: "VIP shoppers",
  description: "Top spenders",
  color: "green",
  created_at: "",
  updated_at: "",
  member_ids: [],
  member_count: 0,
};

describe("GroupForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the New group heading in create mode", () => {
    render(<GroupForm group={null} />);
    expect(
      screen.getByRole("heading", { name: "New group" }),
    ).toBeInTheDocument();
  });

  it("blocks an empty name with a toast and does not call the action", async () => {
    const user = userEvent.setup();
    render(<GroupForm group={null} />);

    await user.click(screen.getByRole("button", { name: "Create group" }));

    expect(toast.error).toHaveBeenCalledWith("Group name is required");
    expect(createUserGroup).not.toHaveBeenCalled();
  });

  it("creates a group with the default colour and navigates on success", async () => {
    const user = userEvent.setup();
    vi.mocked(createUserGroup).mockResolvedValue({} as any);
    render(<GroupForm group={null} />);

    await user.type(
      screen.getByPlaceholderText("e.g. VIP shoppers"),
      "Newbies",
    );
    await user.type(
      screen.getByPlaceholderText("Optional — what this group is for"),
      "Just joined",
    );
    await user.click(screen.getByRole("button", { name: "Create group" }));

    await waitFor(() =>
      expect(createUserGroup).toHaveBeenCalledWith({
        name: "Newbies",
        description: "Just joined",
        color: "blue",
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Group created");
    expect(push).toHaveBeenCalledWith("/dashboard/users/user_groups");
    expect(refresh).toHaveBeenCalled();
  });

  it("surfaces the action error and does not navigate", async () => {
    const user = userEvent.setup();
    vi.mocked(createUserGroup).mockResolvedValue({ error: "dupe" } as any);
    render(<GroupForm group={null} />);

    await user.type(screen.getByPlaceholderText("e.g. VIP shoppers"), "Dup");
    await user.click(screen.getByRole("button", { name: "Create group" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("dupe"));
    expect(push).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("passes the chosen colour to the action", async () => {
    const user = userEvent.setup();
    vi.mocked(createUserGroup).mockResolvedValue({} as any);
    render(<GroupForm group={null} />);

    await user.type(screen.getByPlaceholderText("e.g. VIP shoppers"), "Greens");
    await user.click(screen.getByRole("button", { name: "green" }));
    await user.click(screen.getByRole("button", { name: "Create group" }));

    await waitFor(() =>
      expect(createUserGroup).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Greens", color: "green" }),
      ),
    );
  });

  it("renders Edit group with prefilled fields and updates on save", async () => {
    const user = userEvent.setup();
    vi.mocked(updateUserGroup).mockResolvedValue({} as any);
    render(<GroupForm group={EXISTING} />);

    expect(
      screen.getByRole("heading", { name: "Edit group" }),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText("e.g. VIP shoppers")).toHaveValue(
      "VIP shoppers",
    );
    expect(
      screen.getByPlaceholderText("Optional — what this group is for"),
    ).toHaveValue("Top spenders");

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(updateUserGroup).toHaveBeenCalledWith("grp-1", {
        name: "VIP shoppers",
        description: "Top spenders",
        color: "green",
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Group updated");
  });

  it("Cancel navigates back to the list", async () => {
    const user = userEvent.setup();
    render(<GroupForm group={null} />);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(push).toHaveBeenCalledWith("/dashboard/users/user_groups");
  });
});
