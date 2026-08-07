// ==========================================================================
// COMPASS — capture script for Scriptable
// Share a COA PDF, OR a screenshot of a terpene table, to this script.
// It extracts terpenes with Claude and writes one record to your GitHub repo.
// No Shortcuts, no base64 gremlins.
// ==========================================================================

// ---- FILL THESE IN ONCE ---------------------------------------------------
const ANTHROPIC_KEY = "sk-ant-REPLACE_ME";
const GITHUB_USER   = "REPLACE_ME";
const GITHUB_REPO   = "compass";
const GITHUB_TOKEN  = "github_pat_REPLACE_ME";
// ---------------------------------------------------------------------------

const PROMPT = `This is a cannabis Certificate of Analysis. Return ONLY a JSON object, no preamble, no markdown fences.
Schema:
{"id":"<10 random hex chars>","metrc_tag":"<the METRC Test Tag ID or METRC Source ID, digits/letters only>","brand":"<brand or licensee, NOT the lab>","strain":"<strain name>","form":"<e.g. Flower 3.5g, Preroll 1g>","thc":<total THC percent>,"total_terpenes":<number>,"lean":"lifting|settling|mixed","confidence":"strong|moderate|faint","in_stock":true,"shelf_tag":"Unverified","reported":[<up to 2 phrases>],"dominant":[<top 3 terpenes, descending>],"aroma":[<up to 5 aroma words>],"terpenes":{<name>:<percent>}}
Rules:
- All values are % w/w. If the lab reports mg/g (not mg/pkg or mg/serving), divide by 10.
- thc = the percent value for TOTAL THC specifically. Sources vary — some print
  "Total THC" as its own line, some compute it as Δ9-THC + Δ8-THC + (THCA × 0.877),
  some (like the NY Metrc Retail ID page) show a CANNABINOID/WEIGHT/PERCENT table
  with separate rows for "Total THC", "THCa", and "Δ9 THC". In every case: use the
  row explicitly labeled "Total THC" (or "Total THC/Container"), and take its
  PERCENT value, never its WEIGHT/mg value. NEVER use THCA alone as thc — that's
  the acid precursor, always larger than Total THC, and NEVER use Δ9-THC alone —
  that's only the already-decarboxylated fraction, always much smaller than Total
  THC. If no row is explicitly labeled "Total THC", compute it yourself from
  Δ9-THC + Δ8-THC + (THCA × 0.877) using the percent values.
- terpenes table format also varies: some sources add a WEIGHT/mg column next to
  the PERCENT column (identical situation to THC above) — always take PERCENT,
  ignore weight/mg columns entirely for both cannabinoids and terpenes.
- ND, NR, <MRL and <0.0400 all mean 0 — omit them from terpenes.
- ONE COA CAN COVER SEVERAL PRODUCT FORMS. A single batch is often tested as
  Raw Plant Material, Concentrate/Extract, Infused Flower, Infused Prerolls AND
  Inhalable Concentrate, each with its OWN full set of results. Pick the ONE
  matrix matching the product in hand and take every value from it — thc,
  total_terpenes and all terpenes. NEVER mix rows across matrices, and never
  fall back to an earlier stage of the supply chain.
    vape / cart / disposable -> Inhalable Concentrate
    preroll (infused)        -> Infused Prerolls
    flower (infused)         -> Infused Flower
    flower / preroll (plain) -> Raw Plant Material
  The COA usually names it near the top as "Matrix:" or "Category:". If you
  cannot tell which matrix belongs to this product, set total_terpenes to -1
  and leave terpenes empty rather than guessing.
- SANITY CHECK before returning: the terpenes you list must add up to
  total_terpenes within about 20%. If they don't, either you missed rows of the
  terpene table, or you took the total from one matrix and the terpenes from
  another. Re-read the full table from a single matrix. List EVERY detected
  terpene, not just the largest few.
- Canonical names: beta-Myrcene, Limonene, beta-Caryophyllene, Terpinolene, Linalool, alpha-Pinene, beta-Pinene, alpha-Humulene, alpha-Bisabolol, Ocimene, Farnesene, Terpineol, Fenchol, Guaiol, Valencene, Geraniol, Camphene, Carene, alpha-Terpinene, alpha-Phellandrene, p-Cymene, Eucalyptol, Nerolidol. FENCHYL ALCOHOL is Fenchol. ALPHA TERPINEOL is Terpineol.
- lean: terpinolene, limonene, pinene, ocimene push lifting. myrcene, linalool, caryophyllene, humulene, bisabolol push settling. Close to even is mixed.
- confidence: strong if total terpenes >= 1.2, moderate if >= 0.8, faint if under 0.8. ALSO faint if under 0.8 and mostly heavy sesquiterpenes (caryophyllene, humulene, bisabolol, guaiol) because the volatile terpenes have evaporated and the profile is unreliable.
- shelf_tag: ALWAYS the literal string Unverified. NEVER guess Sativa/Indica/Hybrid — that comes from the package, not the COA. (The script asks the human right after this, with the package in their hand.)
- form: for a MULTIPACK give the PER-UNIT size and the count, never just the total — "Preroll 0.4g (5-pack, 2g total)", not "Preroll 2g". Many NY packs print only the total weight on the front, so check for a count anywhere on the label. This is only a prefill; the human confirms it.
- terpenes: detected only, sorted descending.`;

