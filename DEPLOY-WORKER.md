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

## 3. Add the four settings (3 min)

In the Worker → **Settings** → **Variables and Secrets**:

| Name | Type | Value |
|---|---|---|
| `GH_TOKEN` | **Secret** | the token from step 1 |
| `GH_USER` | Text | `magnusalisha` |
| `GH_REPO` | Text | `compass` |
| `ALLOWED_ORIGIN` | Text | `https://magnusalisha.github.io` |

`GH_TOKEN` **must** be added as a Secret (encrypted, not visible afterwards).
Click **Deploy** again so the settings take effect.

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

## If something goes wrong

- **Buttons don't appear:** `STOCK_API` is still empty, or Pages hasn't rebuilt.
- **"Couldn't save that — origin not allowed":** `ALLOWED_ORIGIN` doesn't exactly
  match the site's origin. No trailing slash, no `/compass` path.
- **"Couldn't save that — HTTP 401/403":** the token expired or lacks
  Contents: Read and write. Make a new one, update the `GH_TOKEN` secret.
- **"record not found":** that record predates Metrc filenames, or was renamed.

Nothing is ever lost either way — every change is a normal git commit, so
`git log` shows exactly what happened and anything can be reverted.

## Rotating the token

If a phone goes missing or someone leaves, you don't have to touch any device.
Delete the token on GitHub, make a new one, update the `GH_TOKEN` secret in
Cloudflare. That's the whole rotation — the token was never on anyone's phone.
