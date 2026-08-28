// ==========================================================================
// COMPASS STOCK — Cloudflare Worker
//
// The one piece of server-side infrastructure Compass uses. It serves the
// whole catalogue to the page in one request: GET /data, and nothing else.
//
// It used to write, too — flipping in_stock on a record when a budtender
// tapped "Mark sold out". That button was retired on 2026-08-23 (sandbox:
// 08-21) once the Alleaves sync took over stock, so the POST half was deleted
// here rather than left standing. An unused write endpoint is still a write
// endpoint: it was guarded only by an Origin header check, which is browser
// policy, not authentication — curl sets that header as easily as it sets any
// other. Deleting the handler is what actually closes it.
//
// Gone with it: commitBatch and its four-step Git Data plumbing, commitMessage,
// the batch cap, the base64 record decoder, the cache-drop on write, and the
// ALLOWED_ORIGIN check that was the only thing resembling a gate.
//
// Stock is now written by tools/alleaves-sync.js in the private sandbox repo,
// which pushes over git with its own credentials. Nothing reaches this worker
// to write, and nothing can.
//
// WHAT THIS MEANS FOR THE TOKEN: GH_TOKEN no longer needs write access. The
// PAT in Cloudflare should be downgraded to Contents: Read on compass — the
// code stops using write, but the credential is what actually grants it.
//
// Deploy: paste into a Cloudflare Worker, set the variables below as
// environment variables / secrets in the dashboard. See DEPLOY-WORKER.md.
//   GH_TOKEN       (secret)  fine-grained PAT, Contents: Read, compass only
//   GH_USER        (var)     e.g. magnusalisha
//   GH_REPO        (var)     compass
//   ALLEAVES_USER  (secret)  read-only Alleaves login
//   ALLEAVES_PASS  (secret)  read-only Alleaves password
//   DISCORD_WEBHOOK (secret)  optional new-stock/full-sync alerts
//   STOCK_COORDINATOR (Durable Object binding) class StockCoordinator
// ==========================================================================


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

// Always "*". There is nothing left to gate: the repo is public, the only verb
// is GET, and serveData already answers "*" on the data path — so a narrower
// value here would only have made the preflight disagree with the response it
// was clearing. ALLOWED_ORIGIN went with the write half; it can be deleted
// from the Cloudflare dashboard.
function withCORS(res) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, If-None-Match");
  h.set("Cache-Control", "no-store");
  return new Response(res.body, { status: res.status, headers: h });
}


// Cache key for the assembled-data response. Must be a fully-valid URL with a
// real TLD — Cloudflare rejects hostnames like "compass-internal", which is one
// way this endpoint can blow up with a bare 1101 and no explanation.
const DATA_CACHE_URL = "https://compass-internal.example.com/data";
const dataCacheKey = () => new Request(DATA_CACHE_URL, { method: "GET" });
const STOCK_OBJECT_URL = "https://compass-internal.example.com/stock";
const STOCK_FRESH_MS = 60_000;
const STOCK_STALE_WARNING_MS = 10 * 60_000;

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

// ── GET /data — every record in ONE response.
//
// History matters here, because the obvious version of this endpoint is the one
// that broke. Cloudflare's free plan caps a Worker at 50 subrequests per
// invocation. The first implementation read every record itself, which meant
// n+1 subrequests, and it died with "Too many subrequests" at 80 records.
//
// The fix at the time was to stop reading the files and hand the browser a list
// of raw URLs plus each file's git sha, letting it fetch them itself. That
// worked, but it moved the fan-out to the page: opening Compass at 306 records
// meant 306 requests to raw.githubusercontent. Measured cold, that took 42
// seconds wall-clock with a p99 of 14.6s per record, because Fastly evicts 306
// small objects between visits. And raw serves `max-age=300`, so the browser
// can only hold them five minutes — meaning an open register tab re-checked all
// 306 every five minutes, all shift.
//
// So the fan-out was never acceptable in either place. What removes it is
// reading the whole data directory in one shot, which the REST contents API
// cannot do at all and GraphQL can only do unreliably. GitHub will hand over a
// gzipped tar of the entire repo in a single request, so that is what this does:
// 2 subrequests total, no chunking, no per-record anything.
//
// GraphQL was the first version of this and it is worth recording why it lost.
// One query carrying N aliased `object(expression:"main:data/x.json")` blobs
// works, and 7 queries of 50 aliases assembled the catalogue in ~1s. But under
// sustained use GitHub throttles it with 503 "no server is currently available":
// 16 of 20 consecutive 50-alias queries failed, with the rate limiter reporting
// 4,878 of 5,000 points still available, so it is not a quota — it is a burst
// throttle. It recovers after a pause, which makes it exactly the wrong shape
// for a shop's shelf: it works when you test it and fails when you lean on it.
// Alisha hit the fallback within minutes of deploying it.
//
// The same 20-attempt test against the tarball: 20 of 20, no failures.
//
// Cost of the swap is that this worker now decompresses and walks a tar archive
// instead of reading JSON. That is real work, and the free plan caps CPU per
// invocation, but it measured 12ms for the whole 306-record archive and it does
// not grow per record the way a request-per-record does.
const SAFE_NAME = /^[A-Za-z0-9_-]{1,64}\.json$/;

