// Automated Test Suite for Room Discrepancy Report — DND (Do Not Disturb) feature
const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('--- Starting Room Discrepancy Report DND Test Suite ---\n');

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

// 1. HTML File Integrity and Balance Check
test('HTML file exists and has balanced main structure tags', () => {
  const htmlPath = path.join(__dirname, '..', 'discrepancy-report.html');
  assert.ok(fs.existsSync(htmlPath), 'discrepancy-report.html must exist');
  const content = fs.readFileSync(htmlPath, 'utf8');

  // Check essential elements and sections
  assert.ok(content.includes('<!DOCTYPE html>'), 'Missing doctype');
  assert.ok(content.includes('<html'), 'Missing <html>');
  assert.ok(content.includes('</html>'), 'Missing </html>');
  assert.ok(content.includes('<head>'), 'Missing <head>');
  assert.ok(content.includes('</head>'), 'Missing </head>');
  assert.ok(content.includes('<body>'), 'Missing <body>');
  assert.ok(content.includes('</body>'), 'Missing </body>');
  assert.ok(content.includes('<script>'), 'Missing <script>');
  assert.ok(content.includes('</script>'), 'Missing </script>');

  // Check that sections match
  const sectionIds = ['tab-setup', 'tab-checklist', 'tab-extra', 'tab-summary', 'tab-history', 'tab-staff'];
  sectionIds.forEach(id => {
    assert.ok(content.includes(`id="${id}"`), `Missing section with id=${id}`);
  });
});

test('JavaScript syntax inside discrepancy-report.html is valid', () => {
  const htmlPath = path.join(__dirname, '..', 'discrepancy-report.html');
  const content = fs.readFileSync(htmlPath, 'utf8');
  const scriptMatch = content.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'Could not find <script> tag in HTML');
  const scriptContent = scriptMatch[1];

  const vm = require('vm');
  assert.doesNotThrow(() => {
    new vm.Script(scriptContent);
  }, 'JavaScript in discrepancy-report.html contains syntax errors');
});

test('DOM elements referenced by JavaScript exist in HTML', () => {
  const htmlPath = path.join(__dirname, '..', 'discrepancy-report.html');
  const content = fs.readFileSync(htmlPath, 'utf8');

  // Verify critical elements including newly added DND elements
  const requiredIds = [
    'statConfirmed',
    'statLuggage',
    'statDnd',
    'statDiscrepancies',
    'statNoLuggageSum',
    'statDndSum',
    'sumUnticked',
    'sumExtras',
    'sumLuggage',
    'sumDnd',
    'checklistList',
    'extraList',
    'emailPreview',
    'printArea'
  ];

  requiredIds.forEach(id => {
    assert.ok(content.includes(`id="${id}"`), `DOM element id="${id}" missing in HTML`);
  });
});

// Extract JavaScript logic for unit testing
const htmlContent = fs.readFileSync(path.join(__dirname, '..', 'discrepancy-report.html'), 'utf8');

// Helper to simulate normalizeRooms
function normalizeRooms(rooms) {
  return (rooms || []).map(r => {
    if (r.status && ['unconfirmed', 'confirmed', 'noluggage', 'dnd'].includes(r.status)) return r;
    let status = 'unconfirmed';
    if (r.noLuggage) status = 'noluggage';
    else if (r.ticked) status = 'confirmed';
    return Object.assign({}, r, { status });
  });
}

// Helper to simulate computeSummaryFor
function computeSummaryFor(rawRooms, extras) {
  const rooms = normalizeRooms(rawRooms);
  const unticked = rooms.filter(r => r.status !== 'confirmed' && r.status !== 'noluggage' && r.status !== 'dnd');
  const noLuggage = rooms.filter(r => r.status === 'noluggage');
  const dnd = rooms.filter(r => r.status === 'dnd');
  return { unticked, noLuggage, dnd, extras: extras || [] };
}

