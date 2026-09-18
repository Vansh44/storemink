"use client";

import { useState, useTransition, useRef, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  PhoneAuthProvider,
  RecaptchaVerifier,
  updatePhoneNumber,
} from "firebase/auth";
import {
  Check,
  KeyRound,
  Mail,
  Pencil,
  Shield,
  Smartphone,
  UserRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  getFirebaseAuth,
  establishSession,
  firebaseAuthErrorMessage,
} from "@/lib/auth/firebase-client";
import {
  changePassword,
  setVerifiedPhone,
  updateProfileName,
} from "@/app/actions/account-settings";
import PhoneInput from "react-phone-number-input";
import "react-phone-number-input/style.css";
import { customPhoneLabels } from "@/lib/phone-labels";
import { CountrySelect } from "@/components/ui/phone-country-select";
import { useUnsavedChangesWarning } from "@/hooks/use-unsaved-changes-warning";

type Tab = "profile" | "security";

function passwordStrength(password: string) {
  if (!password) return null;
  if (password.length < 8)
    return { label: "Too short", tone: "var(--dash-red)", width: "33%" };
  if (password.length < 12)
    return { label: "Fair", tone: "var(--dash-amber)", width: "66%" };
  return { label: "Strong", tone: "var(--dash-green)", width: "100%" };
}

function initialsOf(first: string, last: string, email: string) {
  if (first) {
    return `${first[0] ?? ""}${last?.[0] ?? ""}`.toUpperCase() || "?";
  }
  return (email.slice(0, 2) || "?").toUpperCase();
}

export function AccountSettingsView({
  email,
  role,
  firstName,
  lastName,
  phone,
  initialTab,
  initialFocus,
}: {
  email: string;
  role: string;
  firstName: string;
  lastName: string;
  phone: string;
  initialTab: Tab;
  initialFocus: "phone" | "password" | null;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(initialTab);

  const roleLabel = role === "superadmin" ? "Superadmin" : role || "Admin";

  return (
    <div className="dash-page-enter mx-auto w-full max-w-3xl">
      <header className="dash-page-header">
        <h1>Account settings</h1>
        <p>Manage your profile, password, and contact details</p>
      </header>

      <div className="dash-filter-tabs mb-5 mt-4 w-fit">
        <button
          className={`dash-filter-tab${tab === "profile" ? " active" : ""}`}
          onClick={() => setTab("profile")}
        >
          <UserRound className="h-4 w-4" />
          Profile
        </button>
        <button
          className={`dash-filter-tab${tab === "security" ? " active" : ""}`}
          onClick={() => setTab("security")}
        >
          <Shield className="h-4 w-4" />
          Security
        </button>
      </div>

      {tab === "profile" ? (
        <ProfileTab
          email={email}
          roleLabel={roleLabel}
          firstName={firstName}
          lastName={lastName}
          onSaved={() => router.refresh()}
        />
      ) : (
        <SecurityTab
          phone={phone}
          initialFocus={initialFocus}
          onPhoneSaved={() => router.refresh()}
        />
      )}
    </div>
  );
}

/* ───────────────────────── Profile ───────────────────────── */

function ProfileTab({
  email,
  roleLabel,
  firstName,
  lastName,
  onSaved,
}: {
  email: string;
  roleLabel: string;
  firstName: string;
  lastName: string;
  onSaved: () => void;
}) {
  const [first, setFirst] = useState(firstName);
  const [last, setLast] = useState(lastName);
  const [isPending, startTransition] = useTransition();

  const dirty = first.trim() !== firstName || last.trim() !== lastName;

  useUnsavedChangesWarning(dirty);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const fd = new FormData();
    fd.set("firstName", first);
    fd.set("lastName", last);
    startTransition(async () => {
      const res = await updateProfileName(fd);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success("Profile updated");
      onSaved();
    });
  };

  return (
    <form onSubmit={submit} className="dash-card">
      <div className="dash-card-header">
        <div>
          <div className="dash-card-title">Profile</div>
          <div className="dash-card-sub">Your name and account identity</div>
        </div>
      </div>

      <div className="flex flex-col gap-5 p-6">
        <div className="flex items-center gap-4">
          <div
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-lg font-bold text-white"
            style={{
              background:
                "linear-gradient(135deg, var(--dash-accent), var(--dash-accent-2))",
            }}
          >
            {initialsOf(first, last, email)}
          </div>
          <div>
            <div className="text-[15px] font-semibold text-[var(--dash-text)]">
              {[first, last].filter(Boolean).join(" ") || "Unnamed"}
            </div>
            <span className="dash-badge dash-badge-blue mt-1">{roleLabel}</span>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="firstName">First name</Label>
            <Input
              id="firstName"
              value={first}
              onChange={(e) => setFirst(e.target.value)}
              placeholder="First name"
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="lastName">Last name</Label>
            <Input
              id="lastName"
              value={last}
              onChange={(e) => setLast(e.target.value)}
              placeholder="Last name (optional)"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label>Email</Label>
          <div className="flex h-10 items-center gap-2 rounded-md border border-input bg-[var(--dash-surface-2)] px-3 text-sm text-[var(--dash-text-2)]">
            <Mail className="h-4 w-4 text-[var(--dash-text-3)]" />
            {email || "—"}
          </div>
          <p className="text-xs text-[var(--dash-text-3)]">
            Email is tied to your login and cannot be changed here. Ask a
            superadmin to update it.
          </p>
        </div>

        <div className="flex justify-end border-t border-[var(--dash-border)] pt-4">
          <Button type="submit" disabled={!dirty || isPending}>
            {isPending ? "Saving..." : "Save changes"}
          </Button>
        </div>
      </div>
    </form>
  );
}

