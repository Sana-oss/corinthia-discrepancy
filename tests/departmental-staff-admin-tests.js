// Automated Test Suite for Room Discrepancy Report — Departmental Staff Admin
// (Front Office Manager manages Front Desk staff only; Housekeeping Manager
// manages Housekeeping staff only; gm_admin manages every department —
// enforced in the UI, the Supabase RLS policies AND the create-staff edge
// function, not just by hiding controls.)
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

console.log('--- Starting Departmental Staff Admin Test Suite ---\n');

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

const htmlPath = path.join(__dirname, '..', 'discrepancy-report.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
const script = scriptMatch ? scriptMatch[1] : '';

// ============================================================
// 1. File & syntax integrity
// ============================================================
test('HTML file exists with valid JavaScript (syntax check)', () => {
  assert.ok(fs.existsSync(htmlPath), 'discrepancy-report.html must exist');
  assert.ok(scriptMatch, 'Could not find <script> tag in HTML');
  assert.doesNotThrow(() => {
    new vm.Script(script);
  }, 'JavaScript in discrepancy-report.html contains syntax errors');
});

test('Staff UI elements exist (incl. dynamic intro)', () => {
  const requiredIds = [
    'tab-staff', 'staffList', 'staffFormWrap', 'staffRoleSelect',
    'staffNameInput', 'staffEmailInput', 'staffPassInput',
    'staffActiveCheck', 'staffSaveBtn', 'staffCancelBtn',
    'staffAddBtn', 'staffHint', 'staffIntro', 'staffFormTitle'
  ];
  requiredIds.forEach(id => {
    assert.ok(html.includes(`id="${id}"`), `DOM element id="${id}" missing in HTML`);
  });
});

// ============================================================
// 2. Role constants — seven roles, gm_admin sentinel
// ============================================================
test('ROLE_LABELS / ROLE_DEPT / ROLE_TIER define all seven roles with gm_admin = "all"', () => {
  const roles = ['hk_staff', 'hk_supervisor', 'hk_manager', 'fo_staff', 'fo_supervisor', 'fo_manager', 'gm_admin'];
  for (const r of roles) {
    assert.ok(
      new RegExp(`\\b${r}:`).test(script),
      `Role "${r}" missing from the role constants in discrepancy-report.html`
    );
  }
  assert.ok(/ROLE_DEPT\s*=\s*\{[\s\S]*?gm_admin:\s*'all'/.test(script),
    'ROLE_DEPT must map gm_admin to the "all" department sentinel');
  assert.ok(/ROLE_TIER\s*=\s*\{[\s\S]*?gm_admin:\s*'manager'/.test(script),
    'ROLE_TIER must classify gm_admin as a manager tier');
  assert.ok(/MANAGER_ROLES\s*=\s*\[[^\]]*gm_admin[^\]]*\]/.test(script),
    'MANAGER_ROLES must include gm_admin');
});

// ============================================================
// 3. Evaluate the REAL permission functions in a sandbox
//    (regex-extracted from discrepancy-report.html, not re-implemented)
// ============================================================
const rolesStart = script.indexOf('const ROLE_LABELS = {');
const sandboxEnd = script.indexOf('function hkFrozen()');
assert.ok(rolesStart !== -1, 'ROLE_LABELS block not found in script');
assert.ok(sandboxEnd > rolesStart, 'Roles block is malformed (hkFrozen marker not found after it)');
const rolesBlock = script.slice(rolesStart, sandboxEnd);

const sandbox = { console, Math, JSON };
vm.createContext(sandbox);
vm.runInContext('var me = null;', sandbox); // declared so callers can switch roles
vm.runInContext(rolesBlock, sandbox);
// vm.Function boundaries: expose helpers for the tests
vm.runInContext(`
  function __access(tab) { return tabAccess(tab); }
  function __canManage(role) { return canManageRole(role); }
  function __canConfirm(side) { return canConfirm(side); }
`, sandbox);

const ALL_TABS = ['setup', 'checklist', 'extra', 'summary', 'history', 'staff'];
// Expected tabAccess per role, straight from roles-implementation-plan.md.
const EXPECTED_MATRIX = {
  hk_staff:     { setup: 'hidden', checklist: 'full', extra: 'full', summary: 'view',  history: 'hidden', staff: 'hidden' },
  hk_supervisor:{ setup: 'hidden', checklist: 'full', extra: 'full', summary: 'full',  history: 'full',   staff: 'hidden' },
  hk_manager:   { setup: 'hidden', checklist: 'full', extra: 'full', summary: 'full',  history: 'full',   staff: 'full'   },
  fo_staff:     { setup: 'full',   checklist: 'hidden', extra: 'hidden', summary: 'view', history: 'hidden', staff: 'hidden' },
  fo_supervisor:{ setup: 'full',   checklist: 'hidden', extra: 'hidden', summary: 'full', history: 'full',   staff: 'hidden' },
  fo_manager:   { setup: 'full',   checklist: 'hidden', extra: 'hidden', summary: 'full', history: 'full',   staff: 'full'   },
  gm_admin:     { setup: 'hidden', checklist: 'hidden', extra: 'hidden', summary: 'full', history: 'full',   staff: 'full'   }
};

test('REAL tabAccess matrix matches the plan for all seven roles', () => {
  for (const role of Object.keys(EXPECTED_MATRIX)) {
    sandbox.me = { role };
    for (const tab of ALL_TABS) {
      const got = sandbox.__access(tab);
      assert.strictEqual(
        got, EXPECTED_MATRIX[role][tab],
        `tabAccess('${tab}') for ${role} should be '${EXPECTED_MATRIX[role][tab]}' but was '${got}'`
      );
    }
  }
});

test('Front Office Manager can manage ONLY Front Desk roles (canManageRole)', () => {
  sandbox.me = { role: 'fo_manager' };
  assert.strictEqual(sandbox.__canManage('fo_staff'), true);
  assert.strictEqual(sandbox.__canManage('fo_supervisor'), true);
  assert.strictEqual(sandbox.__canManage('fo_manager'), true);
  assert.strictEqual(sandbox.__canManage('hk_staff'), false, 'FO manager must NOT manage Housekeeping staff');
  assert.strictEqual(sandbox.__canManage('hk_supervisor'), false);
  assert.strictEqual(sandbox.__canManage('hk_manager'), false);
  assert.strictEqual(sandbox.__canManage('gm_admin'), false, 'FO manager must NOT manage gm_admin rows');
});

test('Housekeeping Manager can manage ONLY Housekeeping roles (canManageRole)', () => {
  sandbox.me = { role: 'hk_manager' };
  assert.strictEqual(sandbox.__canManage('hk_staff'), true);
  assert.strictEqual(sandbox.__canManage('hk_supervisor'), true);
  assert.strictEqual(sandbox.__canManage('hk_manager'), true);
  assert.strictEqual(sandbox.__canManage('fo_staff'), false, 'HK manager must NOT manage Front Desk staff');
  assert.strictEqual(sandbox.__canManage('fo_supervisor'), false);
  assert.strictEqual(sandbox.__canManage('fo_manager'), false);
  assert.strictEqual(sandbox.__canManage('gm_admin'), false, 'HK manager must NOT manage gm_admin rows');
});

test('gm_admin can manage every role (canManageRole)', () => {
  sandbox.me = { role: 'gm_admin' };
  for (const r of ['hk_staff', 'hk_supervisor', 'hk_manager', 'fo_staff', 'fo_supervisor', 'fo_manager', 'gm_admin']) {
    assert.strictEqual(sandbox.__canManage(r), true, `gm_admin must manage ${r}`);
  }
});

test('gm_admin cannot sign confirmations (canConfirm)', () => {
  sandbox.me = { role: 'gm_admin' };
  assert.strictEqual(sandbox.__canConfirm('housekeeping'), false, 'gm_admin is not HK staff — cannot sign HK confirmation');
  assert.strictEqual(sandbox.__canConfirm('frontdesk'), false, 'gm_admin is not FD staff — cannot sign FD confirmation');
  // Sanity: the departmental managers still can.
  sandbox.me = { role: 'hk_manager' };
  assert.strictEqual(sandbox.__canConfirm('housekeeping'), true);
  sandbox.me = { role: 'fo_manager' };
  assert.strictEqual(sandbox.__canConfirm('frontdesk'), true);
});

// ============================================================
// 4. Frontend enforcement — dropdown, list, save, guard helpers
// ============================================================
test('applyDeptRoleOptions DISABLES non-manageable options (not just hides optgroups)', () => {
  const fnStart = script.indexOf('function applyDeptRoleOptions()');
  assert.ok(fnStart !== -1, 'applyDeptRoleOptions() not found');
  const fnEnd = script.indexOf('\n      }', fnStart);
  const fnSrc = script.slice(fnStart, fnEnd);
  assert.ok(/o\.disabled\s*=\s*!ok/.test(fnSrc),
    'applyDeptRoleOptions must set option.disabled for cross-department roles');
  assert.ok(/canManageRole\(o\.value\)/.test(fnSrc),
    'applyDeptRoleOptions must gate options through canManageRole');
  assert.ok(/sel\.value\s*=\s*''/.test(fnSrc),
    'applyDeptRoleOptions must reset a previously selected unmanageable value');
});

test('openStaffForm guards a pre-selected cross-department role', () => {
  const fnStart = script.indexOf('function openStaffForm(');
  const fnEnd = script.indexOf('\n      }', fnStart);
  const fnSrc = script.slice(fnStart, fnEnd);
  assert.ok(/!canManageRole\(sel\.value\)\)\s*sel\.value\s*=\s*''/.test(fnSrc),
    'openStaffForm must blank an unmanageable pre-selected role');
});