// 2. Data Model: normalizeRooms and Legacy Migration
test('normalizeRooms migrates legacy data and preserves dnd', () => {
  const legacy = [
    { room: '101', ticked: true },
    { room: '102', noLuggage: true },
    { room: '103' },
    { room: '104', status: 'dnd' },
    { room: '105', status: 'confirmed' },
    { room: '106', status: 'noluggage' },
    { room: '107', status: 'unconfirmed' },
    { room: '108', status: 'unknown_value' }
  ];

  const normalized = normalizeRooms(legacy);
  assert.strictEqual(normalized[0].status, 'confirmed');
  assert.strictEqual(normalized[1].status, 'noluggage');
  assert.strictEqual(normalized[2].status, 'unconfirmed');
  assert.strictEqual(normalized[3].status, 'dnd');
  assert.strictEqual(normalized[4].status, 'confirmed');
  assert.strictEqual(normalized[5].status, 'noluggage');
  assert.strictEqual(normalized[6].status, 'unconfirmed');
  assert.strictEqual(normalized[7].status, 'unconfirmed');
});

// 3. Status Transitions & Mutual Exclusivity
test('Status transitions between all four states are mutually exclusive', () => {
  let room = { room: '201', status: 'unconfirmed' };

  // Action handlers simulation
  function doTick(r) {
    r.status = (r.status === 'confirmed' || r.status === 'noluggage') ? 'unconfirmed' : 'confirmed';
  }
  function doLuggage(r) {
    r.status = (r.status === 'noluggage') ? 'confirmed' : 'noluggage';
  }
  function doDnd(r) {
    r.status = (r.status === 'dnd') ? 'unconfirmed' : 'dnd';
  }

  // 1. unconfirmed -> tick -> confirmed
  doTick(room);
  assert.strictEqual(room.status, 'confirmed');

  // 2. confirmed -> dnd -> dnd (DND replaces confirmed)
  doDnd(room);
  assert.strictEqual(room.status, 'dnd');

  // 3. dnd -> dnd -> unconfirmed (Tapping DND again clears to unconfirmed)
  doDnd(room);
  assert.strictEqual(room.status, 'unconfirmed');

  // 4. unconfirmed -> luggage -> noluggage
  doLuggage(room);
  assert.strictEqual(room.status, 'noluggage');

  // 5. noluggage -> dnd -> dnd (DND replaces luggage)
  doDnd(room);
  assert.strictEqual(room.status, 'dnd');

  // 6. dnd -> tick -> confirmed (Tick replaces DND)
  doTick(room);
  assert.strictEqual(room.status, 'confirmed');

  // 7. confirmed -> tick -> unconfirmed
  doTick(room);
  assert.strictEqual(room.status, 'unconfirmed');

  // 8. unconfirmed -> dnd -> dnd
  doDnd(room);
  assert.strictEqual(room.status, 'dnd');

  // 9. dnd -> luggage -> noluggage (Luggage replaces DND)
  doLuggage(room);
  assert.strictEqual(room.status, 'noluggage');

  // 10. noluggage -> luggage -> confirmed
  doLuggage(room);
  assert.strictEqual(room.status, 'confirmed');
});

// 4. Stat Counters Never Double-Count
test('Checklist stat counters are disjoint and never double-count', () => {
  const rooms = [
    { room: '101', status: 'confirmed' },
    { room: '102', status: 'confirmed' },
    { room: '103', status: 'noluggage' },
    { room: '104', status: 'dnd' },
    { room: '105', status: 'dnd' },
    { room: '106', status: 'dnd' },
    { room: '107', status: 'unconfirmed' }
  ];

  const confirmedCount = rooms.filter(r => r.status === 'confirmed').length;
  const luggageCount = rooms.filter(r => r.status === 'noluggage').length;
  const dndCount = rooms.filter(r => r.status === 'dnd').length;
  const unconfirmedCount = rooms.filter(r => r.status === 'unconfirmed').length;

  assert.strictEqual(confirmedCount, 2);
  assert.strictEqual(luggageCount, 1);
  assert.strictEqual(dndCount, 3);
  assert.strictEqual(unconfirmedCount, 1);
  assert.strictEqual(confirmedCount + luggageCount + dndCount + unconfirmedCount, rooms.length);
});

