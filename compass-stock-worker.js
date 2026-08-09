// ==========================================================================
// COMPASS STOCK — Cloudflare Worker
//
// The one piece of server-side infrastructure Compass uses. It exists for a
// single reason: the page is public, so it can never hold a GitHub write
// token (a public page with a write token IS a public write token). This
// worker holds the token instead, out of reach, and exposes exactly one
// operation: flip in_stock on a record that already exists.
//
// It deliberately CANNOT create records, delete records, or modify any other
// field. Worst case if someone finds the URL and abuses it: stock flags get
// flipped. Visible, and fully recoverable from git history.
//
// A write takes a LIST of records and lands as ONE commit. That isn't an
// optimisation — it's the fix for two real failures:
//
//   1. Closing the shop means marking five or six things sold out in a row.
//      Six separate commits meant six GitHub Pages rebuilds racing each other;
//      58 got cancelled and 2 timed out and mailed a failure notice. One of
//      those swallowed a page deploy, which took a manual empty commit to
//      unstick.
//   2. The page could only have one write in flight, so taps during a save
//      were silently dropped — you'd think you marked six and land four.
//
// One commit per burst removes both at the source. The page still sends single
// changes when that's all there is, and the old {key, sold_out} body is still
// accepted, so the page and the worker can be deployed in either order.
//
// Deploy: paste into a Cloudflare Worker, set the variables below as
// environment variables / secrets in the dashboard. See DEPLOY-WORKER.md.
//   GH_TOKEN       (secret)  fine-grained PAT, Contents: Read+Write, compass only
//   GH_USER        (var)     e.g. magnusalisha
//   GH_REPO        (var)     compass
//   ALLOWED_ORIGIN (var)     e.g. https://magnusalisha.github.io
//   GH_BRANCH      (var)     optional, defaults to main — the Git Data API
//                            needs a branch named explicitly, where the old
//                            contents API just used the repo default
// ==========================================================================

// A batch is bounded by Cloudflare's free-plan cap of 50 subrequests per
// invocation. The commit costs one read per record plus five fixed calls
// (ref, base commit, tree, commit, ref update), so N=25 is 30 — comfortable,
// and far more than a shift ever needs. Tree entries carry `content` inline
// rather than pre-creating a blob per file, which is what keeps it to one
// read per record instead of two.
const MAX_BATCH = 25;

// Errors carry no-store: a cached failure outlives the bug that caused it. A
// 500 from a broken deploy stayed pinned at the edge after the fix went live,
// which looked exactly like the fix not working.
const j = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(status >= 400 ? { "Cache-Control": "no-store" } : {}),
    },
  });

function withCORS(res, origin) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", origin || "*");
  h.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type");
  h.set("Cache-Control", "no-store");
  return new Response(res.body, { status: res.status, headers: h });
}

// GitHub hands records back as base64. They contain em dashes (the
// faint-profile notes), so this has to go through UTF-8 properly — atob alone
// is Latin-1 and would corrupt those records silently. There is no encode half
// any more: tree entries carry plain UTF-8 `content`, so only reads decode.
const b64decode = (b64) => {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

// Cache key for the assembled-data response. Must be a fully-valid URL with a
// real TLD — Cloudflare rejects hostnames like "compass-internal", which is one
// way this endpoint can blow up with a bare 1101 and no explanation.
const DATA_CACHE_URL = "https://compass-internal.example.com/data";
const dataCacheKey = () => new Request(DATA_CACHE_URL, { method: "GET" });

// Assemble every record into one response.
//
// Why the page can't just do this itself: GitHub's API allows 60 requests an
// hour PER IP unauthenticated, and every device on the shop's wifi shares that
// number. The Worker's requests are authenticated (5,000/hour) and come from
// Cloudflare, so the shop's limit stops mattering — which is what makes it safe
// for the page to poll at all.
// The Cache API is an optimisation, not a requirement — and it is NOT available
// on workers.dev subdomains, where touching it can throw. A failed cache lookup
// must never take the endpoint down with it, so every call is guarded and the
// worst case is simply rebuilding the response.
async function cacheGet(key) {
  try { return await caches.default.match(key); } catch (e) { return undefined; }
}
function cacheSet(key, res, ctx) {
  try { ctx.waitUntil(caches.default.put(key, res.clone())); } catch (e) { /* uncached is fine */ }
}
function cacheDrop(key, ctx) {
  try { ctx.waitUntil(caches.default.delete(key)); } catch (e) { /* nothing to drop */ }
}

// Return the FILE INDEX, not the file contents.
//
// Cloudflare's free plan caps a Worker at 50 subrequests per invocation, and
// reading 80 records meant 81 — so this endpoint died with "Too many
// subrequests" as soon as it went live. It also got worse with every product
// scanned, which makes fetching-all-files the wrong shape regardless of plan.
//
// So the Worker makes exactly ONE subrequest (the listing, which needs the
// token's authenticated quota) and hands the browser a list of raw URLs plus
// each file's git sha. The browser fetches those itself: raw.githubusercontent
// has no 60/hour API limit, and a sha-pinned URL is immutable, so unchanged
// files come straight from the browser cache and only genuinely-changed records
// cross the network.
async function serveIndex(env, ctx) {
  const hit = await cacheGet(dataCacheKey());
  if (hit) return hit;

  const H = {
    Authorization: `Bearer ${env.GH_TOKEN}`,
    "User-Agent": "compass-stock",
    Accept: "application/vnd.github+json",
  };

  // Bypass Cloudflare's subrequest cache. GitHub serves this listing with
  // max-age=60, and a stale listing means stale shas — which would point the
  // browser's cache-busted URLs at old content and silently undo a write.
  const listRes = await fetch(
    `https://api.github.com/repos/${env.GH_USER}/${env.GH_REPO}/contents/data`,
    { headers: H, cf: { cacheTtl: 0, cacheEverything: false } }
  );
  if (!listRes.ok) return j({ error: "list failed", status: listRes.status }, 502);

  const listing = await listRes.json();
  if (!Array.isArray(listing)) return j({ error: "unexpected listing" }, 502);

  const files = listing
    .filter((f) => f.name.endsWith(".json"))
    .map((f) => ({ name: f.name, sha: f.sha, url: f.download_url }));
  if (!files.length) return j({ error: "no records" }, 502);

  const res = new Response(JSON.stringify(files), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=30",
      "Access-Control-Allow-Origin": "*",
    },
  });
  cacheSet(dataCacheKey(), res, ctx);
  return res;
}

