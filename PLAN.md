# Next up: four honesty fixes

Written 2026-07-29. Everything below is committed and live except these four
changes. Nothing here is urgent — the tool works and staff can use it. All four
are the same species of problem: **the card claims slightly more than the data
earns.** None of them change which products appear in search results.

Do them one at a time. **1 and 2 together** (same function neighbourhood).

> **Superseded. See "Session 2 — 2026-08-01/02" at the end** for everything
> shipped since, including three crash-class bugs and a filename fallback that
> could silently destroy a record. The status note below covers the original
> four fixes only.
>
> **Status 2026-07-30 — this plan is closed.** Fixes 2, 3 and 4 shipped. Fix 1
> was tried and REVERTED the same day; the prescription in §1 does not work and
> the reason is worth reading before anyone touches `lean` again ("§1 was wrong",
> below). Four changes NOT in this plan also shipped, all downstream of the §1
> audit: the type dropdown now filters on the package; the read no longer uses
> `lean` at all; the chips carry plain-English words; and the shelf-vs-chemistry
> verdict line and its ⚠ warning were removed. See "Closing out" at the end.

---

## 1. `lean` is a guess, not arithmetic — derive it in the page ❌ TRIED, REVERTED

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

## 2. "in equal measure" is asserted without checking the ratio ✅ DONE

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

## 3. The evidence badge almost always reads 3-of-3 ✅ DONE

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

## 4. The read never mentions THC ✅ DONE

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

## §1 was wrong — what happened, 2026-07-30

`leanOf()` was implemented exactly as §1 specifies, wired into all four consumers
(`says`, `filterLean`, `labelCheck`, **and `compareText`, which §1's blast-radius
list missed**), verified, and reverted the same day. Fix 2 was kept; it is
independent and needs no direction model.

**The diagnosis in §1 is still correct.** The stored `lean` IS a model guess, it
IS unreproducible (the two Blue Dream records), and those five records ARE wrong.
**The prescribed remedy is what fails.** Summing `CHAR` by direction does not
measure direction:

- **The settle side is never zero** — 0 of 176 readable profiles — while the lift
  side is zero in 17. Median settle:lift across the whole inventory is **2.76×**.
  A 2× threshold therefore calls the *average* product settling. The classifier
  was returning the baseline, not a reading. No threshold repairs this: Flower +
  Sativa lands at 7 (T=2), 9 (T=1.5), 10 (T=1.25) against 22 sativa packages
  actually in the case.
- **beta-Caryophyllene cannot carry a direction.** It is in 165 of 177 profiles
  and *leads* 89 of them; among those leaders the package says **Sativa 29 /
  Indica 18**. A variable present in nearly everything discriminates nothing.
  Its `settle` classification is also doubtful on the merits: `REPORTED` here
  already records it as a selective **CB2** agonist (Gertsch 2008) — peripheral,
  anti-inflammatory — and describes it as "body calm, eases tension." That is not
  the same axis as myrcene's "heavy, sedating, couch-leaning," yet the sum adds
  them as if it were. "Calm in the body" ≠ "low energy."
- **No terpene in `CHAR` marks lift in this data.** Median in sativa-labelled vs
  indica-labelled product: Limonene 0.73× (*higher* in indica), beta-Pinene
  0.60×, Terpinolene and Ocimene median 0.000 in both. The lift side isn't merely
  outweighed — its terpenes are largely absent from this inventory.

**The number that settles it.** Agreement with the package on 79 non-faint
sativa/indica records (the tool wants *some* disagreement — that's the mislabel
detector — but only as an informative minority):

| direction source | agrees | contradicts | agreement |
|---|---|---|---|
| stored `lean` (current) | 37 | 25 | **60%** |
| derived raw sum | 28 | 28 | **50% — a coin flip** |
| share-of-profile vs typical | 34 | 25 | 58% |
| baseline-corrected ratio | 22 | 15 | 59% |

**The methodological lesson, which is the real takeaway.** §1's argument was that
deriving `lean` from `CHAR` makes the read and the verdict consistent *by
construction*. That is true and it is worthless as evidence: two outputs of one
computation always agree, including when the computation is noise. The verify
recipe below inherits the same blind spot — every metric in it is internal to the
page. **Any future change to `lean` must be scored against something outside the
page** (the package labels, or staff/customer feedback), not merely against
self-consistency.

