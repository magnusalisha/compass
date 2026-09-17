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
  // package_tags (added 6 Sept) is a LIST of the same licence-identifying tags,
  // and deleting metrc_tag alone left seventeen records publishing them. Caught
  // by the identifying-strings check below, which is the second time that guard
  // has stopped a real leak — the first was compass-palette.html on 1 Sept.
  // Any new field carrying a Metrc tag has to be added here too.
  delete r.package_tags;
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

// 3. The stock button used to be patched in here, twice: once to show it when
//    STOCK_API was blank, and once to make setStock() flip the flag on screen
//    without saving. Both are gone, because the FEATURE is gone — "Mark sold
//    out" and the Worker's whole POST half were deleted on 21-23 Aug (see
//    "Closed: the button and the write endpoint"). setStock no longer appears
//    in index.html at all.
//
//    That left this script failing on a pattern that could never match again,
//    and it stayed that way for NINE DAYS because nothing runs it — the demo is
//    rebuilt by hand, only when someone wants to reshare it. A build step that
//    only runs on demand can rot silently; the fail-loud check is what caught
//    it, and it did its job.

// 4. swap the empty catalogue for the frozen one
//
//    Matches `let DATA = []` and NOTHING ELSE on that line. The previous
//    pattern reached forward to `, tab = 'effect'` and rewrote everything in
//    between, which broke twice for the same reason: it encoded the shape of a
//    declaration list that is none of this script's business.
//
//    It broke on 21-23 Aug when the seed's trailing lines moved, and again on
//    3 Sept when the seed was deleted and the line became
//    `let DATA = [], loadFailed = false, tab = 'effect', ...`. That second
//    break hid a worse bug: the replacement text ended `, tab = 'effect'`, so
//    widening the regex to match the new line would have silently DROPPED the
//    `loadFailed = false` declaration and shipped a demo that throws
//    ReferenceError the moment a viewer picks a size nothing matches.
//
//    Anchored to the empty array instead. Nothing after it is touched, so a
//    new variable added to that line cannot break this or be eaten by it.
sub(/let DATA = \[\]/, `let DATA = ${blob}`, 'embed frozen catalogue');

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

// 7. drop every whole-line comment
//
//    The comments are the reasoning behind the tool, written for whoever
//    maintains it. A demo has a different reader — someone looking at the
//    PRODUCT — and shipping the commentary to them costs three ways.
//
//    It names Alisha six times. It quotes her, by name, saying a brand the shop
//    actually stocks makes weed that "sucks". And it carries a running account
//    of how the shop works, which is nobody's business at a link.
//
//    The identity check below is what forced this: it was case-sensitive and
//    looking only for lowercase 'alisha', so all six sailed through and shipped.
//    Folding the case caught them, and stripping is the fix that closes the
//    class rather than the instance — a comment added next month cannot leak.
//
//    WHOLE-LINE only (first non-space characters are //). An inline trailing
//    comment can sit inside a template literal or a regex, and cutting those by
//    pattern is how a build starts corrupting code it does not understand.
//    Verified: the stripped page still parses, and it is roughly half the size.
{
  const before = html.split('\n').length;
  html = html.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  must(html.split('\n').length < before, 'strip comments — nothing was removed');
}

// ── write to a SCRATCH file, verify it, and only then put it in place ──────
//
// The header promises a failed build "exits non-zero and writes nothing
// useful". That was untrue for every check below: index.html was written to
// OUT first and verified afterwards, so a build that failed the
// identifying-strings check had ALREADY replaced the last known-good demo with
// the one carrying the string. The folder is what gets dragged onto Netlify,
// and the header itself warns that people trust a glance at the output.
//
// Still verifying real bytes off the disk rather than the `html` variable —
// that instinct was right and is why the checks below read a file. The file
// they read is just not the published one until it has passed.
fs.mkdirSync(OUT, { recursive: true });
const staged = path.join(OUT, '.index.html.building');
fs.writeFileSync(staged, html);

// ── verify what was actually written, don't trust the steps above ──────────
const o = fs.readFileSync(staged, 'utf8');
// Anything that exits from here on leaves the previous demo untouched.
process.on('exit', () => { try { fs.unlinkSync(staged); } catch {} });
// CASE-INSENSITIVE, and that is not a detail.
//
// This list used to be matched with o.includes() against the raw page, and
// held only lowercase 'alisha'. index.html carries "Alisha" six times in
// comments — including line 432, which quotes her by name saying a brand the
// shop stocks makes weed that "sucks". Every one of them sailed through the
// check and shipped, in a demo the header above says is built to be shown to
// a named industry audience.
//
// 'Budega' is kept in the list beside 'budega' only as documentation of what
// is being looked for; the comparison folds case on both sides now.
const identifying = ['magnusalisha','magnus-alisha','workers.dev','1A41203','budega','alisha'];
const lower = o.toLowerCase();
const found = identifying.filter(s => lower.includes(s.toLowerCase()));
must(!found.length, 'identifying strings survived: ' + found.join(', '));
must(!/"metrc_tag"/.test(o), 'metrc_tag survived');
must(!/"package_tags"/.test(o), 'package_tags survived');
must(!/"reported"/.test(o), 'reported survived');
must(!/api\.github\.com/.test(o) || /if \(GH_USER && GH_REPO\) startAutoRefresh/.test(o),
     'a live GitHub call may still be reachable');
must(o.includes('const DEMO = true'), 'DEMO flag missing');

// ── and check the FOLDER, not just the file we wrote ───────────────────────
//
// Every check above inspects index.html. None of them looked at what else was
// sitting in OUT — and the whole folder is what gets dragged onto Netlify.
//
// Found 1 Sep: compass-palette.html, a test page left in demo/ on 25 Aug,
// carrying 330 Metrc tags. It would have been published alongside a demo built
// specifically to strip them. The build does not clear OUT (deliberately — it
// is a folder the user owns and may keep things in), so anything dropped there
// rides along silently.
//
// Named allowlist rather than a wildcard: a new stray gets caught rather than
// pattern-matched into acceptance.
const EXPECTED = new Set(['index.html','favicon-32.png','favicon-16.png','apple-touch-icon.png']);
const strays = fs.readdirSync(OUT)
  .filter(f => f !== path.basename(staged))       // our own scratch file, removed on exit
  .filter(f => !EXPECTED.has(f) && !f.startsWith('.'));
must(!strays.length,
     'unexpected files in ' + OUT + ' — they would be published too:\n  ' + strays.join('\n  ') +
     '\nMove them out, or add them to EXPECTED if they belong.');

// ── everything passed: publish ─────────────────────────────────────────────
fs.renameSync(staged, path.join(OUT, 'index.html'));
for (const icon of ['favicon-32.png','favicon-16.png','apple-touch-icon.png']){
  const from = path.join(SRC, icon);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(OUT, icon));
}

console.log('built   :', path.join(OUT, 'index.html'));
console.log('size    :', (o.length / 1024).toFixed(0) + ' KB');
console.log('records :', records.length + (skipped.length ? '  (skipped ' + skipped.length + ')' : ''));
skipped.forEach(s => console.log('  SKIPPED:', s));
console.log('brands  :', new Set(records.map(r => r.brand)).size, Object.keys(BRANDS).length ? '(renamed)' : '(real names)');
console.log('checks  : no metrc tags, no reported[], no owner/worker strings, no live polling');
console.log('\nnext    : drag', OUT, 'onto app.netlify.com/drop');
