// Edge Function: change-password
//
// Lets ANY signed-in employee change their OWN password — the self-service
// path that complements the manager flows in create-staff (create + reset).
//
// Why a function? Supabase's standard password update (auth.updateUser)
// does NOT verify the current password, so a stolen/unattended session
// could silently re-set the password. This function closes that gap:
//
//   1. The caller's identity is taken ONLY from their verified JWT —
//      the request body carries no email and no user id, so no caller can
//      ever target another employee's account.
//   2. The CURRENT password is verified server-side with a real GoTrue
//      password grant (the same check a sign-in performs), using the
//      anon key only — the service role is never used for verification.
//   3. Only after that grant succeeds is the new password written, using
//      the service role (which must stay server-side) via updateUserById
//      on the CALLER'S OWN user id.
//
// Passwords are never stored anywhere (GoTrue holds only a bcrypt hash),
// never written to logs, and never echoed back in responses.
//
// Deploy (once, from the project root, with the Supabase CLI linked):
//   supabase functions deploy change-password
// The SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY secrets are
// injected automatically for linked projects. If the service key is missing:
//   supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<your service_role key>
//
// Request (POST, JSON, Authorization: Bearer <employee's access token>):
//   { "current_password": "...", "new_password": "..." }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });

// Matches the minimum length the create-staff manager flow already enforces,
// so a manager-issued initial password can always be kept or replaced.
const MIN_PASSWORD_LENGTH = 6;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SERVICE_ROLE_KEY");
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
    if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
      return json({ error: "Password service not configured (service role key missing)." }, 500);
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Not signed in." }, 401);

    // `admin` (service role) is used ONLY for the final password write below.
    // `asUser` carries the caller's JWT for identity verification.
    const asUser = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // --- 1. Identify the caller strictly from their verified session token. ---
    // No email/user-id is accepted from the request body: this function can
    // only ever change the password of the person who is signed in.
    const { data: meData, error: meErr } = await asUser.auth.getUser();
    if (meErr || !meData?.user?.email) return json({ error: "Invalid or expired session." }, 401);
    const callerEmail = meData.user.email.toLowerCase();
    const callerId = meData.user.id;

    // --- 2. Parse + validate the request. ---
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const currentPassword = String(body.current_password ?? "");
    const newPassword = String(body.new_password ?? "");

    if (!currentPassword) return json({ error: "Enter your current password." }, 400);
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return json({ error: "New password must be at least 6 characters." }, 400);
    }
    if (newPassword === currentPassword) {
      return json({ error: "The new password must be different from your current password." }, 400);
    }

    // --- 3. Verify the CURRENT password with a real GoTrue password grant. ---
    // This is the same check a sign-in performs, so only the true owner of the
    // account can pass. The anon key is used (never the service role), and the
    // grant is subject to GoTrue's built-in rate limits — which also throttles
    // brute-force guessing of the current password. The extra session this
    // grant creates is never persisted (no refresh token is kept).
    const grantRes = await fetch(SUPABASE_URL + "/auth/v1/token?grant_type=password", {
      method: "POST",
      headers: { "apikey": ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email: callerEmail, password: currentPassword }),
    });
    if (!grantRes.ok) {
      return json({ error: "Your current password is incorrect." }, 401);
    }
    // Discard the verification session immediately — it is never stored.
    await grantRes.arrayBuffer().catch(() => {});

    // --- 4. Write the new password for the CALLER'S OWN account. ---
    // The service role is required for updateUserById, which is exactly why the
    // write lives in this server-side function rather than in the browser.
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error: updErr } = await admin.auth.admin.updateUserById(callerId, {
      password: newPassword,
    });
    if (updErr) {
      // Error details from GoTrue never include password material.
      return json({ error: "Could not change the password: " + (updErr.message || "unknown error") }, 400);
    }

    return json({ ok: true, message: "Password changed — your new password is active." });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: "Unexpected error: " + msg }, 500);
  }
});