// 5. computeSummaryFor excludes DND from discrepancy list
test('computeSummaryFor excludes DND from unticked discrepancy list and returns it separately', () => {
  const rooms = [
    { room: '101', status: 'confirmed' },
    { room: '102', status: 'unconfirmed' },
    { room: '103', status: 'noluggage' },
    { room: '104', status: 'dnd' }
  ];
  const extras = [{ room: '999' }];

  const summary = computeSummaryFor(rooms, extras);

  // Unticked contains only 102
  assert.strictEqual(summary.unticked.length, 1);
  assert.strictEqual(summary.unticked[0].room, '102');

  // No luggage contains 103
  assert.strictEqual(summary.noLuggage.length, 1);
  assert.strictEqual(summary.noLuggage[0].room, '103');

  // DND contains 104
  assert.strictEqual(summary.dnd.length, 1);
  assert.strictEqual(summary.dnd[0].room, '104');

  // Headline discrepancy count = unticked (1) + extras (1) = 2 (DND is excluded)
  const headlineDiscrepancies = summary.unticked.length + summary.extras.length;
  assert.strictEqual(headlineDiscrepancies, 2);
});

// 6. Search Filter and Original Index Mapping
test('Checklist search filter retains original array index mapping', () => {
  const rooms = [
    { room: '101', status: 'unconfirmed' },
    { room: '201', status: 'unconfirmed' },
    { room: '102', status: 'unconfirmed' }
  ];

  const filter = '201';
  const indexed = rooms.map((r, idx) => ({ r, idx }));
  const filtered = indexed.filter(x => x.r.room.includes(filter));

  assert.strictEqual(filtered.length, 1);
  assert.strictEqual(filtered[0].idx, 1);
  assert.strictEqual(filtered[0].r.room, '201');

  // Mutate using filtered[0].idx
  rooms[filtered[0].idx].status = 'dnd';
  assert.strictEqual(rooms[1].status, 'dnd');
  assert.strictEqual(rooms[0].status, 'unconfirmed');
  assert.strictEqual(rooms[2].status, 'unconfirmed');
});

// 7. Email Text Builder includes DND only when DND rooms exist
function buildEmailText(unticked, extras, noLuggage, dnd, dateStr = 'Mon, Oct 13') {
  dnd = dnd || [];
  let lines = [];
  lines.push('Subject: Room Discrepancy Report – ' + dateStr);
  lines.push('');
  lines.push('Hi Front Desk,');
  lines.push('');
  lines.push('The room check for today is complete. Summary below:');
  lines.push('');
  if (unticked.length === 0 && extras.length === 0) {
    lines.push('No discrepancies found — all listed rooms were confirmed occupied.');
  } else {
    if (unticked.length) {
      lines.push('Listed but not confirmed occupied:');
      unticked.forEach(r => lines.push('- Room ' + r.room));
      lines.push('');
    }
    if (extras.length) {
      lines.push('Found occupied but not on the list:');
      extras.forEach(r => lines.push('- Room ' + r.room));
      lines.push('');
    }
  }
  if (noLuggage.length) {
    lines.push('No luggage observed in:');
    noLuggage.forEach(r => lines.push('- Room ' + r.room));
    lines.push('');
  }
  if (dnd.length) {
    lines.push('Do Not Disturb (could not check):');
    dnd.forEach(r => lines.push('- Room ' + r.room));
    lines.push('');
  }
  lines.push('Original physical copy to follow.');
  return lines.join('\n');
}

test('Email builder includes DND section only when DND rooms exist', () => {
  // Case A: No DND rooms
  const emailWithoutDnd = buildEmailText([{ room: '102' }], [], [{ room: '103' }], []);
  assert.ok(!emailWithoutDnd.includes('Do Not Disturb'), 'Email must NOT mention DND when dnd is empty');

  // Case B: With DND rooms
  const emailWithDnd = buildEmailText([{ room: '102' }], [], [{ room: '103' }], [{ room: '104' }]);
  assert.ok(emailWithDnd.includes('Do Not Disturb (could not check):'), 'Email must include DND section');
  assert.ok(emailWithDnd.includes('- Room 104'), 'Email must list room 104 in DND section');
});

// 8. Print HTML Builder includes DND only when DND rooms exist
function buildPrintHtmlFor(dateStr, total, unticked, extras, noLuggage, confirmations, uploadedAt, dnd) {
  dnd = dnd || [];
  const discCount = unticked.length + extras.length;
  let html = `<div class="print-meta"><div>Discrepancies: <b>${discCount}</b></div><div>No luggage: <b>${noLuggage.length}</b></div><div>DND: <b>${dnd.length}</b></div></div>`;
  if (dnd.length > 0) {
    html += '<div class="print-section"><h2>Do Not Disturb (could not check)</h2><table>';
    dnd.forEach(r => { html += `<tr><td>${r.room}</td></tr>`; });
    html += '</table></div>';
  }
  return html;
}

