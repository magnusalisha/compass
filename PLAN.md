# Next up: four honesty fixes

Written 2026-07-29. Everything below is committed and live except these four
changes. Nothing here is urgent — the tool works and staff can use it. All four
are the same species of problem: **the card claims slightly more than the data
earns.** None of them change which products appear in search results.

Do them one at a time. **1 and 2 together** (same function neighbourhood).

---

## 1. `lean` is a guess, not arithmetic — derive it in the page

**The problem.** `lean` (`lifting` / `settling` / `mixed`) is not computed. It's
an instruction in the capture prompt in `compass-capture.js`:

> `lean: terpinolene, limonene, pinene, ocimene push lifting. myrcene, linalool,
> caryophyllene, humulene, bisabolol push settling. Close to even is mixed.`

No formula, no threshold, and the model decides fresh each time. Consequences
measured against the real data:

- **5 of 180 records are unambiguously wrong** — one side is ≥2× the other and
  the stored value says the opposite. All five err the SAME direction
  (settle-dominant, stored as `lifting`): Piescream (2.71×), Blue Dream (2.54×),
  Mixed Sativa (2.50×), Chermoya (2.06×), ChemD x I95 (2.03×).
- **It isn't reproducible.** Two Blue Dream (Untitled) records — total terpenes
  1.46 vs 1.45, myrcene 0.70 vs 0.75, otherwise the same profile — are stored as
  `mixed` and `lifting` respectively. Same product, same chemistry, two answers.
- **Two settling terpenes are missing from the prompt.** The page treats
  `Farnesene` and `Terpineol` as settling (see `CHAR`); the capture prompt never
  mentions either, so the settle side is systematically under-counted. That
  matches the direction of all five errors. On Lemon Fresh, farnesene (0.3195%)
  is the THIRD-largest terpene and the prompt gave no guidance on it.

**The fix.** Compute `lean` in `index.html` from `p.terpenes` using `CHAR` —
which is already the single source of truth for direction, and what `says()`
uses for every word it writes. Deriving lean from the same table makes the read
and the direction consistent *by construction*: they cannot disagree, because
they are the same computation.

Suggested shape (threshold is a judgment call — 1.5× was used in analysis, but
2× is more conservative and only reclassifies the clear cases):

```js
const leanOf = p => {
  let lift = 0, settle = 0;
  for (const [k, v] of Object.entries(p.terpenes || {})){
    if (!CHAR[k] || !(v > 0)) continue;
    CHAR[k][2] === 'lift' ? lift += v : settle += v;
  }
  if (!lift && !settle) return null;          // no readable profile
  if (settle >= lift * T) return 'settling';
  if (lift >= settle * T) return 'lifting';
  return 'mixed';
};
```

**PRECEDENT — this pattern already exists in the file.** `domTerps` deliberately
ignores the stored `dominant` field for exactly this reason:

> `// The dominant terpenes derived from the ACTUAL measured values, sorted — not`
> `// the stored 'dominant' field, which occasionally disagreed with the numbers.`

This is the same move, second time. No change to the phone script is required —
the capture script keeps writing `lean` and the page simply stops trusting it.

**BLAST RADIUS — bigger than the other three. Check all of it.**
`lean` currently feeds three things:
1. `says()` — the read's direction (`dir`)
2. `filterLean()` — the Sativa/Indica/Hybrid dropdown (via `LEAN_OF`)
3. `labelCheck()` — the shelf-says-vs-terps-read verdict, including the ⚠ clash

So some products WILL change category and some clash warnings will appear or
disappear. That's a product decision, not just a bug fix. Re-run the counts in
"how to verify" below before and after.

**Also worth doing (optional, needs a phone edit):** add Farnesene and Terpineol
to the capture prompt's lean list. Moot for `lean` once the page computes it, but
the prompt is also what picks `dominant` and `confidence`.

**Untested hypothesis worth checking:** two of the five bad records are
"Mixed Sativa" and "Blue Dream" — names that suggest sativa. If the capture model
is reading strain NAMES into a chemistry field, that inverts the entire premise
of the tool. n=5 is too small to conclude anything; test it deliberately.

**Stale comment to fix:** `index.html` says the direction comes from "the careful
whole-profile calc". There is no calc. That comment misled me for an hour.

---

## 2. "in equal measure" is asserted without checking the ratio

**The problem.** In `says()`, the non-mixed branch checks the ratio before
calling something an undertone (`leadPair[1] / opp[1] <= 5`). The **mixed branch
checks nothing** — it just says "X and Y in equal measure" whenever
`lean === 'mixed'`.

**13 of 32** mixed records make that claim when the lead terpene is more than
1.75× the opposing one. Worst offenders:

| Record | Ratio | |
|---|---|---|
| PuffinZ | 5.14× | myrcene over terpinolene |
| Uptown Haze | 4.63× | myrcene over ocimene |
| Jack Herer | 3.17× | caryophyllene over terpinolene |
| Durban Poison - Pack | 3.00× | linalool over limonene |
| Blue Dream | 2.92× | myrcene over pinene |
| Lemon Fresh | 2.43× | caryophyllene over terpinolene |

**The fix.** Only say "in equal measure" when the two are actually close (~1.5×
or under). Otherwise fall through to the lead-with-undertone phrasing the
non-mixed branch already produces.

Note fix 1 partly fixes this for free: several of these stop being `mixed` once
lean is computed.

---

## 3. The evidence badge almost always reads 3-of-3

**The problem.** `ev()` returns the **MAX** evidence tier of the top three
terpenes. Caryophyllene is the only tier-3 entry and it's in the top three of
**83% of records**, so it grants the top badge from third place.