async function listData(env, H) {
  // Bypass Cloudflare's subrequest cache. GitHub serves this listing with
  // max-age=60, and a stale listing means stale shas — which would point the
  // browser's cache-busted URLs at old content and silently undo a write.
  const listRes = await fetch(
    `https://api.github.com/repos/${env.GH_USER}/${env.GH_REPO}/contents/data`,
    { headers: H, cf: { cacheTtl: 0, cacheEverything: false } }
  );
  if (!listRes.ok) return { error: "list failed", status: listRes.status };

  const listing = await listRes.json();
  if (!Array.isArray(listing)) return { error: "unexpected listing" };

  const files = listing
    .filter((f) => f.name.endsWith(".json"))
    .map((f) => ({ name: f.name, sha: f.sha, url: f.download_url }));
  if (!files.length) return { error: "no records" };
  return { files };
}

// Fetch the repo as a gzipped tar.
//
// The API answers 302 with a pre-signed codeload.github.com URL. That second
// request deliberately carries NO Authorization header: the URL is already
// signed, and the shop's write token has no business being sent to a different
// host than the one it was issued for.
async function fetchArchive(env) {
  const branch = env.GH_BRANCH || "main";
  const meta = await fetch(
    `https://api.github.com/repos/${env.GH_USER}/${env.GH_REPO}/tarball/${branch}`,
    {
      headers: { Authorization: `Bearer ${env.GH_TOKEN}`, "User-Agent": "compass-stock" },
      redirect: "manual",
      cf: { cacheTtl: 0, cacheEverything: false },
    }
  );
  if (meta.status >= 300 && meta.status < 400) {
    const loc = meta.headers.get("location");
    if (!loc) throw new Error("tarball redirect without location");
    const res = await fetch(loc, { headers: { "User-Agent": "compass-stock" } });
    if (!res.ok) throw new Error("archive " + res.status);
    return res;
  }
  if (!meta.ok) throw new Error("tarball " + meta.status);
  return meta;   // some deployments answer 200 directly
}

