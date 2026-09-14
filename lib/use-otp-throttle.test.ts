// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useOtpThrottle,
  MAX_VERIFY_ATTEMPTS,
  MAX_RESENDS,
} from "./use-otp-throttle";

describe("useOtpThrottle", () => {
  it("starts unblocked with full allowances", () => {
    const { result } = renderHook(() => useOtpThrottle());
    expect(result.current.verifyBlocked).toBe(false);
    expect(result.current.resendBlocked).toBe(false);
    expect(result.current.attemptsLeft).toBe(MAX_VERIFY_ATTEMPTS);
    expect(result.current.resendsLeft).toBe(MAX_RESENDS);
  });

  it("blocks verification after MAX_VERIFY_ATTEMPTS failures", () => {
    const { result } = renderHook(() => useOtpThrottle());
    for (let i = 0; i < MAX_VERIFY_ATTEMPTS; i++) {
      act(() => result.current.registerFailedVerify());
    }
    expect(result.current.verifyBlocked).toBe(true);
    expect(result.current.attemptsLeft).toBe(0);
  });

  it("blocks resends after MAX_RESENDS", () => {
    const { result } = renderHook(() => useOtpThrottle());
    for (let i = 0; i < MAX_RESENDS; i++) {
      act(() => result.current.registerResend());
    }
    expect(result.current.resendBlocked).toBe(true);
    expect(result.current.resendsLeft).toBe(0);
  });

  it("a resend clears the failed-verify tally (fresh code, clean slate)", () => {
    const { result } = renderHook(() => useOtpThrottle());
    act(() => {
      result.current.registerFailedVerify();
      result.current.registerFailedVerify();
    });
    expect(result.current.attemptsLeft).toBe(MAX_VERIFY_ATTEMPTS - 2);

    act(() => result.current.registerResend());
    expect(result.current.attemptsLeft).toBe(MAX_VERIFY_ATTEMPTS);
    expect(result.current.resendsLeft).toBe(MAX_RESENDS - 1);
  });

  it("reset() restores the initial state", () => {
    const { result } = renderHook(() => useOtpThrottle());
    act(() => {
      result.current.registerFailedVerify();
      result.current.registerResend();
    });
    act(() => result.current.reset());
    expect(result.current.verifyBlocked).toBe(false);
    expect(result.current.resendBlocked).toBe(false);
    expect(result.current.attemptsLeft).toBe(MAX_VERIFY_ATTEMPTS);
    expect(result.current.resendsLeft).toBe(MAX_RESENDS);
  });
});
