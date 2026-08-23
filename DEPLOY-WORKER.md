# Serving the catalogue (one-time setup, ~10 minutes)

> **The Worker stopped writing on 2026-08-23.** It used to accept *"mark record X
> sold out"* from the page. That button is gone — the Alleaves sync writes stock
> now, over git, from the private sandbox repo — so the write half was deleted
> rather than left standing unused.
>
> What the Worker does today is **one thing: serve the whole catalogue on GET
> /data.** The page reads it; nothing writes to it.
>
> **If you set this up before that date, do two things:** re-paste
> `compass-stock-worker.js` (step 2), and **downgrade `GH_TOKEN` to Contents:
> Read** (step 1). The code no longer writes, but the token is what actually
> grants it — a read-only worker holding a write token is still a write token
> sitting in the shop's infrastructure. You can also delete `ALLOWED_ORIGIN`.

Compass shows the same stock for everyone because `in_stock` lives in this repo,
not on anyone's phone. The page is **public**, so it can never hold a GitHub
token — a public page with a token *is* a public token.

So one tiny piece of infrastructure holds the token instead: a Cloudflare Worker
that reads the repo on the page's behalf. It exists because GitHub's API allows
only 60 unauthenticated requests an hour per IP, shared by every device on the
shop's wifi; the Worker's requests are authenticated, so that limit stops
mattering and the page can poll at all.

You only do this once. No terminal — everything below is clicking in a browser.

---

## 1. Make a GitHub token (3 min)

github.com → your avatar → **Settings** → **Developer settings** →
**Personal access tokens** → **Fine-grained tokens** → **Generate new token**

- **Repository access:** Only select repositories → **compass**
- **Permissions** → Repository permissions → **Contents: Read**
- Nothing else. Not "all repositories."

Copy the token. You'll paste it once in step 3 and never need it again.
**Don't paste it into a chat, an email, or the page itself.**

## 2. Create the Worker (3 min)

1. Sign up at **dash.cloudflare.com** (free).
2. **Workers & Pages** → **Create** → **Create Worker**.
3. Name it `compass-stock`. Click **Deploy** (deploys the placeholder — fine).
4. Click **Edit code**.
5. Delete everything in the editor, paste the entire contents of
   [`compass-stock-worker.js`](compass-stock-worker.js), click **Deploy**.

## 3. Add the settings (3 min)

In the Worker → **Settings** → **Variables and Secrets**:

| Name | Type | Value |
|---|---|---|
| `GH_TOKEN` | **Secret** | the token from step 1 |
| `GH_USER` | Text | `magnusalisha` |
| `GH_REPO` | Text | `compass` |


`GH_TOKEN` **must** be added as a Secret (encrypted, not visible afterwards).
Click **Deploy** again so the settings take effect.

`ALLOWED_ORIGIN` and `GH_BRANCH` are no longer read by the Worker — both
belonged to the write half. If they are still set from an earlier setup, delete
them; leaving them does no harm beyond suggesting a gate that isn't there.

## 4. Point Compass at it (1 min)

Copy the Worker's URL **from your own Cloudflare dashboard** — for this account
it is:

```
https://compass-stock.magnus-alisha.workers.dev
```

Then edit [`index.html`](index.html) (the pencil on GitHub works fine) and paste
it between the quotes on line ~168:

```js
const STOCK_API = "https://compass-stock.magnus-alisha.workers.dev";
```

⚠️ Never paste an example subdomain from a guide. A wrong hostname fails
quietly — the buttons still appear, they just error on every tap, because the
address doesn't resolve at all. (This happened on the first setup: the
placeholder `budega` got copied in verbatim.)

Commit. Wait a minute for GitHub Pages to rebuild.

---

## That's it

Every device now loads the whole catalogue in one request, and sees the same
stock as everyone else — including whoever comes in on the next shift.

Until `STOCK_API` is filled in, the page falls back to its embedded seed: nine
products instead of the full case. Nothing breaks, but it looks enough like
success to be worth checking — if you see nine, this isn't wired up yet.

---

## Updating the Worker (one paste, ~2 minutes)

