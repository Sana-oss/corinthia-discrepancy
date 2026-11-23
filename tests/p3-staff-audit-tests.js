// Static regression tests for P3 Batch A - staff/password audit.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('--- Starting P3 Staff Audit Test Suite ---\n');

let passed = 0, total = 0;
function test(name, fn) {
  total++;
  try { fn(); console.log(`  [PASS] ${name}`); passed++; }
  catch (err) { console.error(`  [FAIL] ${name}`); console.error(`         ${err.message}`); }
}

const root = path.join(__dirname, '..');
const sqlPath = path.join(root, 'supabase', 'migrations', '011_p3_staff_audit.sql');
assert.ok(fs.existsSync(sqlPath), 'migration 011_p3_staff_audit.sql must exist');
const sql = fs.readFileSync(sqlPath, 'utf8');

test('migration is scoped and does not touch 009/010 or create tables', () => {
  assert.ok(/create or replace function public\.audit_staff_changes\(\)/.test(sql), 'staff trigger function missing');
  assert.ok(!/create table/i.test(sql), 'no new table allowed');
  assert.ok(!/009_system_audit_logs|010_p2_audit_capture/.test(sql), 'must not reference/edit prior migrations');
  assert.ok(!/alter table public\.system_audit_logs add column/i.test(sql), 'no new audit column');
  assert.ok(!/alter table public\.daily_reports/i.test(sql), 'daily_reports untouched in Batch A');
});

test('visibility constraint is extended without dropping existing values', () => {
  assert.ok(/check \(visibility in \('department', 'shared_report', 'staff_admin'\)\)/.test(sql),
    'staff_admin must be added to the check constraint');
});

test('RLS policy preserves P1/P2 and excludes supervisors from staff_admin', () => {
  assert.ok(/drop policy if exists "audit read scoped"/.test(sql), 'old policy must be replaced');
  assert.ok(/v\.viewer_role = 'gm_admin'/.test(sql), 'GM must see all');
  assert.ok(/v\.viewer_tier = 'manager'/.test(sql), 'manager branch missing');
  assert.ok(/\(visibility = 'department' and department = v\.viewer_department\)/.test(sql),
    'managers/supervisors must keep department-scoped reads');
  assert.ok(/visibility = 'shared_report'/.test(sql), 'shared lifecycle reads must be preserved');
  assert.ok(/\(visibility = 'staff_admin' and department = v\.viewer_department\)/.test(sql),
    'only managers get department-scoped staff_admin');
  assert.ok(/v\.viewer_tier = 'supervisor'[\s\S]{0,200}visibility = 'department'[\s\S]{0,120}v\.viewer_department/.test(sql),
    'supervisors must be limited to department visibility');
  assert.ok(!/v\.viewer_tier = 'supervisor'[\s\S]{0,200}staff_admin/.test(sql),
    'supervisors must not see staff_admin');
});

test('staff DELETE/TRUNCATE is revoked and FOR ALL policy is split', () => {
  assert.ok(/revoke delete, truncate on table public\.staff from anon, authenticated;/i.test(sql),
    'DELETE/TRUNCATE must be revoked');
  assert.ok(/drop policy if exists "manager write own dept" on public\.staff;/.test(sql),
    'broad FOR ALL policy must be dropped');
  assert.ok(/create policy "manager insert own dept"[\s\S]{0,300}for insert/.test(sql), 'insert policy missing');
  assert.ok(/create policy "manager update own dept"[\s\S]{0,300}for update/.test(sql), 'update policy missing');
  assert.ok(!/for all to authenticated/.test(sql), 'no remaining FOR ALL write policy');
  assert.ok(/email <> auth\.jwt\(\) ->> 'email'/.test(sql), 'self-demotion guard must be preserved');
  assert.ok(/role like 'hk\\_%'/i.test(sql) && /role like 'fo\\_%'/i.test(sql), 'department guards must be preserved');
});

test('staff trigger actor is verified and target is separate', () => {
  assert.ok(/if v_identity_unresolved then[\s\S]{0,300}v_actor_uid := null;/.test(sql),
    'unverifiable actor must be null, not the target');
  assert.ok(/select actor_user_id, actor_email, actor_name, actor_role, actor_department[\s\S]{0,200}from public\.audit_actor\(\)/.test(sql),
    'verified actor snapshot missing');
  assert.ok(/v_actor_uid, v_actor_email, v_actor_name,\s*v_actor_role, v_actor_dept/.test(sql),
    'actor fields must be written from the JWT-derived actor');
  ['target_email', 'target_full_name', 'target_role', 'target_department', 'target_user_id'].forEach(k =>
    assert.ok(sql.includes("'" + k + "'"), `target metadata missing ${k}`));
  assert.ok(/'staff', v_target_email, v_target_name/.test(sql),
    'entity must identify the target employee');
  assert.ok(/public\.audit_user_id_by_email\(v_target_email\)/.test(sql), 'target uid helper missing');
});