/* ───────────────────────── Security ───────────────────────── */

function SecurityTab({
  phone,
  initialFocus,
  onPhoneSaved,
}: {
  phone: string;
  initialFocus: "phone" | "password" | null;
  onPhoneSaved: () => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <PasswordCard autoFocus={initialFocus === "password"} />
      <PhoneCard
        phone={phone}
        startEditing={initialFocus === "phone"}
        onSaved={onPhoneSaved}
      />
    </div>
  );
}

function PasswordCard({ autoFocus }: { autoFocus: boolean }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [isPending, startTransition] = useTransition();

  const strength = passwordStrength(next);
  const mismatch = confirm.length > 0 && next !== confirm;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (next.length < 8) return toast.error("New password is too short.");
    if (next !== confirm) return toast.error("New passwords don't match.");
    const fd = new FormData();
    fd.set("currentPassword", current);
    fd.set("newPassword", next);
    fd.set("confirmPassword", confirm);
    startTransition(async () => {
      const res = await changePassword(fd);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success("Password updated");
      setCurrent("");
      setNext("");
      setConfirm("");
    });
  };

  return (
    <form onSubmit={submit} className="dash-card">
      <div className="dash-card-header">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--dash-accent-soft)] text-[var(--dash-accent)]">
            <KeyRound className="h-4 w-4" />
          </span>
          <div>
            <div className="dash-card-title">Password</div>
            <div className="dash-card-sub">
              Use at least 8 characters, hard to guess
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-4 p-6">
        <div className="flex max-w-md flex-col gap-1.5">
          <Label htmlFor="currentPassword">Current password</Label>
          <Input
            id="currentPassword"
            type="password"
            autoFocus={autoFocus}
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
          />
        </div>
        <div className="flex max-w-md flex-col gap-1.5">
          <Label htmlFor="newPassword">New password</Label>
          <Input
            id="newPassword"
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            placeholder="Minimum 8 characters"
          />
          {strength && (
            <div className="mt-1 flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--dash-surface-3)]">
                <div
                  className="h-full rounded-full transition-all"
                  style={{ width: strength.width, background: strength.tone }}
                />
              </div>
              <span
                className="text-xs font-medium"
                style={{ color: strength.tone }}
              >
                {strength.label}
              </span>
            </div>
          )}
        </div>
        <div className="flex max-w-md flex-col gap-1.5">
          <Label htmlFor="confirmPassword">Confirm new password</Label>
          <Input
            id="confirmPassword"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
          />
          {mismatch && (
            <p className="text-xs text-[var(--dash-red)]">
              Passwords do not match
            </p>
          )}
        </div>

        <div className="flex justify-end border-t border-[var(--dash-border)] pt-4">
          <Button
            type="submit"
            disabled={isPending || !current || !next || !confirm || mismatch}
          >
            {isPending ? "Updating..." : "Update password"}
          </Button>
        </div>
      </div>
    </form>
  );
}