Do this whenever `compass-stock-worker.js` changes in the repo.

1. Cloudflare → **Workers & Pages** → `compass-stock` → **Edit code**
2. Select all, delete, paste the whole current
   [`compass-stock-worker.js`](compass-stock-worker.js)
3. **Deploy**

No settings change. Nothing to touch on the page.

### Check it worked

```bash
curl -s -D - -o /dev/null "https://compass-stock.magnus-alisha.workers.dev/data?t=$(date +%s)" | grep -i x-compass
```

(`-I` will *not* work here — it sends a HEAD request, which the Worker doesn't
answer, so you get a 405 and no headers at all.)

You want to see:

```
x-compass-shape: records
x-compass-count: 306
x-compass-skipped: 0
```

`shape: records` means the fast path is live — the whole catalogue arrives in
one response. Anything else means it fell back, and Compass still works, just
slowly:

| header | what it means |
|---|---|
| `shape: records` | working as intended |
| `shape: index-fallback` | GitHub wouldn't hand over the archive; `x-compass-error` says why. Compass still works, just slowly. |
| `skipped: 1` or more | that many records were unreadable and left out — usually a hand-edit that broke a file's JSON. |
| HTTP 502 | both routes are down. Rare; the page keeps whatever it already had. |
| no `x-compass-*` at all | an older Worker is still deployed. Paste again. |

### Why this exists

Before it, the Worker sent the page a *list* of records and the browser fetched
each one itself — 306 separate requests to open Compass. Cold, that measured 42
seconds, with the slowest single record taking 15. It also re-checked all 306
every five minutes on every open device, because GitHub only lets a browser
cache those files for five minutes.

The reason it was built that way is real: Cloudflare's free plan caps a Worker
at **50 subrequests per invocation**, and reading every record one-by-one needs
307. It actually broke exactly this way at 80 records.

Now the Worker asks GitHub for the whole repo as one gzipped tar and reads the
records out of it: **2 subrequests**, one response to the page, ~30 KB on the
wire. The count of records stops mattering — 306 or 3,000 is the same two
requests.

### Two dead ends, recorded so nobody repeats them

**Fetching each record inside the Worker.** The obvious version. Needs one
subrequest per record, so it dies at the 50 cap — which it did, at 80 records.

**GraphQL.** Genuinely clever: one query can carry 50 aliased file reads, and
seven of those assembled the catalogue in about a second. It shipped, and it
failed within minutes of going live. Under sustained use GitHub throttles it
with a 503 — **16 of 20 consecutive queries failed**, while the rate limiter
still showed 4,878 of 5,000 allowance remaining, so it isn't a quota, it's a
burst throttle that clears after a pause. That's the worst possible shape for a
shop tool: fine when you test it, broken when you lean on it. The same
20-attempt test against the tarball passed 20 of 20.

If you ever change this part: the Worker deliberately never parses the records,
it splices them together as text. Parsing 306 records just to re-print them
would burn CPU the free plan budgets tightly, and it's the one cost that grows
every time you scan a new product.

## If something goes wrong

- **Only 9 products show up:** the page fell back to its embedded seed, which
  means `/data` didn't answer. Check `STOCK_API` is set and the Worker is
  deployed.
- **HTTP 401/403 from the Worker:** the token expired or lacks Contents: Read.
  Make a new one, update the `GH_TOKEN` secret.
- **`{"error":"GET only"}` on a POST:** expected. The write half was removed on
  2026-08-23; nothing should be posting here.
- **Stock looks out of date:** that is the sync's job now, not the Worker's. The
  scheduled run flips `in_stock` every ten minutes through trading hours; if it
  has stopped, look at the Action in the sandbox repo.

## Rotating the token

If a phone goes missing or someone leaves, you don't have to touch any device.
Delete the token on GitHub, make a new one, update the `GH_TOKEN` secret in
Cloudflare. That's the whole rotation — the token was never on anyone's phone.

Note this token is separate from `PROD_PUSH_TOKEN`, the one the stock Action
uses to push. That one does have write access, and it lives in the sandbox
repo's Actions secrets, not in Cloudflare.
