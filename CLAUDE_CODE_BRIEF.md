# Brief: Compass

Paste this whole file into Claude Code as your first message, with `index.html`,
`products.json`, and `parse.py` in the working directory.

---

## What this is

A personal tool for a budtender. Customers ask "what's the difference between these
two sativas from the same brand?" and the honest answer today is a shrug. Every
product has a QR code linking to its lab COA, which lists terpenes. This tool captures
those terpene profiles and puts a **one-sentence difference** in my hand while a
customer is standing in front of me.

Scale: ~50–150 products on shelf at a time. Single user. Phone-first.

## Architecture (already decided — don't redesign it)

- **Capture:** an iOS Shortcut. I scan the QR, share the URL to the Shortcut, it
  fetches the COA, sends it to the Claude API for extraction, and writes one JSON
  file per product to `data/` in a GitHub repo. No laptop involved.
- **Storage:** flat JSON files in the repo. **One file per product** — never one big
  appended file (read-modify-write is painful in Shortcuts and corrupts on overlap).
  Git gives me history, sync, and hand-editing from my phone for free.
- **Read:** `compass.html` on GitHub Pages (rename to `index.html` at the repo root).
  Three modes: **Match by effect** (free text — "relaxing but not sleepy"), **Find similar**
  (cosine over the terpene vector), **Compare** (mirrored side-by-side).

No database. No backend. No build step. At this scale they'd be pure overhead.

## Tasks

1. Create a public repo, e.g. `compass`. Public matters: the page reads the data
   files unauthenticated from the browser.
2. Commit `compass.html` as `index.html` at root and the 9 seed records from `products.json` as
   individual files at `data/<id>.json`.
3. In the page, set `GH_USER` and `GH_REPO` at the top of the script. The page
   then lists `data/` via the GitHub API and loads every record, falling back to the
   embedded seed if that fails.
4. Enable GitHub Pages (main branch, root). Give me the URL.
5. Sanity-check on a phone viewport: search, select two, read the verdict, deselect.

## Schema — this is the contract

Both the Shortcut's extraction prompt and the page depend on this. Don't drift.

```json
{
  "id": "b413a3544f",
  "brand": "Rolling Green",
  "strain": "Georgia Haze",
  "form": "Flower 3.5g",
  "batch": "GH43026",
  "thc": 31.51,
  "total_terpenes": 1.53,
  "lean": "settling",
  "balance": -0.73,
  "confidence": "strong",
  "note": null,
  "in_stock": true,
  "shelf_tag": "Unverified",
  "reported": ["heavy and relaxed", "calm in the body"],
  "dominant": ["beta-Myrcene", "beta-Caryophyllene", "alpha-Humulene"],
  "aroma": ["earthy", "musky", "mango", "pepper", "spice"],
  "terpenes": { "beta-Myrcene": 0.74, "beta-Caryophyllene": 0.28 }
}
```

Normalization rules, learned the hard way from three different NY labs:

- **Units are always % w/w.** Some labs (DRS/Confident) also print mg/g — that's just
  %×10. Ignore it, or divide by 10.
- **Non-detects are `0`.** Labs write this as `ND`, `< MRL`, `<0.0400`, or `NR`.
- **Names are canonical.** `β-Pinene`, `beta-Pinene`, and `B-PINENE` are one terpene.
  `FENCHYL ALCOHOL` = `Fenchol`. `ALPHA TERPINEOL` = `Terpineol`. Use the canonical
  vocabulary in `parse.py`.
- **`dominant`** = the three highest terpenes, descending.
- **`terpenes`** contains detected ones only (>0), sorted descending.

`parse.py` is a working reference implementation of all of this, validated against
Kaycha, Green Analytics, and DRS/Confident COAs. **It is not part of the running
system** — extraction happens in the Shortcut via the API. Keep it in the repo as
documentation of the rules and as a way to re-parse a batch of PDFs on a laptop if I
ever need to.

## The archive is the product — this is the most important section

Two real questions from the counter, and they're the same question:

- "What were the effects of that thing I bought last month?" (we no longer carry it)
- "I loved X, you're out of it, what's close?"