function PhoneCard({
  phone,
  startEditing,
  onSaved,
}: {
  phone: string;
  startEditing: boolean;
  onSaved: () => void;
}) {
  const [savedPhone, setSavedPhone] = useState(phone);
  const [editing, setEditing] = useState(
    startEditing && !phone ? true : startEditing,
  );
  const [newPhone, setNewPhone] = useState<string | undefined>("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [isPending, startTransition] = useTransition();

  // Firebase phone linking: invisible reCAPTCHA + verificationId.
  const recaptchaRef = useRef<HTMLDivElement | null>(null);
  const verifierRef = useRef<RecaptchaVerifier | null>(null);
  const verificationIdRef = useRef<string | null>(null);

  const fullPhone = newPhone || "";

  const getVerifier = (): RecaptchaVerifier => {
    if (!verifierRef.current) {
      verifierRef.current = new RecaptchaVerifier(
        getFirebaseAuth(),
        recaptchaRef.current!,
        { size: "invisible" },
      );
    }
    return verifierRef.current;
  };

  const reset = () => {
    setEditing(false);
    setOtpSent(false);
    setOtp("");
    setNewPhone("");
    setErr("");
  };

  const sendOtp = async () => {
    if (!newPhone || newPhone.length < 10) {
      setErr("Enter a valid phone number.");
      return;
    }
    setErr("");
    setBusy(true);
    try {
      const provider = new PhoneAuthProvider(getFirebaseAuth());
      verificationIdRef.current = await provider.verifyPhoneNumber(
        fullPhone,
        getVerifier(),
      );
      setOtpSent(true);
    } catch (e) {
      setErr(firebaseAuthErrorMessage(e));
    }
    setBusy(false);
  };

  const verifyOtp = async () => {
    if (otp.length < 6) {
      setErr("Enter the 6-digit code.");
      return;
    }
    if (!verificationIdRef.current) {
      setErr("Please request a code first.");
      return;
    }
    setErr("");
    setBusy(true);
    try {
      const credential = PhoneAuthProvider.credential(
        verificationIdRef.current,
        otp,
      );
      const user = getFirebaseAuth().currentUser;
      if (!user) throw new Error("Not signed in.");
      await updatePhoneNumber(user, credential);
      // Re-mint the session cookie so getServerUser sees the new verified phone
      // (setVerifiedPhone only accepts a number auth has actually recorded).
      await establishSession(true);
    } catch (e) {
      setErr(firebaseAuthErrorMessage(e));
      setBusy(false);
      return;
    }
    startTransition(async () => {
      const res = await setVerifiedPhone(fullPhone);
      setBusy(false);
      if (res.error) {
        setErr(res.error);
        return;
      }
      setSavedPhone(fullPhone);
      reset();
      toast.success("Phone number updated");
      onSaved();
    });
  };

  return (
    <div className="dash-card">
      {/* Invisible reCAPTCHA anchor for Identity Platform phone verification. */}
      <div ref={recaptchaRef} />
      <div className="dash-card-header">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--dash-accent-soft)] text-[var(--dash-accent)]">
            <Smartphone className="h-4 w-4" />
          </span>
          <div>
            <div className="dash-card-title">Phone number</div>
            <div className="dash-card-sub">
              Used for account verification via OTP
            </div>
          </div>
        </div>
        {!editing && (
          <button
            type="button"
            className="dash-btn dash-btn-ghost dash-btn-sm"
            onClick={() => setEditing(true)}
          >
            <Pencil className="h-3.5 w-3.5" />
            {savedPhone ? "Update" : "Add phone"}
          </button>
        )}
      </div>

      <div className="p-6">
        {!editing ? (
          savedPhone ? (
            <div className="flex items-center gap-3">
              <span className="font-mono-dash text-[15px] text-[var(--dash-text)]">
                {savedPhone}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--dash-green-soft)] px-2 py-0.5 text-xs font-semibold text-[var(--dash-green)]">
                <Check className="h-3 w-3" />
                Verified
              </span>
            </div>
          ) : (
            <p className="text-sm text-[var(--dash-text-3)]">
              No phone number added yet.
            </p>
          )
        ) : (
          <div className="flex max-w-md flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>New phone number</Label>
              <PhoneInput
                defaultCountry="IN"
                countrySelectComponent={CountrySelect}
                labels={customPhoneLabels}
                placeholder="Mobile number"
                value={newPhone}
                onChange={setNewPhone}
                disabled={otpSent}
                inputComponent={Input}
                className="flex gap-2 [&>.PhoneInputCountry]:h-10 [&>.PhoneInputCountry]:rounded-md [&>.PhoneInputCountry]:border [&>.PhoneInputCountry]:border-input [&>.PhoneInputCountry]:bg-background [&>.PhoneInputCountry]:p-0"
              />
            </div>

            {otpSent && (
              <div className="flex flex-col gap-1.5">
                <Label>
                  Enter the code sent to {fullPhone}{" "}
                  <button
                    type="button"
                    className="text-[var(--dash-accent)] underline"
                    onClick={() => {
                      setOtpSent(false);
                      setOtp("");
                    }}
                  >
                    Edit
                  </button>
                </Label>
                <Input
                  type="text"
                  inputMode="numeric"
                  placeholder="6-digit code"
                  value={otp}
                  maxLength={6}
                  onChange={(e) =>
                    setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))
                  }
                />
              </div>
            )}

            {err && <p className="text-sm text-[var(--dash-red)]">{err}</p>}

            <div className="flex gap-2">
              {!otpSent ? (
                <Button
                  type="button"
                  onClick={sendOtp}
                  disabled={busy || !newPhone || newPhone.length < 10}
                >
                  {busy ? "Sending..." : "Send code"}
                </Button>
              ) : (
                <Button
                  type="button"
                  onClick={verifyOtp}
                  disabled={busy || isPending || otp.length < 6}
                >
                  {busy || isPending ? "Verifying..." : "Verify & save"}
                </Button>
              )}
              <Button type="button" variant="outline" onClick={reset}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
