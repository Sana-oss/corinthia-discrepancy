// Behavioural regression tests for the Activity "Event details" presentation layer.
// The helpers are extracted from discrepancy-report.html and executed in-process
// with stubbed UI dependencies, so wording regressions fail here, not in production.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('--- Starting Activity Detail UX Test Suite ---\n');

let passedTests = 0;
let totalTests = 0;
function test(name, fn) {
  totalTests++;
  try { fn(); console.log(`  [PASS] ${name}`); passedTests++; }
  catch (err) { console.error(`  [FAIL] ${name}`); console.error(`         ${err.message}`); }
}

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'discrepancy-report.html'), 'utf8');

// ---------------------------------------------------------------- extraction
const startMarker = '      const ACTIVITY_TITLES = {';
const endMarker = '      async function loadActivity(reset) {';
const startIdx = html.indexOf(startMarker);
const endIdx = html.indexOf(endMarker);
assert.ok(startIdx > -1 && endIdx > startIdx, 'presentation layer could not be located');

const layerCode = html.slice(startIdx, endIdx);

const ROLE_LABELS = {
  hk_staff: 'HK Staff',
  hk_supervisor: 'HK Supervisor',
  hk_manager: 'HK Manager',
  fo_staff: 'FD Staff',
  fo_supervisor: 'FD Supervisor',
  fo_manager: 'FD Manager',
  gm_admin: 'GM Admin'
};
const ROLE_DEPT = {
  hk_staff: 'hk', hk_supervisor: 'hk', hk_manager: 'hk',
  fo_staff: 'fo', fo_supervisor: 'fo', fo_manager: 'fo',
  gm_admin: 'all'
};

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function formatAuditTime(value) {
  return value ? 'Nov 24, 2026, 10:00 AM' : 'Not recorded';
}
function prettyAuditJson(value) {
  try { return JSON.stringify(value, null, 2); } catch (e) { return String(value); }
}
const elements = {};
function getElement(id) {
  if (!elements[id]) {
    elements[id] = {
      id, innerHTML: '', textContent: '', value: '', hidden: false,
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }
    };
  }
  return elements[id];
}
const documentStub = { documentElement: { lang: 'en' }, getElementById: getElement };

const factory = new Function('ROLE_LABELS', 'ROLE_DEPT', 'escapeHtml', 'formatAuditTime', 'prettyAuditJson', 'document',
  layerCode + `
  return {
    presentation: activityPresentation,
    changeLines: activityChangeLines,
    sanitize: activitySanitize,
    flagList: activityFlagList,
    dateLabel: activityDateLabel,
    actionLabel: activityActionLabel,
    visibilityLabel: activityVisibilityLabel,
    renderDetail: renderActivityDetail,
    renderRow: renderActivityRow
  };
  `);
const api = factory(ROLE_LABELS, ROLE_DEPT, escapeHtml, formatAuditTime, prettyAuditJson, documentStub);

function row(action, overrides) {
  return Object.assign({
    id: 'evt-1',
    action_type: action,
    module: 'room_checklist',
    source: 'rpc',
    visibility: 'department',
    description: action,
    actor_name: 'Amina Ben Ali',
    actor_email: 'amina@corinthia-tripoli.com',
    actor_role: 'hk_staff',
    actor_department: 'hk',
    entity_type: 'daily_report',
    entity_id: 'report-1',
    entity_label: '2026-11-24',
    old_values: null,
    new_values: null,
    metadata: { report_date: '2026-11-24' },
    occurred_at: '2026-11-24T10:00:00Z'
  }, overrides || {});
}

// Every live action type, as enumerated from the audit triggers.
const ACTION_TYPES = [
  'room_confirmed', 'room_unconfirmed', 'room_noluggage_on', 'room_noluggage_off',
  'room_dnd_on', 'room_dnd_off', 'room_status_changed', 'room_list_imported',
  'extra_room_added', 'extra_room_removed', 'report_created', 'report_submitted',
  'report_recalled', 'report_received', 'report_receive_undone', 'report_signed',
  'report_signature_undone', 'report_lifecycle_changed', 'staff_created',
  'staff_updated', 'staff_active_changed', 'staff_deleted', 'staff_password_reset',
  'staff_password_changed_self'
];

