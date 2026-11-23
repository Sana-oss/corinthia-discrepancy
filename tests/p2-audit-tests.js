// Static regression tests for P2 audit capture (migration 010).
const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('--- Starting P2 Audit Test Suite ---\n');

let passedTests = 0;
let totalTests = 0;
function test(name, fn) {
  totalTests++;
  try { fn(); console.log(`  [PASS] ${name}`); passedTests++; }
  catch (err) { console.error(`  [FAIL] ${name}`); console.error(`         ${err.message}`); }
}

const root = path.join(__dirname, '..');
const sqlPath = path.join(root, 'supabase', 'migrations', '010_p2_audit_capture.sql');
assert.ok(fs.existsSync(sqlPath), 'migration 010_p2_audit_capture.sql must exist');
const sql = fs.readFileSync(sqlPath, 'utf8');
const plan = fs.readFileSync(path.join(root, 'docs', 'p2-audit-plan.md'), 'utf8');

test('migration only replaces the existing trigger function', () => {
  assert.ok(/create or replace function public\.audit_daily_report_changes\(\)/i.test(sql),
    'must replace the P1 function');
  assert.ok(!/create table/i.test(sql), 'P2 must not create an audit table');
  assert.ok(!/create policy|enable row level security|create trigger/i.test(sql),
    'P2 must not alter RLS or trigger definitions');
  assert.ok(!/insert into public\.daily_reports|update public\.daily_reports|delete from public\.daily_reports/i.test(sql),
    'P2 must not modify business data');
  assert.ok(!/service_role/i.test(sql), 'no service-role access');
  assert.ok(!/009_system_audit_logs|db push/i.test(sql), 'migration must not reapply or edit 009');
});

test('trust model and atomicity guards from P1 are preserved', () => {
  assert.ok(/if auth\.uid\(\) is null then[\s\S]*?return null;/i.test(sql), 'unauthenticated writes skipped');
  assert.ok(/if tg_op <> 'UPDATE' then[\s\S]*?return null;/i.test(sql), 'INSERT skipped');
  assert.ok(/if new\.payload is not distinct from old\.payload then[\s\S]*?return null;/i.test(sql), 'no-op skipped');
  assert.ok(/select \* into v_actor from public\.audit_actor\(\)/.test(sql), 'actor snapshot preserved');
  assert.ok(/v_actor\.actor_user_id, v_actor\.actor_email, v_actor\.actor_name,\s*v_actor\.actor_role, v_actor\.actor_department/.test(sql),
    'historical employee snapshot must be written on every branch');
  assert.ok(/identity_unresolved/.test(sql), 'unresolved identity must be flagged, never fabricated');
});

test('branch order is import -> extras -> lifecycle -> P1 room status', () => {
  const i = sql.indexOf('-- 1. Room-list import');
  const x = sql.indexOf('-- 2. Extra rooms');
  const l = sql.indexOf('-- 3. Report lifecycle');
  const r = sql.indexOf('-- 4. P1 room-checklist status diffs');
  assert.ok(i > 0 && x > i && l > x && r > l, `bad branch order: ${i},${x},${l},${r}`);
  assert.ok(/if not v_is_import then[\s\S]*?for v_room_key/.test(sql),
    'P1 room status loop must be suppressed for import writes');
});

test('import records aggregate counts and precise bounded detail arrays', () => {
  ['added_count', 'removed_count', 'reset_count', 'changed_stay_count', 'affected_room_count',
    'added_rooms', 'removed_rooms', 'reset_rooms', 'changed_stay_rooms', 'cleared_confirmations',
    'operation_id', 'part_count', 'is_continuation'
  ].forEach(key => assert.ok(sql.includes("'" + key + "'"), `import metadata missing ${key}`));
  assert.ok(/jsonb_build_object\(\s*'room', n\.room, 'arrival', n\.arr, 'departure', n\.dep, 'status', n\.status\)/.test(sql),
    'added_rooms must hold identifiers + before/after relevant values');
  assert.ok(/'old_arrival', o\.arr, 'new_arrival', n\.arr/.test(sql), 'arrival changes must be preserved');
  assert.ok(/'old_departure', o\.dep, 'new_departure', n\.dep/.test(sql), 'departure changes must be preserved');
  assert.ok(/'from_status', o\.status, 'to_status', n\.status/.test(sql), 'status resets must be preserved');
  assert.ok(!/jsonb_build_object\('old_room', o\.obj\)|'full_old_room'/.test(sql),
    'full old room objects must not be stored');
});

