# Build guide

Start to finish. Roughly **90 minutes**, most of it in step 5.

You need: a laptop, your iPhone, a GitHub account, an Anthropic API key.

---

## 1. Get the files onto your laptop (5 min)

Download all five into one folder — call it `compass/`:

```
compass/
  compass.html          ← the app (becomes index.html in step 3)
  products.json         ← your 9 real products, parsed
  parse.py              ← reference implementation of the normalisation rules
  CLAUDE_CODE_BRIEF.md  ← the spec
  SHORTCUT.md           ← the iOS half
```

---

## 2. Get your two keys (10 min)

**Anthropic API key** — console.anthropic.com → API Keys → Create Key. Copy it
somewhere safe; you only see it once. Add ~$5 of credit. That's enough for well over
150 COAs.

**GitHub token** — github.com → Settings → Developer settings → Personal access tokens
→ **Fine-grained tokens** → Generate new token.
- Repository access: **Only select repositories** → the one you're about to make
- Permissions → Repository permissions → **Contents: Read and write**
- Nothing else. Not "all repositories." Not admin.

You can't select a repo that doesn't exist yet, so either make the empty repo first at
github.com/new (public, name it whatever), or do this after step 3.

---

## 3. Claude Code does the repo and the site (20 min)

In your terminal:

```bash
cd compass
claude
```

Then paste this, exactly:

> Read CLAUDE_CODE_BRIEF.md. It's the spec for this project — follow it, don't redesign it.
>
> Do these things:
> 1. Create a public GitHub repo called `compass` and push to it.
> 2. Rename `compass.html` to `index.html` at the repo root.
> 3. Split `products.json` into one file per product at `data/<id>.json`, using each
>    record's own `id` field as the filename. Add `"shelf_tag": "Unverified"` to every
>    record. Do NOT guess Sativa/Indica/Hybrid — read the brief on why.
> 4. In `index.html`, set `GH_USER` and `GH_REPO` at the top of the script.
> 5. Keep `parse.py` and both .md files in the repo as documentation.
> 6. Enable GitHub Pages (main branch, root) and give me the live URL.
>
> Then confirm: open the Pages URL, verify all 9 products load from `data/` and not
> from the embedded seed, and verify the two Honey prerolls show the faint-terpene
> warning instead of a confident read.

**What it can't do:** enable Pages through the web UI on its own if you haven't
authorised `gh`. If it stalls, run `gh auth login` once and re-ask.

**Check before moving on:** the live URL loads on your phone, shows 9 products, and
comparing the two Honey prerolls gives you the "can't call this from the terpenes"
warning — not a confident read. If it gives a confident read, the seed didn't carry the
`confidence` field. Tell Claude Code that.

---

## 4. Add it to your home screen (2 min)

Open the Pages URL in Safari → Share → **Add to Home Screen**. It'll behave like an
app. This is the thing you open at the counter.

---

## 5. Build the Shortcut (45 min, and it will fight you)

Follow `SHORTCUT.md` action by action. This is the only part nothing can do for you —
Apple only allows signed shortcuts to be shared, so it's hand-assembly.

Budget for the first run to fail. The two things that go wrong:

- **Bad JSON in the request body.** Add a `Quick Look` action right after the API call;
  the error comes back as readable JSON.
- **The GitHub PUT 404s.** Almost always the token lacks Contents: write, or the repo
  path in the URL is wrong.

**Test it on a COA you already have.** Scan one of the Rolling Green jars. If a new file
lands in `data/` and the product appears on the site after a refresh, you're done.

---

## 6. Set the shelf tags (15 min, on shift)

Nine products, nine packages. Read each label, set Sativa/Indica/Hybrid by hand. This is
the only field a human must type, and it's the one that makes the whole
label-vs-chemistry question answerable.

---

## 7. Then just scan (forever)

Every product that comes in. Especially the ones about to sell out — those are the ones
a customer will ask about in six weeks when you no longer have them.

---

## What to watch for once it's live

- **Does the "faint" flag fire on stuff your nose says is fine?** If so my 0.8% threshold
  is too high and we move it. That number came from nine products, not from evidence.
- **How often does the chemistry disagree with the shelf tag?** This is the real question.
  You now have the two columns to answer it.
- **Average total terpenes by brand.** After a month, this is a purchasing argument.

---

## Fixing a bad record

Open the repo on your phone, tap `data/<id>.json`, hit the pencil, edit, commit. It's
plain JSON. This is exactly why there's no database.
