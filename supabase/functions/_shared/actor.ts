// Shared actor-derivation helper for user-facing endpoints on /t/<public_code>.
// Used by cancel-label and label-print (both ride the 3-path auth shape decided
// in proposals/2026-05-11_label-cancel-and-change_decided-2026-05-12.md).
//
// Why extract this:
//   - Both endpoints need to answer "who is this caller?" against a shipment row.
//   - The 3-path scheme (JWT admin/link_owner / X-Cancel-Token / body cancel_token)
//     took three Q&A rounds to land correctly in cancel-label (see 2026-05-12 LOG).
//   - Re-implementing it inline in label-print risks subtle drift. One source
//     of truth is the Rule-6 (prefer extension over invention) play here.
//
// What's intentionally NOT in this helper:
//   - The HTTP response shape (each caller has different "anonymous allowed"
//     policy — cancel returns 401, label-print proceeds with actor='anonymous').
//   - Rate limiting (each caller has its own ceiling).
//   - The shipment SELECT (each caller selects different columns).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

export type Actor =
  | "admin"
  | "link_owner"
  | "session_token"   // X-Cancel-Token header (just-shipped sender's sessionStorage)
  | "email_token"     // body.cancel_token (email link, header-stripped by a proxy)
  | "anonymous";      // none of the above — caller has URL only

export interface DeriveActorInput {
  supabase: SupabaseClient;
  jwtToken: string | null;
  headerCancelToken: string | null;
  bodyCancelToken: string | null;
  shipmentCancelToken: string | null;
  linkOwnerId: string | null;
}

export interface DeriveActorResult {
  actor: Actor;
  /** Auth user id when JWT path resolved; null otherwise. */
  callerId: string | null;
}

// Constant-time hex compare (32-byte tokens → 64-char hex). Fast-rejects on
// length mismatch; same-length compares run in constant time.
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export async function deriveActor(input: DeriveActorInput): Promise<DeriveActorResult> {
  const {
    supabase,
    jwtToken,
    headerCancelToken,
    bodyCancelToken,
    shipmentCancelToken,
    linkOwnerId,
  } = input;

  // Path 1 — JWT (admin OR link_owner). Admin beats link_owner in the rare
  // case where an admin user is also the link owner (admin role wins).
  if (jwtToken) {
    const { data: userResp, error: userErr } = await supabase.auth.getUser(jwtToken);
    if (!userErr && userResp?.user) {
      const callerId = userResp.user.id;
      const { data: callerProfile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", callerId)
        .single();
      const isAdmin = callerProfile?.role === "admin";
      if (isAdmin) return { actor: "admin", callerId };
      if (linkOwnerId && linkOwnerId === callerId) return { actor: "link_owner", callerId };
    }
  }

  // Path 2/3 — cancel token. Header preferred (session transport); body
  // accepted as fallback for proxies that strip custom headers (email transport).
  const presentedToken = headerCancelToken || bodyCancelToken || null;
  if (presentedToken && shipmentCancelToken && timingSafeEqual(presentedToken, shipmentCancelToken)) {
    return {
      actor: headerCancelToken ? "session_token" : "email_token",
      callerId: null,
    };
  }

  return { actor: "anonymous", callerId: null };
}