// ------------------------------------------------------------------- tests
test('Every live action type has a human title and summary', () => {
  ACTION_TYPES.forEach(action => {
    const view = api.presentation(row(action));
    assert.ok(view.title && view.title.trim(), `${action}: empty title`);
    assert.ok(!view.title.includes('_'), `${action}: title still raw: ${view.title}`);
    assert.ok(view.summary && view.summary.trim(), `${action}: empty summary`);
    assert.ok(!view.summary.includes('_'), `${action}: summary still raw: ${view.summary}`);
    assert.ok(!/\b(null|undefined|NaN)\b/.test(view.summary), `${action}: placeholder leaked: ${view.summary}`);
    assert.ok(/[.!]$/.test(view.summary), `${action}: summary is not a sentence: ${view.summary}`);
  });
});

test('No raw action / module / trigger names appear in the default view', () => {
  ACTION_TYPES.forEach(action => {
    const view = api.presentation(row(action, { description: action }));
    const visible = [view.title, view.summary]
      .concat(view.facts.map(p => p[0] + ': ' + p[1]))
      .concat(view.changes)
      .join(' | ');
    ['report_created', 'db_trigger', 'shared_report', 'room_checklist', 'system_audit_logs']
      .forEach(raw => assert.ok(!visible.includes(raw), `${action}: raw token "${raw}" in default view`));
  });
});

test('Facts never show empty, null or em-dash placeholders', () => {
  ACTION_TYPES.forEach(action => {
    const view = api.presentation(row(action, { metadata: { report_date: '2026-11-24', room: null } }));
    view.facts.forEach(([label, value]) => {
      assert.ok(label && value, `${action}: empty fact pair`);
      assert.ok(!['—', '-', 'null', 'undefined'].includes(String(value).trim()),
        `${action}: placeholder fact ${label}=${value}`);
    });
  });
});

test('Report-wide events do not show a Room fact, room events do', () => {
  const reportEvents = ['report_created', 'report_submitted', 'report_received', 'report_signed',
    'report_lifecycle_changed', 'staff_created', 'staff_updated'];
  reportEvents.forEach(action => {
    const view = api.presentation(row(action));
    assert.ok(!view.facts.some(([label]) => label === 'Room'), `${action}: stray Room fact`);
  });
  const roomView = api.presentation(row('room_confirmed', {
    metadata: { report_date: '2026-11-24', room: '412', status_from: 'unconfirmed', status_to: 'confirmed' }
  }));
  assert.ok(roomView.facts.some(([label, value]) => label === 'Room' && value === '412'));
});

test('Daily report creation reads the stored counts', () => {
  const view = api.presentation(row('report_created', {
    module: 'daily_report',
    metadata: { report_date: '2026-11-24' },
    new_values: {
      rooms_count: 97,
      status_counts: { unconfirmed: 90, confirmed: 5, noluggage: 1, dnd: 1 },
      extras_count: 0,
      creation_source: 'manual'
    }
  }));
  assert.ok(view.summary.includes('November 24, 2026'), view.summary);
  assert.ok(view.facts.some(([l, v]) => l === 'Total rooms' && v === '97'));
  assert.ok(view.facts.some(([l, v]) => l === 'Extra rooms' && v === '0'),
    'a real zero must still be shown');
  assert.ok(view.facts.some(([l, v]) => l === 'Room status' && v.includes('5 checked')));
});

