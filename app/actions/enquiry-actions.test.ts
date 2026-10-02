/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));
vi.mock("@/lib/store/resolve", () => ({
  getCurrentStoreId: vi.fn(async () => "a0000000-0000-4000-8000-000000000001"),
  FALLBACK_STORE_ID: "a0000000-0000-4000-8000-000000000001",
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  clientIp: vi.fn(() => "1.2.3.4"),
}));
vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerUserId: vi.fn(),
  getActingStoreId: vi.fn(async () => "a0000000-0000-4000-8000-000000000001"),
}));
vi.mock("@/lib/store/brand", () => ({
  getStoreBrand: vi.fn(async () => ({
    name: "WholeSip",
    domain: "wholesip.com",
  })),
}));
vi.mock("@/lib/email/enquiry-notifications", () => ({
  sendEnquiryAcknowledgementEmail: vi.fn().mockResolvedValue(undefined),
}));

// The ported data layer: with* runners invoke the callback with the mock db.
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn((_identity: any, fn: any) => fn(dbHolder.current.db)),
  withService: vi.fn((fn: any) => fn(dbHolder.current.db)),
  withAnon: vi.fn((fn: any) => fn(dbHolder.current.db)),
}));

import {
  submitEnquiry,
  updateEnquiryStatus,
  deleteEnquiry,
} from "./enquiry-actions";
import { getManagerUserId } from "@/app/dashboard/lib/access";
import { sendEnquiryAcknowledgementEmail } from "@/lib/email/enquiry-notifications";
import { revalidatePath } from "next/cache";
import { rateLimit } from "@/lib/rate-limit";
import { demoStoreRefusal } from "@/lib/store/demo-guard";

const DEMO =
  "This is a theme preview, so orders, accounts and forms are turned off.";
// Demo stores refuse every public write (lib/store/demo-guard.ts); a real
// store is the default here.
vi.mock("@/lib/store/demo-guard", () => ({
  demoStoreRefusal: vi.fn(async () => null),
}));

const validInput = {
  name: "  Ada Lovelace  ",
  email: "ada@example.com",
  phone: "+91 9876543210",
  subject: "Wholesale",
  subjectDetail: "",
  message: "I'd like to know about bulk pricing.",
};