test('saveStaffForm validates the role via canManageRole (server-side mirror)', () => {
  const fnStart = script.indexOf('async function saveStaffForm()');
  const fnEnd = script.indexOf('\n      }', fnStart);
  const fnSrc = script.slice(fnStart, fnEnd);
  assert.ok(/if\s*\(!canManageRole\(role\)\)/.test(fnSrc),
    'saveStaffForm must reject roles outside the manager\u2019s department via canManageRole');
  assert.ok(!/ROLE_DEPT\[role\]\s*!==\s*myDept\(\)/.test(fnSrc),
    'saveStaffForm must not use the old ROLE_DEPT[role] !== myDept() check');
});

test('sbListStaff scopes the query to the manager\u2019s department; gm_admin bypasses', () => {
  const fnStart = script.indexOf('async function sbListStaff()');
  const fnEnd = script.indexOf('\n      }', fnStart);
  const fnSrc = script.slice(fnStart, fnEnd);
  assert.ok(/\.like\('role',\s*dept \+ '\\\\_%'\)/.test(fnSrc),
    'sbListStaff must use a LIKE "hk\\_%" style department filter on role');
  assert.ok(/if\s*\(!canManageAnyDept\(\)\)/.test(fnSrc),
    'sbListStaff must skip the department filter for gm_admin (canManageAnyDept)');
});

