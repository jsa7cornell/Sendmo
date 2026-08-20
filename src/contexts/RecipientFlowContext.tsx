import { createContext, useContext, useCallback, useEffect, useState, useRef } from "react";
import { flushSync } from "react-dom";
import { useNavigate, useParams } from "react-router-dom";
import type { RecipientPath } from "@/lib/types";
import {
  INITIAL_DATA,
  loadPersisted,
  persist,
  prefillSlotFor,
  type RecipientFlowData,
} from "@/lib/recipientFlowStorage";
import {
  pathSlugToPath,
  pathForFlags,
  slugToStep,
  stepUrl,
  nextStep,
  prevStep,
  canAccessStep,
  stepIndex,
} from "@/lib/stepRouting";
import { getValidationErrors, type RecipientFlowState } from "@/hooks/useRecipientFlow";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/lib/supabase";

// ─── Navigation direction for animation ─────────────────────

export type NavDirection = "forward" | "backward";

// ─── Context Value ──────────────────────────────────────────

interface RecipientFlowContextValue {
  data: RecipientFlowData;
  currentStep: number; // derived from URL
  direction: NavDirection;
  updateData: (partial: Partial<RecipientFlowData>) => void;
  tryAdvance: (step: number) => boolean;
  goBack: () => void;
  goToStep: (step: number) => void;
  selectPath: (path: RecipientPath) => void;
  deferToSender: (field: "destination" | "origin" | "package") => void;
  /** Clears one deferral IN PLACE — the toggle's "I have it", no navigation. */
  keepIt: (field: "destination" | "origin" | "package") => void;
  markSkipExplainerSeen: () => void;
  undoShippingLinkSwitch: () => void;
  markStepComplete: (step: number) => void;
  getErrors: (step: number) => string[];
  state: RecipientFlowState;
}

const RecipientFlowContext = createContext<RecipientFlowContextValue | null>(null);

// ─── Provider ───────────────────────────────────────────────