test('Room status change spells out the transition in plain language', () => {
  const view = api.presentation(row('room_status_changed', {
    metadata: {
      report_date: '2026-11-24', room: '412', status_from: 'unconfirmed', status_to: 'confirmed',
      set_flags: ['confirmed'], unset_flags: []
    }
  }));
  assert.ok(view.summary.includes('Room 412'), view.summary);
  assert.ok(view.summary.includes('Unchecked') && view.summary.includes('Checked'), view.summary);
  assert.ok(view.facts.some(([l, v]) => l === 'Flags set' && v === 'Checked'));
  assert.ok(!view.facts.some(([l]) => l === 'Flags cleared'), 'empty cleared list must be hidden');
});

test('Room toggles explain the flag that changed', () => {
  const dnd = api.presentation(row('room_dnd_on', { metadata: { report_date: '2026-11-24', room: '701' } }));
  assert.ok(/Do Not Disturb/.test(dnd.summary) && dnd.summary.includes('701'), dnd.summary);
  const cleared = api.presentation(row('room_noluggage_off', { metadata: { report_date: '2026-11-24', room: '701' } }));
  assert.ok(/no-luggage/i.test(cleared.summary), cleared.summary);
});

test('Multi-part room list imports read clearly and stay scoped', () => {
  const view = api.presentation(row('room_list_imported', {
    module: 'setup',
    metadata: {
      report_date: '2026-11-24', operation_id: 'op-1', part: 2, part_count: 3,
      is_continuation: true, added_rooms: [{ room: '101' }, { room: '102' }]
    }
  }));
  assert.ok(view.summary.includes('2 added'), view.summary);
  assert.ok(view.summary.includes('Part 2 of 3'), view.summary);
  assert.ok(!view.facts.some(([l]) => l === 'Total rooms'),
    'continuation parts must not pretend to have a new total');
});

test('Report lifecycle events show both statuses without raw values', () => {
  const view = api.presentation(row('report_lifecycle_changed', {
    module: 'report_lifecycle', visibility: 'shared_report',
    metadata: { report_date: '2026-11-24', from_status: 'submitted', to_status: 'received' },
    old_values: { status: 'submitted', signature: null },
    new_values: { status: 'received', signature: { name: 'Nadia', email: 'nadia@x.com', time: '2026-11-24T11:00:00Z' } }
  }));
  assert.ok(view.facts.some(([l, v]) => l === 'Status' && v === 'Submitted → Received'));
  assert.ok(view.summary.includes('Submitted') && view.summary.includes('Received'), view.summary);
  assert.ok(!view.summary.includes('_'));
});

test('Lifecycle anomaly reason is explained, not echoed', () => {
  const view = api.presentation(row('report_lifecycle_changed', {
    module: 'report_lifecycle',
    metadata: { report_date: '2026-11-24', reason: 'unexpected_companion_state' }
  }));
  const reason = view.facts.find(([l]) => l === 'Reason');
  assert.ok(reason, 'reason fact missing');
  assert.ok(!reason[1].includes('unexpected_companion_state'),
    'raw reason code leaked into the readable view');
});

test('Submission and signature facts name the signer', () => {
  const view = api.presentation(row('report_submitted', {
    module: 'report_lifecycle',
    metadata: { report_date: '2026-11-24', from_status: 'in_progress', to_status: 'submitted' },
    new_values: { status: 'submitted', signature: { name: 'Nadia', email: 'nadia@x.com', time: '2026-11-24T11:00:00Z' } }
  }));
  assert.ok(view.summary.includes('Nadia'), view.summary);
  assert.ok(view.facts.some(([l, v]) => l === 'Submitted by' && v.includes('Nadia')));
  assert.ok(view.facts.some(([l]) => l === 'Signed at'));
});

