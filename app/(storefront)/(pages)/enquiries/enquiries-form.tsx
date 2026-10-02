"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  RecaptchaVerifier,
  signInWithPhoneNumber,
  type ConfirmationResult,
} from "firebase/auth";
import {
  getSecondaryFirebaseAuth,
  firebaseAuthErrorMessage,
} from "@/lib/auth/firebase-client";
import { useAuth } from "../../components/auth/AuthProvider";
import { submitEnquiry } from "@/app/actions/enquiry-actions";
import styles from "./enquiries.module.css";
import PhoneInput from "react-phone-number-input";
import "react-phone-number-input/style.css";
import { customPhoneLabels } from "@/lib/phone-labels";
import { CountrySelect } from "@/components/ui/phone-country-select";
import { useOtpThrottle } from "@/lib/use-otp-throttle";
import { DEMO_STORE_MESSAGE as DEMO_FORM_MESSAGE } from "@/lib/store/demo-copy";

// Preset enquiry topics. "Other" reveals a free-text field.
const SUBJECT_OPTIONS = [
  "General enquiry",
  "Bulk / Wholesale order",
  "Order support",
  "Product question",
  "Collaboration / Partnership",
  "Feedback",
  "Other",
];
const OTHER = "Other";

const OTP_LENGTH = 6;
const RESEND_COOLDOWN = 30;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function formatPhone(p?: string | null): string {
  if (!p) return "";
  return p.startsWith("+") ? p : `+${p}`;
}