export function RecipientFlowProvider({ children }: { children: React.ReactNode }) {
  // sender starts null (2026-08-18: the who's-sending step is gone) and is
  // resolved in-flow — by a "use my address" chip or by deferring. A persisted
  // draft may carry an already-resolved value; nothing else seeds it.
  const [data, setData] = useState<RecipientFlowData>(() => loadPersisted() ?? INITIAL_DATA);
  const navigate = useNavigate();
  const params = useParams<{ pathSlug?: string; stepSlug?: string }>();
  const directionRef = useRef<NavDirection>("forward");
  const { user } = useAuth();

  // URL is the source of truth for path + step
  const urlPath = pathSlugToPath(params.pathSlug ?? "");
  const currentStep = slugToStep(urlPath, params.stepSlug);

  // Mirror data → sessionStorage so the OAuth roundtrip in the verify step
  // doesn't blow away the user's destination, rate selection, etc.
  useEffect(() => {
    persist(data);
  }, [data]);

  // If the user is already authenticated with a session whose email matches
  // the typed destination email, the verify step is redundant — the session
  // IS the verification. Mark email_verified=true so the step-11 validation
  // passes and the user goes straight from shipping → payment. Handles
  // (a) Google CTA at step 1 and (b) returning users with a live session.
  useEffect(() => {
    if (!user?.email) return;
    if (data.email_verified) return;
    if (!data.email) return;
    if (user.email.toLowerCase() !== data.email.toLowerCase()) return;
    setData((prev) => ({
      ...prev,
      email_verified: true,
      verification_email: prev.verification_email || prev.email,
    }));
  }, [user?.email, data.email, data.email_verified]);

  // Sync data.path from URL — also marks step 0 complete since the path
  // picker is implicit in the URL.
  useEffect(() => {
    if (!urlPath) return;
    if (data.path === urlPath) return;
    setData((prev) => ({
      ...prev,
      path: urlPath,
      completedSteps: prev.completedSteps.includes(0) ? prev.completedSteps : [...prev.completedSteps, 0],
    }));
  }, [urlPath, data.path]);

  // Auth-aware prefill: when an authenticated user lands here without an
  // address yet, fetch their most recent saved address + profile and prefill.
  //
  // WHICH SLOT the saved address fills depends on step 0's answer, because the
  // account holder is a different party in each branch:
  //   sender='other' (or unknown) → they RECEIVE  → prefill destinationAddress
  //   sender='self'               → they SHIP OUT → prefill originAddress
  // Filling destination unconditionally would pre-populate the user's own
  // address as "where the package is going" on the 'self' branch — pre-verified
  // and green, so a user who doesn't overwrite it ships to themselves. Same
  // class as the 2026-08-16 stale-autofill incident: data that was correct in
  // its original role, silently landing in the inverted role.
  const prefillRan = useRef(false);
  useEffect(() => {
    if (prefillRan.current) return;
    if (!user) return;
    // Runs only once `sender` is RESOLVED (2026-08-18: the who's-sending step
    // is gone, so sender starts null and is derived from the "use my address"
    // chips or from deferring). Unresolved means we don't know which party the
    // account holder is, and guessing a slot is the wrong-party bug. The
    // origin-step chip relies on this effect re-running when the chip resolves
    // sender to 'self' — it fires updateData({sender:'self'}) and this fills.
    const slot = prefillSlotFor(data.sender);
    if (!slot) return;
    const fillsOrigin = slot === "origin";
    // Guard on the TARGET SLOT only. The old `|| data.email` bail predates the
    // chips: by the origin step the email is always filled, so it would make
    // the 'self' chip a silent no-op. Typed email is preserved below instead.
    const targetTouched = fillsOrigin
      ? data.originAddress.street
      : data.destinationAddress.street;
    if (targetTouched) return;
    prefillRan.current = true;

    let cancelled = false;
    (async () => {
      const [{ data: profile }, { data: recentAddr }] = await Promise.all([
        supabase.from("profiles").select("email, full_name, phone").eq("id", user.id).single(),
        supabase
          .from("addresses")
          .select("name, street1, street2, city, state, zip, phone, is_verified")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      if (cancelled) return;

      const recentComplete =
        recentAddr && !!recentAddr.street1 && !!recentAddr.city && !!recentAddr.state && !!recentAddr.zip;

      setData((prev) => {
        // Bail out if the user has typed anything in the meantime
        const prevTarget = fillsOrigin ? prev.originAddress : prev.destinationAddress;
        if (prevTarget.street) return prev;

        const filled = recentComplete
          ? {
              name: recentAddr.name || profile?.full_name || "",
              street: recentAddr.street1!,
              city: recentAddr.city!,
              state: recentAddr.state!,
              zip: recentAddr.zip!,
              phone: recentAddr.phone || profile?.phone || "",
              verified: !!recentAddr.is_verified,
            }
          : profile?.full_name
          ? { ...prevTarget, name: profile.full_name }
          : prevTarget;

        return {
          ...prev,
          // Only the slot the account holder actually owns in this branch.
          ...(fillsOrigin ? { originAddress: filled } : { destinationAddress: filled }),
          email: prev.email || (profile?.email ?? user.email ?? ""),
        };
      });
    })();
    return () => { cancelled = true; };
  }, [user, data.sender, data.destinationAddress.street, data.originAddress.street, data.email]);

  // Backward-compat state object (step components still expect currentStep on it)
  const state: RecipientFlowState = { ...data, currentStep };

  const updateData = useCallback((partial: Partial<RecipientFlowData>) => {
    setData((prev) => ({ ...prev, ...partial }));
  }, []);

  const tryAdvance = useCallback((step: number): boolean => {
    const errors = getValidationErrors({ ...data, currentStep: step }, step);
    if (errors.length > 0) {
      setData((prev) => ({
        ...prev,
        tried: { ...prev.tried, [step]: true },
      }));
      return false;
    }

    let next = nextStep(step, data.path);
    // Skip the verify step when email is already confirmed (Google OAuth
    // session). Without the jump the verify screen flashes for ~1s before its
    // own auto-advance fires; skipping is the same outcome with no flicker.
    // One case since the maps unified — verify is step 11 on both paths.
    if (next === 11 && data.email_verified) {
      next = nextStep(11, data.path);
    }
    if (next !== null) {
      // flushSync forces React to commit the completedSteps update BEFORE we
      // navigate. Without this, navigate() updates the URL synchronously while
      // setData is still queued — the page-level guard at RecipientOnboarding
      // reads the OLD completedSteps against the NEW URL's step and bounces
      // the user back to firstIncompleteUrl. Notably visible on the flex
      // /authorize → /share advance when the server auto-detected an existing
      // PM and the auto-skip path fires (FlexPaymentStep first-effect).
      flushSync(() => {
        setData((prev) => ({
          ...prev,
          // Passing a step's validation IS answering it — so answering clears
          // its deferral. Without this, defer-then-undo-then-fill left the
          // stale flag set and the flow still turned into a link even though
          // every question had been answered.
          ...(step === 10 ? { deferredOrigin: false } : {}),
          ...(step === 14 ? { deferredPackage: false } : {}),
          completedSteps: prev.completedSteps.includes(step)
            ? (next === 12 && !prev.completedSteps.includes(11)
                ? [...prev.completedSteps, 11]
                : prev.completedSteps)
            : (next === 12
                ? [...prev.completedSteps, step, 11]
                : [...prev.completedSteps, step]),
        }));
      });
      directionRef.current = "forward";
      // The segment is derived from the skip flags on every navigation — this
      // is where the full-label ⇄ flexible rewrite happens (§2.2). The flags
      // read here account for the clear above: passing 10/14 un-defers it.
      navigate(stepUrl(
        pathForFlags({
          deferredDestination: data.deferredDestination,
          deferredOrigin: step === 10 ? false : data.deferredOrigin,
          deferredPackage: step === 14 ? false : data.deferredPackage,
        }),
        next,
      ));
    }
    return true;
  }, [data, navigate]);

  const goBack = useCallback(() => {
    directionRef.current = "backward";
    let prev = prevStep(currentStep, data.path);
    // Skip the verify step on the way back when the email is already
    // confirmed — symmetric with the forward skip in tryAdvance. Landing on
    // the verify screen would just show its "Email verified" state and
    // auto-advance the user straight back here, making Back a dead-end.
    if (prev === 11 && data.email_verified) {
      prev = prevStep(11, data.path);
    }
    if (prev !== null) {
      navigate(stepUrl(pathForFlags(data), prev));
    } else {
      navigate("/onboarding");
    }
  }, [navigate, currentStep, data]);

  const goToStep = useCallback((step: number) => {
    if (!canAccessStep(step, data.completedSteps, data.path) && step !== currentStep) return;
    const targetIdx = stepIndex(step, data.path);
    const currentIdx = stepIndex(currentStep, data.path);
    directionRef.current = targetIdx < currentIdx ? "backward" : "forward";
    navigate(stepUrl(pathForFlags(data), step));
  }, [data, currentStep, navigate]);

  const selectPath = useCallback((path: RecipientPath) => {
    setData((prev) => ({
      ...prev,
      path,
      completedSteps: prev.completedSteps.includes(0) ? prev.completedSteps : [...prev.completedSteps, 0],
    }));
    directionRef.current = "forward";
    navigate(stepUrl(path, 1));
  }, [navigate]);

  // ── The address escape ────────────────────────────────────
  //
  // "I don't have their address" is the ONLY place a flow changes product
  // mid-session. Both branches start on full_label; this moves the user to the
  // shipping-link (flexible) path, where the other party fills in the origin.
  //
  // Steps 0 and 1 are shared by both paths and are already complete here, so
  // canAccessStep(20, …, 'flexible') passes without touching completedSteps.
  // originAddress is deliberately NOT cleared — undo restores what was typed.
  //
  // Navigate ONLY — do not pre-set data.path here.
  //
  // The 2026-05-19 flushSync pattern exists for updates the page guard reads
  // (completedSteps). This transition changes neither: steps 0 and 1 are
  // already complete and are shared by both paths, so canAccessStep(20, [0,1],
  // 'flexible') passes on the very first render after the URL flips.
  //
  // `data.path` is DERIVED from the URL by the sync effect above, so setting it
  // here as well would only add a redundant write plus one render where
  // data.path and the URL disagree. Let the URL stay the single source of truth
  // for path, exactly as it is for every other entry into a path.
  // "The sender will fill this in" — an ANSWER, not an escape. All three
  // skips flow through here (2026-08-19, one map): the flag is set, the step
  // is marked complete (the question was answered), and the flow advances to
  // the NEXT question with the URL segment rewritten to `flexible` — the
  // first skip is what makes the product a shipping link, and the segment
  // says so immediately (§2.2).
  //
  // "destination" is the exception on two counts, both deliberate: the flag
  // is set but step 1 is NOT marked complete, and there is no navigation —
  // the user still presses Continue, which runs tryAdvance(1) and marks it
  // there. (Until 2026-08-19 the stated reason was step 1's email half, which
  // was not deferrable; the email has since moved to step 11 and step 1 asks
  // only about the address. The behaviour is unchanged: deferring answers the
  // question, Continue is what advances.) The
  // flushSync below exists because the guard reads completedSteps in the same
  // tick as the navigate — the 2026-05-19 race (PLAYBOOK Rule 20); it must
  // survive any refactor of this function.
  const deferToSender = useCallback((field: "destination" | "origin" | "package") => {
    if (field === "destination") {
      setData((prev) => ({
        ...prev,
        deferredDestination: true,
        sender: prev.sender ?? "other",
      }));
      return;
    }
    const step = field === "origin" ? 10 : 14;
    flushSync(() => {
      setData((prev) => ({
        ...prev,
        ...(field === "origin" ? { deferredOrigin: true } : { deferredPackage: true }),
        // Deferring IS an identity claim: "the sender will fill this in" only
        // makes sense when someone else is the sender. Resolves a still-null
        // sender the same way the address chips do (never overrides 'self' —
        // the defer buttons are hidden on that branch anyway).
        sender: prev.sender ?? "other",
        completedSteps: prev.completedSteps.includes(step)
          ? prev.completedSteps
          : [...prev.completedSteps, step],
      }));
    });
    directionRef.current = "forward";
    // One sequence: origin's next question is the package (14); the package's
    // is shipping (20), which renders preferences+cap because something was
    // skipped. Segment is `flexible` from the first skip onward.
    navigate(stepUrl("flexible", step === 10 ? 14 : 20));
  }, [navigate]);

  // The toggle's "I have it" — the inverse of deferToSender for ONE field,
  // and deliberately NOT a navigation. `undoShippingLinkSwitch` reverses the
  // whole decision and moves the user; this just reopens the field group the
  // user is already looking at, so the layout stays put (the dim-in-place
  // requirement is about not moving things under the user's cursor).
  //
  // The step's completion is withdrawn with the flag: the deferral is what
  // marked it complete, so keeping the completion would let the guard admit a
  // step whose question is now unanswered.
  const keepIt = useCallback((field: "destination" | "origin" | "package") => {
    setData((prev) => {
      if (field === "destination") return { ...prev, deferredDestination: false };
      const step = field === "origin" ? 10 : 14;
      return {
        ...prev,
        ...(field === "origin" ? { deferredOrigin: false } : { deferredPackage: false }),
        completedSteps: prev.completedSteps.filter((s) => s !== step),
      };
    });
  }, []);

  const markSkipExplainerSeen = useCallback(() => {
    setData((prev) => (prev.seenSkipExplainer ? prev : { ...prev, seenSkipExplainer: true }));
  }, []);

  const undoShippingLinkSwitch = useCallback(() => {
    // Undo reverses the deferral decision itself, not just the location:
    // flags cleared AND the steps deferral completed un-completed. Leaving
    // them in completedSteps let the progress bar jump defer→undo users
    // forward past an empty origin (review finding 5) — deferral was how
    // those steps got "completed", so undoing it un-completes them.
    // Step 20 un-completes too: its flex-mode answer (speed/cap preferences)
    // is void once every question is answered — the label path needs a
    // concrete rate picked there instead.
    // (Step 1 is different: deferring the DESTINATION never marked it
    // complete — email validation still had to pass — so there is nothing to
    // un-complete for it; the user just gets the address form back.)
    const hadDeferredDestination = data.deferredDestination;
    // flushSync is LOAD-BEARING here (PLAYBOOK Rule 20 / LOG 2026-05-19).
    // Without it a render lands with the OLD URL and the NEW completedSteps:
    // the guard fails canAccessStep for the step being left and its
    // <Navigate replace> to firstIncompleteUrl — computed from the OLD URL's
    // segment — wins over this function's navigate. The pre-2026-08-19 code
    // had the same race, invisibly: its bounce target happened to coincide
    // with the intended destination. The segment rewrite made them differ,
    // which is how the race was finally caught (e2e: undo landed on
    // /flexible/origin instead of /full-label/origin).
    flushSync(() => {
      setData((prev) => ({
        ...prev,
        deferredDestination: false,
        deferredOrigin: false,
        deferredPackage: false,
        completedSteps: prev.completedSteps.filter((s) => s !== 10 && s !== 14 && s !== 20),
      }));
    });
    directionRef.current = "backward";
    // Land on the earliest question the undo re-opens, back on the label
    // segment — the last undo is the other direction of the §2.2 rewrite.
    // (10 rather than "earliest deferred": 10 was just un-completed above, so
    // any deeper target would bounce off the guard back to it anyway.)
    navigate(stepUrl("full_label", hadDeferredDestination ? 1 : 10));
  }, [navigate, data.deferredDestination]);

  const markStepComplete = useCallback((step: number) => {
    setData((prev) => ({
      ...prev,
      completedSteps: prev.completedSteps.includes(step) ? prev.completedSteps : [...prev.completedSteps, step],
    }));
  }, []);

  const getErrors = useCallback((step: number) => {
    return getValidationErrors({ ...data, currentStep: step }, step);
  }, [data]);

  return (
    <RecipientFlowContext.Provider
      value={{
        data,
        currentStep,
        direction: directionRef.current,
        updateData,
        tryAdvance,
        goBack,
        goToStep,
        selectPath,
        deferToSender,
        keepIt,
        markSkipExplainerSeen,
        undoShippingLinkSwitch,
        markStepComplete,
        getErrors,
        state,
      }}
    >
      {children}
    </RecipientFlowContext.Provider>
  );
}

// ─── Hook ───────────────────────────────────────────────────

export function useRecipientFlowContext() {
  const ctx = useContext(RecipientFlowContext);
  if (!ctx) throw new Error("useRecipientFlowContext must be used within RecipientFlowProvider");
  return ctx;
}