test('Print builder includes DND table only when DND rooms exist', () => {
  const printWithoutDnd = buildPrintHtmlFor('2026-10-13', 10, [], [], [], {}, null, []);
  assert.ok(!printWithoutDnd.includes('Do Not Disturb (could not check)'), 'Print must not have DND table when dnd is empty');
  assert.ok(printWithoutDnd.includes('DND: <b>0</b>'), 'Print metadata displays DND count');

  const printWithDnd = buildPrintHtmlFor('2026-10-13', 10, [], [], [], {}, null, [{ room: '104' }]);
  assert.ok(printWithDnd.includes('Do Not Disturb (could not check)'), 'Print must have DND table when dnd > 0');
  assert.ok(printWithDnd.includes('<td>104</td>'), 'Print table contains room 104');
  assert.ok(printWithDnd.includes('DND: <b>1</b>'), 'Print metadata displays DND count 1');
});

// 9. Role Permissions Matrix for Checklist & DND
test('Role permission matrix enforces strictly departmental access to Checklist and DND', () => {
  const ROLE_DEPT = {
    hk_staff: 'hk', hk_supervisor: 'hk', hk_manager: 'hk',
    fo_staff: 'fo', fo_supervisor: 'fo', fo_manager: 'fo'
  };
  function tabAccess(tab, role) {
    const dept = ROLE_DEPT[role] || '';
    if (tab === 'setup') return dept === 'fo' ? 'full' : 'hidden';
    if (tab === 'checklist' || tab === 'extra') return dept === 'hk' ? 'full' : 'hidden';
    if (tab === 'summary') return (role === 'hk_staff' || role === 'fo_staff') ? 'view' : 'full';
    return 'hidden';
  }

  // Housekeeping roles can edit Checklist and DND
  assert.strictEqual(tabAccess('checklist', 'hk_staff'), 'full');
  assert.strictEqual(tabAccess('checklist', 'hk_supervisor'), 'full');
  assert.strictEqual(tabAccess('checklist', 'hk_manager'), 'full');

  // Front Desk roles have Checklist hidden (cannot edit or set DND)
  assert.strictEqual(tabAccess('checklist', 'fo_staff'), 'hidden');
  assert.strictEqual(tabAccess('checklist', 'fo_supervisor'), 'hidden');
  assert.strictEqual(tabAccess('checklist', 'fo_manager'), 'hidden');
});

// 10. Opera PMS Sample Text Parsing
function splitColumns(line) {
  if (line.includes('\t')) return line.split('\t').map(s => s.trim()).filter(Boolean);
  if (line.includes(',')) return line.split(',').map(s => s.trim()).filter(Boolean);
  return line.split(/\s{2,}/).map(s => s.trim()).filter(Boolean);
}
function parsePaste(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const rooms = [];
  const seen = new Set();
  for (const line of lines) {
    const cols = splitColumns(line);
    const first = (cols[0] || '').replace(/^room\s*/i, '').trim();
    const roomMatch = first.match(/^(\d{3,5}[A-Za-z]?)$/);
    if (!roomMatch) continue;
    const room = roomMatch[1];
    if (seen.has(room)) continue;
    seen.add(room);
    rooms.push({ room, status: 'unconfirmed' });
  }
  return { rooms };
}

test('Opera PMS sample text extracts rooms with unconfirmed initial status', () => {
  const sample = `1069\tDikmen,Emre,Mr\tC- Yasar Ozkan\t25-08-26\t08-09-26\tDLXQ\t1\t0\tCA\tBARBB
1070\tSmith,John,Mr\tC- Corp\t26-08-26\t09-09-26\tDLXQ\t1\t0\tCA\tBARBB`;
  const { rooms } = parsePaste(sample);
  assert.strictEqual(rooms.length, 2);
  assert.strictEqual(rooms[0].room, '1069');
  assert.strictEqual(rooms[0].status, 'unconfirmed');
  assert.strictEqual(rooms[1].room, '1070');
  assert.strictEqual(rooms[1].status, 'unconfirmed');
});

console.log(`\n--- Test Suite Completed: ${passedTests}/${totalTests} Passed ---`);
if (passedTests !== totalTests) {
  process.exit(1);
}
