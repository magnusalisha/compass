# Compass

A budtender's tool for one dispensary in New York. It holds the lab chemistry
for everything on the shelf and helps staff answer what a customer is actually
asking for.

213 products scanned, 164 in stock, 54 brands. One static HTML page, records as
JSON in this repo, no database and no build step.

## What it does

**Match by effect** — type what the customer said. "relaxing but not heavy",
"for a concert", "limonene". Ranks in-stock products by the terpenes those words
map to. Filters by category, sativa/indica/hybrid, size and infusion.

**Find similar** — they name something they liked. Compass finds what's
chemically closest on the shelf right now, including when the original is sold
out. The strongest function in the tool, because the customer supplies the
ground truth.

**Compare** — two products side by side: strength, terpene bars, and what
actually differs.

**Lookup** — a strain or brand by name.

## How it works

A COA is shared to a phone shortcut, which extracts the terpene and cannabinoid
figures and commits one JSON record to `data/`. The page reads those records
directly from GitHub. Marking something sold out writes back through a
Cloudflare Worker, so the whole shop sees it immediately.

## What it claims, and what it doesn't

The numbers are measured: terpene percentages and THC come from the lab, and the
card shows strength against that category's own range in this shop.

The interpretation is hedged on purpose. Every card grades its own evidence —
of 213 records, 109 lead with a terpene that has a real receptor mechanism, 52
with one backed by some human data, and 52 with pure folklore — and the card
says which. The WHY? panel names the source of every claim.

Compass does **not** convert chemistry into sativa/indica. Tested across every
labelled record in this inventory, no terpene predicts that label better than
chance — which matches the published chemovar literature. The type filter reads
the package, because that is the only place the claim actually lives.

The working premise is narrower than it started:

> **The package sorts. The chemistry differentiates within the sort.**

Sativa/indica/hybrid is the vocabulary customers use, and it does the coarse
sort. Chemistry then separates products *inside* a category — which matters most
for "Hybrid", because Hybrid asserts nothing and leaves nothing to choose on.

## Files

| | |
|---|---|
| `index.html` | the whole app — page, logic, embedded fallback data |
| `data/*.json` | one record per product, keyed by Metrc tag |
| `compass-capture.js` | phone shortcut: COA → record |
| `compass-manage.js` | back-office edits and duplicate cleanup |
| `compass-stock-worker.js` | Cloudflare Worker for stock writes |
| `build-demo.js` | regenerates the public demo with identifying data stripped |
| `PLAN.md` | the working record — what was tried, what failed, and why |
| `PREMISE.md` | where the product thinking stands |