test('last-manager guard counts managers in the AFFECTED row\u2019s own department', () => {
  const fnStart = script.indexOf('function lastManagerError(');
  const fnEnd = script.indexOf('\n      }', fnStart);
  const fnSrc = script.slice(fnStart, fnEnd);
  assert.ok(/ROLE_DEPT\[row\.role\]/.test(fnSrc),
    'lastManagerError must derive the department from the candidate row\u2019s role');
  assert.ok(/MANAGER_ROLES\.includes/.test(fnSrc),
    'lastManagerError must classify managers via MANAGER_ROLES (incl. gm_admin)');
});

test('toggleStaffActive passes the target row\u2019s own role to the guard', () => {
  const fnStart = script.indexOf('async function toggleStaffActive(');
  const fnEnd = script.indexOf('\n      }', fnStart);
  const fnSrc = script.slice(fnStart, fnEnd);
  assert.ok(/staffRows\.find\(r => r\.email === email\)/.test(fnSrc),
    'toggleStaffActive must look up the target row (not hardcode hk_manager)');
});

test('Role chips render a distinct gm_admin style (chip-gm) + CSS rules exist', () => {
  assert.ok(/chip-gm/.test(script), 'JS must emit a chip-gm class for the gm_admin department');
  assert.ok(/staffRoleChip\(role\)[\s\S]{0,400}chip-gm/.test(script),
    'staffRoleChip must map the "all" department to chip-gm');
  assert.ok(html.includes('.who .role-chip.chip-gm'), 'CSS rule for the header who-chip missing');
  assert.ok(html.includes('.staff-chip .role-chip.chip-gm'), 'CSS rule for the staff list chip missing');
});

// ============================================================
// 5. Edge function (create-staff) — backend enforcement
// ============================================================
const edgePath = path.join(__dirname, '..', 'supabase', 'functions', 'create-staff', 'index.ts');
const edge = fs.readFileSync(edgePath, 'utf8');

test('Edge function recognizes gm_admin as an authorized caller', () => {
  assert.ok(/"gm_admin",/.test(edge), 'ROLES list must include gm_admin');
  assert.ok(
    /callerRow\.role !== "hk_manager" && callerRow\.role !== "fo_manager" && callerRow\.role !== "gm_admin"/.test(edge),
    'Caller check must allow gm_admin (or reject it explicitly otherwise)'
  );
  assert.ok(/callerDept/.test(edge), 'callerDept helper must exist');
});

test('Edge function enforces departments server-side via startsWith(dept)', () => {
  assert.ok(
    /dept === "gm" \|\| role\.startsWith\(dept\)/.test(edge),
    'canManageRole in the edge function must allow gm (cross-dept) or the caller\u2019s own prefix only'
  );
});

test('Edge function create path rejects a cross-department EXISTING staff row (403)', () => {
  assert.ok(
    /existingRow\?\.role && !canManageRole/.test(edge),
    'create must check the pre-existing staff row\u2019s department BEFORE creating a login'
  );
  assert.ok(
    /already belongs to a staff member in another department/.test(edge),
    'cross-department existing-row rejection message missing'
  );
});