test('service-role INSERT/UPDATE suppressed, DELETE retained', () => {
  assert.ok(/if tg_op in \('INSERT', 'UPDATE'\) and auth\.uid\(\) is null then[\s\S]{0,120}return null;/.test(sql),
    'must avoid duplicate staff_created from Edge Function');
  assert.ok(/create trigger trg_audit_staff_changes\s+after insert or update or delete on public\.staff/.test(sql),
    'trigger must cover DELETE');
  assert.ok(/v_action := 'staff_deleted'/.test(sql), 'exceptional deletion must be captured');
  assert.ok(/v_meta[\s\S]{0,300}'identity_unresolved', true/.test(sql), 'unresolved actor must be flagged');
});

test('event names and no-op/failed-write guards', () => {
  ['staff_created', 'staff_updated', 'staff_active_changed', 'staff_deleted'].forEach(a =>
    assert.ok(sql.includes("'" + a + "'"), `event missing: ${a}`));
  assert.ok(/if old is not distinct from new then[\s\S]{0,60}return null;/.test(sql), 'no-op update must emit nothing');
  assert.ok(/v_new_vals := '\{\}'::jsonb/.test(sql), 'changed-field-only snapshots required');
});

test('no credential material can be stored', () => {
  ['password', 'passwd', 'hash', 'token', 'secret'].forEach(word =>
    assert.ok(!new RegExp("'" + word + "'", 'i').test(sql), `forbidden literal: ${word}`));
  assert.ok(!/current_password|new_password/.test(sql), 'request-body fields must not appear in migration');
  assert.ok(/comment on function public\.audit_staff_changes/.test(sql), 'design comment missing');
});

const createFn = fs.readFileSync(path.join(root, 'supabase', 'functions', 'create-staff', 'index.ts'), 'utf8');
const pwdFn = fs.readFileSync(path.join(root, 'supabase', 'functions', 'change-password', 'index.ts'), 'utf8');
const html = fs.readFileSync(path.join(root, 'discrepancy-report.html'), 'utf8');

test('create-staff logs one staff_created with verified actor and separate target', () => {
  assert.ok(/action_type: "staff_created"/.test(createFn), 'staff_created event missing');
  assert.ok(/actor_user_id: meData\.user\.id/.test(createFn), 'actor must be the verified JWT user');
  assert.ok(/actor_email: callerEmail/.test(createFn), 'actor email must come from verified session');
  assert.ok(/entity_id: email/.test(createFn), 'target must be the affected employee email');
  assert.ok(/target_email: email/.test(createFn), 'target metadata missing');
  assert.ok(/login_created: true/.test(createFn), 'login-created flag missing');
  assert.ok(/auth\.uid\(\) is null then[\s\S]{0,120}return null;/.test(sql), 'trigger suppression required');
});

test('create-staff logs manager password reset without secret material', () => {
  assert.ok(/action_type: "staff_password_reset"/.test(createFn), 'reset event missing');
  assert.ok(/target_user_id: target\.id/.test(createFn), 'target auth id missing');
  assert.ok(/password_material_logged: false/.test(createFn), 'must assert no secret logging');
  assert.ok(!/metadata:[\s\S]{0,600}password:/.test(createFn), 'password must not enter audit metadata');
});

test('change-password logs self event with actor == target and audit_recorded', () => {
  assert.ok(/action_type: "staff_password_changed_self"/.test(pwdFn), 'self event missing');
  assert.ok(/actor_user_id: callerId/.test(pwdFn), 'actor must be verified caller');
  assert.ok(/entity_id: callerEmail/.test(pwdFn), 'self target must be caller');
  assert.ok(/self_service: true/.test(pwdFn), 'self_service flag missing');
  assert.ok(/audit_recorded: audit\.recorded/.test(pwdFn), 'must return explicit audit_recorded');
  assert.ok(!/current_password[^\n]*metadata/.test(pwdFn), 'current password must not be logged');
});

test('both Edge Functions retry and alert on audit failure', () => {
  [createFn, pwdFn].forEach((fn, idx) => {
    assert.ok(/attempt <= 3/.test(fn), `fn${idx}: retry count missing`);
    assert.ok(/level: "alert"/.test(fn) && /audit_insert_failed/.test(fn), `fn${idx}: alert missing`);
    assert.ok(/error_code/.test(fn), `fn${idx}: non-sensitive correlation code missing`);
    assert.ok(!/body\.password|new_password|current_password/.test(
      (fn.match(/console\.error\(JSON\.stringify\(\{[\s\S]*?\}\)\)/) || [''])[0]
    ), `fn${idx}: alert must not log credentials`);
  });
});

test('frontend surfaces audit recording failure without hiding password success', () => {
  assert.ok(/body\.audit_recorded === false/.test(html), 'password modal must check audit_recorded');
  assert.ok(/audit record could not be saved/.test(html), 'warning text missing');
  assert.ok(/loginResult\.audit_recorded/.test(html), 'staff create must check audit_recorded');
  assert.ok(/resetResult\.audit_recorded/.test(html), 'password reset must check audit_recorded');
});

console.log(`\n--- Test Suite Completed: ${passed}/${total} Passed ---`);
if (passed !== total) process.exit(1);
