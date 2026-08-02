// ==========================================================================
// COMPASS — bootstrap for Scriptable
//
// THIS is the script that lives on the phone. Paste it ONCE, fill in the four
// values below, and never touch it again. It fetches compass-capture.js from
// GitHub every run, so updating the capture logic is a `git push` — no more
// copy-paste, and no re-entering keys.
//
// Set it up exactly like the old script: Scriptable > + > paste > name it
// "Compass", then in the script's settings turn ON "Show in Share Sheet" and
// allow PDFs, images and URLs. Share a COA to it the same way as before.
//
// The keys stay here, on the phone, and never go into the repo.
// ==========================================================================

// ---- FILL THESE IN ONCE ---------------------------------------------------
const COMPASS_CONFIG = {
  ANTHROPIC_KEY: "sk-ant-REPLACE_ME",
  GITHUB_USER:   "REPLACE_ME",
  GITHUB_REPO:   "compass",
  GITHUB_TOKEN:  "github_pat_REPLACE_ME"
};
// ---------------------------------------------------------------------------

const SRC = `https://raw.githubusercontent.com/${COMPASS_CONFIG.GITHUB_USER}/${COMPASS_CONFIG.GITHUB_REPO}/main/compass-capture.js`;

// Cache the last good copy. If the phone is on the shop wifi and GitHub is
// unreachable, capture still works with whatever ran last time rather than
// failing at the counter.
const fm = FileManager.local();
const cachePath = fm.joinPath(fm.cacheDirectory(), "compass-capture-cache.js");

let code = null;
try {
  // Cache-buster: raw.githubusercontent is aggressively cached and would
  // otherwise serve yesterday's script for several minutes after a push.
  const req = new Request(SRC + "?t=" + Date.now());
  req.headers = { "Cache-Control": "no-cache" };
  code = await req.loadString();
  if (!code || code.length < 500) throw new Error("fetched file looks truncated");
  fm.writeString(cachePath, code);
} catch (e) {
  if (fm.fileExists(cachePath)) {
    code = fm.readString(cachePath);
    notifyLocal("Compass", "Using the cached capture script — couldn't reach GitHub.");
  } else {
    notifyLocal("Compass", "Couldn't fetch the capture script and nothing is cached: " + e.message);
    return;
  }
}

// Run it. The capture script uses top-level `await` AND top-level `return`,
// which is legal in Scriptable because it wraps scripts in an async function —
// so reproduce exactly that shape here. `args` and COMPASS_CONFIG are passed
// in as parameters, which is what makes the `typeof COMPASS_CONFIG` check on
// the other side resolve.
try {
  const run = new Function("args", "COMPASS_CONFIG", "return (async () => {\n" + code + "\n})();");
  await run(args, COMPASS_CONFIG);
} catch (e) {
  notifyLocal("Compass", "Capture script failed: " + e.message);
}

// Local copy of notify, because the fetched script defines its own and we may
// need to report a failure before that script ever runs.
function notifyLocal(title, msg) {
  const n = new Notification();
  n.title = title;
  n.body = msg;
  n.schedule();
}