// ---- 1. get the shared file, and figure out what kind it is ---------------
// Two paths: a real COA PDF (from "View COA"), or a screenshot (for pages
// with no PDF button — a login-gated lab portal, a brand page with only an
// inline terpene table, etc). We detect which one we got rather than assume.
let fileData = null;   // the raw bytes
let kind = null;       // "pdf" | "image"

if (args.images && args.images.length) {
  // Shared a screenshot/photo directly.
  fileData = Data.fromPNG(args.images[0]) || Data.fromJPEG(args.images[0]);
  kind = "image";
} else if (args.fileURLs && args.fileURLs.length) {
  const path = args.fileURLs[0];
  fileData = Data.fromFile(path);
  kind = /\.(png|jpe?g|heic)$/i.test(path) ? "image" : "pdf";
} else if (args.urls && args.urls.length) {
  const req = new Request(args.urls[0]);
  fileData = await req.load();
  // COA links (Azure blob etc) have no extension — assume PDF; the
  // signature check right below catches it if that assumption is wrong.
  kind = "pdf";
} else {
  // Manual test run (tapping ▶ in Scriptable): paste a fresh COA link.
  const a = new Alert();
  a.title = "Compass test";
  a.message = "Paste a fresh COA URL (they expire in ~1 day)";
  a.addTextField("https://...");
  a.addAction("Fetch");
  a.addCancelAction("Cancel");
  if (await a.presentAlert() === 0 && a.textFieldValue(0)) {
    fileData = await new Request(a.textFieldValue(0)).load();
    kind = "pdf";
  }
}

if (!fileData) { notify("Compass", "Nothing usable was shared."); return; }

// Sanity check: if it claims to be a PDF but doesn't start with the PDF
// magic bytes, it's almost certainly the empty Metrc landing page, not a
// real COA. Catch that here instead of getting a confusing API error later.
if (kind === "pdf") {
  // Check the raw bytes for the "%PDF" magic number — NOT toRawString(),
  // which tries to decode the whole file as UTF-8 text and returns null
  // (not an error) on ordinary binary PDF content. That null caused a
  // crash here on a completely valid COA. Byte-level check can't have
  // that failure mode.
  try {
    const bytes = fileData.getBytes().slice(0, 4);          // %  P   D   F
    const isPDF = bytes[0] === 37 && bytes[1] === 80 && bytes[2] === 68 && bytes[3] === 70;
    if (!isPDF) {
      notify("Compass", "That link didn't return a real PDF — probably the landing page, not the COA. Tap \"View COA\" first, or screenshot the terpene table instead.");
      return;
    }
  } catch (e) {
    // If the check itself can't run for some reason, don't block on it —
    // let the Claude API be the final judge, same as before this fix existed.
  }
}

const b64 = fileData.toBase64String();  // <-- the thing Shortcuts couldn't do

// ---- 2. ask Claude to extract --------------------------------------------
// Content block matches whatever we actually got — PDF document or image.
const fileBlock = kind === "image"
  ? { type: "image", source: { type: "base64", media_type: "image/png", data: b64 } }
  : { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } };

const body = {
  model: "claude-sonnet-4-6",
  max_tokens: 1500,
  messages: [{
    role: "user",
    content: [ fileBlock, { type: "text", text: PROMPT } ]
  }]
};

let product;
try {
  const r = new Request("https://api.anthropic.com/v1/messages");
  r.method = "POST";
  r.headers = {
    "x-api-key": ANTHROPIC_KEY,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json"
  };
  r.body = JSON.stringify(body);
  const res = await r.loadJSON();
  if (res.error) { notify("Compass", "Claude: " + res.error.message); return; }
  let text = res.content[0].text.trim();
  text = text.replace(/^```json\s*/i, "").replace(/```$/,"").trim(); // just in case
  product = JSON.parse(text);
} catch (e) {
  notify("Compass", "Extraction failed: " + e.message);
  return;
}

