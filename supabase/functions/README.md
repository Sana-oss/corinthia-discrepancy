# Supabase Edge Functions

## create-staff — employee logins from the Staff tab

The app's **Staff tab** calls this function so a manager can create an
employee's login account (email + initial password) and staff row in one step —
no Supabase dashboard needed. It also supports **Edit → set new password**.

### Deploy (one time, per project)

From the repo root, with the Supabase CLI installed and linked:

```bash
# 1. Install the CLI if you haven't:  npm install -g supabase
# 2. Link the project (asks for project ref):
supabase link --project-ref <your-project-ref>

# 3. Deploy the function:
supabase functions deploy create-staff

# 4. Only if step 3 warns about a missing service-role key, set it manually
#    (find the key in Supabase → Project Settings → API → service_role):
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<your service_role key>
```

### How it's secured

- The browser never sees the service-role key — it lives only in the function.
- The function verifies the caller's JWT and checks the `staff` table to prove
  the caller is an **active `hk_manager`/`fo_manager`** before doing anything.
- It re-enforces the **departmental rule** (an `hk_manager` can only create
  `hk_*` logins; `fo_manager` only `fo_*`), because the service role bypasses
  the table RLS that normally enforces this.
- Supabase's `verify_jwt` (on by default) blocks all unauthenticated calls.

### If the function is NOT deployed

The app degrades gracefully: adding a staff member still saves the staff row,
with a hint explaining that the login must be created in
**Supabase → Authentication → Users** manually (the old workflow). Deploying
the function removes that manual step.
