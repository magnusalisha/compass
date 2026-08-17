# Turning on shared stock (one-time setup, ~10 minutes)

Compass shows the same stock for everyone because `in_stock` lives in this repo,
not on anyone's phone. But the page is **public**, so it can never hold a GitHub
token — a public page with a write token *is* a public write token.

So one tiny piece of infrastructure holds the token instead: a Cloudflare Worker
that accepts exactly one instruction, *"mark record X sold out."* It cannot
create records, delete records, or change any other field. Worst case if someone
finds the URL: stock flags get flipped, which is visible and recoverable from git.

You only do this once. No terminal — everything below is clicking in a browser.

---

## 1. Make a GitHub token (3 min)

github.com → your avatar → **Settings** → **Developer settings** →
**Personal access tokens** → **Fine-grained tokens** → **Generate new token**

- **Repository access:** Only select repositories → **compass**
- **Permissions** → Repository permissions → **Contents: Read and write**
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
| `ALLOWED_ORIGIN` | Text | `https://magnusalisha.github.io` |
| `GH_BRANCH` | Text | `main` — optional, defaults to `main` |

`GH_TOKEN` **must** be added as a Secret (encrypted, not visible afterwards).
Click **Deploy** again so the settings take effect.

`GH_BRANCH` is new as of batched writes. The worker used to write one file at a
time through the contents API, which just used the repo's default branch. A
batch has to be committed by hand — build a tree, commit it, move the branch —
and moving a branch means naming it. Leave it unset unless the default branch is
called something other than `main`. The token needs no new permission: Contents:
Read and write covers the git plumbing too.

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

"Mark sold out" now appears on every card, for everyone, on every device. One
tap. It's true for the whole shop within a minute — including whoever comes in
on the next shift.

Until `STOCK_API` is filled in, the buttons simply don't appear. Nothing breaks;
the page just doesn't offer a control that wouldn't work.

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
curl -sI "https://compass-stock.magnus-alisha.workers.dev/data?t=$(date +%s)" | grep -i x-compass
```

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
| `shape: index-fallback` | GitHub's GraphQL API refused; `x-compass-error` says why. Retry in a few minutes. |
| `shape: index-too-many` | over ~2,000 records. Raise `CHUNK` in the Worker. |
| `skipped: 1` or more | that many records were unreadable and left out — usually a hand-edit that broke a file's JSON. |
| no `x-compass-*` at all | the old Worker is still deployed. Paste again. |

### Why this exists

Before it, the Worker sent the page a *list* of records and the browser fetched
each one itself — 306 separate requests to open Compass. Cold, that measured 42
seconds, with the slowest single record taking 15. It also re-checked all 306
every five minutes on every open device, because GitHub only lets a browser
cache those files for five minutes.

The reason it was built that way is real: Cloudflare's free plan caps a Worker
at **50 subrequests per invocation**, and reading every record one-by-one needs
307. It actually broke exactly this way at 80 records. The fix is to read many
files per subrequest, which GitHub's GraphQL API can do and the REST API can't —
so it's now 1 listing + 7 bulk reads = **8 subrequests**, and one response to the
page instead of 307.

Two details worth knowing if you ever edit this part: all 306 in a single GraphQL
query does **not** work (GitHub answers 503, reproducibly — the chunking is
required), and the Worker deliberately never parses the records, it splices them
together as text, because parsing 306 records would burn CPU the free plan
budgets tightly.

## If something goes wrong

- **Buttons don't appear:** `STOCK_API` is still empty, or Pages hasn't rebuilt.
- **"Couldn't save that — origin not allowed":** `ALLOWED_ORIGIN` doesn't exactly
  match the site's origin. No trailing slash, no `/compass` path.
- **"Couldn't save that — HTTP 401/403":** the token expired or lacks
  Contents: Read and write. Make a new one, update the `GH_TOKEN` secret.
- **"record not found":** that record predates Metrc filenames, or was deleted
  or renamed since the page loaded. In a batch it's reported on its own and the
  other marks still commit — pull to refresh and the stale card goes away.
- **"read branch failed":** `GH_BRANCH` names a branch that doesn't exist.
- **"write conflict, try again":** two devices committed at the same moment. The
  worker already retries once on the new head; a second failure means genuinely
  simultaneous writes, and tapping again works.

Nothing is ever lost either way — every change is a normal git commit, so
`git log` shows exactly what happened and anything can be reverted. A batch is a
single commit, so `git show` on it lists every record that moved at once.

## Rotating the token

If a phone goes missing or someone leaves, you don't have to touch any device.
Delete the token on GitHub, make a new one, update the `GH_TOKEN` secret in
Cloudflare. That's the whole rotation — the token was never on anyone's phone.