export default {
  // Everything runs inside this wrapper so a thrown exception comes back as a
  // readable message instead of Cloudflare's opaque "error code: 1101", which
  // cost a full debug cycle the first time this endpoint broke.
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (err) {
      return new Response(
        JSON.stringify({ error: "worker exception", message: String(err && err.message || err) }),
        { status: 500, headers: { "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } }
      );
    }
  },
};

async function handle(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const allowed = env.ALLOWED_ORIGIN || "";

    if (request.method === "OPTIONS")
      return withCORS(new Response(null, { status: 204 }), allowed);

    // Reading is public — the repo is public, so there is nothing to gate here,
    // and leaving it open means the page can fetch data before anyone signs in
    // to anything. Only writes are origin-checked.
    if (request.method === "GET") return serveIndex(env, ctx);

    if (request.method !== "POST")
      return withCORS(j({ error: "POST or GET only" }, 405), allowed);

    // Not a security boundary so much as a bot filter — an Origin header is
    // trivially forged by anything that isn't a browser. It costs staff
    // nothing and keeps casual drive-by traffic off the endpoint.
    if (allowed && origin !== allowed)
      return withCORS(j({ error: "origin not allowed" }, 403), allowed);

    let body;
    try { body = await request.json(); }
    catch { return withCORS(j({ error: "bad json" }, 400), allowed); }

    // Two accepted shapes. {key, sold_out} is what every deployed page sent
    // before batching existed, and a page can be older than the worker (they
    // are pasted into different places by hand), so it stays supported forever
    // — normalised into a batch of one rather than kept as a second code path.
    const changes = Array.isArray(body.changes)
      ? body.changes
      : [{ key: body.key, sold_out: body.sold_out }];

    if (!changes.length)
      return withCORS(j({ error: "no changes" }, 400), allowed);
    if (changes.length > MAX_BATCH)
      return withCORS(j({ error: `too many changes (max ${MAX_BATCH})` }, 400), allowed);

    const seen = new Set();
    for (const c of changes) {
      // key is a repo filename stem — constrain it hard so this can never be
      // pointed at another path in the repo.
      if (!c || typeof c.key !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(c.key))
        return withCORS(j({ error: "bad key" }, 400), allowed);
      if (typeof c.sold_out !== "boolean")
        return withCORS(j({ error: "sold_out must be boolean" }, 400), allowed);
      // Two entries for one record would put two tree entries on one path and
      // the later one would silently win. Reject instead of picking.
      if (seen.has(c.key))
        return withCORS(j({ error: `duplicate key ${c.key}` }, 400), allowed);
      seen.add(c.key);
    }

    const H = {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      "User-Agent": "compass-stock",
      Accept: "application/vnd.github+json",
    };

    // Retry once as a whole: between reading the branch head and moving it,
    // someone else may have committed (the other budtender's phone, or a
    // capture from the shortcut). GitHub refuses the non-fast-forward and the
    // second pass rebuilds on the new head.
    let last = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      last = await commitBatch(env, H, changes);
      if (last.ok) {
        // Drop the cached record set so the next reader gets this change
        // immediately instead of waiting out the 30s TTL.
        cacheDrop(dataCacheKey(), ctx);
        return withCORS(j(last.body), allowed);
      }
      if (!last.retry) return withCORS(j(last.body, last.status), allowed);
    }

    return withCORS(j({ error: "write conflict, try again" }, 409), allowed);
  }

