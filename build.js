// Reads .env and writes config.js so the HTML can pick up Supabase creds
// without committing them. Run before opening discrepancy-report.html in a
// browser, or have your host call `npm run build` on deploy.

const fs = require('fs');
const path = require('path');

function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

const env = loadEnv(path.join(__dirname, '.env'));
const url = env.SUPABASE_URL || '';
const key = env.SUPABASE_ANON_KEY || '';

if (!url || !key || url.includes('YOUR-PROJECT') || key.includes('YOUR-ANON')) {
  console.warn('[build] SUPABASE_URL / SUPABASE_ANON_KEY not set in .env — app will show a "not configured" notice.');
}

const out = 'window.__APP_CONFIG__ = ' + JSON.stringify({
  supabaseUrl: url,
  supabaseAnonKey: key
}, null, 2) + ';\n';

fs.writeFileSync(path.join(__dirname, 'config.js'), out);
console.log('[build] wrote config.js');