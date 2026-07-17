// ==========================================================================
// COMPASS MANAGE — cleanup + editing tool for Scriptable
// Lists every record in your repo. Auto-cleans duplicates, deletes one by
// hand, or edits strain/brand/shelf_tag on a record. Token stays on your
// phone. Run it manually (tap ▶) — it's a back-office tool, not a share target.
// ==========================================================================

// ---- same values as your capture script ----------------------------------
const GITHUB_USER  = "REPLACE_ME";
const GITHUB_REPO  = "compass";
const GITHUB_TOKEN = "github_pat_REPLACE_ME";
// ---------------------------------------------------------------------------

const base = `https://api.github.com/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/data`;
const H = { "Authorization": "Bearer " + GITHUB_TOKEN, "User-Agent": "compass", "Accept": "application/vnd.github+json" };

// ---- 1. list every record file -------------------------------------------
let files;
try {
  const r = new Request(base); r.headers = H;
  files = await r.loadJSON();
  if (!Array.isArray(files)) { await note("Couldn't list records", files.message || ""); return; }
} catch (e) { await note("List failed", e.message); return; }

const jsons = files.filter(f => f.name.endsWith(".json"));
if (!jsons.length) { await note("Repo is empty", "No records here yet."); return; }

// ---- 2. load each in full — editing needs the whole record, not just a
// few display fields, so keep the raw parsed JSON alongside file/sha -------
const recs = [];
for (const f of jsons) {
  try {
    const r = new Request(f.download_url); r.headers = H;
    const data = await r.loadJSON();
    recs.push({ file: f.name, sha: f.sha, data,
                strain: data.strain || f.name, brand: data.brand || "" });
  } catch (e) {
    recs.push({ file: f.name, sha: f.sha, data: {}, strain: f.name, brand: "" });
  }
}

// Group by metrc_tag — the ONLY key that provably identifies one physical
// package. Do NOT group by strain+brand: the flower and the preroll of the
// same strain share both, and they are different products with different
// profiles. An earlier version grouped that way and deleted the Heir Heads
// preroll (1.72% terps) and the Pinyatti flower (2.2% terps) as "duplicates"
// of their flower/preroll twins. Per CLAUDE_CODE_BRIEF.md the archive IS the
// product — a record that can't be PROVEN redundant is never auto-deleted.
const seen = {};
for (const r of recs) {
  const tag = (r.data.metrc_tag || "").trim();
  if (!tag) continue;            // no tag = can't prove redundancy = leave it alone
  (seen[tag] = seen[tag] || []).push(r);
}
const dupeKeys = Object.keys(seen).filter(k => seen[k].length > 1);
const untagged = recs.filter(r => !(r.data.metrc_tag || "").trim());

// ---- 3. top menu — built as an explicit action list, not positional
// index math, so adding/removing options here can't silently break another
// one (that fragility bit an earlier version of this script) --------------
const actions = [];
if (dupeKeys.length) actions.push({ label: "Auto-clean duplicates", run: autoClean });
actions.push({ label: "Set shelf tag", run: setShelfTag });
actions.push({ label: "Edit a record", run: editOne });
actions.push({ label: "Delete one by hand", run: deleteOne });

const menu = new Alert();
menu.title = "Compass";
menu.message = `${recs.length} records · ${dupeKeys.length ? `${dupeKeys.length} sharing a Metrc tag` : "no duplicates"}`
  + (untagged.length ? `\n${untagged.length} have no Metrc tag (never auto-cleaned)` : "");
actions.forEach(a => menu.addAction(a.label));
menu.addCancelAction("Close");
const pick = await menu.presentSheet();
if (pick >= 0 && pick < actions.length) await actions[pick].run();

// ---- AUTO-CLEAN: only ever removes files that share a Metrc tag, i.e. two
// copies of the same physical package. Shows exactly what it will delete and
// waits for confirmation — this deletes from the archive, so it does not get
// to be a surprise.
async function autoClean() {
  const plan = [];
  for (const k of dupeKeys) {
    // Keep the file the capture script would write today: the one named for
    // its Metrc tag. That copy stays in sync on every rescan; the others are
    // strays from the old random-id filenames.
    const group = seen[k].slice().sort((a, b) =>
      (a.file === k + ".json" ? 0 : 1) - (b.file === k + ".json" ? 0 : 1));
    for (const r of group.slice(1)) plan.push({ doomed: r, kept: group[0] });
  }
  if (!plan.length) { await note("Nothing to clean", "No two records share a Metrc tag."); return; }

  const confirm = new Alert();
  confirm.title = `Delete ${plan.length} duplicate${plan.length > 1 ? "s" : ""}?`;
  confirm.message = plan.map(p =>
    `${p.doomed.strain} · ${p.doomed.data.form || "?"}\n  delete ${p.doomed.file}\n  keep   ${p.kept.file}`).join("\n\n");
  confirm.addDestructiveAction("Delete them");
  confirm.addCancelAction("Cancel");
  if (await confirm.presentAlert() !== 0) return;

  let removed = 0;
  for (const p of plan) if (await del(p.doomed.file, p.doomed.sha, p.doomed.strain)) removed++;
  await note("Duplicates cleaned", `Removed ${removed}. Refresh Compass to see it.`);
}