// ---- 2b. sum check: do the terpenes add up to the stated total? -----------
// A COA often carries several product forms side by side — Raw Plant Material,
// Infused Prerolls, Inhalable Concentrate — each with its own results. Taking
// the total from one and the terpenes from another produces a record that looks
// completely normal and describes nothing. Baja Breeze had total_terpenes 1.53
// (Raw Plant Material) with two terpenes summing to 0.31 (Infused Prerolls);
// neither described the cart it was filed under.
//
// Adding them up catches it. The threshold took three tries, because the LAB's
// own numbers don't add up either — a stated "Total Terpenes" routinely differs
// from the sum of the analytes printed beneath it, in both directions.
// Everything below was checked field-by-field against Alleaves:
//
//   REAL capture failures     Baja Breeze 80% · Golden Yuzu 80% · Papaya Punch 50%
//   LAB's own inconsistency   Slingria 20% short · Silver Surfer 11% over
//                             Papaya Punch (once corrected) 11% over
//
// Short gaps are compounds detected but below the reporting limit: counted in
// the total, not printed as rows. Over-gaps are labs differing on which analytes
// count toward "total". So anything under ~20% is noise, and 3%, 10% and 15%
// each rejected records that turned out to be perfectly captured.
//
// 30% sits clear of the noise and still catches every genuine failure seen,
// which run 50-80% because a crossed matrix is a completely different sample.
//
// Refuses rather than saving. A bad record that looks fine is worse than no
// record, and rescanning costs one photo.
{
  const t = product.terpenes || {};
  const sum = Object.values(t).reduce((a, v) => a + (typeof v === "number" ? v : 0), 0);
  const tot = product.total_terpenes;
  if (tot === -1) {
    notify("Compass ⚠️", "Couldn't tell which product form this COA is for. Re-shoot the page showing Matrix/Category.");
    return;
  }
  if (typeof tot === "number" && tot > 0 && Object.keys(t).length) {
    const off = Math.abs(sum - tot) / tot;
    if (off > 0.30) {
      notify("Compass ⚠️ not saved",
        `Terpenes sum to ${sum.toFixed(2)}% but the total says ${tot}% (${Math.round(off*100)}% off). ` +
        `Likely two different product forms on one COA. Re-scan the section for ${product.form || "this product"}.`);
      return;
    }
  }
}

// ---- 2c. confirm the two things only the package can tell you -------------
// The COA carries chemistry. It does NOT carry sativa/indica, and it usually
// doesn't carry pack structure — both are printed on the package you are
// holding at the moment you scan. So ask, once, instead of leaving a cleanup
// job for later.
//
// SHELF TAG. The prompt still forbids the model from guessing this, and that
// stays: the whole label-vs-chemistry question is only answerable because the
// tag comes from a human looking at the package. This just moves that human
// from "some evening, going through the Unverified list" to "now, with the jar
// in hand". Cancel still writes Unverified, so nothing is ever worse than before.
//
// PACK STRUCTURE. Miss Grass prints "2g" on a tube holding five 0.4g joints, so
// the model wrote `Preroll 2g` and the page read it as one 2g joint — wrong on
// the card and, worse, filed under 2g in the size filter, where nobody looking
// for a small preroll would ever see it. The page can only detect a multipack
// if the form string says so, so build a string it can always parse.
const CANON = (() => {
  const f = String(product.form || "");
  // What the model thought, used to prefill — so the common case is two taps.
  const w  = f.match(/(\d+(?:\.\d+)?)\s*g\b/i);
  const pk = f.match(/(\d+)\s*-?\s*(?:pk|ct|pack|cpk)/i);
  // Everything that isn't size or pack info — "Infused Preroll", "Flower".
  // Kept verbatim because it carries category and qualifiers the page reads.
  const head = f.replace(/\([^)]*\)/g, "")
                .replace(/\d+(?:\.\d+)?\s*g\b/gi, "")
                .replace(/\d+\s*-?\s*(?:pk|ct|pack|cpk)/gi, "")
                .replace(/[\s,·-]+$/, "").replace(/\s{2,}/g, " ").trim();
  return { head: head || "Preroll", per: w ? w[1] : "", count: pk ? pk[1] : "1" };
})();