test('Edge function reset path requires an existing staff row (404) + department check', () => {
  assert.ok(
    /No staff record exists for that email/.test(edge),
    'reset must refuse emails with no staff row (404) instead of resetting any login'
  );
  assert.ok(
    /!canManageRole\(String\(targetRow\.role\)\)/.test(edge),
    'reset must check the target row\u2019s department through canManageRole'
  );
});

// ============================================================
// 6. SQL — RLS + CHECK constraint (schema.sql and migration 008)
// ============================================================
const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8');
const mig008Path = path.join(__dirname, '..', 'supabase', 'migrations', '008_gm_admin_role.sql');
const mig008 = fs.readFileSync(mig008Path, 'utf8');

test('staff_role_check allows all seven roles (schema.sql + migration 008)', () => {
  const roles = ['hk_staff', 'hk_supervisor', 'hk_manager', 'fo_staff', 'fo_supervisor', 'fo_manager', 'gm_admin'];
  for (const [name, sql] of [['schema.sql', schemaSql], ['migration 008', mig008]]) {
    const checkMatch = sql.match(/staff_role_check[\s\S]*?check \(role in \(([^)]*)\)\)/);
    assert.ok(checkMatch, `${name}: staff_role_check constraint not found`);
    const allowed = checkMatch[1].split(',').map(s => s.trim().replace(/'/g, ''));
    for (const r of roles) {
      assert.ok(allowed.includes(r), `${name}: staff_role_check does not allow '${r}'`);
    }
    assert.strictEqual(allowed.length, 7, `${name}: staff_role_check should list exactly 7 roles`);
  }
});

test('RLS: gm_admin reads every staff row; dept managers keep their own prefix', () => {
  for (const [name, sql] of [['schema.sql', schemaSql], ['migration 008', mig008]]) {
    const readPolicy = sql.match(/create policy "manager read own dept"[\s\S]*?using \(([\s\S]*?)\);/);
    assert.ok(readPolicy, `${name}: "manager read own dept" policy not found`);
    assert.ok(/my_staff_role\(\) = 'gm_admin'/.test(readPolicy[1]),
      `${name}: read policy must grant gm_admin every row`);
    assert.ok(/role like 'hk\\_%'/.test(readPolicy[1]) && /role like 'fo\\_%'/.test(readPolicy[1]),
      `${name}: read policy must keep hk_manager/fo_manager scoped to their own prefix`);
  }
});

test('RLS: gm_admin writes every staff row (with check) incl. its own email', () => {
  for (const [name, sql] of [['schema.sql', schemaSql], ['migration 008', mig008]]) {
    const writePolicy = sql.match(/create policy "manager write own dept"[\s\S]*?with check \(([\s\S]*?)\);/);
    assert.ok(writePolicy, `${name}: "manager write own dept" policy not found`);
    assert.ok(/my_staff_role\(\) = 'gm_admin'/.test(writePolicy[1]),
      `${name}: write policy must grant gm_admin every row (incl. its own email)`);
    assert.ok(/email <> auth\.jwt\(\) ->> 'email'/.test(writePolicy[1]),
      `${name}: write policy must still stop a dept manager from editing their own row`);
  }
});

test('daily_reports insert policy includes gm_admin (schema.sql + migration 008)', () => {
  const roles = ['hk_staff', 'hk_supervisor', 'hk_manager', 'fo_staff', 'fo_supervisor', 'fo_manager', 'gm_admin'];
  for (const [name, sql] of [['schema.sql', schemaSql], ['migration 008', mig008]]) {
    const insertPolicy = sql.match(/create policy "auth insert daily"[\s\S]*?my_staff_role\(\) in\s*\(([^)]*)\)/);
    assert.ok(insertPolicy, `${name}: "auth insert daily" policy not found`);
    const allowed = insertPolicy[1].split(',').map(s => s.trim().replace(/'/g, ''));
    roles.forEach(r => assert.ok(allowed.includes(r), `${name}: daily insert policy missing '${r}'`));
  }
});

test('seed.sql documents the gm_admin bootstrap path', () => {
  const seed = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'seed.sql'), 'utf8');
  assert.ok(/gm_admin/.test(seed), 'seed.sql should mention the gm_admin role');
  assert.ok(/insert into public\.staff[\s\S]*?'gm_admin'/.test(seed),
    'seed.sql should include a commented gm_admin staff row example');
});

// ============================================================
// Summary
// ============================================================
console.log(`\n--- Test Suite Completed: ${passedTests}/${totalTests} Passed ---`);
if (passedTests !== totalTests) {
  console.error('SOME TESTS FAILED — see output above.');
  process.exit(1);
}
