import { describe, it, expect, vi, beforeEach } from "vitest";

const execute = vi.fn();
const withService = vi.fn();

vi.mock("@/lib/db/client", () => ({
  withService: (fn: (db: unknown) => unknown) => withService(fn),
}));
vi.mock("@/lib/observability/logger", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

import { claimPosCustomer } from "./claim-customer";

/** The SQL the last call actually sent, flattened for assertion. */
function lastSql(): string {
  // Every statement the claim sent — the guards are split across the lookup and
  // the claim itself, and both must carry them.
  return JSON.stringify(execute.mock.calls);
}

beforeEach(() => {
  vi.clearAllMocks();
  // ⚠ clearAllMocks clears CALLS, not IMPLEMENTATIONS — restore both explicitly
  // every time (AGENTS.md convention #8), or a rejection set in one test leaks.
  // The claim runs: SELECT (find the pos_ row) → UPDATE (claim it) → repoints.
  // Default = nothing to claim.
  execute.mockResolvedValue({ rowCount: 0, rows: [] });
  withService.mockImplementation((fn: (db: unknown) => unknown) =>
    fn({ execute }),
  );
});

const INPUT = {
  uid: "firebaseUid123",
  storeId: "a0000000-0000-4000-8000-000000000001",
  verifiedPhone: "+91 98765 43210",
};

describe("claimPosCustomer", () => {
  it("claims when the statement matched a row", async () => {
    execute.mockResolvedValue({ rowCount: 1, rows: [{ id: "pos_abc" }] });
    await expect(claimPosCustomer(INPUT)).resolves.toEqual({ claimed: true });
  });

  it("looks for both phone shapes the code has written", async () => {
    // ★★ WHY. Website signup wrote Identity Platform's E.164 straight through
    // while the till writes the national form, so a till row could be stored
    // in either shape depending on when it was made. Matching only one meant
    // the claim silently never fired for the other, and the shopper got a
    // second row with none of their in-store history.
    execute.mockResolvedValue({ rowCount: 1, rows: [{ id: "pos_abc" }] });
    await claimPosCustomer(INPUT);
    const sent = lastSql();
    // Both shapes are bound, canonical first.
    expect(sent).toContain("9876543210");
    expect(sent).toContain("+919876543210");
  });

  it("does nothing when no unclaimed till row exists for that phone", async () => {
    execute.mockResolvedValue({ rowCount: 0, rows: [] });
    await expect(claimPosCustomer(INPUT)).resolves.toEqual({ claimed: false });
    // Found nothing, so it must not have attempted the rewrite.
    expect(execute).toHaveBeenCalledTimes(1);
  });

  // ★★ The cascade only reaches tables with a foreign key, and these have none.
  // The credit ones hold MONEY: a walk-in refunded to store credit at the till
  // would otherwise have their balance orphaned by their own signup.
  describe("repoints the tables the FK cascade cannot reach", () => {
    let sent: string;
    beforeEach(async () => {
      execute.mockResolvedValue({ rowCount: 1, rows: [{ id: "pos_abc" }] });
      await claimPosCustomer(INPUT);
      sent = JSON.stringify(execute.mock.calls);
    });

    it.each([
      ["customer_credit_balances", "the balance is money owed"],
      ["customer_credit_ledger", "and its history explains the balance"],
      ["notifications", "their bell should not be empty"],
      ["notification_email_queue", "mail already queued is still theirs"],
      ["orders", "collected_by is their name on a pickup"],
    ])("repoints %s — %s", (table) => {
      expect(sent).toContain(table);
    });

    it("moves them to the new uid, keyed off the OLD pos_ id", () => {
      expect(sent).toContain("pos_abc");
      expect(sent).toContain(INPUT.uid);
    });

    // Only the customer's own rows — a store admin shares these tables.
    it("scopes the notification repoints to recipient_type customer", () => {
      expect(sent).toContain("recipient_type = 'customer'");
    });
  });

  // ★ Atomic: no claim at all beats a claim that moved the person and left
  // their store-credit balance behind.
  it("rolls the whole claim back when a repoint fails", async () => {
    execute
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "pos_abc" }] }) // select
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: INPUT.uid }] }) // claim
      .mockRejectedValueOnce(new Error("credit table unavailable"));
    await expect(claimPosCustomer(INPUT)).resolves.toEqual({ claimed: false });
  });

  it("reports no claim when nothing matched", async () => {
    // The claim runs: SELECT (find the pos_ row) → UPDATE (claim it) → repoints.
    // Default = nothing to claim.
    execute.mockResolvedValue({ rowCount: 0, rows: [] });
    await expect(claimPosCustomer(INPUT)).resolves.toEqual({ claimed: false });
  });

  // The driver returns a Result; several mocks return a bare array. The
  // exactly-once guarantee is read from this number, so both must agree.
  it("reads a row count from a bare array too", async () => {
    execute.mockResolvedValue([{ id: "pos_abc" }]);
    await expect(claimPosCustomer(INPUT)).resolves.toEqual({ claimed: true });
    execute.mockResolvedValue([]);
    await expect(claimPosCustomer(INPUT)).resolves.toEqual({ claimed: false });
  });

  it("does not query at all without a verified phone", async () => {
    await expect(
      claimPosCustomer({ ...INPUT, verifiedPhone: null }),
    ).resolves.toEqual({ claimed: false });
    expect(execute).not.toHaveBeenCalled();
  });

  // ★ An unusable phone can never match a signup, so asking is wasted work —
  // and storing one would have been the real bug upstream.
  it("does not query on an unparseable phone", async () => {
    await expect(
      claimPosCustomer({ ...INPUT, verifiedPhone: "12345" }),
    ).resolves.toEqual({ claimed: false });
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not query without a uid or a store", async () => {
    await claimPosCustomer({ ...INPUT, uid: "" });
    await claimPosCustomer({ ...INPUT, storeId: "" });
    expect(execute).not.toHaveBeenCalled();
  });

  // ★ NEVER THROWS. A failed claim costs a link to in-store history; a thrown
  // one would cost the shopper their signup.
  it("swallows a database failure rather than failing the signup", async () => {
    execute.mockRejectedValue(new Error("connection reset"));
    await expect(claimPosCustomer(INPUT)).resolves.toEqual({ claimed: false });
  });

  it("swallows a failure to even open the transaction", async () => {
    withService.mockRejectedValue(new Error("pool exhausted"));
    await expect(claimPosCustomer(INPUT)).resolves.toEqual({ claimed: false });
  });

  describe("the four guards are all in the statement", () => {
    beforeEach(async () => {
      execute.mockResolvedValue({ rowCount: 1, rows: [{ id: "pos_abc" }] });
      await claimPosCustomer(INPUT);
    });

    it("scopes to the store", () => {
      expect(lastSql()).toContain("store_id");
    });

    it("matches on the normalised phone, not the raw input", () => {
      const sent = lastSql();
      expect(sent).toContain("9876543210");
      expect(sent).not.toContain("+91 98765 43210");
    });

    // ★ Without this a signup could take over another signup's row.
    it("requires a pos_ id", () => {
      expect(lastSql()).toContain("pos\\\\_%");
    });

    // ★ Without this one customer's history goes to whoever typed their number.
    it("requires claimed_at to be null", () => {
      expect(lastSql()).toContain("claimed_at is null");
    });

    // ★ Without this a returning shopper hits a raw primary-key violation on a
    // profile save instead of a clean no-op.
    it("requires the uid to have no row of its own yet", () => {
      expect(lastSql()).toContain("not exists");
    });

    it("stamps claimed_at so the row can never be adopted twice", () => {
      expect(lastSql()).toContain("claimed_at = now()");
    });
  });
});