{
  const a = new Alert();
  a.title = `${product.strain || "?"} · ${product.brand || "?"}`;
  a.message = `${product.form || "?"}\n${product.thc ?? "?"}% THC · ${product.total_terpenes ?? "?"}% terps\n\n`
            + `Check the package: per-joint size, how many, and what it says.`;
  // Leading "." is what a label prints and what a person types (".75g"), but the
  // page's size regex needs a digit before the point, so normalise on the way in.
  a.addTextField("size of ONE, in g", CANON.per);
  a.addTextField("how many in the pack", CANON.count);
  a.addAction("Sativa"); a.addAction("Indica"); a.addAction("Hybrid");
  a.addCancelAction("Skip (leave Unverified)");

  const choice = await a.presentAlert();
  if (choice >= 0) {
    product.shelf_tag = ["Sativa", "Indica", "Hybrid"][choice];

    const per = parseFloat(String(a.textFieldValue(0)).trim().replace(/^\./, "0."));
    const n   = parseInt(String(a.textFieldValue(1)).trim(), 10);
    // Only rewrite `form` on sane input. A typo must not turn a good record into
    // "Preroll NaNg" — leaving the model's original string is the safe failure.
    if (per > 0 && n >= 1) {
      const g = x => (+x.toFixed(2)) + "g";
      product.form = n > 1
        ? `${CANON.head} ${g(per)} (${n}-pack, ${g(per * n)} total)`
        : `${CANON.head} ${g(per)}`;
    }
  }
}

// ---- 3. write it to GitHub -----------------------------------------------
// Filename = the stable Metrc tag (identical every scan of the same package),
// then batch. Rescanning the same package updates it in place; keying on
// anything that changes per scan would make every scan a new file, which was
// the original dupe bug.
//
// The last resort used to be `product.id`, and that was a live way to DESTROY a
// record. The prompt asks for "10 random hex chars" and the model does not
// comply: across 213 records there are only 103 distinct ids, one of them
// shared by 18 products. a3f7c2e91b.json holds Gorilla Glue and that same id
// appears on Carnival, OG Kush, Northern Lights - Pack, Strawberry Guava and
// Bubba Kush — so rescanning any of those without a readable tag would have
// overwritten Gorilla Glue, reported "✅ updated", and left no trace.
//
// So derive the fallback from what the product IS. Same product rescanned ->
// same slug -> updates in place. Two different products cannot collide: tested
// across all 213 records, brand+strain+form gives 212 distinct keys, and the
// single clash is two batches of the same Florist Farms Gelato cart. Worst case
// is now a duplicate file, which compass-manage.js can already clean up, rather
// than an unrecoverable overwrite.
const slug = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const fromContent = [product.brand, product.strain, product.form].map(slug).filter(Boolean).join("_");
const key = product.metrc_tag || product.batch || fromContent || ("" + Date.now());
const filename = (key + "").replace(/[^A-Za-z0-9_-]/g, "-") + ".json";
const path = "data/" + filename;
const contentB64 = Data.fromString(JSON.stringify(product, null, 1)).toBase64String();

try {
  const api = `https://api.github.com/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/${path}`;

  // Does this record already exist? If so we need its sha to overwrite it.
  let sha = null;
  const check = new Request(api);
  check.method = "GET";
  check.headers = { "Authorization": "Bearer " + GITHUB_TOKEN, "User-Agent": "compass", "Accept": "application/vnd.github+json" };
  try {
    const ex = await check.loadJSON();
    if (ex && ex.sha) sha = ex.sha;          // exists → update
  } catch (e) { /* 404 = new file, leave sha null */ }

  const put = new Request(api);
  put.method = "PUT";
  put.headers = { "Authorization": "Bearer " + GITHUB_TOKEN, "User-Agent": "compass", "Content-Type": "application/json" };
  const payload = { message: "compass: " + (product.strain || "product"), content: contentB64 };
  if (sha) payload.sha = sha;
  put.body = JSON.stringify(payload);
  const result = await put.loadJSON();

  if (result.content) {
    const verb = sha ? "updated" : "added";
    notify("Compass ✅", `${verb}: ${product.strain} · ${product.total_terpenes}% terps · ${product.confidence}`);
  } else {
    notify("Compass", "GitHub: " + (result.message || "unknown error"));
  }
} catch (e) {
  notify("Compass", "Save failed: " + e.message);
}

// ---- helper ---------------------------------------------------------------
function notify(title, msg) {
  const n = new Notification();
  n.title = title;
  n.body = msg;
  n.schedule();
  console.log(title + " — " + msg);
}
