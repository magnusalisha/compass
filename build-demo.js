// ==========================================================================
// BUILD-DEMO — freeze Compass into one shareable, self-contained page
//
//   node build-demo.js [outdir]        (default: ./demo)
//
// Produces a single HTML file plus favicons: no repo, no Worker, no API
// calls, nothing to rate-limit and nothing that can break. Drag the output
// folder onto app.netlify.com/drop and it's live. It keeps working
// unchanged for as long as the file exists, because it asks nothing of the
// network.
//
// Re-run this whenever the catalogue has moved on enough to be worth
// resharing — the demo is a SNAPSHOT and does not update itself. That's the
// point: the live tool changes under your staff all shift, and a demo that
// shifted under a viewer would be worse than one that's honestly frozen.
//
// WHAT IT STRIPS, AND WHY
//   metrc_tag  every tag shares a licence-identifying prefix, and nothing in
//              the UI ever displays it. No reason to publish it.
//   reported[] free text that isn't rendered anywhere; drops the file size.
//   id         replaced with a synthetic p001… — the originals are
//              low-entropy and collide, and key() falls back to id.
//   edit links go automatically: editURL() needs GH_USER and p._key, and the
//              demo has neither. They'd carry the repo owner's name.
//
// The script FAILS LOUD rather than shipping something wrong. If an
// identifying string survives, or a field that should be gone isn't, it
// exits non-zero and writes nothing useful. Trust the exit code, not a
// glance at the output.
// ==========================================================================
const fs = require('fs');
const path = require('path');

const SRC = __dirname;
const OUT = path.resolve(process.argv[2] || path.join(SRC, 'demo'));

// Brand names ship as they are. An earlier build renamed them, on the theory
// that the label-vs-chemistry warnings (about 40% of records carry one) read
// as public criticism of named companies. That mattered for an anonymous
// public post; for a named industry audience the real names are what make the
// demo credible, and the warnings are the tool doing its job. If this ever
// goes somewhere colder, put a mapping back here — the rest of the script
// doesn't care either way.
const BRANDS = {};

// ── records ────────────────────────────────────────────────────────────────
const dataDir = path.join(SRC, 'data');
const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.json')).sort();
const skipped = [];
const records = [];
files.forEach((f, i) => {
  let r;
  try { r = JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8')); }
  catch (e) { skipped.push(f + ' (' + e.message.slice(0, 60) + ')'); return; }
  delete r.metrc_tag;
  delete r.reported;
  r.brand = BRANDS[r.brand] || r.brand;
  r.id = 'p' + String(i + 1).padStart(3, '0');
  records.push(r);
});
if (!records.length){ console.error('BUILD FAILED: no readable records'); process.exit(1); }

const blob = JSON.stringify(records, null, 1);

// ── page ───────────────────────────────────────────────────────────────────
let html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
const must = (cond, msg) => { if (!cond){ console.error('BUILD FAILED: ' + msg); process.exit(1); } };
const sub = (find, repl, msg) => {
  const before = html;
  html = html.replace(find, repl);
  must(html !== before, msg + ' — pattern not found (did index.html change?)');
};

// 1. cut every network path
sub(/const GH_USER = "[^"]*", GH_REPO = "[^"]*";/,
    'const GH_USER = "", GH_REPO = "";   // demo: never fetches, no edit links',
    'blank GH_USER/GH_REPO');
sub(/const STOCK_API = "[^"]*";/,
    'const STOCK_API = "";                // demo: no write path\nconst DEMO = true;                   // frozen snapshot; stock toggles on screen only',
    'blank STOCK_API + add DEMO flag');

// 2. The refresh timer doesn't know the repo is off. Left armed it polls
//    https://api.github.com/repos///contents/data every 60s and on every tab
//    focus, forever, on every device the link is opened on.
sub(/  render\(\);\n  startAutoRefresh\(\);/,
    '  render();\n  if (GH_USER && GH_REPO) startAutoRefresh();   // frozen: nothing to poll',
    'guard startAutoRefresh');