// ---- DELETE ONE, with confirmation ---------------------------------------
async function deleteOne() {
  const target = await pickRecord("Delete which?");
  if (!target) return;

  const confirm = new Alert();
  confirm.title = "Delete permanently?";
  confirm.message = `${target.strain} — ${target.brand}\nThis removes it from the repo for good.`;
  confirm.addDestructiveAction("Delete");
  confirm.addCancelAction("Keep it");
  if (await confirm.presentAlert() === 0) {
    const ok = await del(target.file, target.sha, target.strain);
    await note(ok ? "Deleted" : "Delete failed", ok ? `${target.strain} is gone. Refresh Compass.` : "Check token write permission.");
  }
}

// The controlled vocabulary. shelf_tag is picked from this, never typed: it
// feeds the label-vs-chemistry comparison, and a typo ("Stavia", a trailing
// space) reads as Unverified and silently drops that record out of the
// analysis. A picker can't typo.
const SHELF_TAGS = ["Sativa", "Indica", "Hybrid", "Unverified"];

async function pickShelfTag(current) {
  const a = new Alert();
  a.title = "Shelf tag";
  a.message = `What does the PACKAGE say?\nNot what the terpenes suggest — the point is to compare the two.\n\nCurrently: ${current || "Unverified"}`;
  SHELF_TAGS.forEach(t => a.addAction(t === (current || "Unverified") ? `${t} ✓` : t));
  a.addCancelAction("Cancel");
  const i = await a.presentSheet();
  return i === -1 ? null : SHELF_TAGS[i];
}

// ---- SET SHELF TAG: the BUILD.md step-6 pass. Stand in front of the
// packages, read each label, tap it in. Untagged records come first because
// those are the ones the comparison is still waiting on.
async function setShelfTag() {
  const untaggedFirst = recs.slice().sort((a, b) => {
    const ua = SHELF_TAGS.indexOf(a.data.shelf_tag) < 3 ? 1 : 0;   // tagged = 1, unverified = 0
    const ub = SHELF_TAGS.indexOf(b.data.shelf_tag) < 3 ? 1 : 0;
    return ua - ub || a.strain.localeCompare(b.strain);
  });
  const list = new Alert();
  list.title = "Set shelf tag";
  untaggedFirst.forEach(r => {
    const t = SHELF_TAGS.includes(r.data.shelf_tag) ? r.data.shelf_tag : "Unverified";
    list.addAction(`${t === "Unverified" ? "○" : "●"} ${r.strain} · ${r.data.form || "?"} — ${t}`);
  });
  list.addCancelAction("Cancel");
  const i = await list.presentSheet();
  if (i === -1) return;
  const target = untaggedFirst[i];

  const tag = await pickShelfTag(target.data.shelf_tag);
  if (!tag) return;
  const updated = Object.assign({}, target.data, { shelf_tag: tag });
  const ok = await putUpdate(target.file, target.sha, updated);
  await note(ok ? "Saved" : "Save failed", ok ? `${target.strain} → ${tag}. Refresh Compass.` : "Check token write permission.");
}

// ---- EDIT ONE: strain, brand, shelf_tag ----------------------------------
async function editOne() {
  const target = await pickRecord("Edit which?");
  if (!target) return;

  const edit = new Alert();
  edit.title = "Edit record";
  edit.message = target.file;
  edit.addTextField("Strain", target.strain);
  edit.addTextField("Brand", target.brand);
  edit.addAction("Save");
  edit.addCancelAction("Cancel");
  if (await edit.presentAlert() !== 0) return;

  // shelf_tag gets its own picker rather than a third text field
  const tag = await pickShelfTag(target.data.shelf_tag);
  if (!tag) return;

  const updated = Object.assign({}, target.data, {
    strain: edit.textFieldValue(0).trim() || target.strain,
    brand: edit.textFieldValue(1).trim() || target.brand,
    shelf_tag: tag
  });

  const ok = await putUpdate(target.file, target.sha, updated);
  await note(ok ? "Saved" : "Save failed", ok ? "Refresh Compass to see it." : "Check token write permission.");
}

// ---- shared picker sheet --------------------------------------------------
async function pickRecord(title) {
  const list = new Alert();
  list.title = title;
  const sorted = recs.slice().sort((a, b) => a.strain.localeCompare(b.strain));
  sorted.forEach(r => list.addAction(`${r.strain} — ${r.brand}`));
  list.addCancelAction("Cancel");
  const i = await list.presentSheet();
  return i === -1 ? null : sorted[i];
}

// ---- GitHub helpers ---------------------------------------------------
async function del(file, sha, strain) {
  try {
    const r = new Request(`${base}/${file}`);
    r.method = "DELETE";
    r.headers = { ...H, "Content-Type": "application/json" };
    r.body = JSON.stringify({ message: "compass: delete " + strain, sha });
    const res = await r.loadJSON();
    return !!res.commit;
  } catch (e) { return false; }
}
async function putUpdate(file, sha, data) {
  try {
    const contentB64 = Data.fromString(JSON.stringify(data, null, 1)).toBase64String();
    const r = new Request(`${base}/${file}`);
    r.method = "PUT";
    r.headers = { ...H, "Content-Type": "application/json" };
    r.body = JSON.stringify({ message: "compass: edit " + (data.strain || file), content: contentB64, sha });
    const res = await r.loadJSON();
    return !!res.commit;
  } catch (e) { return false; }
}
async function note(title, msg) {
  const a = new Alert(); a.title = title; a.message = msg; a.addAction("OK");
  await a.presentAlert();
}