**If you pick this up again**, the options that are not already ruled out:
1. **Leave it.** 60% beats everything tried. The field's real defects are narrow.
2. **Veto, don't replace.** Keep the stored field; override only where it flatly
   contradicts a ratio well above the 2.76× baseline. Fixes the five bad records
   without touching the other 175. Smallest honest change.
3. **Fix the axis, then rederive.** Caryophyllene (and arguably humulene) belong
   on a body/tension axis, not the lift/settle one. Reclassifying them in `CHAR`
   changes `says()`'s wording everywhere, so it's a copy project, not a one-liner.
4. **Correct the five records in `data/` by hand** and leave the code alone.

Do NOT re-derive by raw sum. Do not re-add a threshold without first checking it
against the 2.76× baseline.

### Audit of all 12 `CHAR` directions (2026-07-30)

Caryophyllene was not the only questionable one, so every terpene was tested the
same way: share-of-profile in sativa-labelled vs indica-labelled non-faint records
(n=48/31), AUC with a permutation test, **one-tailed in the direction `CHAR`
already claims** — the most generous fair test.

| terpene | claims | AUC | p (1-tail) |
|---|---|---|---|
| Terpineol | settle | 0.371 | 0.023 |
| Ocimene | lift | 0.604 | 0.033 |
| Terpinolene | lift | 0.601 | 0.036 |
| Linalool | settle | 0.380 | 0.037 |
| Farnesene | settle | 0.439 | 0.157 |
| alpha-Bisabolol | settle | 0.447 | 0.203 |
| beta-Caryophyllene | settle | 0.446 | 0.211 |
| alpha-Humulene | settle | 0.461 | 0.282 |
| beta-Myrcene | settle | 0.498 | 0.486 |
| alpha-Pinene | lift | 0.500 | 0.500 |
| beta-Pinene | lift | 0.447 | 0.787 |
| Limonene | lift | 0.371 | **0.972 — runs backwards** |

**Nothing survives correction for 12 tests** (needs p < 0.0042). Myrcene, the most
famous "indica" terpene in the building, is AUC 0.498 — a coin flip. Limonene is
decisively *higher* in indica-labelled product here.

**The four nominal hits are noise.** Learning each terpene's direction on a random
half and predicting the other half, over 400 splits: **45.7% held-out accuracy,
against 60.8% for always guessing "sativa."** A model built this way does worse
than a constant. There is no per-product directional signal to find.