test('Staff events name the employee, role and department', () => {
  const created = api.presentation(row('staff_created', {
    module: 'staff', visibility: 'staff_admin', entity_type: 'staff',
    metadata: {
      target_email: 'omar@corinthia-tripoli.com', target_full_name: 'Omar Haddad',
      target_role: 'fo_supervisor', target_department: 'fo'
    },
    new_values: { full_name: 'Omar Haddad', role: 'fo_supervisor', active: true }
  }));
  assert.ok(created.summary.includes('Omar Haddad'), created.summary);
  assert.ok(created.summary.includes('FD Supervisor'), created.summary);
  assert.ok(created.facts.some(([l, v]) => l === 'Role' && v === 'FD Supervisor'));
  assert.ok(created.facts.some(([l, v]) => l === 'Department' && v === 'Front Desk'));
});

test('Staff updates render a readable before → after diff', () => {
  const view = api.presentation(row('staff_updated', {
    module: 'staff', entity_type: 'staff',
    old_values: { role: 'hk_staff' },
    new_values: { role: 'hk_supervisor' }
  }));
  assert.ok(view.changes.some(line => line === 'Role: HK Staff → HK Supervisor'), view.changes.join('|'));
});

test('Deactivation and password events are explicit and safe', () => {
  const deactivated = api.presentation(row('staff_active_changed', {
    module: 'staff',
    old_values: { active: true }, new_values: { active: false }
  }));
  assert.ok(/deactivated/i.test(deactivated.summary), deactivated.summary);
  assert.ok(deactivated.facts.some(([l, v]) => l === 'Account' && v === 'Inactive'));

  const reset = api.presentation(row('staff_password_reset', { module: 'staff' }));
  assert.ok(/password/i.test(reset.summary), reset.summary);
  const self = api.presentation(row('staff_password_changed_self', { module: 'staff' }));
  assert.ok(/their own/i.test(self.summary), self.summary);
});

test('Credential-like keys are stripped everywhere', () => {
  const clean = api.sanitize({
    password: 'hunter2',
    password_hash: 'deadbeef',
    nested: { token: 'abc123', api_key: 'k-1', note: 'kept' },
    list: [{ secret: 's', room: '101' }]
  });
  assert.strictEqual(clean.password, undefined);
  assert.strictEqual(clean.password_hash, undefined);
  assert.strictEqual(clean.nested.token, undefined);
  assert.strictEqual(clean.nested.api_key, undefined);
  assert.strictEqual(clean.nested.note, 'kept');
  assert.strictEqual(clean.list[0].secret, undefined);
  assert.strictEqual(clean.list[0].room, '101');
});

test('Detail view renders hero, facts and a collapsed technical section', () => {
  const detail = row('report_created', {
    module: 'daily_report',
    metadata: { report_date: '2026-11-24', initial_room_numbers_sample: ['101', '102'] },
    new_values: { rooms_count: 2, status_counts: { unconfirmed: 2 }, extras_count: 0 }
  });
  api.renderDetail(detail);
  const out = getElement('activityDetailBody').innerHTML;

  assert.ok(out.includes('activity-hero'), 'hero missing');
  assert.ok(out.includes('Daily report created'), 'friendly title missing');
  assert.ok(out.includes('A new daily report was created'), 'summary missing');
  assert.ok(out.includes('activity-facts'), 'facts list missing');
  assert.ok(out.includes('<details class="activity-tech">'), 'technical details must be collapsed by default');
  assert.ok(out.includes('<summary>Technical details</summary>'), 'technical summary label missing');
  assert.ok(!/open=/.test(out.slice(out.indexOf('<details'), out.indexOf('<summary>'))),
    'technical details must not start expanded');

  const visible = out.slice(0, out.indexOf('<details'));
  assert.ok(!visible.includes('report_created'), 'raw action type leaked into the readable view');
  assert.ok(!visible.includes('initial_room_numbers_sample'), 'raw metadata key leaked into the readable view');

  const technical = out.slice(out.indexOf('<details'));
  assert.ok(technical.includes('report_created'), 'action type must remain available in technical details');
  assert.ok(technical.includes('&quot;rooms_count&quot;: 2'), 'raw JSON formatting must be preserved');
  assert.ok(technical.includes('&quot;initial_room_numbers_sample&quot;'), 'sample arrays must remain available');
});

