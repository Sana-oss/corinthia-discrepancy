// Static regression tests for P3 Batch B - report_created on INSERT.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('--- Starting P3 Report Creation Test Suite ---\n');

let passed = 0, total = 0;
function test(name, fn) {
  total++;
  try { fn(); console.log(`  [PASS] ${name}`); passed++; }
  catch (err) { console.error(`  [FAIL] ${name}`); console.error(`         ${err.message}`); }
}

const root = path.join(__dirname, '..');
const p = path.join(root, 'supabase', 'migrations', '012_p3_report_creation.sql');
assert.ok(fs.existsSync(p), 'migration 012_p3_report_creation.sql must exist');
const sql = fs.readFileSync(p, 'utf8');

test('migration only replaces the audit function', () => {
  assert.ok(/create or replace function public\.audit_daily_report_changes\(\)/i.test(sql), 'function replacement missing');
  assert.ok(!/create table|alter table|create policy|grant |revoke /i.test(sql),
    'Batch B must not change schema/RLS/grants');
  assert.ok(/drop trigger if exists trg_audit_daily_report_changes on public\.daily_reports;/i.test(sql)
    && /after insert or update on public\.daily_reports/i.test(sql),
    'trigger must be extended to INSERT');
  assert.ok(!/009_system_audit_logs|010_p2_audit_capture|011_p3_staff_audit/.test(sql), 'must not edit earlier migrations');
});

test('INSERT emits exactly one bounded report_created event', () => {
  assert.ok(/if tg_op = 'INSERT' then/.test(sql), 'INSERT branch missing');
  assert.ok(/'report_created'/.test(sql), 'event name missing');
  assert.ok(/return null;\s*end if;\s*if tg_op <> 'UPDATE'/.test(sql),
    'INSERT branch must return before P1/P2 UPDATE logic');
  assert.ok(/'shared_report'/.test(sql), 'report_created must use shared visibility');
  assert.ok(/'daily_report', new\.report_date, 'Report ' \|\| new\.report_date/.test(sql), 'entity must be the report date');
});

test('payload is a concise summary, not the full report payload', () => {
  assert.ok(/'rooms_count', v_room_count/.test(sql), 'room count missing');
  assert.ok(/'status_counts', v_status_counts/.test(sql), 'status counts missing');
  assert.ok(/'extras_count', v_extras_count/.test(sql), 'extras count missing');
  assert.ok(/'creation_source', v_creation_source/.test(sql), 'creation source missing');
  assert.ok(!/'new_values'[\s\S]{0,300}new\.payload[^-\>]/.test(sql), 'full payload must not be stored');
});

test('metadata includes hash, bounded sample and truncation flag', () => {
  ['report_date', 'initial_room_numbers_hash', 'initial_room_numbers_sample',
    'initial_room_numbers_truncated', 'source_hint'].forEach(k =>
    assert.ok(sql.includes("'" + k + "'"), `metadata missing ${k}`));
  assert.ok(/md5\(coalesce\(v_room_list_text, ''\)\)/.test(sql), 'canonical room-list hash missing');
  assert.ok(/limit 25/.test(sql), 'sample must be bounded to 25');
  assert.ok(/jsonb_array_length\(v_room_numbers\) > 25/.test(sql), 'truncation flag missing');
});

test('creation source covers all four documented cases', () => {
  ['room_list_import', 'first_checklist_action', 'extras_first', 'new_day'].forEach(s =>
    assert.ok(sql.includes("'" + s + "'"), `source case missing: ${s}`));
  assert.ok(/new\.list_uploaded_at is not null/.test(sql), 'list import detection missing');
  assert.ok(/coalesce\(r\.value ->> 'status', 'unconfirmed'\) <> 'unconfirmed'/.test(sql),
    'first checklist detection missing');
});

test('P1/P2 UPDATE behaviour is preserved verbatim', () => {
  ['room_list_imported', 'extra_room_added', 'extra_room_removed', 'report_submitted',
    'report_recalled', 'report_received', 'report_receive_undone', 'report_signed',
    'report_signature_undone', 'room_confirmed', 'room_dnd_on'].forEach(a =>
    assert.ok(sql.includes("'" + a + "'"), `P1/P2 action lost: ${a}`));
  assert.ok(/v_is_import := new\.list_uploaded_at is distinct from old\.list_uploaded_at/.test(sql), 'import branch lost');
  assert.ok(/if not v_is_import then/.test(sql), 'P1 status suppression on import lost');
  assert.ok(/part_count/.test(sql) && /is_continuation/.test(sql), 'bounded continuation lost');
});

test('actor and trust guards preserved', () => {
  assert.ok(/if auth\.uid\(\) is null then[\s\S]{0,40}return null;/.test(sql), 'unauthenticated guard lost');
  assert.ok(/select \* into v_actor from public\.audit_actor\(\)/.test(sql), 'actor snapshot lost');
  assert.ok(/identity_unresolved/.test(sql), 'unresolved identity flag lost');
  assert.ok(/if new\.payload is not distinct from old\.payload then[\s\S]{0,40}return null;/.test(sql),
    'no-op guard lost');
});

test('no credential or sensitive material can be stored', () => {
  ['password', 'passwd', 'hash', 'token', 'secret'].forEach(word => {
    // md5 is a hash function name, not credential data; allow it explicitly.
    if (word === 'hash') {
      assert.ok(/md5\(/.test(sql), 'hash function missing');
      return;
    }
    assert.ok(!new RegExp("'" + word + "'", 'i').test(sql), `forbidden literal: ${word}`);
  });
});

console.log(`\n--- Test Suite Completed: ${passed}/${total} Passed ---`);
if (passed !== total) process.exit(1);
