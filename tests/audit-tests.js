// Static regression tests for Phase P1 of the centralized audit trail.
// These tests guard the invariant that Room Checklist transitions are captured
// by the database (not by a client claim) and that audit history cannot be
// rewritten. Live database verification is recorded in docs/audit-trail.md.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('--- Starting Audit Trail (P1) Test Suite ---\n');

let passedTests = 0;
let totalTests = 0;

function test(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  [PASS] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  [FAIL] ${name}`);
    console.error(`         ${err.message}`);
  }
}

const root = path.join(__dirname, '..');
const migrationPath = path.join(root, 'supabase', 'migrations', '009_system_audit_logs.sql');
const htmlPath = path.join(root, 'discrepancy-report.html');

assert.ok(fs.existsSync(migrationPath), 'migration 009_system_audit_logs.sql must exist');
const sql = fs.readFileSync(migrationPath, 'utf8');
const html = fs.readFileSync(htmlPath, 'utf8');

// ---------------------------------------------------------------------------
// 1. Centralized table and actor snapshot
// ---------------------------------------------------------------------------
test('centralized append-only table exists with identity key and occurrence time', () => {
  assert.ok(/create table public\.system_audit_logs\s*\(/i.test(sql), 'table definition missing');
  assert.ok(/id\s+bigint generated always as identity primary key/i.test(sql), 'immutable identity key missing');
  assert.ok(/occurred_at\s+timestamptz not null default now\(\)/i.test(sql), 'DB-clock timestamp missing');
  assert.ok(/metadata\s+jsonb not null default '\{\}'::jsonb/i.test(sql), 'metadata column missing');
});

test('actor is snapshotted from verified JWT and staff row (never from the client)', () => {
  ['actor_user_id', 'actor_email', 'actor_name', 'actor_role', 'actor_department'].forEach(col => {
    assert.ok(new RegExp('\\b' + col + '\\b').test(sql), `actor snapshot column ${col} missing`);
  });
  assert.ok(/auth\.uid\(\)/.test(sql), 'actor must come from auth.uid()');
  assert.ok(/auth\.jwt\(\)\s*->>\s*'email'/.test(sql), 'actor email must come from the verified JWT');
  assert.ok(/join public\.staff s/.test(sql), 'actor name/role must come from the staff row');
  assert.ok(/lower\(s\.email\)\s*=\s*lower\(/.test(sql), 'staff lookup must be normalized by email');
  assert.ok(!html.includes('updated_by'), 'the browser must never send or read updated_by');
});

test('visibility model supports department scope and cross-department shared reports', () => {
  assert.ok(/visibility\s+text not null default 'department'/i.test(sql), 'visibility default missing');
  assert.ok(/check \(visibility in \('department', 'shared_report'\)\)/i.test(sql), 'visibility check missing');
  assert.ok(/department\s+text,/.test(sql), 'event-scope department missing');
});

// ---------------------------------------------------------------------------
// 2. RLS and immutability
// ---------------------------------------------------------------------------
test('RLS is enabled with a single read policy and no write policies', () => {
  assert.ok(/alter table public\.system_audit_logs enable row level security/i.test(sql), 'RLS not enabled');
  assert.ok(/create policy "audit read scoped"[\s\S]*?for select[\s\S]*?to authenticated/i.test(sql), 'read policy missing');
  const policies = [...sql.matchAll(/create policy\s+"[^"]+"[\s\S]*?on public\.system_audit_logs[\s\S]*?for\s+(\w+)/gi)]
    .map(m => m[1].toLowerCase());
  assert.deepStrictEqual(policies, ['select'], 'only SELECT policies are allowed');
});

test('write grants are revoked from API roles and SELECT is granted to authenticated', () => {
  assert.ok(/revoke all on table public\.system_audit_logs from anon, authenticated;/i.test(sql), 'revoke missing');
  assert.ok(/grant select on table public\.system_audit_logs to authenticated;/i.test(sql), 'select grant missing');
  assert.ok(!/grant (insert|update|delete|all) on table public\.system_audit_logs/i.test(sql), 'unexpected write grant');
});

test('UPDATE, DELETE and TRUNCATE are blocked by triggers for every non-owner role', () => {
  assert.ok(/create trigger trg_system_audit_logs_no_update[\s\S]*?before update/i.test(sql), 'no UPDATE guard');
  assert.ok(/create trigger trg_system_audit_logs_no_delete[\s\S]*?before delete/i.test(sql), 'no DELETE guard');
  assert.ok(/create trigger trg_system_audit_logs_no_truncate[\s\S]*?before truncate/i.test(sql), 'no TRUNCATE guard');
  assert.ok(/current_user not in \('postgres', 'supabase_admin'\)/.test(sql), 'owner exemption missing');
  assert.ok(/system_audit_logs is append-only/.test(sql), 'exception message missing');
  assert.ok(!/^\s*(update|delete from|truncate)\s+public\.system_audit_logs/gim.test(sql.replace(/create trigger[\s\S]*?;/gi, '')),
    'migration itself must not mutate audit rows');
});

test('RLS read rules match the approved scope matrix', () => {
  assert.ok(/v\.viewer_role = 'gm_admin'/.test(sql), 'GM full read missing');
  assert.ok(/v\.viewer_tier = 'manager'/.test(sql), 'manager scope missing');
  assert.ok(/v\.viewer_tier = 'supervisor'/.test(sql), 'supervisor scope missing');
  assert.ok(/visibility = 'shared_report'/.test(sql), 'cross-department shared_report read missing');
  assert.ok(/actor_user_id = auth\.uid\(\)/.test(sql), 'staff self-read missing');
});

// ---------------------------------------------------------------------------
// 3. Room Checklist capture model
// ---------------------------------------------------------------------------
test('only authenticated UPDATE writes are captured (no baseline or service-role rows)', () => {
  assert.ok(/create trigger trg_audit_daily_report_changes[\s\S]*?after update on public\.daily_reports/i.test(sql),
    'capture must be an AFTER UPDATE trigger');
  assert.ok(/if auth\.uid\(\) is null then[\s\S]*?return null;/i.test(sql), 'unauthenticated writes must be skipped');
  assert.ok(/if tg_op <> 'UPDATE' then[\s\S]*?return null;/i.test(sql), 'INSERT must not emit baseline rows');
  assert.ok(!/insert\s+into\s+public\.system_audit_logs[\s\S]*?from\s+public\.daily_reports/i.test(sql),
    'no historical backfill is allowed');
  assert.ok(!/generate_series/i.test(sql), 'no generated baseline rows are allowed');
});

test('no-op saves and list imports emit zero rows', () => {
  assert.ok(/if new\.payload is not distinct from old\.payload then[\s\S]*?return null;/i.test(sql),
    'identical payload must emit nothing');
  assert.ok(/if new\.list_uploaded_at is distinct from old\.list_uploaded_at then[\s\S]*?return null;/i.test(sql),
    'list import must not be mislabelled as checklist activity');
});

test('all four mutually exclusive room statuses map to explicit ON/OFF actions', () => {
  const actions = [
    'room_confirmed', 'room_unconfirmed',
    'room_noluggage_on', 'room_noluggage_off',
    'room_dnd_on', 'room_dnd_off',
    'room_status_changed' // unexpected persisted value: never silently dropped
  ];
  actions.forEach(action => {
    assert.ok(sql.includes(`'${action}'`), `missing action mapping: ${action}`);
  });
  ['unconfirmed', 'confirmed', 'noluggage', 'dnd'].forEach(status => {
    assert.ok(new RegExp(`v_(from|to) = '${status}'`).test(sql) || sql.includes(`'${status}'`),
      `status ${status} not handled`);
  });
});

test('cross-state replacement records one row with cleared flags preserved', () => {
  assert.ok(/jsonb_build_array\(v_from\)/.test(sql), 'previous state must be preserved in unset_flags');
  assert.ok(/'unset_flags',\s*v_unset_flags/.test(sql), 'unset_flags must be stored in metadata');
  assert.ok(/'status_from',\s*v_from/.test(sql), 'status_from missing');
  assert.ok(/'status_to',\s*v_to/.test(sql), 'status_to missing');
  assert.ok(/'report_date',\s*new\.report_date/.test(sql), 'report_date missing');
  assert.ok(/'room',\s*v_room_key/.test(sql), 'room missing');
  assert.ok(/if v_from = v_to then[\s\S]*?continue;/i.test(sql), 'unchanged rooms must emit nothing');
  assert.ok(/if v_old_room is null then[\s\S]*?continue;/i.test(sql), 'new rooms are P2, not P1');
});

test('changed values contain only the persisted status field', () => {
  assert.ok(/jsonb_build_object\('status', v_from\)/.test(sql), 'old_values must hold only status');
  assert.ok(/jsonb_build_object\('status', v_to\)/.test(sql), 'new_values must hold only status');
});

test('every browser status mutation persists through sbSaveDay', () => {
  const setters = [
    "r.status = (r.status === 'confirmed' || r.status === 'noluggage') ? 'unconfirmed' : 'confirmed';",
    "r.status = (r.status === 'noluggage') ? 'confirmed' : 'noluggage';",
    "r.status = (r.status === 'dnd') ? 'unconfirmed' : 'dnd';"
  ];
  setters.forEach(setter => {
    const i = html.indexOf(setter);
    assert.ok(i >= 0, `missing status mutation: ${setter}`);
    const chunk = html.slice(i, i + 250);
    assert.ok(/await saveState\(\);/.test(chunk), `status mutation is not saved: ${setter}`);
  });
  assert.ok(/async function saveState\(stampUpload\)[\s\S]{0,400}await sbSaveDay\(todayKey, state, stampUpload\)/.test(html),
    'saveState must persist via sbSaveDay');
  assert.ok(!/updated_by/.test(html), 'client must never attempt to set the actor');
});

// ---------------------------------------------------------------------------
// 4. Privacy and coverage rules
// ---------------------------------------------------------------------------
test('no password, hash or token data can enter the audit table', () => {
  // The word "password" only appears in a comment about a FUTURE phase.
  // What matters is that no such value is stored as a column or read from a row.
  const columnDefs = (sql.match(/^\s{2}[a-z_]+\s+(?:uuid|text|jsonb|bigint|timestamptz)[^,;]*/gim) || []).join('\n');
  ['password', 'passwd', 'hash', 'token', 'secret', 'credential'].forEach(word => {
    assert.ok(!new RegExp(`\\b${word}\\b`, 'i').test(columnDefs), `forbidden credential column: ${word}`);
  });
  assert.ok(!/->>\s*'(password|passwd|hash|token)'/i.test(sql), 'no credential value may be read into metadata');
  assert.ok(!/encrypted_password/i.test(sql), 'no auth credential may be referenced');
});

test('coverage start is documented and no actor/timestamp is fabricated', () => {
  assert.ok(/Coverage begins at the first row written after this migration/i.test(sql),
    'coverage start must be stated on the table');
  assert.ok(/no marker ROW/i.test(sql), 'synthetic marker rows are forbidden');
  assert.ok(/occurred_at\s+timestamptz not null default now\(\)/i.test(sql),
    'timestamps must come from the database clock');
});

test('updated_by is stamped server-side from auth.uid()', () => {
  assert.ok(/create trigger trg_stamp_daily_report_actor[\s\S]*?before insert or update on public\.daily_reports/i.test(sql),
    'updated_by stamping trigger missing');
  assert.ok(/new\.updated_by := auth\.uid\(\)/.test(sql), 'updated_by must come from auth.uid()');
});

console.log(`\n--- Test Suite Completed: ${passedTests}/${totalTests} Passed ---`);
if (passedTests !== totalTests) {
  process.exit(1);
}