// Decompress a gzip stream into one Uint8Array. DecompressionStream is native to
// the runtime, so the gunzip itself is not JS work.
async function gunzip(body) {
  const reader = body.pipeThrough(new DecompressionStream("gzip")).getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

// Read every record out of the archive and splice them into one JSON array.
//
// Deliberately never calls JSON.parse. Parsing 306 records only to re-serialise
// them is the one cost here that grows with the catalogue for no benefit, and
// CPU per invocation is capped. Each record's text goes out exactly as it sits
// in the repo, with `_key` spliced into the opening brace as a string op.
//
// `_key` has to come from here because the page needs it to write stock back and
// the repo filename is the only unique handle on a record — the `id` field is
// duplicated across 43 of them. On the index path the page derived it from the
// file listing; on this path there is no listing in the browser.
//
// Tar layout: 512-byte header block, then the file's bytes padded up to the next
// multiple of 512. Archive paths are `<repo>-<sha>/data/<name>.json`, so only
// one directory level is stripped and the name is still checked against
// SAFE_NAME — a crafted path in the archive must not become a record.
async function readRecords(env) {
  const archive = await fetchArchive(env);
  if (!archive.body) throw new Error("archive has no body");
  const bytes = await gunzip(archive.body);

  const dec = new TextDecoder();
  const str = (off, len) => dec.decode(bytes.subarray(off, off + len)).replace(/\0[\s\S]*$/, "").trim();

  const parts = [];
  let skipped = 0;
  let p = 0;
  while (p + 512 <= bytes.length) {
    const path = str(p, 100);
    if (!path) { p += 512; continue; }          // zero block: end of archive, or padding
    const size = parseInt(str(p + 124, 12), 8) || 0;
    const type = String.fromCharCode(bytes[p + 156] || 48);
    const body = p + 512;
    p = body + Math.ceil(size / 512) * 512;

    if (type !== "0" && type !== "\0") continue;   // not a regular file
    const m = /^[^/]+\/data\/([^/]+)$/.exec(path);
    if (!m) continue;                              // not one of ours — index.html, docs, demo/
    if (!SAFE_NAME.test(m[1])) { skipped++; continue; }

    const text = dec.decode(bytes.subarray(body, body + size));
    // Requires at least one existing field, or the splice would produce
    // `{"_key":"x",}` — invalid JSON.
    if (!/^\s*\{\s*"/.test(text)) { skipped++; continue; }
    const key = JSON.stringify(m[1].replace(/\.json$/, ""));
    parts.push(text.replace(/^\s*\{/, `{"_key":${key},`));
  }

  if (!parts.length) throw new Error("no readable records");
  return { body: "[" + parts.join(",") + "]", skipped, count: parts.length };
}

// A validator for the assembled catalogue, so a page that already has the
// current copy can be told "unchanged" instead of being sent all of it again.
//
// Every open register asks for the whole catalogue once a minute, and it is
// identical to the last answer nearly every time — stock moves a few times an
// hour, not a few times a minute. At 340 records that is ~290KB per device per
// minute; the shelf grows, so it only gets worse.
//
// FNV-1a over the body, plus the length. Not a cryptographic hash and does not
// need to be: it answers "is this byte-for-byte what I already sent", where the
// only cost of a collision is one stale minute, and length has to match too.
// Cheap enough to run on a cache MISS only — a hit reads the ETag back off the
// cached response, so the common path hashes nothing.
function etagFor(bodyText) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bodyText.length; i++) {
    h ^= bodyText.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `"${bodyText.length.toString(36)}-${h.toString(36)}"`;
}

function dataResponse(bodyText, extraHeaders, ctx) {
  const res = new Response(bodyText, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=30",
      "Access-Control-Allow-Origin": "*",
      // Without this the browser hides every X-Compass-* header from page JS.
      // Allow-Origin only governs whether the RESPONSE is readable; custom
      // headers stay invisible unless named here, and the page needs
      // X-Compass-Skipped to tell the shelf that a record was dropped.
      "ETag": etagFor(bodyText),
      "Access-Control-Expose-Headers": "ETag, X-Compass-Shape, X-Compass-Count, X-Compass-Skipped, X-Compass-Stock-Checked-At, X-Compass-Stock-Stale",
      ...extraHeaders,
    },
  });
  cacheSet(dataCacheKey(), res, ctx);
  return res;
}

// Availability is matched only by Metrc package label. Names are useful history
// context, never identity: two brands can sell the same strain and a spelling
// can change while the package label cannot.
export function overlayAvailability(bodyText, snapshot) {
  if (!snapshot || !Array.isArray(snapshot.tags) || !snapshot.checkedAt)
    throw new Error("invalid stock snapshot");
  const live = new Set(snapshot.tags);
  const records = JSON.parse(bodyText);
  if (!Array.isArray(records) || !records.length) throw new Error("invalid catalogue");

  const idCounts = new Map();
  for (const rec of records) {
    if (rec && rec.id != null) idCounts.set(String(rec.id), (idCounts.get(String(rec.id)) || 0) + 1);
  }
  const observations = [];
  let matched = 0;
  for (const rec of records) {
    if (!rec || typeof rec !== "object") continue;
    const tag = typeof rec.metrc_tag === "string" ? rec.metrc_tag.trim() : "";
    if (!tag) continue; // no stable upstream identifier: preserve committed stock
    rec.in_stock = live.has(tag);
    matched++;
    const ownId = rec.id == null ? "" : String(rec.id);
    const stableProductId = ownId && idCounts.get(ownId) === 1 ? ownId : tag;
    observations.push({
      stableProductId,
      identifierType: stableProductId === tag ? "metrc_package_label" : "catalogue_id",
      metrcTag: tag,
      name: typeof rec.strain === "string" ? rec.strain.slice(0, 160) : null,
      available: rec.in_stock,
    });
  }
  if (!matched) throw new Error("catalogue has no stable stock identifiers");
  return { body: JSON.stringify(records), observations, matched };
}

async function liveStock(env) {
  if (!env.STOCK_COORDINATOR) return null;
  const stub = env.STOCK_COORDINATOR.getByName
    ? env.STOCK_COORDINATOR.getByName("global")
    : env.STOCK_COORDINATOR.get(env.STOCK_COORDINATOR.idFromName("global"));
  const res = await stub.fetch(STOCK_OBJECT_URL);
  if (!res.ok) throw new Error("stock coordinator " + res.status);
  const snapshot = await res.json();
  return { snapshot, stub };
}

function stockHeaders(snapshot) {
  if (!snapshot || !snapshot.checkedAt) return {};
  const age = Date.now() - Date.parse(snapshot.checkedAt);
  return {
    "X-Compass-Stock-Checked-At": snapshot.checkedAt,
    ...(age > STOCK_STALE_WARNING_MS ? { "X-Compass-Stock-Stale": "true" } : {}),
  };
}

function recordObservations(stub, observations, checkedAt, ctx) {
  if (!stub || !observations.length) return;
  const req = new Request(STOCK_OBJECT_URL + "/observe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ checkedAt, observations }),
  });
  try { ctx.waitUntil(stub.fetch(req)); } catch (_) { /* history cannot break /data */ }
}