test('Detail view hides empty blocks and never shows em dashes', () => {
  const detail = row('room_confirmed', {
    metadata: { report_date: '2026-11-24', room: '412' },
    old_values: null, new_values: null
  });
  api.renderDetail(detail);
  const out = getElement('activityDetailBody').innerHTML;
  assert.ok(!out.includes('Previous values'), 'empty previous-values block should be hidden');
  assert.ok(!out.includes('New values'), 'empty new-values block should be hidden');
  assert.ok(!out.includes('—'), 'em dash placeholders must not be rendered');
  assert.ok(out.includes('Technical details'));

  api.renderDetail(row('room_confirmed', { metadata: {}, old_values: null, new_values: null }));
  const bare = getElement('activityDetailBody').innerHTML;
  assert.ok(!bare.includes('Metadata'), 'empty metadata block should be hidden');
});

test('Unresolved identity is stated plainly', () => {
  const detail = row('room_confirmed', {
    actor_name: null, actor_email: null, actor_role: null, actor_department: null,
    metadata: { report_date: '2026-11-24', room: '412', identity_unresolved: true }
  });
  api.renderDetail(detail);
  const out = getElement('activityDetailBody').innerHTML;
  assert.ok(out.includes('activity-who-unresolved'), 'unresolved identity marker missing');
  assert.ok(/identity could not be confirmed/i.test(out));
});

test('Technical details redact credential material from raw JSON', () => {
  const detail = row('staff_password_reset', {
    module: 'staff',
    metadata: {
      target_email: 'amina@corinthia-tripoli.com', target_full_name: 'Amina Ben Ali',
      password: 'hunter2', password_hash: 'deadbeef', access_token: 'tok-123'
    },
    old_values: { password_hash: 'deadbeef' },
    new_values: { password: 'hunter2' }
  });
  api.renderDetail(detail);
  const out = getElement('activityDetailBody').innerHTML;
  assert.ok(!out.includes('hunter2'), 'plaintext password leaked');
  assert.ok(!out.includes('deadbeef'), 'password hash leaked');
  assert.ok(!out.includes('tok-123'), 'access token leaked');
  assert.ok(out.includes('Amina Ben Ali'), 'non-secret context must survive');
});

test('Unknown future event types degrade gracefully', () => {
  const view = api.presentation(row('future_room_audit', { description: 'Something new happened' }));
  assert.ok(view.title && !view.title.includes('_'), view.title);
  assert.ok(view.summary.includes('Something new happened'), view.summary);
});

test('List rows show the friendly title and summary, never raw JSON', () => {
  const out = api.renderRow(row('report_created', {
    module: 'daily_report',
    new_values: { rooms_count: 97, extras_count: 0 }
  }));
  assert.ok(out.includes('Daily report created'), 'friendly title missing from row');
  assert.ok(out.includes('A new daily report was created'), 'summary missing from row');
  assert.ok(out.includes('a-summary'), 'summary must be clamps to two lines');
  assert.ok(!out.includes('report_created'), 'raw action name leaked into row');
  assert.ok(!out.includes('{'), 'JSON leaked into row');
  assert.ok(!out.includes('Unknown role') && !out.includes('Unknown employee'),
    'placeholder role/employee labels must not be rendered');
});

test('Rows with unresolved identity do not show placeholder labels', () => {
  const out = api.renderRow(row('room_confirmed', {
    actor_name: null, actor_email: null, actor_role: null, actor_department: null,
    metadata: { report_date: '2026-11-24', room: '412', identity_unresolved: true }
  }));
  assert.ok(out.includes('Employee identity could not be confirmed'), out);
  assert.ok(!out.includes('Unknown role') && !out.includes('Unknown employee'), out);
});

console.log(`\n--- Test Suite Completed: ${passedTests}/${totalTests} Passed ---`);
if (passedTests !== totalTests) process.exit(1);