**What this does and does not show.** It is scored against package labels, which
are themselves unreliable — so it cannot separate "labels are noise" from "the
mapping doesn't exist." Either way `lean` has nothing to stand on. It does NOT
show terpenes are meaningless: the published chemovar work finds terpene profiles
cluster reliably, just **not along the sativa/indica axis**
([PLOS One 2022](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0267498),
[Nature Plants 2021](https://www.nature.com/articles/s41477-021-01003-y)). Our
data reproduces the published null exactly.

**The uncomfortable implication.** The tool's premise — ignore the strain name,
read the profile — is well supported. `lean` then converts the profile *back into*
the sativa/indica axis, which is the one thing the literature says the profile
does not predict. The dropdown re-creates the category the tool exists to get past.

### Terpenes are not independent variables (bears on "entourage")

Pearson r on share-of-profile, 176 readable records:

- beta-Caryophyllene ~ alpha-Humulene **r=+0.34** — same synthase, effectively
  inseparable. Together they are a median **52% of the entire settle side.**
- beta-Myrcene ~ beta-Caryophyllene **r=−0.46** — two `settle` terpenes that move
  *opposite* each other. The settle side is not one construct.
- alpha-Pinene ~ beta-Myrcene **r=+0.35** — opposite `CHAR` directions, rising
  together.

No observational dataset can attribute an effect to a single terpene when they
travel in bundles like this. And a weighted sum is an *additive* model: if
entourage effects are real, they are interactions, which is precisely what a sum
cannot represent. "Entourage" is therefore an argument against additive terpene
scoring, not a route to a better one.

## What landed for fix 2 (2026-07-30)

`says()` gained `EVEN_T = 1.5` and a shared `undertone()` helper. The mixed
branch now checks the top two against each other before claiming they're even;
when they aren't, it falls through to the same lead-with-undertone phrasing the
directional branch has always produced.

One trap: the mixed branch cannot simply fall through as §2 suggests. With
`dir === 'mixed'`, the existing `opp` lookup (`CHAR[k][2] !== dir`) matches
`ranked[0]` itself, so the lead would be framed as its own undertone. The helper
takes the top terpene's own direction explicitly instead.

Measured across all 180 records:

| | before | after |
|---|---|---|
| "in equal measure" claims | 29 | 14 |
| …of those, skewed >1.75x | **13** | **0** |

Nothing else moved: lean distribution, type-dropdown counts (Flower 28/24/12,
Preroll 17/30/11, Vape 17/8/5), clash count (27) and badge distribution are all
byte-identical to the pre-change baseline. Fix 2 changes wording only, never
which products appear — unlike fix 1, where the header's "none of them change
which products appear in search results" turned out to be badly wrong.

Sample rewordings:

- PuffinZ — "heavy and heady in equal measure" (5.14x) → "heavy and relaxed"
- Lemon Fresh — "calm and heady in equal measure" → "body-calm, with a heady lift on top"
- Durban Poison - Pack — "mellow and upbeat in equal measure" → "mellow and soft, with an upbeat lift on top"

## The dropdown now reads the package (2026-07-30, not in the original plan)

`filterLean()` used to answer the Sativa/Indica/Hybrid dropdown from chemistry
wherever the profile was readable, falling back to the package only when faint.
It now always answers from the package. This followed directly from the §1 audit:
the chemistry does not carry a directional claim, so the dropdown was sorting the
case by a quantity nobody has shown to exist, in preference to the one claim a
human actually read off the box.

In-stock counts now match the shelf exactly, which is the point:

| | dropdown S/I/H | packages actually in the case |
|---|---|---|
| Flower | 25/15/24 | Sativa 22 +3 leaning · Indica 13 +2 leaning · Hybrid 24 |
| Preroll | 27/15/16 | Sativa 22 +5 leaning · Indica 12 +3 leaning · Hybrid 16 |
| Vape | 14/8/8 | Sativa 13 +1 leaning · Indica 8 · Hybrid 8 |

**The mislabel detector is untouched.** `labelCheck()` still holds the package
against the chemistry, still raises the ⚠ clash on the card, and the count is
unchanged at 27. Disagreement is worth showing a budtender; it just isn't worth
silently sorting on. Unverified still matches no type (0 in-stock records affected).

This does contradict "Deliberately NOT filtering on shelf_tag" in
CLAUDE_CODE_BRIEF.md — decided knowingly, on the numbers in §1.

## What landed for fixes 3 and 4 (2026-07-30)

**Fix 3.** `ev()` grades `domTerps(p)[0]`, the leading terpene, instead of the max
of the top three. Distribution moved **12/18/150 → 49/42/89**, matching §3's
prediction exactly, and **70 records stopped claiming a tier borrowed from 2nd or
3rd place** — also exactly as predicted. Took §3's optional recommendation and
named the driver via a new `evWord()`, so OG Kush now reads `●○○ evidence ·
folklore — leans on myrcene, trust your nose over this`, checkable against the
chips directly above it and the WHY? panel directly below.

**Fix 4.** New `thcNote()` renders a strength line at the top of the read.
Banded against **this shop's own per-category distribution** rather than invented
absolute thresholds, because the categories aren't comparable (median THC: flower
27.6%, preroll 30.3%, vape 86.7%). Percentile rather than a point gap, for the
same reason — vapes span 71–94% and flower 19–51%, so "+8 points" is not one
thing. Bands land 20/35/72/35/17 across lightest→strongest, so it is not another
near-constant like the old badge was.

Lemon Fresh, §4's example case, now opens with:
`Strength: 37.7% THC — on the strong side for prerolls here (typical is 30.7%).`

It also renders on **no-profile records**, where it is the only chemistry there is
— an OG Kush cart with cannabinoids only now leads with `90.4% THC — on the strong
side for vapes here` instead of saying nothing.

The peer distribution is cached against the `DATA` array by identity. `DATA` is
reassigned (not mutated) on load and after stock writes, so the cache invalidates
exactly when the numbers change.

**Also:** THC figures are now printed to one decimal everywhere (`thc1()`). COAs
report 37.705 / 15.5366; two of those in one sentence is unreadable. Comparisons
still run on the stored value.

## Closing out — the read, the chips, the verdict line (2026-07-30)

Three last changes, all following from the §1 audit rather than from this plan.

**The read stopped consulting `lean`.** `says()` now leads with the biggest
measured terpene, full stop. It used to pick a direction from `lean` and then
lead with the strongest terpene pointing that way, which let the sentence lead
with a terpene that wasn't the biggest on the card — Mountain Girl read "heady and
alert" off 2.41% myrcene, the largest single terpene reading in the inventory,
with the chips saying so directly above. Eight records did that; now none do.
`EVEN_T` went 1.5 → **1.25**, because once direction stopped choosing the lead,
"in equal measure" jumped from 14 cards to 43. It lands on 26. (Measured: 1.15x →
12, 1.35x → 32, 1.5x → 43.) `Compare` was moved onto the same test via `netDir()`,
so it can't announce "opposite directions" over two reads that lead the same way.

**"heady" became "buzzy"** in `CHAR`. Heady is trade vernacular whose everyday
meaning is *intoxicating* — a strength claim, competing with the THC figure
printed directly above it — and it sat one letter from "heavy", its own opposite,
in the same sentence on 10 cards ("heavy and heady in equal measure"). Buzzy was
already terpinolene's own descriptor in `REPORTED`. 17 cards reworded, 0
collisions left. `REPORTED` still says "heady, alert, buzzy" in the WHY? panel;
that's the one surviving instance and it never sits next to "heavy".

**Chips carry their plain word:** `caryophyllene 1.19% · calm`. Nobody behind the
counter has twelve terpenes memorised, and the card named three molecules in the
chips while putting their meaning in a sentence below, where you can't tell which
word belongs to which. Same word `CHAR` gives the read, so chips and sentence
teach each other. No new lines. It also repairs the evidence line, which names a
molecule the chips have now already translated.

**The verdict line and the ⚠ clash warning are GONE**, along with `labelCheck()`.
This was the tool's signature feature, so the reasoning is in the code where the
function used to be, and in §1's audit. Short version: nothing supports the claim
(no terpene separates sativa- from indica-labelled product at any corrected
significance level; held-out accuracy 45.7% against 60.8% for guessing "sativa"),
and repairing it made it worse — pointing the line at measured chemistry fixes the
36-of-135 self-contradiction by construction but would then flag **29 of 48
sativa-labelled products against 7 of 31 indica**, which is caryophyllene and
myrcene dominating every profile, not a shelf full of mislabelled jars. The
dropdown had already abandoned this exact claim earlier the same day; the warning
was asserting it in prose.

`p.lean` now has **no reader anywhere in the page.** The capture script still
writes it. A real mislabel check needs something outside the terpenes.

### Where that leaves the card

Package tag · form · brand · THC → chips with words → strength vs this shop's own
distribution → the read → evidence dots naming their driver → WHY?. Every line is
either a measurement or a hedge on one. Nothing adjudicates the package any more.

### Still open

- **`CHAR`'s lift/settle axis.** Caryophyllene's evidence is CB2, peripheral and
  anti-inflammatory — "calm in the body", not "low energy" — and it's filed
  alongside myrcene's sedation. Fixing it rewrites copy on every card. Deferred.
- **Capture-side, needs a phone edit:** Farnesene and Terpineol missing from the
  prompt's lean list (moot for `lean`, still affects `dominant` and `confidence`);
  and normalising `trans-Caryophyllene` / `D-Limonene` / `trans-b-Ocimene` so a
  lab changing conventions can't produce a card that skips its own biggest terpene.
- **Terpene percentages still print raw** (`1.1955%`). THC is rounded; these aren't.

## Session 2 — 2026-08-01/02

Everything below shipped after this plan closed. Kept here because most of it
cost measurement to find and would be expensive to re-derive.

### Card and search

**Caryophyllene got its own direction: `body`, not `settle`.** Its evidence is
CB2 (Gertsch 2008) — peripheral, anti-inflammatory — and `REPORTED` already
called it "body calm, eases tension", which is not a drowsiness claim. Filing it
beside myrcene meant everything else settling counted as the same direction, so
`says()` reached past a 0.24% linalool for a 0.04% limonene and then dropped that
too. Reads naming a non-runner-up: **44 → 5**. Reads naming no second character:
**43 → 12**. A third value is NOT a third opposite — `OPPOSED()` treats only
lift↔settle as opposed, or Compare would have called 7,387 of 21,736 pairs
"opposite directions".

**Negative-only effect queries were completely broken.** Found from one counter
moment — scrolling the hybrid list for something not too heavy.

- `"not too heavy"` returned **nothing**. Score is wanted-minus-avoided, so with
  nothing wanted every product scored ≤0 and the `> 0.02` cut swept the lot. Now
  ranks by ABSENCE: least of the avoided terpene first.
- `"nothing heavy"` returned the **55 heaviest products**, led by Piescream
  ("heavy and relaxed"). `\bno\b` cannot match inside "nothing", so it read as
  WANTING myrcene — the exact opposite of the request.
- `"light"` wasn't a keyword at all.
- Records with no terpene profile are excluded from negative ranking: two
  cannabinoid-only carts were scoring zero myrcene and taking the top slots on
  the strength of having no data.

**Infusion picker on the effect tab** (Any infusion / Infused / Non-infused).
A FILTER, not a sort — a sort would put the weakest thing that matched on top.
Shown only on All and Preroll, because in stock there are 27 infused prerolls,
1 infused flower and 0 infused vapes. After the Lobo/Boom corrections below, a
random infused preroll beats a random plain one **94%** of the time (medians
36.7% vs 26.5% THC).

**Strength line dropped from vapes.** Vapes span 17% of their median from p10 to
p90 (75.6–90.5%); prerolls span 90%. Sorting that into five bands invented a
distinction nobody chooses on — 18 vapes read "about typical", and products
flagged "on the lighter side" were 83% THC. The figure still sits at the top of
the card.

**Terpene synonyms resolved (`TERP_ALIAS`).** Labs report the same compound under
different names and the page knew one spelling each, so a terpene filed under a
synonym was invisible — absent from the read, chips, WHY and search. Jusbud's OG
had 12% of its profile hidden as "D-Limonene". Isomers are SUMMED, not
overwritten; verified total terpene mass changes on zero of 213 records.
Deliberately not merged: bare "Cedrene", which could be the alpha or beta isomer.

**Find similar and Compare start empty.** Both auto-selected on open — Find
similar fell back to `sources[0]`, Compare to `list[0]` and `list[1]` — so
opening either showed a confident result for products nobody asked about. The
Compare ↔ handoff still pre-fills, because there the pair IS the question.
Clear (×) buttons added to all three pickers; clearing drops the SELECTION, not
just the text.

### Correctness review — three crash-class bugs

Found by fuzzing 25 malformed record shapes through 18 display functions and
every pair function.

1. **A record missing `terpenes` blanked the whole results list, silently.**
   `stack()` and `vec()` called `Object.entries(p.terpenes)` unguarded while
   `domTerps`, `hasProfile` and `rankedTerps` all used `p.terpenes||{}`. One such
   record threw inside `card()`, `render()` aborted, and `#out` kept whatever was
   there before — no error, no empty state. Reachable: the capture sum check
   skips itself when terpenes is absent.
2. **A non-numeric `thc` corrupted every card in its category.** `thcPeers`
   filtered on `!= null`, never on type, so a hand-edited `"thc": 26.07%` (which
   parses as a STRING) entered the peer array and printed "typical is NaN%" on
   every flower card.
3. **A numeric `form` threw** — `(p.form||'').match(...)`, and a number is truthy.

Same shape in all three: some call sites defensive about a field, others not.

### The filename fallback nearly ate a record

`product.id` was the last-resort filename key. The prompt asks for "10 random hex
chars" and the model does not comply: **213 records, 103 distinct ids, one shared
by 18 products.** `a3f7c2e91b.json` holds Gorilla Glue and that id also appears on
Carnival, OG Kush, Northern Lights - Pack, Strawberry Guava and Bubba Kush — so
rescanning any of them without a readable tag would have overwritten Gorilla Glue
and reported "✅ updated".

Refusing to save was rejected: it strands a scan at the counter for a case that
is very rare (all 10 tagless records are legacy). Fallback is now
`brand_strain_form`, which gives 212 distinct keys across 213 records — the one
clash is two batches of the same Florist Farms Gelato cart. Worst case is a
duplicate, which `compass-manage.js` can clean, rather than an unrecoverable
overwrite.

### Capture: the multi-matrix problem

**One COA can cover several product forms** — Raw Plant Material,
Concentrate/Extract, Infused Flower, Infused Prerolls, Inhalable Concentrate —
each with a full set of results. Taking the total from one and the terpenes from
another produces a record that looks entirely normal and describes nothing.

Baja Breeze was **three matrices at once**: total 1.53 from Raw Plant Material,
humulene 0.16 and linalool 0.15 from Infused Prerolls, thc 90.47 from the
standalone field — on a vape cart, whose matrix is Inhalable Concentrate.

The prompt now maps product type to matrix and asks the model to check its own
arithmetic; the script re-checks independently before writing and refuses on a
mismatch.

**The threshold took four tries because the LABS' own numbers don't add up.**
Every figure verified field-by-field against Alleaves:

| | gap | verdict |
|---|---|---|
| Baja Breeze | 80% short | real failure |
| Golden Yuzu | 80% short | real failure |
| Papaya Punch | 50% short | real failure — 4 of 14 terpenes captured |
| Slingria | 20% short | **lab's own**, capture was perfect |
| Silver Surfer | 11% over | **lab's own** |
| Papaya Punch, corrected | 11% over | **lab's own** |

Short gaps are compounds detected but below the reporting limit — counted in the
stated total, not printed as rows. Over-gaps are labs differing on which analytes
count toward "total". **3%, 10% and 15% each rejected records that were perfectly
captured.** 30% clears the noise and still catches every real failure, which run
50–80% because a crossed matrix is a different sample entirely.

### Data corrections, and records that were already right

Corrected: Papaya Punch (4→14 terpenes), Baja Breeze and Golden Yuzu (rebuilt
from Inhalable Concentrate), Jetpacks ×5 and Ruby ×3 and Kings and Queens and Cru
and Anthem ×3 preroll pack counts, Lobo ×3 and Boom ×3 marked infused, Basin
Mixtures renamed **Hashtag Honey**, Ruby "Preroll 5g (7-pack)" → 0.7g ×7.

`parseSize` tolerance is now RELATIVE (3%), because producers round: Ruby's
5g/7-pack is seven 0.7g joints — 4.9g printed as 5g, and 0.0143 off 0.7 fell
outside the old absolute 0.01 window. `STD_UNIT` gained 0.9.

**Already correct, do not re-investigate:** Slingria (Med Raw Plant Material —
note *Med*, not AU), Silver Surfer, High Garden's Granddaddy Purple and Acapulco
Gold. All four were flagged as suspicious and all four checked out exactly.

### Two identical-profile pairs

Baja Breeze and Golden Yuzu have byte-identical Inhalable Concentrate terpenes.
So do High Garden's Granddaddy Purple and Acapulco Gold. Not duplicate records —
Total THC and the minor cannabinoids differ in both pairs. The likely
explanation is a standardised terpene blend added back to distillate, which makes
the strain names decorative. GDP is labelled Indica and Acapulco Gold Sativa, and
they are chemically the same thing.

High Garden's carts are the shelf's outlier at **0.67%** total terpenes against a
brand median range of 2.7–9.0%, and the package says "pure live resin". The lab
result does not look like live resin. Not called a false claim without seeing
process detail, but worth knowing.

### Still open

- **The annotated README figure is unfinished.** `docs-card-anatomy.svg` renders
  but its five callouts collide, because they were anchored to guessed positions
  and the card height is now computed from content. Needs leader lines fanning
  out to evenly spaced labels.
- **Terpene percentages still print raw** (`1.1955%`). THC is rounded to 1dp.
- **The 10 legacy random-id files** still exist. Rescanning one now writes a new
  slug-named file beside it rather than updating it, leaving a duplicate.
  Renaming them would close that.
- **`CHAR`'s lift/settle axis** beyond caryophyllene — humulene is arguably body
  too. Deferred; it's a copy project.
- **Capture-side, needs a phone edit:** normalising isomer names at source, so
  the page's alias table stops being load-bearing.

### The methodological note, which is the actual lesson

Internal consistency is not evidence. A change that makes the tool agree with
itself proves nothing — two outputs of one computation always agree, including
when the computation is noise. Every real error across both sessions was caught
by checking against something outside the code: the physical shelf, a COA, the
Alleaves record, a customer. The verify recipe above inherits this blind spot —
every metric in it is internal to the page.

## Rebuilding the demo

`node build-demo.js` — regenerates `demo/` (gitignored) from current `index.html`
plus `data/`. Drag the folder onto app.netlify.com/drop to update terp-compass.
The script fails loud if anything identifying survives. The demo is a frozen
snapshot on purpose and does not update itself; re-run it after these fixes.
