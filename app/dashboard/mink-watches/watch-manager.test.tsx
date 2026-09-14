// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MinkWatchManager } from "./watch-manager";
const fetchMock = vi.fn();
const data = {
  watches: [],
  locations: ["Shop", "Delhi"],
  timeZone: "Asia/Kolkata",
};
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
beforeEach(() => {
  fetchMock.mockReset().mockImplementation(async () => response(data));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("human watch controls", () => {
  it("requires consent before enabling and sends selected Echos scope", async () => {
    render(<MinkWatchManager />);
    const enable = await screen.findByRole("button", { name: "Enable watch" });
    expect(enable).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Location"), {
      target: { value: "Delhi" },
    });
    fireEvent.click(screen.getByLabelText(/I reviewed these settings/));
    expect(enable).not.toBeDisabled();
    fireEvent.click(enable);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((call) => call[1]?.method === "POST"),
      ).toBe(true),
    );
    const call = fetchMock.mock.calls.find(
      (call) => call[1]?.method === "POST",
    )!;
    expect(JSON.parse(call[1].body)).toMatchObject({
      action: "create",
      confirmed: true,
      locationName: "Delhi",
      schedule: {
        frequency: "daily",
        time: "09:00",
        quietStart: "22:00",
        quietEnd: "08:00",
      },
    });
  });
  it("supports weekly timing and no quiet hours", async () => {
    render(<MinkWatchManager />);
    await screen.findByRole("button", { name: "Enable watch" });
    fireEvent.change(screen.getByLabelText("Repeat"), {
      target: { value: "weekly" },
    });
    expect(screen.getByLabelText("Day")).toHaveValue("1");
    fireEvent.click(screen.getByLabelText("Quiet hours for notifications"));
    expect(screen.queryByLabelText("From")).not.toBeInTheDocument();
  });
  it("shows an honest error instead of a successful empty list", async () => {
    fetchMock.mockResolvedValue(response({ error: "No access" }, 403));
    render(<MinkWatchManager />);
    expect(await screen.findByRole("alert")).toHaveTextContent("No access");
  });
  it("requires delete confirmation and passes the exact version", async () => {
    const watch = {
      id: "one",
      kind: "inventory",
      status: "paused",
      version: 3,
      locationLabel: "Delhi",
      timeZone: "Asia/Kolkata",
      schedule: { frequency: "daily", time: "09:00" },
      result: null,
    };
    fetchMock.mockImplementation(async () =>
      response({ ...data, watches: [watch] }),
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<MinkWatchManager />);
    const remove = await screen.findByRole("button", { name: "Delete" });
    fireEvent.click(remove);
    expect(
      fetchMock.mock.calls.some((call) => call[1]?.method === "POST"),
    ).toBe(false);
    confirm.mockReturnValue(true);
    fireEvent.click(remove);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((call) => call[1]?.method === "POST"),
      ).toBe(true),
    );
    const call = fetchMock.mock.calls.find(
      (call) => call[1]?.method === "POST",
    )!;
    expect(JSON.parse(call[1].body)).toEqual({
      action: "delete",
      id: "one",
      version: 3,
    });
    confirm.mockRestore();
  });
});
