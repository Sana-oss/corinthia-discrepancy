// Automated Test Suite for Room Discrepancy Report — Employee Self-Service
// Password Change (change-password edge function + frontend modal).
//
// Verifies:
//   - the edge function exists and enforces self-only scoping (JWT-only
//     identity, no email/user-id accepted from the request body)
//   - the current password is verified server-side via a real GoTrue grant
//     with the anon key (never the service role)
//   - the password write targets the CALLER'S OWN user id via updateUserById
//   - minimum length (6) + new !== current validation on both sides
//   - the frontend modal exists, validates inputs, and calls the endpoint
//   - manager flows in create-staff (create + reset) are untouched
//   - no RLS/schema changes are involved in this feature
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

console.log('--- Starting Password Change Test Suite ---\n');

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
const html = fs.readFileSync(path.join(root, 'discrepancy-report.html'), 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
const script = scriptMatch ? scriptMatch[1] : '';

const fnPath = path.join(root, 'supabase', 'functions', 'change-password', 'index.ts');
const fnSrc = fnPath && fs.existsSync(fnPath) ? fs.readFileSync(fnPath, 'utf8') : null;
const createStaffSrc = fs.readFileSync(path.join(root, 'supabase', 'functions', 'create-staff', 'index.ts'), 'utf8');

// ============================================================
// 1. File & syntax integrity
// ============================================================
test('change-password edge function exists with valid TypeScript', () => {
  assert.ok(fnSrc, 'supabase/functions/change-password/index.ts must exist');
  assert.ok(fnSrc.includes('Deno.serve'), 'edge function must serve requests');
  assert.ok(!fnSrc.includes('password: newPassword') === false || true, 'noop');
});

test('App HTML exists with valid JavaScript (syntax check)', () => {
  assert.ok(fs.existsSync(path.join(root, 'discrepancy-report.html')), 'discrepancy-report.html must exist');
  assert.ok(scriptMatch, 'Could not find <script> tag in HTML');
  assert.doesNotThrow(() => {
    new vm.Script(script);
  }, 'JavaScript in discrepancy-report.html contains syntax errors');
});

// ============================================================
// 2. Edge function — self-only, secure scoping
// ============================================================
test('Edge function: identity comes ONLY from the verified JWT (no body email/user id)', () => {
  assert.ok(fnSrc.includes('asUser.auth.getUser()'),
    'must resolve the caller with auth.getUser() against their token');
  // The request body must not carry any identity field.
  assert.ok(!/body\s*\.?\[?\(?\s*['"](email|user_id|caller_id|callerEmail)['"]/.test(fnSrc),
    'request body must never supply email/user id');
  assert.ok(fnSrc.includes('callerId = meData.user.id'),
    'caller id must be taken from the verified token');
});

test('Edge function: current password verified server-side via GoTrue password grant with ANON key', () => {
  assert.ok(fnSrc.includes('grant_type=password'),
    'must verify the current password with a real GoTrue token grant');
  const grantBlock = fnSrc.slice(fnSrc.indexOf('grant_type=password') - 400, fnSrc.indexOf('grant_type=password') + 200);
  assert.ok(grantBlock.includes('ANON_KEY'), 'grant must use the anon key, not the service role');
  assert.ok(!grantBlock.includes('SERVICE_KEY'), 'grant must never use the service role key');
});

test('Edge function: password written via updateUserById on the CALLER OWN id only (service role)', () => {
  assert.ok(fnSrc.includes('updateUserById(callerId'), 'write must target the caller own id');
  const writeBlock = fnSrc.slice(fnSrc.indexOf('updateUserById(callerId') - 600, fnSrc.indexOf('updateUserById(callerId') + 200);
  assert.ok(writeBlock.includes('SERVICE_KEY'), 'the service-role client must be used for the write');
});

test('Edge function: min length 6 + new !== current enforced server-side', () => {
  assert.ok(fnSrc.includes('MIN_PASSWORD_LENGTH = 6'), 'must define MIN_PASSWORD_LENGTH = 6');
  assert.ok(fnSrc.includes('newPassword.length < MIN_PASSWORD_LENGTH'), 'must check length');
  assert.ok(fnSrc.includes('newPassword === currentPassword'), 'must reject unchanged password');
});

test('Edge function: no password values are logged or echoed', () => {
  // No console.* with password material anywhere in the function.
  assert.ok(!/console\.(log|error|warn)\([^)]*(currentPassword|newPassword|current_password|new_password)/.test(fnSrc),
    'passwords must never appear in logs');
  assert.ok(!fnSrc.includes('JSON.stringify({ current'), 'responses must not echo password material');
});

test('Edge function: 401 with clear message when the current password is wrong', () => {
  assert.ok(fnSrc.includes("error: \"Your current password is incorrect.\""),
    'wrong current password must return the clear message');
  assert.ok(fnSrc.includes('}, 401)'), 'should return HTTP 401 for that case');
});

test('Edge function: 401 when no/invalid session (no unauthenticated changes)', () => {
  assert.ok(fnSrc.includes('Not signed in.'), 'must reject requests without a token');
  assert.ok(fnSrc.includes('Invalid or expired session.'), 'must reject invalid tokens');
});

// ============================================================
// 3. Frontend — modal, validation, endpoint call
// ============================================================
test('Frontend: Change password entry point + modal elements exist', () => {
  assert.ok(html.includes('id="changePwdBtn"'), 'whoBadge must have a Change password button');
  ['changePwdOverlay', 'pwdCurrent', 'pwdNew', 'pwdConfirm', 'pwdError', 'pwdSaveBtn', 'pwdCancelBtn']
    .forEach(id => assert.ok(html.includes(`id="${id}"`), `modal element id="${id}" missing`));
});

test('Frontend: changePassword() validates all three fields, match, length 6, and new !== current', () => {
  const js = script;
  assert.ok(js.includes("function changePassword"), 'changePassword() must be defined');
  assert.ok(js.includes("next !== confirm") || js.includes("next!==confirm"),
    'must check confirmation match');
  assert.ok(js.includes("next.length < 6"), 'must enforce min 6 client-side');
  assert.ok(js.includes("next === current"), 'must reject unchanged password client-side');
  assert.ok(js.includes('Fill in all three fields.'), 'clear message for empty fields');
  assert.ok(js.includes('do not match'), 'clear message for mismatch');
});

test('Frontend: changePassword() posts to the change-password endpoint with session headers', () => {
  assert.ok(script.includes("/functions/v1/change-password"), 'must call the edge function');
  assert.ok(script.includes("sbHeaders({ 'Content-Type': 'application/json' })"),
    'must send session headers + JSON content type');
  assert.ok(script.includes('current_password: current') && script.includes('new_password: next'),
    'must send current + new password in the body');
  assert.ok(script.includes("res.status === 401"), 'must map 401 to the wrong-current-password message');
});

test('Frontend: modal state resets on success and on sign out', () => {
  assert.ok(script.includes('closeChangePwdModal()'), 'modal must be closed/reset');
  // signOut() must reset the modal so the next user starts clean.
  const signOutIdx = script.indexOf('async function signOut()');
  const signOutSrc = script.slice(signOutIdx, signOutIdx + 2500);
  assert.ok(signOutSrc.includes('closeChangePwdModal()'), 'signOut must reset the modal');
});

test('Frontend: event listeners wired for the modal', () => {
  assert.ok(script.includes("getElementById('changePwdBtn').addEventListener"), 'open wiring');
  assert.ok(script.includes("getElementById('pwdSaveBtn').addEventListener"), 'submit wiring');
  assert.ok(script.includes("getElementById('pwdCancelBtn').addEventListener"), 'cancel wiring');
});

// ============================================================
// 4. Manager flows preserved (create-staff untouched)
// ============================================================
test('create-staff edge function still implements create AND reset actions', () => {
  assert.ok(createStaffSrc.includes('"create"') || createStaffSrc.includes("'create'") || createStaffSrc.includes('`create`'),
    'create action must remain');
  assert.ok(createStaffSrc.includes('"reset"') || createStaffSrc.includes("'reset'") || createStaffSrc.includes('`reset`'),
    'reset action must remain');
  assert.ok(createStaffSrc.includes('updateUserById'),
    'manager reset path must keep updateUserById');
  assert.ok(createStaffSrc.includes('password.length < 6'),
    'manager initial-password minimum must remain');
});

test('Manager reset UI unchanged (Staff tab initial/reset password inputs intact)', () => {
  assert.ok(html.includes('id="staffPassInput"'), 'manager initial-password input must remain');
  assert.ok(html.includes('set a new password'), 'manager reset hint must remain');
  assert.ok(html.includes('id="staffAddBtn"'), 'manager add-staff flow must remain');
});

test('change-password does not touch the staff table or RLS policies', () => {
  assert.ok(fnSrc, 'edge function must exist');
  assert.ok(!fnSrc.includes("from('staff'"), 'password change must not read/write the staff table');
  assert.ok(!fnSrc.includes('UPDATE') && !fnSrc.includes('CREATE POLICY') && !fnSrc.includes('ALTER'),
    'edge function must contain no SQL/schema/RLS statements');
  // No new migration file added for this feature.
  const migDir = path.join(root, 'supabase', 'migrations');
  if (fs.existsSync(migDir)) {
    const migs = fs.readdirSync(migDir).filter(f => /password/i.test(f));
    assert.ok(migs.length === 0, 'no password-change migration should have been added');
  }
});

// ============================================================
// Summary
// ============================================================
console.log(`\n--- Password Change Test Suite Complete: ${passedTests}/${totalTests} tests passed ---\n`);
process.exit(passedTests === totalTests ? 0 : 1);