Both are answerable **only if records are never deleted.** When a product leaves the
shelf, set `in_stock: false`. Never remove the file. The archive is what makes this
tool better than any strain website — strain names aren't standardized, so "Blue Dream"
from two growers is chemically two different products. A generic strain database can't
tell you what *this shop* sold someone in March. This can.

`Find what's closest` ranks by **cosine similarity over the normalized terpene vector**
(composition, not absolute amount — the same chemovar at different strengths should
still match). It searches everything but only *recommends* what's `in_stock`. Below a
0.5 match it refuses to recommend and says nothing is close, which is the honest answer
and a better sales moment than a bad substitution.

**Stock toggling** happens in `localStorage`, on the device. Product data comes from the
repo; which of it is on the shelf today is a local overlay. This is deliberate: the page
must NEVER hold a GitHub write token, because a public page with a write token is a public
write token. (The earlier build showed "Couldn't save" only because it ran in a sandbox
that blocks storage — on real hosting it works. The page degrades gracefully either way.)

## shelf_tag — the only field a human types, and it must stay that way

`shelf_tag` (Sativa / Indica / Hybrid / Unverified) is what the **package** says. It does
not appear on a COA. It is therefore the one field the extraction step must NEVER fill in.

This is not fussiness. The whole point of storing it is to compare marketing against
chemistry — "the shelf says sativa, the terps say settling." If a model guesses the tag,
that comparison measures nothing but the guess. A build that inferred this field silently
defaulted two sativa-labelled prerolls to "Hybrid," which would have quietly destroyed the
most valuable question this tool can ask.

So: extraction sets `shelf_tag: "Unverified"`, always. The UI offers a dropdown. Only a
human standing in front of the package sets it. Anything Unverified is excluded from any
label-vs-chemistry analysis.

## Non-negotiables in the copy

The effect language is in the **reporting register** — "people usually describe this as
heavy and relaxed." Never "eases tension and discomfort," "helps with," "relieves," or any
condition name. An earlier build used that phrasing; it is exactly what NY treats as an
enforcement matter.

`Match by effect` refuses outright on medical words (anxiety, pain, insomnia, depression…)
and asks the user to describe a feeling instead. Keep that guard.

Faint-profile products are score-penalized in effect matching and get no confident read in
Compare. A faded preroll must never win a recommendation on the strength of the terpenes
that merely survived.

## Also want, eventually

- Filtering by form (preroll vs flower vs vape).
- Sorting by a chosen terpene ("show me everything terpinolene-forward").
- Vendor quality view: average total terpenes by brand over time.

## The effects language — read this before you touch any copy

New York prohibits claims that a product treats, cures, or prevents anything. It is an
enforcement matter, not a style preference.

So the tool speaks in the **reporting register**: "people usually describe this one as
heady and alert." That is an observation about how customers talk, not a pharmacological
claim, and it is the same register every strain database lives in.

- `lean` is computed from the terpene profile: terpinolene/limonene/pinene/ocimene push
  "lifting"; myrcene/linalool/caryophyllene/humulene push "settling"; anything in
  between is "mixed." See `lean()` in `parse.py`.
- `confidence` is the honesty valve. Caryophyllene and humulene are heavy
  sesquiterpenes; myrcene, limonene, pinene and terpinolene are volatile monoterpenes
  that evaporate through drying, grinding and shelf time. So a faded product looks
  sesquiterpene-dominant no matter what strain went into it — and a naive model calls
  that "settling." When total terps are under 0.8% and mostly sesquiterpenes, the tool
  says **"trust the package label, not this profile."** Do not optimize this away; it is
  the difference between a tool that's right and a tool that's confidently wrong.
- `thc` matters more than any terpene for how a product actually lands. Terpenes shape
  the character; dose decides the intensity. The verdict says both.
- Every verdict carries the "not a medical claim" line. **Do not remove it.**

Never write: cures, treats, helps with, relieves, for anxiety/pain/sleep, medicinal.
Always write: people describe, customers report, usually reads as, tends to be.
