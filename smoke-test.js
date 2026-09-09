// Smoke test: confirm the Supabase project responds, the staff table is
// reachable (will return [] because RLS blocks anon reads), and daily_reports
// is reachable for the same reason. After this passes, open
// discrepancy-report.html in a browser and try logging in with one of your
// seeded staff emails.

const fs = require('fs');
const cfgSrc = fs.readFileSync('./config.js', 'utf8')
  .replace(/^[^{]*/, '')
  .replace(/}\s*;?\s*$/, '}');
const cfg = JSON.parse(cfgSrc);
const url = cfg.supabaseUrl;
const key = cfg.supabaseAnonKey;
const headers = { 'apikey': key, 'Authorization': 'Bearer ' + key };

async function probe(path) {
  const r = await fetch(url + path, { headers });
  const text = await r.text();
  console.log(path, '->', r.status, text.slice(0, 120).replace(/\n/g, ' '));
}

(async () => {
  await probe('/rest/v1/');
  await probe('/rest/v1/staff?select=email&limit=1');
  await probe('/rest/v1/daily_reports?select=report_date&limit=1');
})();