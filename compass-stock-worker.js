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
// Deploy: paste into a Cloudflare Worker, set the four variables below as
// environment variables / secrets in the dashboard. See DEPLOY-WORKER.md.
//   GH_TOKEN       (secret)  fine-grained PAT, Contents: Read+Write, compass only
//   GH_USER        (var)     e.g. magnusalisha
//   GH_REPO        (var)     compass
//   ALLOWED_ORIGIN (var)     e.g. https://magnusalisha.github.io
// ==========================================================================

const j = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

function withCORS(res, origin) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", origin || "*");
  h.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type");
  h.set("Cache-Control", "no-store");
  return new Response(res.body, { status: res.status, headers: h });
}

// GitHub hands back base64 and wants base64. The records contain em dashes
// (the faint-profile notes), so this has to go through UTF-8 properly —
// btoa/atob alone are Latin-1 and would corrupt those records silently.
const b64decode = (b64) => {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};
const b64encode = (str) => {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
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

async function serveData(env, ctx) {
  const hit = await cacheGet(dataCacheKey());
  if (hit) return hit;

  const H = {
    Authorization: `Bearer ${env.GH_TOKEN}`,
    "User-Agent": "compass-stock",
    Accept: "application/vnd.github+json",
  };

  // Bypass Cloudflare's subrequest cache here. GitHub serves this listing with
  // max-age=60, and a stale listing means stale shas — which would make the
  // cache-buster below point at old file content and silently undo a write.
  const listRes = await fetch(
    `https://api.github.com/repos/${env.GH_USER}/${env.GH_REPO}/contents/data`,
    { headers: H, cf: { cacheTtl: 0, cacheEverything: false } }
  );
  if (!listRes.ok) return j({ error: "list failed", status: listRes.status }, 502);

  const files = (await listRes.json()).filter((f) => f.name.endsWith(".json"));

  // download_url points at raw.githubusercontent, which caches for 5 minutes —
  // long enough to serve a stale record right after someone marks it sold out.
  // Appending the file's git sha changes the URL exactly when the file changes,
  // so edits are picked up instantly while unchanged files still hit the CDN.
  const records = await Promise.all(
    files.map(async (f) => {
      const r = await fetch(`${f.download_url}?v=${f.sha}`, {
        headers: { "User-Agent": "compass-stock" },
      });
      if (!r.ok) return null;
      const rec = await r.json().catch(() => null);
      if (!rec) return null;
      rec._key = f.name.replace(/\.json$/, "");
      return rec;
    })
  );

  const clean = records.filter(Boolean);
  if (!clean.length) return j({ error: "no records" }, 502);

  const res = new Response(JSON.stringify(clean), {
    headers: {
      "Content-Type": "application/json",
      // Short, so a stock change reaches everyone quickly, but long enough
      // that ten people loading at once cost one rebuild.
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
        { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
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
    if (request.method === "GET") return serveData(env, ctx);

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

    const { key, sold_out } = body;
    // key is a repo filename stem — constrain it hard so this can never be
    // pointed at another path in the repo.
    if (typeof key !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(key))
      return withCORS(j({ error: "bad key" }, 400), allowed);
    if (typeof sold_out !== "boolean")
      return withCORS(j({ error: "sold_out must be boolean" }, 400), allowed);

    const api = `https://api.github.com/repos/${env.GH_USER}/${env.GH_REPO}/contents/data/${key}.json`;
    const H = {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      "User-Agent": "compass-stock",
      Accept: "application/vnd.github+json",
    };

    // Read → modify → write, retrying once if someone else committed to the
    // same record in between (two budtenders marking the same jar at once).
    for (let attempt = 0; attempt < 2; attempt++) {
      const get = await fetch(api, { headers: H });
      if (get.status === 404)
        return withCORS(j({ error: "record not found" }, 404), allowed);
      if (!get.ok)
        return withCORS(j({ error: "read failed", status: get.status }, 502), allowed);

      const meta = await get.json();
      let rec;
      try { rec = JSON.parse(b64decode(meta.content)); }
      catch { return withCORS(j({ error: "record is not valid json" }, 500), allowed); }

      // The ONLY fields this worker is allowed to touch.
      rec.in_stock = !sold_out;
      if (sold_out) rec.sold_out_at = new Date().toISOString();
      else delete rec.sold_out_at;

      const put = await fetch(api, {
        method: "PUT",
        headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `compass: ${sold_out ? "sold out" : "back in stock"} — ${rec.strain || key}`,
          content: b64encode(JSON.stringify(rec, null, 1) + "\n"),
          sha: meta.sha,
        }),
      });

      if (put.ok) {
        // Drop the cached record set so the next reader gets this change
        // immediately instead of waiting out the 30s TTL.
        cacheDrop(dataCacheKey(), ctx);
        return withCORS(j({ ok: true, key, in_stock: rec.in_stock, strain: rec.strain || null }), allowed);
      }
      if (put.status === 409) continue;  // stale sha — re-read and retry once

      return withCORS(j({ error: "write failed", status: put.status }, 502), allowed);
    }

    return withCORS(j({ error: "write conflict, try again" }, 409), allowed);
  }