// `inm` is the request's If-None-Match. A match means the caller already holds
// this exact catalogue, so the answer is 304 and no body at all.
async function serveData(env, ctx, inm) {
  const notModified = tag => new Response(null, {
    status: 304,
    headers: {
      "ETag": tag,
      "Cache-Control": "public, max-age=30",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "ETag",
    },
  });

  const hit = await cacheGet(dataCacheKey());
  if (hit) {
    const tag = hit.headers.get("ETag");
    // Reading the tag off the cached response is why the hash never runs here.
    if (tag && inm && inm === tag) return notModified(tag);
    return hit;
  }

  // The archive read needs no listing, so the happy path is 2 subrequests and
  // never touches the contents API. The listing is only fetched if the archive
  // read fails, to build the fallback.
  try {
    let { body, skipped, count } = await readRecords(env);
    let stock = null;
    try {
      stock = await liveStock(env);
      if (stock) {
        const overlaid = overlayAvailability(body, stock.snapshot);
        body = overlaid.body;
        recordObservations(stock.stub, overlaid.observations, stock.snapshot.checkedAt, ctx);
      }
    } catch (err) {
      // Never turn auth, latency, malformed JSON or an empty upstream answer
      // into stock. The committed catalogue is a safe fallback; the Durable
      // Object retains the last successful snapshot for the next request.
      stock = null;
      console.warn("Compass stock refresh unavailable", {
        kind: String((err && err.message) || err).slice(0, 100),
      });
    }
    // The cache expiring does not mean the DATA changed. Thirty seconds pass far
    // more often than a record does, so this is the branch that saves the most.
    const fresh = dataResponse(body, {
      "X-Compass-Shape": "records",
      "X-Compass-Count": String(count),
      "X-Compass-Skipped": String(skipped),
      ...stockHeaders(stock && stock.snapshot),
    }, ctx);
    const tag = fresh.headers.get("ETag");
    return (tag && inm && inm === tag) ? notModified(tag) : fresh;
  } catch (err) {
    // Fall back to the file index. The page accepts both shapes, so the worst
    // case is the old one-request-per-record load rather than an empty shelf —
    // which is the whole reason the index shape stays supported.
    const H = {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      "User-Agent": "compass-stock",
      Accept: "application/vnd.github+json",
    };
    const listed = await listData(env, H);
    // Both routes are down. Say so rather than caching an error as if it were
    // data — the page keeps whatever it already had and retries in a minute.
    if (listed.error) return j({ ...listed, archive: String((err && err.message) || err) }, 502);
    return dataResponse(JSON.stringify(listed.files), {
      "X-Compass-Shape": "index-fallback",
      "X-Compass-Error": String((err && err.message) || err).slice(0, 100),
    }, ctx);
  }
}