// One commit for the whole batch, via the Git Data API.
//
// The contents API can only write a single file per commit, which is the entire
// reason this exists. The sequence is the standard four-step plumbing: read the
// branch head, build a tree on top of the existing one, commit it, then move
// the branch. Nothing is visible until that last step, so a failure part-way
// leaves the repo exactly as it was — no half-applied burst.
async function commitBatch(env, H, changes) {
  const base = `https://api.github.com/repos/${env.GH_USER}/${env.GH_REPO}`;
  const branch = env.GH_BRANCH || "main";
  const now = new Date().toISOString();

  const refRes = await fetch(`${base}/git/ref/heads/${branch}`,
    { headers: H, cf: { cacheTtl: 0, cacheEverything: false } });
  if (!refRes.ok)
    return { ok: false, status: 502, body: { error: "read branch failed", status: refRes.status } };
  const headSha = (await refRes.json()).object.sha;

  const commitRes = await fetch(`${base}/git/commits/${headSha}`, { headers: H });
  if (!commitRes.ok)
    return { ok: false, status: 502, body: { error: "read commit failed", status: commitRes.status } };
  const baseTree = (await commitRes.json()).tree.sha;

  // Read every record at the head we are about to build on — NOT at whatever
  // the caller last saw. The record is rewritten wholesale below, so reading a
  // stale copy would revert any other field edited since.
  const applied = [], failed = [], entries = [];
  for (const { key, sold_out } of changes) {
    const path = `data/${key}.json`;
    const get = await fetch(`${base}/contents/${path}?ref=${headSha}`,
      { headers: H, cf: { cacheTtl: 0, cacheEverything: false } });

    // A missing record is the one failure that shouldn't sink the batch: it
    // means that record was deleted or renamed since the page loaded, and
    // failing all six marks over one dead key would leave the shelf wrong for
    // the rest of the shift. Commit the rest and name the one that didn't take.
    if (get.status === 404) { failed.push({ key, error: "record not found" }); continue; }
    if (!get.ok)
      return { ok: false, status: 502, body: { error: "read failed", key, status: get.status } };

    let rec;
    try { rec = JSON.parse(b64decode((await get.json()).content)); }
    catch { failed.push({ key, error: "record is not valid json" }); continue; }

    // The ONLY fields this worker is allowed to touch.
    rec.in_stock = !sold_out;
    if (sold_out) rec.sold_out_at = now;
    else delete rec.sold_out_at;

    // `content` inline instead of a pre-created blob: same result, one fewer
    // subrequest per record. GitHub takes UTF-8 text here, so the em dashes in
    // the faint-profile notes need no base64 round trip.
    entries.push({ path, mode: "100644", type: "blob",
                   content: JSON.stringify(rec, null, 1) + "\n" });
    applied.push({ key, in_stock: rec.in_stock, strain: rec.strain || null });
  }

  // Every key was dead. Nothing to commit, and it isn't a server error.
  if (!entries.length)
    return { ok: false, status: 404, body: { error: "record not found", failed } };

  const treeRes = await fetch(`${base}/git/trees`, {
    method: "POST", headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify({ base_tree: baseTree, tree: entries }),
  });
  if (!treeRes.ok)
    return { ok: false, status: 502, body: { error: "tree failed", status: treeRes.status } };

  const newCommit = await fetch(`${base}/git/commits`, {
    method: "POST", headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify({ message: commitMessage(applied), tree: (await treeRes.json()).sha, parents: [headSha] }),
  });
  if (!newCommit.ok)
    return { ok: false, status: 502, body: { error: "commit failed", status: newCommit.status } };

  // force stays false on purpose. A non-fast-forward here means someone
  // committed while we were building, and the correct response is to rebuild on
  // their commit — never to overwrite it.
  const move = await fetch(`${base}/git/refs/heads/${branch}`, {
    method: "PATCH", headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify({ sha: (await newCommit.json()).sha, force: false }),
  });
  if (move.ok) return { ok: true, body: { ok: true, applied, failed } };

  // 422 is GitHub's "not a fast forward"; 409 shows up for a concurrent ref
  // update. Both mean try again on the new head.
  if (move.status === 422 || move.status === 409)
    return { ok: false, retry: true, status: 409, body: { error: "write conflict, try again" } };

  return { ok: false, status: 502, body: { error: "write failed", status: move.status } };
}

// Keep the one-record message byte-identical to what the contents API wrote for
// months — `git log` for a single mark should read the same before and after
// batching, so the history stays greppable.
function commitMessage(applied) {
  if (applied.length === 1) {
    const a = applied[0];
    return `compass: ${a.in_stock ? "back in stock" : "sold out"} — ${a.strain || a.key}`;
  }
  const out = applied.filter(a => !a.in_stock), back = applied.filter(a => a.in_stock);
  const head = [
    out.length ? `${out.length} sold out` : "",
    back.length ? `${back.length} back in stock` : "",
  ].filter(Boolean).join(", ");
  // The strains go in the commit body so the history still says WHICH products
  // moved, not just how many.
  return `compass: ${head}\n\n` + applied
    .map(a => `${a.in_stock ? "back in stock" : "sold out"} — ${a.strain || a.key}`)
    .join("\n") + "\n";
}
