# The Compass Shortcut: scan → shelf-ready, no laptop

You build this by hand in the Shortcuts app, once. It's about 15 actions. Nothing can
generate it for you — Apple only lets signed shortcuts be shared, so tapping it in is
the price of admission. Budget half an hour, and expect the first run to fail on a
typo. That's normal.

## Before you start

Two secrets to have ready:

1. **Anthropic API key** — console.anthropic.com → API Keys. Starts with `sk-ant-`.
2. **GitHub token** — github.com → Settings → Developer settings → Personal access
   tokens → Fine-grained tokens. Give it access to *only* your `compass` repo, with
   **Contents: Read and write**. Nothing else.

Both go straight into the Shortcut as text. It lives on your phone and you're the only
user, so that's acceptable — but it does mean: don't share this Shortcut with anyone.

## The flow

**1. Shortcut Details** → turn on **Show in Share Sheet**, accept **URLs**.

**2. `Get Contents of URL`** — input: `Shortcut Input`.
This downloads whatever the QR points at: a PDF, an image, or a web page.

**3. `Get Details of Files`** → **File Extension**. This is how you branch.

**4. `If`** — Extension `contains` `pdf`:

   → **`Base64 Encode`** the file, then a **`Text`** action containing:
   ```
   {"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"BASE64HERE"}}
   ```
   *(drop the Base64 variable where BASE64HERE is)*

   **Otherwise If** extension contains `jpg`, `jpeg`, or `png`:

   → **`Base64 Encode`**, then a **`Text`** action:
   ```
   {"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":"BASE64HERE"}}
   ```

   **Otherwise** (it's an HTML page with the terpenes listed):

   → **`Get Text from Input`**, then a **`Text`** action:
   ```
   {"type":"text","text":"PAGETEXTHERE"}
   ```

   Each branch ends by setting a variable — call it **Block**.

**5. `Text`** — the API request body. This is the heart of it:

```json
{"model":"claude-sonnet-4-6","max_tokens":1500,"messages":[{"role":"user","content":[
BLOCK,
{"type":"text","text":"This is a cannabis Certificate of Analysis. Extract the terpene data and return ONLY a JSON object, no preamble, no markdown fences.\n\nSchema:\n{\"id\":\"<10 random hex chars>\",\"brand\":\"<brand or licensee, not the lab>\",\"strain\":\"<strain name>\",\"form\":\"<e.g. Flower 3.5g, Preroll 1g>\",\"thc\":<total THC percent>,\"total_terpenes\":<number>,\"lean\":\"lifting|settling|mixed\",\"confidence\":\"strong|moderate|faint\",\"in_stock\":true,\"shelf_tag\":\"Unverified\",\"reported\":[<up to 2 phrases>],\"dominant\":[<top 3 terpene names, descending>],\"aroma\":[<up to 5 aroma words>],\"terpenes\":{<name>:<percent>}}\n\nRules:\n- All values are % w/w. If the lab reports mg/g, divide by 10.\n- ND, NR, <MRL, and <0.0400 all mean 0 — omit them from terpenes.\n- Canonical names: beta-Myrcene, Limonene, beta-Caryophyllene, Terpinolene, Linalool, alpha-Pinene, beta-Pinene, alpha-Humulene, alpha-Bisabolol, Ocimene, Farnesene, Terpineol, Fenchol, Guaiol, Valencene, Geraniol, Camphene, Carene, alpha-Terpinene, gamma-Terpinene, alpha-Phellandrene, p-Cymene, Caryophyllene oxide, Eucalyptol, Nerolidol. FENCHYL ALCOHOL is Fenchol. ALPHA TERPINEOL is Terpineol.\n- terpenes: detected only, sorted descending.\n- shelf_tag: ALWAYS the literal string \"Unverified\". Never guess Sativa/Indica/Hybrid — that comes from the package, not the COA, and a guessed value is worse than an empty one.\n- thc = Total THC as a percent (% w/w). Every COA prints it.\n- confidence: strong if total terpenes >= 1.2, moderate if >= 0.8, faint if below 0.8. If faint AND the profile is mostly heavy sesquiterpenes (caryophyllene, humulene, bisabolol, guaiol), the volatile terpenes have evaporated and the profile is unreliable — set confidence faint.\n- lean: terpinolene, limonene, pinene, ocimene = lifting. myrcene, linalool, caryophyllene, humulene, bisabolol = settling. If the two sides are close, mixed.\n- reported: how people COMMONLY DESCRIBE this profile, e.g. \"heady and alert\", \"heavy and relaxed\", \"calm in the body\". This is a report, never a medical claim. Never use: cures, treats, helps with, relieves, for anxiety/pain/sleep.\n- Aroma words describe smell only."}]}]}
```

Replace `BLOCK` with your Block variable.

**6. `Get Contents of URL`** — `https://api.anthropic.com/v1/messages`
   - Method: **POST**
   - Headers:
     - `x-api-key` → your key
     - `anthropic-version` → `2023-06-01`
     - `content-type` → `application/json`
   - Request Body: **File** → pass the Text from step 5.

**7. `Get Dictionary Value`** → key `content` → then **Get Item from List** (First) →
   **Get Dictionary Value** → key `text`.
   That's your product JSON as a string. Call it **Product**.

**8. `Base64 Encode`** the Product. GitHub's API wants file content base64'd.

**9. `Text`** — the GitHub request body:
```json
{"message":"add product","content":"BASE64PRODUCTHERE"}
```

**10. `Get Contents of URL`** —
   `https://api.github.com/repos/YOURUSER/compass/contents/data/[random].json`

   Use a **`Random Number`** action (1 to 999999) in the filename so every scan creates
   a new file and nothing ever collides.
   - Method: **PUT**
   - Headers: `Authorization` → `Bearer YOUR_GITHUB_TOKEN`
   - Request Body: **File** → the Text from step 9.

**11. `Show Notification`** — "Added ✅". Optional, but you'll want the confirmation
when you're doing twenty in a row.

## Using it

Camera app → point at the QR → tap the banner → Share → **Compass**. Wait ~10
seconds. Notification. Next product.

The site picks it up on your next refresh.

## When it breaks

- **Nothing gets added:** add a `Quick Look` action right after step 6. The API returns
  its errors as readable JSON — usually a bad key or a malformed body.
- **The record looks wrong** (missing strain, weird numbers): the COA was probably an
  image-only scan. Open the repo on your phone, tap the file, edit it. It's just JSON —
  that's exactly why we're not using a database.
- **A QR needs a login:** nothing to be done. Screenshot the terpene table instead and
  share the screenshot to the Shortcut — the image branch handles it.
