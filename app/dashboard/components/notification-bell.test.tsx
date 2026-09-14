// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMyNotifications,
  getUnreadNotificationCount,
} from "@/app/actions/notification-actions";
import { NotificationBell } from "./notification-bell";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/app/actions/notification-actions", () => ({
  getMyNotifications: vi.fn(),
  getUnreadNotificationCount: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  markNotificationRead: vi.fn(),
}));

describe("NotificationBell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getUnreadNotificationCount).mockResolvedValue(1);
    vi.mocked(getMyNotifications).mockResolvedValue({
      unread: 1,
      notifications: [
        {
          id: "n1",
          type: "plan.changed",
          title: "Plan changed",
          body: "Changed by StoreMink",
          url: "/dashboard/plans",
          severity: "info",
          read_at: null,
          created_at: "2026-08-31T00:00:00.000Z",
        },
      ],
    });
  });

  it("anchors the phone inbox to viewport gutters and keeps desktop alignment", async () => {
    render(<NotificationBell />);

    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
    const panel = await screen.findByRole("dialog", {
      name: "Notifications",
    });

    expect(panel).toHaveClass(
      "fixed",
      "inset-x-3",
      "top-16",
      "w-auto",
      "max-h-[calc(100dvh-5rem)]",
      "overscroll-contain",
      "sm:absolute",
      "sm:right-0",
    );
    await waitFor(() => expect(screen.getByText("Plan changed")).toBeVisible());
  });
});
