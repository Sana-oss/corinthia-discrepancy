// Static regression tests for the Activity UI in the History tab.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('--- Starting Activity UI Test Suite ---\n');

let passedTests = 0;
let totalTests = 0;
function test(name, fn) {
  totalTests++;
  try { fn(); console.log(`  [PASS] ${name}`); passedTests++; }
  catch (err) { console.error(`  [FAIL] ${name}`); console.error(`         ${err.message}`); }
}

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'discrepancy-report.html'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('History tab has Reports | Activity segments and both panels', () => {
  ['tab-history', 'historySegmentReports', 'historySegmentActivity', 'historyReports', 'historyActivity',
    'activityCoverage', 'activityFiltersWrap', 'activityEmployeeFilter', 'activityDepartmentFilter',
    'activityRoleFilter', 'activityModuleFilter', 'activityActionFilter', 'activityDateFrom',
    'activityDateTo', 'activitySearch', 'activityResetBtn', 'activityList', 'activityLoadMoreBtn',
    'activityDetail', 'activityDetailBody', 'activityBackBtn', 'activityStatus'
  ].forEach(id => assert.ok(html.includes('id="' + id + '"'), `missing id="${id}"`));
});

test('JavaScript in the page still parses (no syntax regressions)', () => {
  const vm = require('vm');
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script, 'main <script> block missing');
  assert.doesNotThrow(() => new vm.Script(script[1]), 'JavaScript syntax error');
});

test('Activity reads only the centralized system_audit_logs table', () => {
  assert.ok(/from\('system_audit_logs'\)\.select\('\*'\)/.test(html), 'Activity must select from system_audit_logs');
  assert.ok(!/create table[\s\S]{0,200}audit/i.test(html), 'no new audit table in the client');
  assert.ok(!/\.insert\(\s*\{\s*[^}]*(actor_|action_type|old_values)/i.test(html),
    'the client must never insert audit rows');
  assert.ok(!/system_audit_logs['"]\s*\)\s*\.(update|delete|upsert)/i.test(html),
    'the client must never mutate audit rows');
});

test('Backend RLS remains authoritative — no frontend authorization bypass', () => {
  assert.ok(/Row visibility is enforced by Supabase RLS; nothing here tries/i.test(html),
    'RLS-first comment missing');
  assert.ok(!/service_role/i.test(html), 'the browser must not use a service role');
  assert.ok(/if \(f\.employee\) q = q\.eq\('actor_user_id', f\.employee\)/.test(html),
    'employee filter must use actor_user_id from the JWT-derived row');
  assert.ok(/f\.department === 'shared'\) q = q\.eq\('visibility', 'shared_report'\)/.test(html),
    'shared-report filter must use the DB visibility field');
});

test('Role-aware gating keeps Reports restricted and staff on their own Activity', () => {
  assert.ok(/if \(tab === 'history'\) return 'full';/.test(html), 'History must be reachable by all roles');
  assert.ok(/function canSeeHistoryReports\(\) \{ return myTier\(\) !== 'staff'; \}/.test(html),
    'Reports must stay restricted to supervisors/managers');
  assert.ok(/document\.getElementById\('historySegmentReports'\)\.classList\.toggle\('hidden', staffOnly\)/.test(html),
    'Reports segment must be hidden for staff');
  assert.ok(/document\.getElementById\('historyReports'\)\.classList\.toggle\('hidden', staffOnly\)/.test(html),
    'Reports panel must be hidden for staff');
  assert.ok(/if \(staffOnly\) setHistorySegment\('activity'\)/.test(html), 'staff must default to Activity');
  assert.ok(/You can see only your own recorded actions\./.test(html), 'staff self-only notice missing');
  assert.ok(/if \(canSeeHistoryReports\(\)\) \{[\s\S]{0,400}loadHistoryList\(\);[\s\S]{0,200}\} else \{\s*setHistorySegment\('activity'\);/i.test(html),
    'staff must not load past reports');
});

test('Filters, search and pagination are implemented', () => {
  ['activityEmployeeFilter', 'activityDepartmentFilter', 'activityRoleFilter', 'activityModuleFilter',
    'activityActionFilter', 'activityDateFrom', 'activityDateTo', 'activitySearch'
  ].forEach(id => {
    assert.ok(new RegExp("document\\.getElementById\\('" + id + "'\\)\\.value").test(html),
      `${id} is not read by the query builder`);
  });
  assert.ok(/\.range\(activityOffset, activityOffset \+ ACTIVITY_PAGE_SIZE\)/.test(html), 'pagination missing');
  assert.ok(/const ACTIVITY_PAGE_SIZE = 50;/.test(html), 'page size missing');
  assert.ok(/activityLoadMoreBtn'\)\.hidden = !activityHasMore/.test(html), 'load-more state missing');
  assert.ok(/replace\(\/\[\^A-Za-z0-9\\-\]\/g, ''\)/.test(html), 'search input must be sanitized');
  assert.ok(/metadata->>room\.ilike/.test(html) && /metadata->>report_date\.ilike/.test(html),
    'room and report search must target metadata');
  assert.ok(/resetActivityFilters\(\)/.test(html), 'reset control missing');
});

test('Required fields are rendered: identity, action, record, values, timestamps, source', () => {
  ['actor_name', 'actor_role', 'actor_department', 'description', 'action_type',
    'entity_label', 'entity_id', 'old_values', 'new_values', 'occurred_at', 'module', 'source'
  ].forEach(field => {
    assert.ok(new RegExp('r\\.' + field + '\\b').test(html), `row renderer omits ${field}`);
  });
  assert.ok(/Original action timestamp/.test(html), 'original timestamp label missing');
  assert.ok(/Server recording timestamp/.test(html), 'server timestamp label missing');
  assert.ok(/client_occurred_at \? formatAuditTime/.test(html),
    'original time must be shown only when actually stored');
  assert.ok(/Not recorded for this event \(server time only\)/.test(html),
    'no fabricated original timestamp');
  assert.ok(/Cleared flags/.test(html), 'cross-state metadata must be visible');
});

test('Coverage start is explicit and never claims pre-deployment history', () => {
  assert.ok(/AUDIT_COVERAGE_START = '2026-11-23'/.test(html), 'coverage constant missing');
  assert.ok(/Audit coverage begins/.test(html), 'coverage banner missing');
  assert.ok(/Activity before this date was not captured\./.test(html), 'coverage limitation missing');
});

test('RTL/LTR and responsive layout use direction-neutral CSS', () => {
  ['border-block-end', 'margin-block-end', 'margin-block-start', 'padding-block', 'text-align: start'
  ].forEach(prop => assert.ok(html.includes(prop), `logical CSS property missing: ${prop}`));
  assert.ok(/grid-template-columns: repeat\(auto-fit, minmax\(200px, 1fr\)\)/.test(html),
    'filter grid must adapt from mobile to desktop');
  assert.ok(/Intl\.DateTimeFormat\(document\.documentElement\.lang \|\| undefined/.test(html),
    'dates must follow the document language');
});

test('No new dependencies were introduced', () => {
  assert.deepStrictEqual(Object.keys(pkg.dependencies || {}), ['sharp'],
    'Activity UI must not add packages');
});

console.log(`\n--- Test Suite Completed: ${passedTests}/${totalTests} Passed ---`);
if (passedTests !== totalTests) process.exit(1);