// One named instance ("global") is the authoritative refresh coordinator.
// Durable Objects serialize requests at one location; `refreshing` also
// coalesces requests that overlap while fetch() is awaiting Alleaves.
export class StockCoordinator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.refreshing = null;
    this.token = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/stock/observe")
      return this.observe(request);
    if (request.method !== "GET") return j({ error: "GET only" }, 405);

    const saved = await this.state.storage.get("stock:snapshot");
    const age = saved ? Date.now() - Date.parse(saved.checkedAt) : Infinity;
    if (saved && age <= STOCK_FRESH_MS) return j(saved);

    if (saved) {
      // Stale-while-revalidate: after a quiet period the first caller receives
      // the LKG immediately. The refresh is global and runs once in background.
      this.state.waitUntil(this.refresh().catch(err =>
        console.warn("Compass stock background refresh failed", { kind: err.message.slice(0, 100) })));
      return j({ ...saved, stale: true });
    }

    // No successful snapshot has ever existed. Block briefly for the first one;
    // failure returns 503 and the outer Worker serves committed Git stock.
    try { return j(await this.refresh()); }
    catch (err) { return j({ error: "stock unavailable" }, 503); }
  }

  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.fetchAlleaves().then(async snapshot => {
      await this.state.storage.put("stock:snapshot", snapshot);
      return snapshot;
    }).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async timedFetch(url, init = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(this.env.ALLEAVES_TIMEOUT_MS || 5000));
    try { return await fetch(url, { ...init, signal: controller.signal }); }
    finally { clearTimeout(timeout); }
  }

  async authenticate() {
    if (!this.env.ALLEAVES_USER || !this.env.ALLEAVES_PASS)
      throw new Error("Alleaves credentials missing");
    const basic = btoa(`${this.env.ALLEAVES_USER}:${this.env.ALLEAVES_PASS}`);
    const res = await this.timedFetch(`${this.env.ALLEAVES_HOST || "https://app.alleaves.com"}/api/auth`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        Accept: "application/json",
        ...(this.env.ALLEAVES_LOCATION ? { "X-Location-Id": this.env.ALLEAVES_LOCATION } : {}),
      },
    });
    if (!res.ok) throw new Error("Alleaves auth " + res.status);
    let body;
    try { body = await res.json(); } catch (_) { throw new Error("Alleaves auth malformed"); }
    if (!body || typeof body.token !== "string" || body.token.length < 8)
      throw new Error("Alleaves auth missing token");
    this.token = body.token; // isolate memory only; never storage, response or log
    return this.token;
  }

  async search(token, skip) {
    return this.timedFetch(`${this.env.ALLEAVES_HOST || "https://app.alleaves.com"}/api/inventory/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(this.env.ALLEAVES_LOCATION ? { "X-Location-Id": this.env.ALLEAVES_LOCATION } : {}),
      },
      body: JSON.stringify({ skip, take: 500, filter: { logic: "and", filters: [
        { field: "has_available_inventory", value: true, operator: "eq" },
        { field: "is_cannabis", value: true, operator: "eq" },
      ] } }),
    });
  }

  async fetchAlleaves() {
    let token = this.token || await this.authenticate();
    const rows = [];
    for (let page = 0; page < 5; page++) {
      let res = await this.search(token, page * 500);
      if ((res.status === 401 || res.status === 403) && this.token) {
        this.token = null;
        token = await this.authenticate();
        res = await this.search(token, page * 500);
      }
      if (!res.ok) throw new Error("Alleaves inventory " + res.status);
      let body;
      try { body = await res.json(); } catch (_) { throw new Error("Alleaves inventory malformed"); }
      const pageRows = Array.isArray(body) ? body : body && body.data;
      if (!Array.isArray(pageRows)) throw new Error("Alleaves inventory wrong shape");
      rows.push(...pageRows);
      if (pageRows.length < 500) break;
      if (page === 4) throw new Error("Alleaves inventory pagination exceeded");
    }

    const minimum = Number(this.env.ALLEAVES_MIN_ROWS || 50);
    if (rows.length < minimum) throw new Error("Alleaves inventory implausibly empty");
    if (!rows.some(row => row && row.on_hand != null))
      throw new Error("Alleaves inventory missing on_hand");
    // Match the sync's scope exactly. Available inventory also includes the
    // vault and quarantine; treating either as customer-facing stock would put
    // products on the public catalogue before they reached the sales floor.
    const scoped = rows.filter(row => /^retail$/i.test(String(row && row.area_type || "")))
      .filter(row => /^(Flower|Pre-?Roll|Vapes?)\b/i.test(String(row && row.category || "")));
    const tags = [...new Set(scoped
      .filter(row => Number(row && row.on_hand) > 0)
      .map(row => typeof row.metrc_package_label === "string" ? row.metrc_package_label.trim() : "")
      .filter(Boolean))];
    if (tags.length < minimum) throw new Error("Alleaves inventory missing package labels");
    const items = [];
    const seen = new Set();
    for (const row of scoped) {
      const tag = typeof row.metrc_package_label === "string" ? row.metrc_package_label.trim() : "";
      if (!tag || Number(row.on_hand) <= 0 || seen.has(tag)) continue;
      seen.add(tag);
      items.push({
        tag,
        name: String(row.item || row.strain || "Unnamed package").slice(0, 180),
        category: String(row.category || "").slice(0, 80),
      });
    }
    return { version: 1, checkedAt: new Date().toISOString(), tags, items,
      rowCount: rows.length, scopedRowCount: scoped.length };
  }

  async observe(request) {
    let body;
    try { body = await request.json(); } catch (_) { return j({ error: "bad observations" }, 400); }
    if (!body || !Array.isArray(body.observations) || !body.checkedAt)
      return j({ error: "bad observations" }, 400);

    const snapshot = await this.state.storage.get("stock:snapshot");
    const catalogueTags = new Set(body.observations
      .map(obs => obs && obs.metrcTag).filter(tag => typeof tag === "string" && tag));
    const missing = snapshot && Array.isArray(snapshot.items)
      ? snapshot.items.filter(item => item && item.tag && !catalogueTags.has(item.tag)) : [];
    const previousMissing = await this.state.storage.get("alerts:missing-tags");
    const previousSet = new Set(Array.isArray(previousMissing) ? previousMissing : []);
    const newlyMissing = missing.filter(item => !previousSet.has(item.tag));

    // Baseline silently on the first observation so deploying Route 2 cannot
    // announce the whole existing shelf. Every later unknown package is a new
    // product or restock that needs the human full-sync path.
    await this.state.storage.put("alerts:missing-tags", missing.map(item => item.tag));
    if (Array.isArray(previousMissing) && newlyMissing.length && this.env.DISCORD_WEBHOOK)
      this.state.waitUntil(this.alertNewStock(newlyMissing));

    const writes = {};
    for (const obs of body.observations) {
      if (!obs || typeof obs.stableProductId !== "string" || typeof obs.available !== "boolean") continue;
      const id = obs.stableProductId.slice(0, 160);
      const stateKey = "history:state:" + id;
      const previous = await this.state.storage.get(stateKey);
      const next = {
        stableProductId: id,
        identifierType: obs.identifierType,
        metrcTag: obs.metrcTag,
        name: obs.name,
        availability: obs.available,
        firstObservedAt: previous ? previous.firstObservedAt : body.checkedAt,
        lastObservedAt: body.checkedAt,
        becameAvailableAt: obs.available
          ? (!previous || !previous.availability ? body.checkedAt : previous.becameAvailableAt)
          : previous && previous.becameAvailableAt,
        becameUnavailableAt: !obs.available
          ? (!previous || previous.availability ? body.checkedAt : previous.becameUnavailableAt)
          : previous && previous.becameUnavailableAt,
      };
      writes[stateKey] = next;
      if (!previous || previous.availability !== obs.available) {
        const eventKey = `history:event:${body.checkedAt}:${id}`;
        writes[eventKey] = {
          stableProductId: id,
          metrcTag: obs.metrcTag,
          name: obs.name,
          previousAvailability: previous ? previous.availability : null,
          newAvailability: obs.available,
          observedAt: body.checkedAt,
        };
      }
      if (Object.keys(writes).length >= 100) {
        await this.state.storage.put(writes);
        for (const key of Object.keys(writes)) delete writes[key];
      }
    }
    if (Object.keys(writes).length) await this.state.storage.put(writes);
    return j({ ok: true });
  }

  async alertNewStock(items) {
    const shown = items.slice(0, 20).map(item => `• ${item.name}`).join("\n");
    const more = items.length > 20 ? `\n…and ${items.length - 20} more` : "";
    const content = `⚠️ **new stock needs a full sync**\n${shown}${more}`;
    try {
      const res = await this.timedFetch(this.env.DISCORD_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) console.warn("Compass new-stock alert failed", { status: res.status });
    } catch (err) {
      console.warn("Compass new-stock alert failed", { kind: String(err && err.name || "network") });
    }
  }
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
    if (request.method === "OPTIONS")
      return withCORS(new Response(null, { status: 204 }));

    // Reading is public — the repo is public, so there is nothing to gate here,
    // and leaving it open means the page can fetch data before anyone signs in
    // to anything.
    if (request.method === "GET")
      return serveData(env, ctx, request.headers.get("If-None-Match"));

    // Every other verb, POST included. This used to be the write path.
    return withCORS(j({ error: "GET only" }, 405));
  }