// enquiry-actions.ts — anonymous storefront submission (service-scope insert +
// best-effort ack email) plus dashboard status/delete actions guarded by the
// "enquiries" manage permission. All writes go through withService with
// explicit store scoping.
describe("enquiry-actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbHolder.current = makeDbMock();
    vi.mocked(getManagerUserId).mockResolvedValue("user-1");
    vi.mocked(sendEnquiryAcknowledgementEmail).mockResolvedValue(undefined);
    vi.mocked(rateLimit).mockResolvedValue({ allowed: true });
  });

  describe("submitEnquiry", () => {
    it("refuses on a theme demo store", async () => {
      vi.mocked(demoStoreRefusal).mockResolvedValueOnce(DEMO);
      const result = await submitEnquiry(validInput);
      expect(result.error).toBe(DEMO);
      expect(dbHolder.current.calls.insert).toHaveLength(0);
    });

    // Name is mandatory — whitespace-only is treated as empty.
    it("rejects empty name", async () => {
      const result = await submitEnquiry({ ...validInput, name: "   " });
      expect(result.error).toMatch(/enter your name/i);
    });

    // Malformed email is rejected before any DB call.
    it("rejects invalid email", async () => {
      const result = await submitEnquiry({
        ...validInput,
        email: "not-an-email",
      });
      expect(result.error).toMatch(/valid email/i);
    });

    // Missing email is also rejected.
    it("rejects missing email", async () => {
      const result = await submitEnquiry({ ...validInput, email: "  " });
      expect(result.error).toMatch(/valid email/i);
    });

    // Phone must have at least 8 digits after stripping non-digits.
    it("rejects a too-short phone number", async () => {
      const result = await submitEnquiry({ ...validInput, phone: "12345" });
      expect(result.error).toMatch(/verified phone/i);
    });

    // Subject must be selected.
    it("rejects missing subject", async () => {
      const result = await submitEnquiry({ ...validInput, subject: "  " });
      expect(result.error).toMatch(/select a subject/i);
    });

    // Message body is mandatory.
    it("rejects missing message", async () => {
      const result = await submitEnquiry({ ...validInput, message: "   " });
      expect(result.error).toMatch(/enter a message/i);
    });

    // Happy path — inserts the trimmed payload, sends the ack email and
    // revalidates the dashboard list.
    it("inserts the enquiry, sends the email, and revalidates", async () => {
      const result = await submitEnquiry(validInput);
      expect(result.success).toBe(true);
      expect(dbHolder.current.calls.values[0]).toEqual({
        name: "Ada Lovelace",
        email: "ada@example.com",
        phone: "+91 9876543210",
        subject: "Wholesale",
        subjectDetail: null,
        message: "I'd like to know about bulk pricing.",
        storeId: "a0000000-0000-4000-8000-000000000001",
      });
      expect(sendEnquiryAcknowledgementEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "ada@example.com",
          name: "Ada Lovelace",
          subject: "Wholesale",
        }),
      );
      expect(revalidatePath).toHaveBeenCalledWith("/dashboard/enquiries");
    });

    // For "Other", the customer-facing email subject becomes the free-text
    // detail they typed rather than the literal word "Other".
    it("uses the free-text detail as the email subject for 'Other'", async () => {
      await submitEnquiry({
        ...validInput,
        subject: "Other",
        subjectDetail: "Partnership idea",
      });
      expect(sendEnquiryAcknowledgementEmail).toHaveBeenCalledWith(
        expect.objectContaining({ subject: "Partnership idea" }),
      );
      const inserted = dbHolder.current.calls.values[0];
      expect(inserted.subject).toBe("Other");
      expect(inserted.subjectDetail).toBe("Partnership idea");
    });

    // When the IP has exceeded its window, reject before touching the DB.
    it("rejects when rate limited (no insert, no email)", async () => {
      vi.mocked(rateLimit).mockResolvedValue({ allowed: false });
      const result = await submitEnquiry(validInput);
      expect(result.error).toMatch(/too many enquiries/i);
      expect(dbHolder.current.calls.insert).toHaveLength(0);
      expect(sendEnquiryAcknowledgementEmail).not.toHaveBeenCalled();
    });

    // DB insert failure → friendly message, no email, no revalidate.
    it("returns a friendly error when the insert fails", async () => {
      dbHolder.current.db.insert = vi.fn(() => {
        throw new Error("boom");
      });
      const result = await submitEnquiry(validInput);
      expect(result.error).toMatch(/something went wrong/i);
      expect(sendEnquiryAcknowledgementEmail).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    });
  });

  describe("updateEnquiryStatus", () => {
    // Permission gate.
    it("rejects when caller lacks enquiries.manage", async () => {
      vi.mocked(getManagerUserId).mockResolvedValue(null);
      const result = await updateEnquiryStatus("id", "resolved");
      expect(result.error).toMatch(/permission/i);
      expect(dbHolder.current.calls.update).toHaveLength(0);
    });

    // Only the four known workflow statuses are accepted.
    it("rejects an invalid status value", async () => {
      const result = await updateEnquiryStatus("id", "bogus" as any);
      expect(result.error).toMatch(/invalid status/i);
      expect(dbHolder.current.calls.update).toHaveLength(0);
    });

    // Happy path — updates the row (store-scoped where) and revalidates.
    it("updates the status and revalidates", async () => {
      const result = await updateEnquiryStatus("id-1", "in_progress");
      expect(result.success).toBe(true);
      expect(dbHolder.current.calls.set[0]).toEqual({ status: "in_progress" });
      expect(dbHolder.current.calls.where).toHaveLength(1);
      expect(revalidatePath).toHaveBeenCalledWith("/dashboard/enquiries");
    });

    // DB error path.
    it("returns an error when the update fails", async () => {
      dbHolder.current.db.update = vi.fn(() => {
        throw new Error("nope");
      });
      const result = await updateEnquiryStatus("id", "resolved");
      expect(result.error).toMatch(/failed to update/i);
    });
  });

  describe("deleteEnquiry", () => {
    // Permission gate.
    it("rejects when caller lacks enquiries.manage", async () => {
      vi.mocked(getManagerUserId).mockResolvedValue(null);
      const result = await deleteEnquiry("id");
      expect(result.error).toMatch(/permission/i);
      expect(dbHolder.current.calls.delete).toHaveLength(0);
    });

    // Happy path — deletes by id (store-scoped where) and revalidates.
    it("deletes the enquiry and revalidates", async () => {
      const result = await deleteEnquiry("id-9");
      expect(result.success).toBe(true);
      expect(dbHolder.current.calls.delete).toHaveLength(1);
      expect(dbHolder.current.calls.where).toHaveLength(1);
      expect(revalidatePath).toHaveBeenCalledWith("/dashboard/enquiries");
    });

    // DB error path.
    it("returns an error when the delete fails", async () => {
      dbHolder.current.db.delete = vi.fn(() => {
        throw new Error("nope");
      });
      const result = await deleteEnquiry("id");
      expect(result.error).toMatch(/failed to delete/i);
    });
  });
});