- **150 of 180 (83%) show ●●● "real mechanism."** The badge is nearly a constant.
- **70 of 180 display a higher badge than their LEADING terpene earns.** e.g.
  OG Kush leads with myrcene (folklore, tier 1) and shows ●●● real mechanism.

The read is written from the dominant terpene; the badge was reporting the
best-evidenced terpene present. Two lines apart, the card says "here's a myrcene
story" and "this rests on a real receptor mechanism" — and the mechanism belongs
to a different molecule sitting in third place.

**The fix — grade the LEADING terpene**, not the max. Distribution across 180:

| Method | ●○○ | ●●○ | ●●● |
|---|---|---|---|
| now (max of top 3) | 12 | 18 | **150** |
| **lead terpene** ← recommended | 49 | 42 | 89 |
| weighted by amount | 38 | **134** | 8 |

Lead-terpene gives the widest honest spread and the cleanest rationale. Weighting
by amount was tested and **rejected**: averaging drags everything to the middle,
so 74% become ●●○ — one meaningless constant swapped for another.

This does NOT cynically downgrade everything: the 89 still at ●●● genuinely lead
with caryophyllene, which genuinely has a receptor mechanism (Gertsch 2008).
Only the 70 borrowing credit from third place change.

**Optional and recommended:** name the driver — `●○○ folklore — leans on
myrcene`. Makes the badge checkable, teaches staff the chemistry, and it sits
directly above the WHY? panel that explains that same terpene.

**Blast radius: one line.** `ev()` is defined once and used in exactly one place
(the badge). It never touches scoring, sorting, ranking, or similarity. Verified
by grep. Do NOT change the tiers in `REPORTED` — those are correct as written.

---

## 4. The read never mentions THC

**The problem.** The footer already says THC is "the one number on the COA that
reliably drives the experience" — and that's right. But `says()` is purely
terpene-based. Within a single group of 17 products sharing the same terpene
ranking, THC ranged **15.5% to 75.6%** and every one got an identical read.

Lemon Fresh is the clean example: a **37.7% THC infused 1g preroll**. That is the
single most decision-relevant fact about it, and the read says nothing. A
customer used to 20% flower needs to hear that far more than any terpene note.

**The fix.** Surface THC in the single-card read, the way `matchNote()` already
does in Find similar and `read()` does in Compare. Keep it factual — a strength
note, not an effect claim.

---

## How to verify (no browser needed)

The pattern that worked all day: extract the page's OWN functions and run them
against the real data, so the test can't drift from what actually ships.

```js
const html = fs.readFileSync('index.html','utf8');
const ctx = {};
new Function('ctx', html.match(/const CHAR = \{[\s\S]*?\n\};/)[0] + '\nctx.CHAR=CHAR;')(ctx);
```

Then reconcile against every file in `data/`. Before-and-after counts to record:

- `lean` distribution (`settling` / `lifting` / `mixed`)
- type-dropdown counts per category — Preroll+Sativa was **2 → 17** after the
  earlier `filterLean` fix; don't regress it
- how many records show a label-vs-chemistry ⚠ clash (was 26)
- badge distribution (see table in §3)
- how many "in equal measure" claims survive

Syntax gate, since `node --check` can't read HTML:

```bash
sed -n '/<script>/,/<\/script>/p' index.html | sed '1d;$d' > /tmp/c.js && node --check /tmp/c.js
```

## Facts worth not re-deriving

- **Capture accuracy is excellent.** Every figure on the Lemon Fresh COA matched
  the stored record exactly (THC 37.705, caryophyllene 0.84, terpinolene 0.3455,
  humulene 0.2598, limonene 0.2413, myrcene 0.1366). The extraction pipeline is
  not the problem — the interpretation layer is.
- **No re-scanning needed** for any of these four. The terpene numbers are right;
  only the reading of them changes. All 180 records update the moment the page
  does.
- **No phone-script change needed** for any of the four.
- **Prerolls are structurally faint**: 48% vs 11% of flower and 3% of vapes. The
  volatiles that evaporate first (limonene, terpinolene, pinene) are exactly the
  ones that mean "lifting", so degraded prerolls read "settling" almost
  mechanically. This is why `filterLean()` defers to the package when the profile
  is faint. Don't undo that.
- **Kaycha COAs DO report CBN and THCV** (0.5853% and 0.2903% on one sampled
  COA); the capture script just doesn't extract them. So a cannabinoid-weighted
  model is *possible* — but "CBN is sedating" traces to a tiny 1975 study and is
  more poorly evidenced than the terpene folklore it would claim to improve on.
  Don't add cannabinoid effect claims without much better evidence.
- **Four records use non-canonical terpene names** the page silently ignores:
  `trans-Caryophyllene` (chemically identical to beta-caryophyllene),
  `D-Limonene`, `trans-b-Ocimene`. Changes zero reads today, but a lab switching
  to those names would produce a card whose read omits its dominant terpene.
  Worth normalising at capture time.
- **Do not adopt** these, for the record: cannabinoid-based effect weighting,
  matching on "anxiety" (the medical guard is deliberate and regulatory), or
  confident outcome tags that drop the hedging. The hedging is the product.

## Rebuilding the demo

`node build-demo.js` — regenerates `demo/` (gitignored) from current `index.html`
plus `data/`. Drag the folder onto app.netlify.com/drop to update terp-compass.
The script fails loud if anything identifying survives. The demo is a frozen
snapshot on purpose and does not update itself; re-run it after these fixes.
