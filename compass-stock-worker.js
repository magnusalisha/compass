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
      "Access-Control-Expose-Headers": "ETag, X-Compass-Shape, X-Compass-Count, X-Compass-Skipped",
      ...extraHeaders,
    },
  });
  cacheSet(dataCacheKey(), res, ctx);
  return res;
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
    const { body, skipped, count } = await readRecords(env);
    // The cache expiring does not mean the DATA changed. Thirty seconds pass far
    // more often than a record does, so this is the branch that saves the most.
    const fresh = dataResponse(body, {
      "X-Compass-Shape": "records",
      "X-Compass-Count": String(count),
      "X-Compass-Skipped": String(skipped),
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
