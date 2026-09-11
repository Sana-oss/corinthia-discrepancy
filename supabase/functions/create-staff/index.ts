// Edge Function: create-staff
//
// Lets a manager create a Supabase Auth login (with an initial password) and
// the matching staff row in ONE step, directly from the app's Staff tab — so a
// newly added employee can sign in immediately with the shared credentials.
// Also supports resetting an existing employee's password.
//
// Why a function? The browser only has the anon key; creating auth users
// requires the service-role key, which must never ship to the client. This
// function holds the service-role key server-side, but only after proving the
// caller is a signed-in, active manager — and it re-enforces the departmental
// rule (hk_manager → hk_* roles only, fo_manager → fo_* roles only), because
// the service role bypasses RLS.
//
// Deploy (once, from the project root, with the Supabase CLI linked):
//   supabase functions deploy create-staff
// The SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY secrets are
// injected automatically for linked projects. If the service key is missing:
//   supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<your service_role key>
//
// Request (POST, JSON, Authorization: Bearer <manager's access token>):
//   { "action": "create", "email", "full_name", "role", "active", "password" }
//   { "action": "reset",  "email", "password" }

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

const ROLES = [
  "hk_staff", "hk_supervisor", "hk_manager",
  "fo_staff", "fo_supervisor", "fo_manager",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SERVICE_ROLE_KEY");
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
    if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
      return json({ error: "Login service not configured (service role key missing)." }, 500);
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Not signed in." }, 401);

    // `admin` uses the service role (bypasses RLS — so this function must
    // enforce every rule itself). `asUser` carries the caller's JWT.
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const asUser = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // --- 1. Verify the caller is a signed-in, active manager. ---
    const { data: meData, error: meErr } = await asUser.auth.getUser();
    if (meErr || !meData?.user?.email) return json({ error: "Invalid or expired session." }, 401);
    const callerEmail = meData.user.email.toLowerCase();

    const { data: callerRow, error: callerErr } = await admin
      .from("staff").select("role, active").eq("email", callerEmail).maybeSingle();
    if (callerErr || !callerRow) return json({ error: "You are not on the staff list." }, 403);
    if (callerRow.active === false) return json({ error: "Your account is disabled." }, 403);
    if (callerRow.role !== "hk_manager" && callerRow.role !== "fo_manager") {
      return json({ error: "Only managers can manage staff logins." }, 403);
    }
    const dept = callerRow.role.slice(0, 3); // "hk_" or "fo_"

    // --- 2. Parse + validate the request. ---
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const action = body.action === "reset" ? "reset" : "create";
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    const fullName = String(body.full_name ?? "").trim();
    const role = String(body.role ?? "");

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Enter a valid email." }, 400);
    if (password.length < 6) return json({ error: "Password must be at least 6 characters." }, 400);

    if (action === "create") {
      if (!fullName) return json({ error: "Enter the employee's full name." }, 400);
      if (!ROLES.includes(role)) return json({ error: "Pick a valid role." }, 400);
      if (!role.startsWith(dept)) {
        return json({ error: "You can only add staff in your own department." }, 403);
      }

      // --- 3a. Create the login (confirmed, so they can sign in right away). ---
      const { error: createErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: fullName },
      });
      if (createErr) {
        const msg = createErr.message || "";
        if (/already registered|already exists|duplicate/i.test(msg)) {
          return json({ error: "ALREADY_EXISTS: a login account already exists for this email." }, 409);
        }
        return json({ error: "Could not create the login: " + msg }, 400);
      }

      // --- 3b. Upsert the staff row. ---
      const { error: staffErr } = await admin
        .from("staff")
        .upsert({ email, full_name: fullName, role, active: body.active !== false }, { onConflict: "email" });
      if (staffErr) {
        return json({ error: "Login created, but saving the staff row failed: " + staffErr.message }, 500);
      }
      return json({ ok: true, message: "Login created — share the email and password with the employee." });
    }

    // --- action === "reset": set a new password for an existing login. ---
    let target: { id: string } | null = null;
    for (let page = 1; page <= 10 && !target; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
      if (error) return json({ error: "Could not look up logins: " + error.message }, 500);
      const users = data?.users ?? [];
      target = users.find((u) => (u.email || "").toLowerCase() === email) ?? null;
      if (users.length < 200) break;
    }
    if (!target) {
      return json({ error: "No login exists for that email yet. Add the employee with a password first." }, 404);
    }

    // Departmental check: only reset logins for staff in the caller's department.
    const { data: targetRow } = await admin.from("staff").select("role").eq("email", email).maybeSingle();
    if (targetRow?.role && !String(targetRow.role).startsWith(dept)) {
      return json({ error: "You can only reset passwords for staff in your own department." }, 403);
    }

    const { error: updErr } = await admin.auth.admin.updateUserById(target.id, { password });
    if (updErr) return json({ error: "Could not set the password: " + updErr.message }, 400);
    return json({ ok: true, message: "Password updated — share the new password with the employee." });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: "Unexpected error: " + msg }, 500);
  }
});