// 3. let the stock button work locally, so the feature is demoable
sub(/\$\{STOCK_API \? `<button onclick="setStock\('\$\{key\(p\)\}', \$\{stocked\(p\)\}\)"/,
    '${(STOCK_API || DEMO) ? `<button onclick="setStock(\'${key(p)}\', ${stocked(p)})"',
    'show stock button in demo');
sub(/async function setStock\(k, soldOut\)\{\n  if \(!STOCK_API \|\| busyKey\) return;\n  const p = DATA\.find\(x => key\(x\) === k\);\n  if \(!p\) return;/,
`async function setStock(k, soldOut){
  if (busyKey) return;
  const p = DATA.find(x => key(x) === k);
  if (!p) return;
  if (DEMO){                      // frozen copy: flip it on screen, save nothing
    p.in_stock = !soldOut;
    flash = \`\${p.strain} — \${soldOut ? 'marked sold out' : 'back in stock'}. Demo only — nothing is saved.\`;
    render();
    setTimeout(() => { flash = ''; render(); }, 4000);
    return;
  }
  if (!STOCK_API) return;`,
    'local-only setStock');

// 4. swap the embedded seed for the frozen catalogue
sub(/let DATA = \[[\s\S]*?\n\], tab = 'effect'/, `let DATA = ${blob}, tab = 'effect'`,
    'embed frozen catalogue');

// 5. the footer tells you to "tap Edit on a card" to fix an unverified shelf
//    tag — but the demo has no Edit links, so it points at a control that
//    isn't there. State the count without the instruction.
sub(/ — tap Edit on a card to set one/, '', 'drop the Edit instruction from the footer');

// 6. say what this is, once, quietly
sub(/(<div class="sub">[^<]*<\/div>)/,
    `$1\n<div class="demonote">Demo — a frozen snapshot of a working shop's case. Real lab results. Nothing here saves or updates.</div>`,
    'add demo note');
sub(/(  \.sub\{[^}]*\})/,
    `$1\n  .demonote{font-family:'IBM Plex Mono',monospace;font-size:11.5px;line-height:1.5;\n    letter-spacing:.04em;color:var(--dim);border-left:2px solid var(--gold);\n    padding-left:10px;margin:-14px 0 22px;max-width:46ch}`,
    'add demo note style');

// ── write ──────────────────────────────────────────────────────────────────
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'index.html'), html);
for (const icon of ['favicon-32.png','favicon-16.png','apple-touch-icon.png']){
  const from = path.join(SRC, icon);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(OUT, icon));
}

// ── verify what was actually written, don't trust the steps above ──────────
const o = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
const identifying = ['magnusalisha','magnus-alisha','workers.dev','1A41203','budega','Budega','alisha'];
const found = identifying.filter(s => o.includes(s));
must(!found.length, 'identifying strings survived: ' + found.join(', '));
must(!/"metrc_tag"/.test(o), 'metrc_tag survived');
must(!/"reported"/.test(o), 'reported survived');
must(!/api\.github\.com/.test(o) || /if \(GH_USER && GH_REPO\) startAutoRefresh/.test(o),
     'a live GitHub call may still be reachable');
must(o.includes('const DEMO = true'), 'DEMO flag missing');

console.log('built   :', path.join(OUT, 'index.html'));
console.log('size    :', (o.length / 1024).toFixed(0) + ' KB');
console.log('records :', records.length + (skipped.length ? '  (skipped ' + skipped.length + ')' : ''));
skipped.forEach(s => console.log('  SKIPPED:', s));
console.log('brands  :', new Set(records.map(r => r.brand)).size, Object.keys(BRANDS).length ? '(renamed)' : '(real names)');
console.log('checks  : no metrc tags, no reported[], no owner/worker strings, no live polling');
console.log('\nnext    : drag', OUT, 'onto app.netlify.com/drop');