test('import uses bounded continuation parts with no truncation or double counts', () => {
  assert.ok(/ceil\(v_total::numeric \/ 50\.0\)/.test(sql), '50-entry bound missing');
  assert.ok(/ord > \(v_part - 1\) \* 50 and ord <= v_part \* 50/.test(sql), 'slicing rule missing');
  assert.ok(/if v_part = 1 then[\s\S]*?added_count[\s\S]*?else[\s\S]*?is_continuation', true/.test(sql),
    'counts must appear only on part 1');
  assert.ok(/left\(v_operation_id::text, 8\)/.test(sql), 'operation id must be visible in descriptions');
  assert.ok(/v_details :=[\s\S]{0,600}\|\|[\s\S]{0,600}\|\|/.test(sql), 'detail categories must be concatenated');
  assert.ok(/if v_total > 0 then/.test(sql), 'empty import must emit no rows');
  assert.ok(/'added', \(select coalesce\(jsonb_agg\(d ->> 'room'\)/.test(sql),
    'aggregate old/new room-id arrays must read the room key directly');
});

test('(room, occurrence_index) matching is deterministic for rooms and extras', () => {
  const occ = (sql.match(/row_number\(\) over \(partition by r\.value ->> 'room' order by r\.ord\)/g) || []).length;
  assert.ok(occ >= 6, `expected occurrence-index matching in rooms and extras, found ${occ}`);
  assert.ok(/o\.room = n\.room and o\.occ = n\.occ/.test(sql), 'matched rooms must use room + occurrence');
  assert.ok(/n\.room = o\.room and n\.occ = o\.occ/.test(sql), 'extras must use room + occurrence');
  assert.ok(/count\(distinct d -> 'data' ->> 'room'\)/.test(sql),
    'affected_room_count must use distinct room identifiers');
});

test('extra rooms produce one row per actual add/remove', () => {
  assert.ok(/extra_room_added/.test(sql) && /extra_room_removed/.test(sql), 'extra actions missing');
  assert.ok(/for v_x_room, v_x_obj in/.test(sql), 'extra diff loops missing');
  assert.ok(/'extra_room', v_x_room, 'Extra room ' \|\| v_x_room/.test(sql), 'extra entity id must be the room');
  assert.ok(/null, v_x_obj/.test(sql) && /v_x_obj, null/.test(sql), 'old/new values must reflect add vs remove only');
});

test('all six lifecycle actions and the fallback are present', () => {
  ['report_submitted', 'report_recalled', 'report_received', 'report_receive_undone',
    'report_signed', 'report_signature_undone', 'report_lifecycle_changed'
  ].forEach(a => assert.ok(sql.includes("'" + a + "'"), `lifecycle action missing: ${a}`));
});

test('lifecycle requires a real status change plus companion conditions', () => {
  assert.ok(/\(old\.payload -> 'handoff' ->> 'status'\) is distinct from \(new\.payload -> 'handoff' ->> 'status'\)/.test(sql),
    'handoff status field must actually change');
  assert.ok(/v_old_status is distinct from v_new_status/.test(sql), 'logical status must actually change');
  assert.ok(/new\.payload -> 'handoff' -> 'hk_sign' is not null/.test(sql), 'submit companion missing');
  assert.ok(/not \(new\.payload -> 'confirmations' \? 'housekeeping'\)/.test(sql), 'recall companion missing');
  assert.ok(/new\.payload -> 'handoff' -> 'fd_received' is not null/.test(sql), 'receive companion missing');
  assert.ok(/old\.payload -> 'confirmations' -> 'frontdesk' is null/.test(sql), 'sign companion missing');
  assert.ok(/v_new_status in \('received', 'submitted'\)/.test(sql), 'undo-signature target states missing');
  assert.ok(/'reason', 'unexpected_companion_state'/.test(sql), 'fallback reason missing');
  assert.ok(/'identity_mismatch', true/.test(sql), 'signer/actor mismatch must be flagged');
});

test('lifecycle snapshots contain only non-sensitive signature fields', () => {
  ["'name', v_old_sig ->> 'name'", "'email', v_old_sig ->> 'email'", "'time', v_old_sig ->> 'time'"].forEach(s =>
    assert.ok(sql.includes(s), `signature field missing: ${s}`));
  ['password', 'passwd', 'hash', 'token', 'secret'].forEach(word =>
    assert.ok(!new RegExp("->>\\s*'" + word + "'", 'i').test(sql), `forbidden sensitive field read: ${word}`));
});

test('shared visibility is used only for lifecycle events', () => {
  assert.ok(/'shared_report', 'report_lifecycle'/.test(sql), 'lifecycle must be shared_report');
  assert.ok(/'fo', 'department', 'setup', 'room_list_imported'/.test(sql), 'import must be department-scoped');
  assert.ok(/'hk', 'department', 'extra_rooms'/.test(sql), 'extras must be department-scoped');
  assert.ok(/'hk', 'department', 'room_checklist'/.test(sql), 'P1 room status must stay department-scoped');
});

test('P1 transition mapping is unchanged', () => {
  ['room_confirmed', 'room_unconfirmed', 'room_noluggage_on', 'room_noluggage_off',
    'room_dnd_on', 'room_dnd_off', 'room_status_changed'
  ].forEach(a => assert.ok(sql.includes("'" + a + "'"), `P1 action lost: ${a}`));
});

test('plan is committed with the implementation package', () => {
  assert.ok(/Bounded payload strategy/i.test(plan), 'plan must document bounded payload strategy');
  assert.ok(/RLS visibility matrix/i.test(plan), 'plan must document RLS matrix');
  assert.ok(/Lifecycle transition validation/i.test(plan), 'plan must document lifecycle conditions');
});

console.log(`\n--- Test Suite Completed: ${passedTests}/${totalTests} Passed ---`);
if (passedTests !== totalTests) process.exit(1);
