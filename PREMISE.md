# Compass — where the premise actually stands

Context brief, written 2026-08-01. Paste this into a fresh chat for strategy
questions. It deliberately leaves out implementation detail — that's in PLAN.md.

## What it is

A budtender tool for one dispensary in NY. 213 scanned products, live, used
daily by me (Alisha); Alex is co-owner and has more counter years than I do.
Terpene and THC data is captured from lab COAs via a phone shortcut, stored as
JSON in a git repo, rendered by a single static page. It has four tabs: Match by
effect, Find similar, Compare, Lookup.

The tagline is: *"Match what's on the shelf to what a customer's actually asking
for — by terpene, not by strain name."*

## What got established today — measured, please don't re-litigate

These came from running tests against all 213 records, not from reasoning.

1. **The terpene→effect mapping is folklore-grade.** The tool's own evidence
   table already grades 10 of 12 terpenes as tier 1 ("essentially strain-database
   folklore"). Only caryophyllene has a real receptor mechanism (CB2, Gertsch
   2008) — and CB2 is peripheral/anti-inflammatory, not sedating.

2. **Terpene profile does not predict the sativa/indica label.** Tested every
   terpene against every non-faint sativa/indica record (n=48/31). Nothing
   survives correction for multiple comparisons. Myrcene — the famous "indica"
   terpene — is a coin flip. Limonene runs backwards. Train on half the records,
   predict the other half: 45.7% accurate against 60.8% for always guessing
   "sativa". This reproduces the published chemovar literature: terpene profiles
   cluster reliably, but not along the sativa/indica axis.

3. **Consequence, already shipped:** the type dropdown now filters on the package
   label rather than derived chemistry, and the shelf-vs-chemistry ⚠ mislabel
   warning was removed entirely. Both were asserting the claim in (2).

4. **The entourage effect doesn't rescue it.** Contested literature, and every
   version of the claim is about *magnitude* (does THC hit harder), not
   *direction* (energising vs sedating). Also, terpenes travel in correlated
   bundles, so an additive model can't express interactions anyway.

## The reframe that came out of it

> **The package sorts. The chemistry differentiates within the sort.**

Sativa/indica/hybrid is the vocabulary customers and packages use. It does the
coarse sort. Chemistry then differentiates *inside* a category — which matters
most for "Hybrid", because Hybrid asserts nothing and leaves the customer with
nothing to choose on.

This is much more modest than the tagline and it's what the data supports.

## Counter observations (mine, n=1, but it's the only real evidence in this domain)

- The most common opening line is **"I need a recommendation"** — open-ended, no
  prior product, no terpene named. It fits none of the strong tools.
- A customer wanted one each of sativa / hybrid / indica, and was **choosiest
  about the hybrid** — the category that carries no information.
- **"Having something to look at was very useful."** The tool's value in that
  moment was being a shared object on the counter, not an oracle. What mattered
  was coverage and being able to flip through, not whether an effect claim was right.
- I was scrolling the hybrid list hunting for **"something not too heavy"** —
  i.e. a negative effect query, on the category that needs the most help.

## Strongest and weakest functions

- **Find similar** and **Compare** are the strongest, and they make *no effect
  claims at all* — the customer names something they liked, and the tool matches
  on measured chemistry. The customer supplies the ground truth.
- **Match by effect** is the weakest link in the chain (folklore mapping) and is
  currently the default landing tab.
- A terpene-name search ("something that leads with limonene") is designed but
  not built. Also claim-free: it's a query on measured values.

## Open questions worth thinking about

1. **What is this product?** An effects tool, or an inventory-intelligence tool
   with an honest reading layer? Today pushed hard toward the second.
2. **What should the tagline say?** The cards got honest; the header didn't.
3. **Productise or not?** Every NY dispensary has the same data. Alleaves (our
   POS) has an open API carrying COA documents, inventory, and lab results —
   that's the integration path, and it's better data than the PDFs we scan.
   Infrastructure cost is negligible; the real costs are compliance/legal and
   the fact that we'd hold other dispensaries' credentials.
4. **Can the effects premise be earned back?** Nobody has a real terpene→effect
   map. We have a counter, repeat customers, and per-batch chemistry. Logging
   "did this work for you" against actual profiles would, over a year, build a
   dataset that doesn't currently exist anywhere. That's the only honest route —
   and it's the one thing a competitor can't buy.
5. **How much of this should Alex weigh in on?** The factual parts don't need
   him. The copy — what the words on the card should say — is where more counter
   years genuinely helps.

## The methodological lesson, which cost most of a day

Internal consistency is not evidence. A change that makes the tool agree with
itself proves nothing — two outputs of one computation always agree, including
when the computation is noise. Every real error today was caught by checking
against something outside the code: the physical shelf, a COA, a customer.
