# TikTok → ERP CSV Converter

A tiny, single-page web app that converts a **TikTok Seller order export**
(comma-delimited) into the **pipe-delimited (`|`) ERP format**.

It runs **entirely in the browser** — your order data never gets uploaded to any
server. That also means **you do NOT need Railway** (Railway is for back-end
apps; this has no back-end). Netlify alone — or even opening the file locally —
is enough.

---

## What it does

1. You upload the `Source.csv` you exported from TikTok Seller Center.
2. You fill in the **static fields** (the values that don't exist in the TikTok
   file — account number, ship method, etc.). They're saved in your browser, so
   you only set them once.
3. *(Optional)* You paste **Order IDs into the filter box** to export only those
   orders. Leave it empty to convert the whole sheet.
4. You click **Convert & Download** and get a `|`-delimited CSV ready to import
   into the ERP.

### Filtering by Order ID (optional)

Leave the **Filter by Order ID** box empty and the whole sheet is converted.
Paste one or more TikTok Order IDs (one per line, or separated by spaces/commas)
and only those orders are kept in the final file — all of each order's line
items come along. The box shows how many orders matched and warns if an ID
isn't found in the uploaded file.

The converter automatically:

- Outputs **pipe (`|`) delimited** rows with the exact ERP column order.
- Converts state names to abbreviations (`New Jersey` → `NJ`).
- Converts country (`United States` → `US`).
- Cleans phone numbers (`(+1)9854699604` → `+19854699604`).
- Splits the recipient into first / last name.
- Reformats the date (`06/03/2026 12:15:08 PM` → `06-03-2026`).
- Computes per-unit prices (Net Price = before discount, Unit Price = after
  discount).
- Quotes only the fields that need it (anything with a space), matching the
  sample ERP file.

---

## Field mapping (TikTok source → ERP output)

| ERP column | Source |
|---|---|
| Order Name | `Order Name Prefix` + **Order ID** |
| Order Status | static (`unfulfilled`) |
| Order Date | **Created Time** (or override) |
| Total tax | **Taxes** |
| Shipping Cost (ex tax) | **Shipping Fee After Discount** |
| Order Total | **Order Amount** |
| Customer Name / Shipping Name | **Recipient** |
| Customer/Shipping Email | static |
| Customer/Shipping Phone | **Phone #** (cleaned) |
| Ship Method | static (`US1`) |
| Payment Method | static (`PayPal Payflow Pro`) |
| Shipping First/Last Name | split from **Recipient** |
| Shipping Street 1 / 2 | **Address Line 1 / 2** |
| Shipping Suburb | **City** |
| Shipping State | **State** |
| Shipping State Abbreviations | **State** → 2-letter |
| Shipping Zip | **Zipcode** |
| Shipping Country | **Country** → ISO-2 |
| Product Qty | **Quantity** |
| Product SKU | **Seller SKU** |
| Product Name | **Product Name** (+ Variation) |
| Product Unit Price | **SKU Subtotal After Discount** ÷ qty |
| Account Number | static (`99999280`) |
| Net Price | **SKU Subtotal Before Discount** ÷ qty |
| ProductGroupType | static (`MULTI`) |

All other ERP columns are intentionally left blank (matching the sample file).

> **Note on Product Name & Email:** TikTok's export uses long marketing product
> titles and does **not** include customer emails. The ERP matches products by
> **SKU**, so the product title is informational. Email is a static field you can
> leave blank or set to a default.

---

## Deploy — pick ONE (both are free)

### Option A — Netlify drag-and-drop (fastest, ~30 seconds)
1. Go to <https://app.netlify.com/drop>.
2. Drag the whole **`tiktok-converter`** folder onto the page.
3. Netlify gives you a live URL. Done.

### Option B — Netlify connected to GitHub (auto-updates)
1. Push this repo to GitHub (already done if Claude pushed it for you).
2. In Netlify: **Add new site → Import an existing project → GitHub** and pick
   the repo.
3. Set **Base directory** to `tiktok-converter` and leave the build command
   empty, publish directory `.`.
4. Deploy. Every push now updates the site automatically.

### Option C — Just run it locally (no hosting at all)
Open `tiktok-converter/index.html` in any browser. It works offline (it only
fetches the PapaParse CSV library from a CDN the first time).

---

## Files

| File | Purpose |
|---|---|
| `index.html` | The page (upload, settings, export UI) |
| `app.js` | All conversion logic + field mapping |
| `styles.css` | Styling |
| `netlify.toml` | Netlify config (no build step) |