export default function EnquiriesForm({
  demoStore = false,
}: {
  /** Theme preview: show the form, send nothing. */
  demoStore?: boolean;
} = {}) {
  const { user, customer } = useAuth();

  const [submitted, setSubmitted] = useState(false);

  // Form fields
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState<string | undefined>("");
  const [subjectChoice, setSubjectChoice] = useState("");
  const [customSubject, setCustomSubject] = useState("");
  const [message, setMessage] = useState("");

  // Phone verification
  const [phoneVerified, setPhoneVerified] = useState(false);
  const [verifiedPhone, setVerifiedPhone] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [otp, setOtp] = useState<string[]>(Array(OTP_LENGTH).fill(""));
  const [sendingOtp, setSendingOtp] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [resendTimer, setResendTimer] = useState(0);

  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();

  // Client-side caps on wrong-code submissions and resends (see hook).
  const {
    verifyBlocked,
    resendBlocked,
    registerFailedVerify,
    registerResend,
    reset: resetOtpThrottle,
  } = useOtpThrottle();

  const otpRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Phone verification runs on an ISOLATED secondary Firebase app so it never
  // logs the enquirer in or touches the main session — we only prove ownership.
  const recaptchaRef = useRef<HTMLDivElement | null>(null);
  const verifierRef = useRef<RecaptchaVerifier | null>(null);
  const confirmationRef = useRef<ConfirmationResult | null>(null);

  const getVerifier = (): RecaptchaVerifier => {
    if (!verifierRef.current) {
      verifierRef.current = new RecaptchaVerifier(
        getSecondaryFirebaseAuth(),
        recaptchaRef.current!,
        { size: "invisible" },
      );
    }
    return verifierRef.current;
  };

  // An already-signed-in customer's phone is verified (their account number),
  // so they skip OTP entirely. Latch this once, adjusting state during render
  // (lint forbids set-state-in-effect) without clobbering later edits.
  const [userLatched, setUserLatched] = useState(false);
  if (user && !userLatched) {
    setUserLatched(true);
    setPhoneVerified(true);
    setVerifiedPhone(formatPhone(user.phone));
  }
  const [prefilled, setPrefilled] = useState(false);
  if (customer && !prefilled) {
    setPrefilled(true);
    const fullName = [customer.first_name, customer.last_name]
      .filter(Boolean)
      .join(" ")
      .trim();
    if (fullName) setName(fullName);
    if (customer.email) setEmail(customer.email);
  }

  // Resend cooldown countdown (a timer subscription — the correct use of an
  // effect, mirroring the auth modal).
  useEffect(() => {
    if (resendTimer <= 0) return;
    const interval = setInterval(
      () => setResendTimer((prev) => prev - 1),
      1000,
    );
    return () => clearInterval(interval);
  }, [resendTimer]);

  const fullPhone = phone || "";
  const otpActive = otpSent && !phoneVerified;

  // ---- Phone: send the OTP ----
  const sendOtp = async () => {
    if (demoStore) {
      setError(DEMO_FORM_MESSAGE);
      return;
    }
    if (!phone || phone.trim().length < 10) {
      setError("Please enter a valid 10-digit phone number.");
      return;
    }
    // A send while a code is already out is a "resend" — cap those.
    const isResend = otpSent;
    if (isResend && resendBlocked) {
      setError("Too many code requests. Please try again later.");
      return;
    }
    setError("");
    setSendingOtp(true);
    try {
      confirmationRef.current = await signInWithPhoneNumber(
        getSecondaryFirebaseAuth(),
        fullPhone,
        getVerifier(),
      );
      if (isResend) registerResend();
      setOtp(Array(OTP_LENGTH).fill(""));
      setOtpSent(true);
      setResendTimer(RESEND_COOLDOWN);
      setSendingOtp(false);
      setTimeout(() => otpRefs.current[0]?.focus(), 100);
    } catch (err) {
      setError(
        firebaseAuthErrorMessage(err) ||
          "Something went wrong sending the code. Please try again.",
      );
      setSendingOtp(false);
    }
  };

  // ---- Phone: verify the OTP (does NOT establish a session) ----
  const handleVerifyOtp = useCallback(
    async (otpValue: string) => {
      if (verifyBlocked) return;
      if (!confirmationRef.current) {
        setError("Please request a code first.");
        return;
      }
      setError("");
      setVerifying(true);
      try {
        // Confirm on the secondary app (proves ownership), then immediately
        // sign that throwaway session out — the enquirer stays logged out and
        // the main AuthProvider session is untouched.
        await confirmationRef.current.confirm(otpValue);
        await getSecondaryFirebaseAuth().signOut();
        setVerifying(false);
        setPhoneVerified(true);
        setVerifiedPhone(fullPhone);
        setOtpSent(false);
      } catch (err) {
        registerFailedVerify();
        setError(
          firebaseAuthErrorMessage(err) ||
            "Verification failed. Please try again.",
        );
        setVerifying(false);
      }
    },
    [fullPhone, verifyBlocked, registerFailedVerify],
  );

  const resetPhone = () => {
    setOtpSent(false);
    setOtp(Array(OTP_LENGTH).fill(""));
    setError("");
    resetOtpThrottle();
  };

  // ---- OTP input handlers ----
  const handleOtpChange = (index: number, value: string) => {
    const digit = value.replace(/\D/g, "").slice(-1);
    const next = [...otp];
    next[index] = digit;
    setOtp(next);
    if (digit && index < OTP_LENGTH - 1) {
      otpRefs.current[index + 1]?.focus();
    }
    const joined = next.join("");
    if (joined.length === OTP_LENGTH) {
      handleVerifyOtp(joined);
    }
  };

  const handleOtpKeyDown = (
    index: number,
    e: React.KeyboardEvent<HTMLInputElement>,
  ) => {
    if (e.key === "Backspace" && !otp[index] && index > 0) {
      otpRefs.current[index - 1]?.focus();
    }
  };

  const handleOtpPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "");
    if (pasted.length === OTP_LENGTH) {
      setOtp(pasted.split(""));
      handleVerifyOtp(pasted);
    }
  };

  // ---- Submit ----
  const doSubmit = useCallback(() => {
    setError("");
    startTransition(async () => {
      const result = await submitEnquiry({
        name: name.trim(),
        email: email.trim(),
        phone: verifiedPhone,
        subject: subjectChoice || undefined,
        subjectDetail:
          subjectChoice === OTHER ? customSubject.trim() : undefined,
        message: message.trim(),
      });
      if (result.error) {
        setError(result.error);
      } else {
        setSubmitted(true);
      }
    });
  }, [name, email, verifiedPhone, subjectChoice, customSubject, message]);

  const handleSubmit = () => {
    if (!name.trim()) {
      setError("Please enter your name.");
      return;
    }
    if (!EMAIL_RE.test(email.trim())) {
      setError("Please enter a valid email address.");
      return;
    }
    if (!subjectChoice) {
      setError("Please select a subject.");
      return;
    }
    if (subjectChoice === OTHER && !customSubject.trim()) {
      setError("Please enter your subject.");
      return;
    }
    if (!message.trim()) {
      setError("Please enter a message.");
      return;
    }
    if (!phoneVerified) {
      setError("Please verify your phone number first.");
      return;
    }
    setError("");
    doSubmit();
  };

  const resetForm = () => {
    setSubmitted(false);
    setSubjectChoice("");
    setCustomSubject("");
    setMessage("");
    setError("");
  };

  // ---------------------------------------------------------------- render
  if (submitted) {
    return (
      <main className={styles.container}>
        <div className={styles.content}>
          <div className={styles.card}>
            <div className={styles.successWrap}>
              <div className={styles.checkCircle} aria-hidden>
                <svg
                  width="30"
                  height="30"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#fff"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <h2 className={styles.successTitle}>Enquiry sent!</h2>
              <p className={styles.successText}>
                Thanks, {name.trim() || "there"} — we&rsquo;ve received your
                message and will be in touch within 1&ndash;2 business days. A
                confirmation has been sent to <strong>{email.trim()}</strong>.
              </p>
              <button
                type="button"
                className={styles.secondaryBtn}
                onClick={resetForm}
              >
                Send another enquiry
              </button>
            </div>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className={styles.container}>
      {/* Invisible reCAPTCHA anchor for Identity Platform phone verification. */}
      <div ref={recaptchaRef} />
      <div className={styles.content}>
        <header className={styles.header}>
          <h1 className={styles.title}>Get in touch</h1>
          <p className={styles.subtitle}>
            Got a question, a suggestion, or just want to say hi? Send us a
            message and we&rsquo;ll get back to you soon.
          </p>
        </header>

        <div className={styles.card}>
          {demoStore ? (
            <p
              className={`${styles.statusMessage} ${styles.error}`}
              role="status"
            >
              {DEMO_FORM_MESSAGE}
            </p>
          ) : null}
          <form
            className={styles.form}
            onSubmit={(e) => {
              e.preventDefault();
              handleSubmit();
            }}
          >
            {error && !otpActive && (
              <p className={`${styles.statusMessage} ${styles.error}`}>
                {error}
              </p>
            )}

            <div className={styles.inputGroup}>
              <label className={styles.label} htmlFor="enq-name">
                Name<span className={styles.required}>*</span>
              </label>
              <input
                id="enq-name"
                className={styles.input}
                type="text"
                placeholder="Your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
              />
            </div>

            <div className={styles.inputGroup}>
              <label className={styles.label} htmlFor="enq-email">
                Email<span className={styles.required}>*</span>
              </label>
              <input
                id="enq-email"
                className={styles.input}
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
            </div>

            {/* Phone + inline verification */}
            <div className={styles.inputGroup}>
              <label className={styles.label} htmlFor="enq-phone">
                Phone<span className={styles.required}>*</span>
              </label>

              {phoneVerified ? (
                <div className={styles.verifiedNote}>
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>
                    {verifiedPhone || "Your number"} &middot; verified
                  </span>
                </div>
              ) : (
                <>
                  <div className={styles.phoneRow}>
                    <PhoneInput
                      defaultCountry="IN"
                      countrySelectComponent={CountrySelect}
                      labels={customPhoneLabels}
                      placeholder="Mobile number"
                      value={phone}
                      onChange={setPhone}
                      disabled={otpSent}
                      className="flex-1 flex gap-2 [&>.PhoneInputCountry]:h-[48px] [&>.PhoneInputCountry]:rounded-xl [&>.PhoneInputCountry]:border [&>.PhoneInputCountry]:border-gray-300 [&>.PhoneInputCountry]:bg-[#f9f9f9] [&>.PhoneInputCountry]:p-0"
                      numberInputProps={{
                        id: "enq-phone",
                        className: styles.phoneInput,
                        autoComplete: "tel-national",
                      }}
                    />
                    {otpSent ? (
                      <button
                        type="button"
                        className={styles.changeBtn}
                        onClick={resetPhone}
                      >
                        Change
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={styles.verifyBtn}
                        onClick={() => sendOtp()}
                        disabled={
                          sendingOtp || !phone || phone.trim().length < 10
                        }
                      >
                        {sendingOtp ? "Sending…" : "Verify"}
                      </button>
                    )}
                  </div>

                  {!otpSent && (
                    <span className={styles.hint}>
                      We&rsquo;ll text a 6-digit code to verify this number. You
                      won&rsquo;t be signed in.
                    </span>
                  )}

                  {otpSent && (
                    <div className={styles.otpInline}>
                      <p className={styles.otpHint}>
                        Enter the 6-digit code sent to{" "}
                        <strong>{fullPhone}</strong>
                      </p>
                      <div className={styles.otpGrid} onPaste={handleOtpPaste}>
                        {otp.map((digit, i) => (
                          <input
                            key={i}
                            ref={(el) => {
                              otpRefs.current[i] = el;
                            }}
                            className={styles.otpInput}
                            type="text"
                            inputMode="numeric"
                            maxLength={1}
                            value={digit}
                            placeholder="·"
                            disabled={verifying || verifyBlocked}
                            onChange={(e) => handleOtpChange(i, e.target.value)}
                            onKeyDown={(e) => handleOtpKeyDown(i, e)}
                            aria-label={`Digit ${i + 1}`}
                          />
                        ))}
                      </div>

                      {verifying && (
                        <div className={styles.centerRow}>
                          <span className={styles.spinnerDark} />
                          <span className={styles.mutedText}>Verifying…</span>
                        </div>
                      )}

                      {error && (
                        <p
                          className={`${styles.statusMessage} ${styles.error}`}
                        >
                          {error}
                        </p>
                      )}

                      <div className={styles.resendRow}>
                        {resendBlocked ? (
                          <span>
                            Too many code requests. Please try again later.
                          </span>
                        ) : resendTimer > 0 ? (
                          <span>Resend code in {resendTimer}s</span>
                        ) : (
                          <button
                            type="button"
                            className={styles.resendBtn}
                            onClick={() => sendOtp()}
                            disabled={sendingOtp || verifying}
                          >
                            Resend code
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Subject preset + optional free-text */}
            <div className={styles.inputGroup}>
              <label className={styles.label} htmlFor="enq-subject">
                Subject<span className={styles.required}>*</span>
              </label>
              <select
                id="enq-subject"
                className={styles.select}
                value={subjectChoice}
                onChange={(e) => setSubjectChoice(e.target.value)}
                required
              >
                <option value="">Select a topic</option>
                {SUBJECT_OPTIONS.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
              {subjectChoice === OTHER && (
                <input
                  className={styles.input}
                  style={{ marginTop: 8 }}
                  type="text"
                  placeholder="Tell us the subject"
                  value={customSubject}
                  onChange={(e) => setCustomSubject(e.target.value)}
                  autoFocus
                />
              )}
            </div>

            <div className={styles.inputGroup}>
              <label className={styles.label} htmlFor="enq-message">
                Message<span className={styles.required}>*</span>
              </label>
              <textarea
                id="enq-message"
                className={`${styles.input} ${styles.textarea}`}
                placeholder="How can we help?"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={5}
              />
            </div>

            <button
              type="submit"
              className={styles.submitBtn}
              disabled={isPending || !phoneVerified}
            >
              {isPending && <span className={styles.spinner} />}
              {isPending ? "Sending…" : "Send enquiry"}
            </button>
            {!phoneVerified && (
              <span className={styles.submitHint}>
                Verify your phone number above to send.
              </span>
            )}
          </form>
        </div>
      </div>
    </main>
  );
}
