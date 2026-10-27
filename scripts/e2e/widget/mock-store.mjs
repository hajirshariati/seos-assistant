// Mock storefront for the widget browser tests: serves the real widget JS/CSS
// on a page shaped like the live theme, and stands in for the app proxy
// (/apps/hajirai/*), the cart API and FITFinder.
import http from "node:http";
import fs from "node:fs";
const W = new URL("../../../extensions/hajirai-chat-widget/assets/", import.meta.url).pathname;
export const cartLog = [];
export const chatBodies = [];
export const fitSaves = [];
export const returnBodies = [];
// Returns the "server" has started, like the ChatReturn table: orderId → list.
export const startedReturns = {};
// Test switches: drop the connection after the next return is created (the
// shopper never hears back), or make the next request slow.
export const mockCtl = { dropNextPost: false, slowPostMs: 0, compareFail: false, viewAllFail: 0, viewAllDelayMs: 150 };
export const compareLog = [];
// "View all" pages the widget asked for ({ page, search }), its filter
// index requests and the cards it asked for by handle.
export const viewAllLog = [];
export const viewAllIndexLog = [];
export const viewAllCardsLog = [];
export const feedbackBodies = [];
// Order lookups without signing in (POST /apps/hajirai/order-lookup).
export const lookupBodies = [];
export const METHODS = [
  { key: "happy_returns", label: "Drop off at any Happy Returns location", detail: "No box or label needed.", fee: "$5.95", findUrl: "https://locations.example/" },
  { key: "usps", label: "USPS drop-off", detail: "Print the label, box it and drop it off.", fee: "$5.95", findUrl: "" },
];
let rmaSeq = 1000;
const { signedInPage } = await import("../../../app/lib/signed-in-page.js");
// A signed-in shopper's orders, shaped like app/lib/orders.server.js cards.
const ORDERS = [
  { id: "5001", number: "1171674", date: "2026-10-14", stage: "delivered", stageLabel: "Delivered", step: 3, shippedAt: "2026-10-15", deliveredAt: "2026-10-18", eta: "", carrier: "UPS", trackUrl: "https://track.example/1Z999", returnStatus: "", canReturn: true,
    items: [
      { lineId: "9001", title: "Savannah Adjustable Quarter Strap Sandal - Red", options: { Size: "8 US", Width: "Medium" }, image: "", quantity: 1, returnable: 1, handle: "savannah-red" },
      { lineId: "9002", title: "Women's Casual Orthotics", options: {}, image: "", quantity: 1, returnable: 1, handle: "orthotic-one" },
    ] },
  { id: "5002", number: "1172010", date: "2026-10-20", stage: "shipped", stageLabel: "On its way", step: 1, shippedAt: "2026-10-21", deliveredAt: "", eta: "2026-10-24", carrier: "USPS", trackUrl: "https://track.example/9400", returnStatus: "", canReturn: false,
    items: [{ lineId: "9003", title: "Jillian Braided Quarter Strap Sandal - Black", options: { Size: "9 US", Width: "Wide" }, image: "", quantity: 1, returnable: 1, handle: "jillian-black" }] },
];
const FF_CONFIG = {
  enabled: true, loggedIn: true, savedFit: null,
  quiz: { title: "Find my fit", questions: [{ id: "q_arch", text: "Do you have flat feet?", helpText: "Look at a wet footprint.", options: [{ id: "a", label: "Yes", sublabel: "Flat feet" }, { id: "b", label: "No / Unsure" }] }] },
  fits: [
    { key: "A", label: "FIT A", code: "20", name: "Posted Support", description: "Angled heel for flat feet.", details: "long" },
    { key: "B", label: "FIT B", code: "00", name: "Cushioned Support", description: "Neutral cushioned support." },
    { key: "C", label: "FIT C", code: "05", name: "Cushioned + Metatarsal Support", description: "With a metatarsal pad." },
    { key: "D", label: "FIT D", code: "25", name: "Maximum Support", description: "Posted plus metatarsal pad." },
  ],
};
const sizes = ["7 US", "7.5 US", "8 US", "8.5 US", "9 US", "10 US"];
const widths = ["Medium", "Wide"];
let vid = 1000;
const product = (handle, title, price, soldOut = []) => ({
  id: 1, handle, title, price: price * 100,
  options: [{ name: "Size", position: 1, values: sizes }, { name: "Width", position: 2, values: widths }],
  variants: sizes.flatMap((s) => widths.map((w) => ({ id: ++vid, title: `${s} / ${w}`, options: [s, w], option1: s, option2: w, available: !soldOut.includes(`${s}/${w}`), price: price * 100 }))),
});
const PRODUCTS = {
  "savannah-red": product("savannah-red", "Savannah Adjustable Quarter Strap Sandal - Red", 129.95, ["8 US/Wide", "9 US/Medium", "9 US/Wide"]),
  "jillian-black": product("jillian-black", "Jillian Braided Quarter Strap Sandal - Black", 119.95, ["7.5 US/Medium", "7.5 US/Wide"]),
  "orthotic-one": { id: 9, handle: "orthotic-one", title: "Women's Casual Orthotics", price: 6995, options: [{ name: "Title", values: ["Default Title"] }], variants: [{ id: 5555, title: "Default Title", options: ["Default Title"], available: true, price: 6995 }] },
};
const img = "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#f1ede6"/><path d="M30 130 Q100 60 170 120 L170 140 L30 140Z" fill="#8a2b2b"/></svg>');
// The same products as the store's synced catalog sees them, for the
// comparison table (built by the real app/lib/lean/compare.js).
const { normalizeProduct } = await import("../../../app/lib/lean/catalog.js");
const { buildComparison, comparisonIntro } = await import("../../../app/lib/lean/compare.js");
const cv = (size, width, price, qty = 4) => ({ price: String(price), compareAtPrice: null, inventoryQty: qty, optionsJson: JSON.stringify([{ name: "Size", value: size }, { name: "Width", value: width }]) });
const CMP_CATALOG = { products: [
  { handle: "savannah-red", title: "Savannah Adjustable Quarter Strap Sandal - Red", productType: "Footwear", featuredImageUrl: "IMG", tags: [], description: "",
    attributesJson: { category_for_filter: "sandals", gender: "women", color: "red", helps_with: ["plantar fasciitis", "flat feet", "bunions"], activity: ["everyday comfort", "travel"], rating: "4.6", review_count: "212", comfort: "<ul><li>Built-in arch support</li><li>Memory foam cushioning</li></ul>", materials: "<ul><li>Leather upper</li></ul>", measurements: "<ul><li>Heel Height: 1.25\"</li></ul>" },
    variants: [cv("7 US", "Medium", 129.95), cv("10 US", "Wide", 129.95)] },
  { handle: "jillian-black", title: "Jillian Braided Quarter Strap Sandal - Black", productType: "Footwear", featuredImageUrl: "IMG", tags: [], description: "",
    attributesJson: { category_for_filter: "sandals", gender: "women", color: "black", helps_with: ["plantar fasciitis", "flat feet"], activity: ["everyday comfort", "social"], rating: "4.3", review_count: "88", badge: "New", comfort: "<ul><li>Built-in arch support</li><li>Adjustable straps</li></ul>", materials: "<ul><li>Leather upper</li></ul>", measurements: "<ul><li>Heel Height: 1.5\"</li></ul>" },
    variants: [cv("7 US", "Medium", 119.95), cv("9 US", "Medium", 119.95)] },
  { handle: "orthotic-one", title: "Women's Casual Orthotics", productType: "Orthotics", featuredImageUrl: "IMG", tags: [], description: "",
    attributesJson: { category_for_filter: "orthotics", gender: "women", helps_with: ["plantar fasciitis", "arch pain"], rating: "4.5", review_count: "1203" },
    variants: [{ price: "69.95", compareAtPrice: null, inventoryQty: 9, optionsJson: "[]" }] },
  { handle: "carly-white", title: "Carly Arch Support Sneaker - White", productType: "Footwear", featuredImageUrl: "IMG", tags: [], description: "",
    attributesJson: { category_for_filter: "sneakers", gender: "women", color: "white", helps_with: ["plantar fasciitis"], activity: ["walking"], rating: "4.7", review_count: "540" },
    variants: [cv("8 US", "Medium", 139.95)] },
].map((r) => normalizeProduct(r, { shop: "aetrex.myshopify.com" })) };
const cards = [
  { title: PRODUCTS["savannah-red"].title, handle: "savannah-red", url: "/products/savannah-red", image: img, price: "129.95", price_formatted: "$129.95", preselect: { Size: "8 US", Width: "Medium" }, choose: ["Size", "Width"], kind: "footwear" },
  { title: PRODUCTS["jillian-black"].title, handle: "jillian-black", url: "/products/jillian-black", image: img, price: "119.95", price_formatted: "$119.95", choose: ["Size", "Width"], kind: "footwear" },
  { title: PRODUCTS["orthotic-one"].title, handle: "orthotic-one", url: "/products/orthotic-one", image: img, price: "69.95", price_formatted: "$69.95", kind: "orthotic" },
];
// A big search for "View all" pages: 60 sale boots, as varied as a real
// search — colors, boots and booties, sizes and widths in stock (Wide only
// in some sizes), prices, foot needs and ratings — so the sheet's filters
// have something to work with. The index comes from the real builder.
const { buildViewAllIndex } = await import("../../../app/lib/lean/view-all-index.js");
const BOOT_COLORS = ["Black", "Brown", "Navy", "Red", "Taupe", "Grey", "Black/White", "Wine"];
const BOOT_SIZES = ["6 US", "6.5 US", "7 US", "7.5 US", "8 US", "8.5 US", "9 US", "9.5 US", "10 US", "11 US"];
export const BOOT_PRODUCTS = Array.from({ length: 60 }, (_, i) => {
  const price = 79.95 + (i % 7) * 20;
  const variants = [];
  BOOT_SIZES.forEach((size, j) => {
    const qty = (i + j) % 4 === 0 ? 0 : 4;
    variants.push({ price: price.toFixed(2), compareAtPrice: (price * 1.5).toFixed(2), inventoryQty: qty, optionsJson: JSON.stringify([{ name: "Size", value: size }, { name: "Width", value: "Medium" }]) });
    if (i % 2 === 0) variants.push({ price: price.toFixed(2), compareAtPrice: (price * 1.5).toFixed(2), inventoryQty: j % 2 === 0 ? qty : 0, optionsJson: JSON.stringify([{ name: "Size", value: size }, { name: "Width", value: "Wide" }]) });
  });
  return normalizeProduct({
    handle: `boot-${i + 1}`, title: `Boot ${i + 1} - ${BOOT_COLORS[i % 8]}`, productType: "Footwear", featuredImageUrl: "IMG", tags: [], description: "",
    attributesJson: { category_for_filter: i % 3 === 0 ? "Booties" : "Boots", gender: "women", color: BOOT_COLORS[i % 8], helps_with: i % 5 === 0 ? ["plantar fasciitis"] : i % 5 === 1 ? ["bunions"] : [], rating: (3.8 + (i % 10) * 0.12).toFixed(1), review_count: String(10 + i * 3) },
    variants,
  }, { shop: "aetrex.myshopify.com" });
});
const MANY_BOOTS = BOOT_PRODUCTS.map((p) => ({ title: p.title, handle: p.handle, url: `/products/${p.handle}`, image: img, price: p.price.toFixed(2), price_formatted: `$${p.price.toFixed(2)}`, compare_at_price: Math.round(p.compareAtPrice * 100), choose: ["Size", "Width"], kind: "footwear" }));
const carly = { title: "Carly Arch Support Sneaker - White", handle: "carly-white", url: "/products/carly-white", image: img, price: "139.95", price_formatted: "$139.95", choose: ["Size", "Width"], kind: "footwear" };
for (const p of CMP_CATALOG.products) p.image = img;
// "Find my shoe size" with no shoe picked: the real answer (true-fit-intro.js)
// from a small store — shoes of several kinds in both lines, an orthotic
// (never a tile) — with photos on https://img.mock.test (tests serve them).
const { trueFitIntro, TRUE_FIT_INTRO_TEXT } = await import("../../../app/lib/lean/true-fit-intro.js");
const INTRO_KINDS = [["Sneakers", 9, 4], ["Sandals", 7, 3], ["Boots", 5, 2], ["Loafers", 4, 2], ["Wedges", 3, 0], ["Slippers", 2, 2], ["Clogs", 1, 1]];
export const INTRO_CATALOG = { products: [
  ...INTRO_KINDS.flatMap(([cat, women, men]) => [
    ...Array.from({ length: women }, (_, i) => ({ cat, line: "women", i })),
    ...Array.from({ length: men }, (_, i) => ({ cat, line: "men", i })),
  ]).map(({ cat, line, i }) => normalizeProduct({
    handle: `${line}-${cat.toLowerCase()}-${i + 1}`, title: `${line === "men" ? "Men's " : ""}${cat.replace(/s$/, "")} ${i + 1} - Black`, productType: "Footwear",
    featuredImageUrl: `https://img.mock.test/${cat.toLowerCase()}.svg`, tags: [], description: "",
    attributesJson: { category_for_filter: cat, gender: line, rating: (4 + (i % 9) / 10).toFixed(1), review_count: String(20 + i) },
    variants: [cv("8 US", "Medium", 129.95)],
  }, { shop: "aetrex.myshopify.com" })),
  CMP_CATALOG.products.find((p) => p.handle === "orthotic-one"),
] };
const page = (style) => `<!doctype html><script>setTimeout(function(){var d=document.createElement("div");d.id="floater";d.style.cssText="position:fixed;right:16px;bottom:16px;width:48px;height:48px;z-index:999999;pointer-events:none";var f=document.createElement("iframe");f.style.cssText="width:48px;height:48px;border:0;border-radius:50%;background:#333;pointer-events:auto";d.appendChild(f);document.body.appendChild(d)},6000)</script><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/w.css">
<script>window.Shopify={routes:{root:"/"}};window.__AI_CHAT_CONFIG={assistantName:"The Fit Concierge",greeting:"Hi!",position:"right"};try{localStorage.setItem("hajirai_product_card_style","${style}")}catch(e){}</script></head>
<body style="font-family:-apple-system,Helvetica,Arial;margin:0;background:#fafafa"><div style="padding:20px">Store page <span class="cart-count">0</span></div><script src="/w.js"></script></body></html>`;
const AVATAR = "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#d9c7b8"/><circle cx="40" cy="32" r="15" fill="#8c6b55"/><rect x="18" y="52" width="44" height="30" rx="14" fill="#5f8f8a"/></svg>');
const fullPage = (login = "", extra = "") => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/w.css">${themeBlockStyle()}
<script>window.Shopify={routes:{root:"/"}};window.__AI_CHAT_CONFIG={assistantName:"AI Shopping Assistant",avatarUrl:${JSON.stringify(AVATAR)},greeting:"Hi! I'm your personal shopping assistant.",greetingCta:"What can I help you find today?",cta1Label:"Find my orthotic",cta1Message:"which orthotic is right for me?",cta1Icon:"heart",cta2Label:"Shop sneakers",cta2Message:"show me sneakers",quickPick1Label:"Sandals",quickPick1Message:"sandals",quickPick2Label:"Heel pain",quickPick2Message:"heel pain",quickPick3Label:"Wide fit",quickPick3Message:"wide shoes",ctaHint:"Log in for faster checkout",${extra}${login ? `customerLoggedIn:true,customerFirstName:${JSON.stringify(login)},customerId:7,customerLogoutUrl:"/account/logout",` : ""}disclaimerText:"This chatbot uses AI and may make mistakes.",widgetPosition:"bottom-center"};try{localStorage.setItem("hajirai_product_card_style","showcase")}catch(e){}</script></head>
<body style="font-family:-apple-system,Helvetica,Arial;margin:0;background:#fafafa"><div style="padding:20px;height:2000px;background:linear-gradient(#f3efe9,#e9e4dc)">Store page <span class="cart-count">0</span> <input id="site-search" placeholder="Search"></div><script src="/w.js"></script></body></html>`;
// The theme block's own inline <style>, read from the liquid file so the
// test page never drifts from what the storefront renders.
function themeBlockStyle() {
  const liquid = fs.readFileSync(new URL("../../../extensions/hajirai-chat-widget/blocks/hajirai_chat.liquid", import.meta.url), "utf8");
  return liquid.match(/<style>[\s\S]*?<\/style>/)?.[0] || "";
}
// A shoe page with the theme's "Find my size" tile and a stand-in for its
// True Fit driver: open() shows the finder, the shopper "answers", it
// closes, and the size appears a moment later — as True Fit does.
// ?tf=none: True Fit has no data for this style (open() shows the size chart).
const shoePage = (handle, tf) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/w.css">
<script>window.Shopify={routes:{root:"/"}};window.__AI_CHAT_CONFIG={assistantName:"AI Shopping Assistant",greeting:"Hi!"};try{localStorage.setItem("hajirai_product_card_style","showcase")}catch(e){}</script></head>
<body style="font-family:-apple-system,Helvetica,Arial;margin:0;background:#fafafa"><div style="padding:20px">Product ${handle} <span class="cart-count">0</span>
${tf === "absent" ? "" : '<button type="button" data-tf-size-tile data-product-id="42">Find my size</button>'}<div id="size-chart" hidden>Size chart</div></div>
<script>
${tf === "absent" ? "" : `document.addEventListener("click",function(e){var t=e.target.closest("[data-tf-size-tile]");if(t){e.preventDefault();window.AetrexTrueFitTile.open(t)}});
window.AetrexTrueFitTile={state:{busy:false,finderOpen:false,recommendation:null},open:function(){
  var s=this.state;if(s.busy)return Promise.resolve();window.__tfOpens=(window.__tfOpens||0)+1;
  if(${JSON.stringify(tf === "none")}){document.getElementById("size-chart").hidden=false;return Promise.resolve()}
  s.busy=true;
  return new Promise(function(r){setTimeout(function(){
    s.busy=false;s.finderOpen=true;document.body.classList.add("tfc-show-modal");window.__tfChatOpenDuringFinder=document.querySelector(".ai-chat-panel.open")?1:0;r();
    setTimeout(function(){document.body.classList.remove("tfc-show-modal");s.finderOpen=false;setTimeout(function(){s.recommendation="9 - 9.5 US"},800)},1200);
  },300)})}};${tf === "known" ? "setTimeout(function(){window.AetrexTrueFitTile.state.recommendation=\"9 - 9.5 US\";try{localStorage.setItem(\"tfTileProfile\",\"1\")}catch(e){}},700);" : ""}`}
</script><script src="/w.js"></script></body></html>`;
// A stand-in for the Aetrex theme's cart: <cart-count> in the header and the
// mobile dock, a closed drawer with <cart-items data-section-id>, and a
// theme.pubsub whose cartUpdate subscribers behave like the real ones —
// including throwing when the drawer's section HTML is missing, and a
// cart:refresh listener that reads event.detail.open.
const aetrexPage = () => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/w.css">
<script>window.Shopify={routes:{root:"/"}};window.__AI_CHAT_CONFIG={assistantName:"AI Shopping Assistant",greeting:"Hi!"};try{localStorage.setItem("hajirai_product_card_style","showcase")}catch(e){}
window.__cartErrors=[];window.__published=[];window.__drawerOpened=0;
window.theme={pubsub:{PUB_SUB_EVENTS:{cartUpdate:"cart-update"},subs:{},subscribe:function(e,f){(this.subs[e]=this.subs[e]||[]).push(f)},publish:function(e,d){window.__published.push(d);(this.subs[e]||[]).forEach(function(f){f(d)})}}};
document.addEventListener("cart:refresh",function(ev){try{ev.detail.open}catch(err){window.__cartErrors.push("cart:refresh without detail")}});
</script></head>
<body style="font-family:-apple-system,Helvetica,Arial;margin:0;background:#fafafa"><header style="padding:20px">Aetrex <a href="/cart">Bag <cart-count id="hdr-count" hidden>0</cart-count></a></header>
<nav id="dock">Dock <cart-count id="dock-count" hidden>0</cart-count></nav>
<div id="CartDrawer" data-section-id="cart-drawer" hidden><cart-items data-section-id="cart-drawer"><div id="MiniCart-cart-drawer">Your cart is empty</div></cart-items></div>
<script>
theme.pubsub.subscribe("cart-update",function(ev){document.querySelectorAll("cart-count").forEach(function(c){c.innerText=ev.cart.item_count;c.hidden=ev.cart.item_count===0})});
theme.pubsub.subscribe("cart-update",function(ev){var html=ev.cart.sections["cart-drawer"];var doc=new DOMParser().parseFromString(html,"text/html");var up=doc.querySelector("#MiniCart-cart-drawer");document.querySelector("#MiniCart-cart-drawer").innerHTML=up?up.innerHTML:"";var t=document.querySelector("#MiniCart-cart-drawer a");if(t)t.focus();});
</script><script src="/w.js"></script></body></html>`;
// The order as the server would show it now: returns started, what's left.
function orderNow(o) {
  const rs = startedReturns[o.id] || [];
  const used = {};
  for (const r of rs) for (const l of r.lineIds) used[l] = (used[l] || 0) + 1;
  const items = o.items.map((i) => ({ ...i, returnable: Math.max(0, i.returnable - (used[i.lineId] || 0)) }));
  const left = items.some((i) => i.returnable > 0);
  return { ...o, items, canReturn: o.canReturn && left, returnBlocked: !o.canReturn ? "not_delivered" : left ? "" : "nothing_left", returns: rs };
}
export function start(port) {
  return new Promise((res) => {
    const srv = http.createServer((req, resp) => {
      const u = new URL(req.url, "http://x");
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const send = (code, type, data) => { resp.writeHead(code, { "Content-Type": type }); resp.end(data); };
        if (u.pathname === "/" || u.pathname === "/showcase") return send(200, "text/html", page("showcase"));
        if (u.pathname === "/horizontal") return send(200, "text/html", page("horizontal"));
        if (u.pathname === "/full" || u.pathname === "/hidden-page") return send(200, "text/html", fullPage(u.searchParams.get("login") || (/signedin=1/.test(req.headers.cookie || "") ? "Ann" : ""), (u.searchParams.get("coop") ? `customerLoginUrl:"/account/login?coop=${u.searchParams.get("coop")}",` : "") + (u.searchParams.get("fb") ? `cta3Label:"Track my order",cta3Message:"track my order",cta4Label:"About Aetrex",cta4Message:"tell me about aetrex",` : "") + (u.searchParams.get("qp") ? `quickPick1Label:"Identify my orthotic",quickPick1Message:"https://form.typeform.com/to/ojyWbTvZ",` : "")));
        if (u.pathname === "/aetrex" && u.searchParams.get("sections")) return send(200, "application/json", JSON.stringify({ "cart-drawer": `<div id="shopify-section-cart-drawer"><div id="MiniCart-cart-drawer"><a href="/products/x">${cartLog.length} item(s) in your cart</a></div></div>` }));
        if (u.pathname === "/aetrex") return send(200, "text/html", aetrexPage());
        // Sign-in: sets the session cookie and goes back where it was told
        // (as Shopify's sign-in does), here straight to the chat's landing page.
        // Shopify's real sign-in cuts the window's link to the opener (COOP).
        // coop=1: lands on the chat's page without an opener; coop=2: never
        // reaches it (ends on the account page) and the shopper closes it.
        if (u.pathname === "/account/login" && u.searchParams.get("coop") && u.searchParams.get("return_url")) {
          const to = u.searchParams.get("coop") === "2" ? "/account" : u.searchParams.get("return_url");
          resp.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": "signedin=1; Path=/" });
          return resp.end(`<!doctype html><script>window.opener=null;location.replace(${JSON.stringify(to)})</script>`);
        }
        if (u.pathname === "/account/login" && (u.searchParams.get("return_url") || u.searchParams.get("return_to"))) {
          const to = u.searchParams.get("return_url") || u.searchParams.get("return_to");
          resp.writeHead(302, { Location: to.startsWith("/") ? to : "/", "Set-Cookie": "signedin=1; Path=/" });
          return resp.end();
        }
        if (u.pathname === "/apps/hajirai/signed-in" && u.searchParams.get("check")) return send(200, "application/json", JSON.stringify({ signedIn: /signedin=1/.test(req.headers.cookie || "") }));
        if (u.pathname === "/apps/hajirai/signed-in") return send(200, "text/html", signedInPage(u.searchParams.get("back")));
        // Order status without signing in: order number (or confirmation code)
        // + email, both of the same order → that order's status, as the real
        // route answers (routes/order-lookup.jsx). mockCtl.lookupTries: tries
        // allowed before "too many tries".
        if (u.pathname === "/apps/hajirai/order-lookup" && req.method === "POST") {
          let b = {};
          try { b = JSON.parse(body || "{}"); } catch { /* */ }
          lookupBodies.push({ ...b, contentType: req.headers["content-type"] || "" });
          const reply = (code, obj) => setTimeout(() => send(code, "application/json", JSON.stringify(obj)), mockCtl.lookupDelayMs ?? 250);
          if (mockCtl.lookupTries != null && lookupBodies.length > mockCtl.lookupTries) return reply(429, { error: "too_many_tries", message: "Too many tries for now. Please wait a little and try again, or sign in to see your orders.", retryAfter: 300 });
          const order = String(b.order || "").replace(/\s+/g, "").replace(/^#+/, "");
          const email = String(b.email || "").trim().toLowerCase();
          const fields = {};
          if (!/^[a-z0-9-]{3,24}$/i.test(order)) fields.order = "Enter your order number or confirmation number.";
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) fields.email = "Enter the email you used for the order.";
          if (Object.keys(fields).length) return reply(400, { error: "invalid", fields });
          const o = ORDERS[1];
          if ((order === o.number || order.toUpperCase() === "QWERTY123") && email === "pat@example.com") {
            const card = { number: o.number, date: o.date, stage: o.stage, stageLabel: o.stageLabel, step: o.step, shippedAt: o.shippedAt, deliveredAt: o.deliveredAt, eta: o.eta, carrier: o.carrier, trackUrl: o.trackUrl, returnStatus: o.returnStatus };
            return reply(200, { ok: true, order: { ...card, id: `guest-${o.number}`, items: o.items.map(({ title, options, image, quantity }) => ({ title, options, image, quantity })), guest: true } });
          }
          return reply(404, { error: "not_found", message: "We couldn't find an order with those details. Check them against your order confirmation email — orders from the last 60 days can be looked up here." });
        }
        if (u.pathname === "/apps/hajirai/returns" && req.method === "GET") {
          if (!/signedin=1/.test(req.headers.cookie || "")) return send(401, "application/json", JSON.stringify({ error: "sign_in_required" }));
          const o = ORDERS.find((x) => x.id === u.searchParams.get("orderId"));
          if (!o) return send(404, "application/json", JSON.stringify({ error: "order_not_found" }));
          const now = orderNow(o);
          return send(200, "application/json", JSON.stringify({ ok: true, order: now, methods: METHODS, returnsUrl: "https://returns.example/?order-number=" + o.number, message: now.canReturn ? "" : now.returnBlocked === "nothing_left" ? "Everything in this order is already being returned." : "You can start a return once the order has been delivered." }));
        }
        if (u.pathname === "/apps/hajirai/returns" && req.method === "POST") {
          const b = JSON.parse(body || "{}");
          returnBodies.push(b);
          if (!/signedin=1/.test(req.headers.cookie || "")) return send(401, "application/json", JSON.stringify({ error: "sign_in_required" }));
          if (b.reason === "other") return send(200, "application/json", JSON.stringify({ ok: false, error: "return_not_created", message: "I couldn't start this return here — you can finish it on our returns page.", fallbackUrl: "https://returns.example/?order-number=1171674" }));
          const o = ORDERS.find((x) => x.id === b.orderId);
          const lineIds = (b.items || []).map((i) => i.lineId);
          const rs = (startedReturns[b.orderId] ||= []);
          const reply = (r, extra = {}) => ({ ok: true, rma: r.rma, labelUrl: r.labelUrl, returnsUrl: "https://returns.example/?order-number=" + (o?.number || ""), method: r.method, exchange: r.exchange, lineIds: r.lineIds, refundTo: "original_payment", exchangeCards: r.exchangeCards, ...extra });
          // Same as the real server: a return already started for these lines comes back as is.
          const prior = [...rs].reverse().find((r) => lineIds.every((l) => r.lineIds.includes(l)));
          if (prior) return send(200, "application/json", JSON.stringify(reply(prior, { already: true })));
          const m = METHODS.find((x) => x.key === b.method) || METHODS[0];
          const r = { rma: "R" + ++rmaSeq, labelUrl: m.key === "usps" ? "https://label.example/" + rmaSeq : "", method: { key: m.key, label: m.label, findUrl: m.findUrl }, exchange: !!b.exchange, lineIds, date: "2026-10-22",
            exchangeCards: b.exchange ? [{ ...cards[0], preselect: { Size: "8.5 US", Width: "Medium" }, exchange_from: "8 US", exchange_to: "8.5 US" }] : [] };
          const finish = () => {
            rs.push(r);
            if (mockCtl.dropNextPost) { mockCtl.dropNextPost = false; return req.socket.destroy(); }
            send(200, "application/json", JSON.stringify(reply(r)));
          };
          return mockCtl.slowPostMs ? setTimeout(finish, mockCtl.slowPostMs) : finish();
        }
        if (u.pathname === "/account/logout" || u.pathname === "/account/login") return send(200, "text/html", "<!doctype html><title>account</title>" + u.pathname);
        const shoe = u.pathname.match(/^\/products\/([^/.]+)$/);
        if (shoe) return send(200, "text/html", shoePage(shoe[1], shoe[1] === "orthotic-one" ? "absent" : u.searchParams.get("tf")));
        if (u.pathname === "/w.js") return send(200, "application/javascript; charset=utf-8", fs.readFileSync(W + "hajirai-chat-widget.js"));
        if (u.pathname === "/w.css") return send(200, "text/css", fs.readFileSync(W + "hajirai-chat-widget.css"));
        if (u.pathname === "/apps/hajirai/feedback") {
          feedbackBodies.push(JSON.parse(body || "{}"));
          return send(200, "application/json", '{"ok":true}');
        }
        // "View all" pages: 60 boots, 24 to a page, for the search the reply sent.
        if (u.pathname === "/apps/hajirai/view-all") {
          let search = null;
          try { search = JSON.parse(u.searchParams.get("search") || "null"); } catch { /* bad */ }
          // The filters' index, and cards by handle (what a filter shows).
          if (u.searchParams.get("index") === "1") {
            viewAllIndexLog.push({ search });
            if (mockCtl.viewAllIndexFail) return setTimeout(() => send(500, "application/json", '{"error":"failed"}'), mockCtl.viewAllDelayMs);
            return setTimeout(() => send(search?.on_sale === true ? 200 : 400, "application/json", search?.on_sale === true ? JSON.stringify({ ok: true, ...buildViewAllIndex(BOOT_PRODUCTS) }) : '{"error":"bad_search"}'), mockCtl.viewAllDelayMs);
          }
          if (u.searchParams.has("handles")) {
            const asked = String(u.searchParams.get("handles") || "").split(",").filter(Boolean);
            viewAllCardsLog.push(asked);
            const all = new Map([...MANY_BOOTS, ...cards, carly].map((c) => [c.handle, c]));
            return setTimeout(() => send(200, "application/json", JSON.stringify({ ok: true, products: asked.map((h) => all.get(h)).filter(Boolean) })), mockCtl.viewAllCardsDelayMs ?? mockCtl.viewAllDelayMs);
          }
          const asked = Number(u.searchParams.get("page")) || 1;
          viewAllLog.push({ page: asked, search });
          if (mockCtl.viewAllFail > 0) { mockCtl.viewAllFail -= 1; return setTimeout(() => send(500, "application/json", JSON.stringify({ error: "failed" })), mockCtl.viewAllDelayMs); }
          const pages = Math.ceil(MANY_BOOTS.length / 24);
          const n = Math.min(Math.max(asked, 1), pages);
          const body = JSON.stringify({ ok: true, page: n, pages, total: MANY_BOOTS.length, pageSize: 24, products: MANY_BOOTS.slice((n - 1) * 24, n * 24) });
          return setTimeout(() => send(search?.on_sale === true ? 200 : 400, "application/json", search?.on_sale === true ? body : '{"error":"bad_search"}'), mockCtl.viewAllDelayMs);
        }
        if (u.pathname === "/apps/hajirai/compare") {
          compareLog.push(u.searchParams.get("handles"));
          if (mockCtl.compareFail) return send(500, "application/json", JSON.stringify({ error: "failed", message: "The comparison couldn't load right now." }));
          const c = buildComparison(CMP_CATALOG, String(u.searchParams.get("handles") || "").split(","));
          return setTimeout(() => send(c.error ? 404 : 200, "application/json", JSON.stringify(c.error ? { error: "not_found" } : { ok: true, intro: comparisonIntro(c), comparison: c })), 120);
        }
        if (u.pathname.startsWith("/apps/hajirai/widget-config")) return send(200, "application/json", JSON.stringify({ productCardStyle: String(req.headers.referer || "").includes("horizontal") ? "horizontal" : "showcase", hideOnUrls: [{ matchType: "contains", pattern: "hidden-page" }],
          // The "How's the chat going?" check-in: off unless the page asks (?rate=N).
          chatRating: (() => { const r = (String(req.headers.referer || "").match(/[?&]rate=(\d)/) || [])[1]; return r ? { on: true, after: Number(r) } : { on: false, after: 3 }; })(),
          ...(() => { const fb = (String(req.headers.referer || "").match(/[?&]fb=(\d)/) || [])[1]; return fb ? { feedbackSurvey: String(req.headers.referer || "").includes("fblook") ? { on: true, form: "ojyWbTvZ", label: "Identify My Orthotic", color: "green", icon: "orthotic", hideAfter: false } : { on: true, form: "jdXBrXMa", label: "Share feedback" }, hideLiveChatButton: fb === "2" } : {}; })() }));
        if (u.pathname === "/apps/fitfinder/config") return send(200, "application/json", JSON.stringify(FF_CONFIG));
        if (u.pathname === "/apps/fitfinder/fit") { fitSaves.push(JSON.parse(body || "{}")); return send(200, "application/json", '{"ok":true}'); }
        if (u.pathname === "/apps/hajirai/chat") {
          const parsed = JSON.parse(body || "{}");
          chatBodies.push(parsed);
          // Error responses the server can send, by status.
          const errMatch = /^err(\d{3})$/.exec(parsed.message || "");
          if (errMatch) {
            const code = Number(errMatch[1]);
            const payload = code === 429 ? { error: "rate_limited", retryAfter: 5 }
              : code === 402 ? { error: "plan_limit_reached", message: "This store reached its conversations for the month." }
              : code === 503 ? { error: "AI engine API key not configured." }
              : { error: "action_failed", message: "I'm having trouble right now. Please try again in a moment." };
            return send(code, "application/json", JSON.stringify(payload));
          }
          // "Find my shoe size" tapped with no shoe picked: answered without the model.
          if (parsed.size_intro === true) {
            resp.writeHead(200, { "Content-Type": "text/event-stream" });
            const w = (o) => resp.write(`data: ${JSON.stringify(o)}\n\n`);
            w({ type: "text", text: TRUE_FIT_INTRO_TEXT });
            w({ type: "products", products: [] });
            w(trueFitIntro(INTRO_CATALOG, { primaryLine: "women" }));
            w({ type: "done" });
            return resp.end();
          }
          if (parsed.message === "xss") {
            resp.writeHead(200, { "Content-Type": "text/event-stream" });
            const w = (o) => resp.write(`data: ${JSON.stringify(o)}\n\n`);
            w({ type: "text", text: 'Hi <img src=x onerror="window.__pwned=1"> [click](javascript:window.__pwned=2) [far](//evil.example/x) [ok](/pages/returns)' });
            w({ type: "products", products: [{ ...cards[0], title: '<img src=x onerror="window.__pwned=3">Evil', url: "javascript:window.__pwned=4" }] });
            w({ type: "link", url: "javascript:window.__pwned=5", label: "<b>x</b>" });
            w({ type: "done" });
            return resp.end();
          }
          if (parsed.message === "cut") {
            resp.writeHead(200, { "Content-Type": "text/event-stream" });
            resp.write(`data: ${JSON.stringify({ type: "text", text: "Here's what I found before the connection dropped." })}\n\n`);
            return resp.end();
          }
          // The assistant offers the "which orthotic do I have?" quiz.
          // The assistant opens the store locator (Storepoint) in the chat.
          if (parsed.message === "storesnear") {
            resp.writeHead(200, { "Content-Type": "text/event-stream" });
            const w = (o) => resp.write(`data: ${JSON.stringify(o)}\n\n`);
            w({ type: "text", text: "Search your area on our store map." });
            w({ type: "map_cta", mapId: "15ecd30bd8acd4", label: "Find a store near you", url: "/pages/store-locator" });
            w({ type: "done" });
            return resp.end();
          }
          // "Any boots on sale?": two cards of ten matches → View all.
          if (parsed.message === "saleboots") {
            resp.writeHead(200, { "Content-Type": "text/event-stream" });
            const w = (o) => resp.write(`data: ${JSON.stringify(o)}\n\n`);
            const more = Array.from({ length: 6 }, (_, i) => ({ title: `Sale Boot ${i + 1} - Black`, handle: `sale-boot-${i + 1}`, url: `/products/sale-boot-${i + 1}`, image: img, price: "99.95", price_formatted: "$99.95", compare_at_price: 14995, choose: ["Size"], kind: "footwear" }));
            w({ type: "text", text: "Here are two of the boots on sale." });
            w({ type: "products", products: [cards[0], cards[2]] });
            w({ type: "view_all", label: "View all 10 women's sale boots", title: "Women's Sale Boots", total: 10, products: [cards[0], cards[1], cards[2], carly, ...more] });
            w({ type: "done" });
            return resp.end();
          }
          // "Any boots on sale?" in a big store: 60 matches, a page of 24 at a time.
          if (parsed.message === "manyboots") {
            resp.writeHead(200, { "Content-Type": "text/event-stream" });
            const w = (o) => resp.write(`data: ${JSON.stringify(o)}\n\n`);
            w({ type: "text", text: "Here are two of the boots on sale." });
            w({ type: "products", products: [MANY_BOOTS[0], MANY_BOOTS[1]] });
            w({ type: "view_all", label: "View all 60 women's sale boots", title: "Women's Sale Boots", total: 60, pageSize: 24, search: { gender: "women", on_sale: true, categories: ["Boots"] }, products: MANY_BOOTS.slice(0, 24) });
            w({ type: "done" });
            return resp.end();
          }
          if (parsed.message === "quizme") {
            resp.writeHead(200, { "Content-Type": "text/event-stream" });
            const w = (o) => resp.write(`data: ${JSON.stringify(o)}\n\n`);
            w({ type: "text", text: "This quick quiz will tell you which orthotic you have." });
            w({ type: "form_cta", form: "ojyWbTvZ", label: "Identify my orthotic" });
            w({ type: "done" });
            return resp.end();
          }
          if (/what size/i.test(parsed.message || "")) {
            resp.writeHead(200, { "Content-Type": "text/event-stream" });
            const handle = parsed.size_finder?.page_handle || "jillian-black";
            resp.write(`data: ${JSON.stringify({ type: "text", text: "True Fit can find your size — tap below." })}\n\n`);
            resp.write(`data: ${JSON.stringify({ type: "size_finder", provider: "truefit", handle, title: "Jillian Sandal" })}\n\n`);
            resp.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
            return resp.end();
          }
          if (/^True Fit recommends/.test(parsed.message || "")) {
            resp.writeHead(200, { "Content-Type": "text/event-stream" });
            resp.write(`data: ${JSON.stringify({ type: "text", text: "Here's the Jillian in 9 - 9.5 US, ready to add." })}\n\n`);
            resp.write(`data: ${JSON.stringify({ type: "products", products: [{ ...cards[1], preselect: { Size: "9 US", Width: "Medium" } }] })}\n\n`);
            resp.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
            return resp.end();
          }
          if (/order|return/i.test(parsed.message || "")) {
            resp.writeHead(200, { "Content-Type": "text/event-stream" });
            const w = (o) => resp.write(`data: ${JSON.stringify(o)}\n\n`);
            const intent = /return/i.test(parsed.message) ? "return" : "track";
            if (/signedin=1/.test(req.headers.cookie || "")) {
              w({ type: "text", text: intent === "return" ? "Here are your orders — tap Return an item on the one you'd like to return." : "Here are your recent orders." });
              w({ type: "products", products: [] });
              // "…on the returns page": the store has returns in the chat turned off.
              const page = /returns page/i.test(parsed.message);
              w({ type: "order_cards", intent, orders: ORDERS.map(orderNow).map((o) => page ? { ...o, returnMode: "page", returnsUrl: "https://returns.example/?order-number=" + o.number } : o), returnMethods: page ? [] : METHODS });
            } else {
              w({ type: "text", text: "Sign in, or look your order up with its number and email." });
              w({ type: "products", products: [] });
              // As the server sends it: the lookup on, with a number they mentioned filled in.
              const num = (parsed.message.match(/#?(\d{5,})/) || [])[1];
              w({ type: "login_prompt", intent, lookup: !/sign-in only/i.test(parsed.message), ...(num ? { order: num } : {}) });
            }
            w({ type: "done" });
            return resp.end();
          }
          if (/fit/i.test(parsed.message || "")) {
            resp.writeHead(200, { "Content-Type": "text/event-stream" });
            resp.write(`data: ${JSON.stringify({ type: "text", text: "Flat feet plus ball-of-foot pain — that's FIT D." })}\n\n`);
            resp.write(`data: ${JSON.stringify({ type: "products", products: [] })}\n\n`);
            resp.write(`data: ${JSON.stringify({ type: "fitfinder_fit", key: "D" })}\n\n`);
            resp.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
            return resp.end();
          }
          if (/^full/i.test(parsed.message || "")) {
            resp.writeHead(200, { "Content-Type": "text/event-stream" });
            const w = (o) => resp.write(`data: ${JSON.stringify(o)}\n\n`);
            setTimeout(() => {
              w({ type: "text", text: "Great choice — the **Carly** is our top-rated sneaker. Who are these for?" });
              w({ type: "products", products: cards });
              w({ type: "suggestions", questions: ["Does the Carly come in wide?", "What's your return policy?"] });
              w({ type: "link", url: "/collections/sneakers", label: "View all Women's Sneakers" });
              w({ type: "done" });
              resp.end();
            }, /slow/i.test(parsed.message) ? 4000 : 50);
            return;
          }
          if (/^compare /i.test(parsed.message || "")) {
            resp.writeHead(200, { "Content-Type": "text/event-stream" });
            const w = (o) => resp.write(`data: ${JSON.stringify(o)}\n\n`);
            w({ type: "text", text: "The Savannah has a little more cushioning; the Jillian is lighter on price." });
            w({ type: "products", products: [] });
            w({ type: "comparison", comparison: buildComparison(CMP_CATALOG, ["savannah-red", "jillian-black", ...(/carly/i.test(parsed.message) ? ["carly-white"] : [])]) });
            w({ type: "done" });
            return resp.end();
          }
          if (/^many/i.test(parsed.message || "")) {
            resp.writeHead(200, { "Content-Type": "text/event-stream" });
            const w = (o) => resp.write(`data: ${JSON.stringify(o)}\n\n`);
            w({ type: "text", text: "Four to consider." });
            w({ type: "products", products: [...cards, carly] });
            w({ type: "done" });
            return resp.end();
          }
          if (/jillian/i.test(parsed.message || "")) {
            resp.writeHead(200, { "Content-Type": "text/event-stream" });
            resp.write(`data: ${JSON.stringify({ type: "text", text: "The Jillian is a great match." })}\n\n`);
            resp.write(`data: ${JSON.stringify({ type: "products", products: [cards[1]] })}\n\n`);
            resp.write(`data: ${JSON.stringify({ type: "visualize_cta", productHandle: cards[1].handle, productTitle: cards[1].title, productImage: img, label: "See It Styled", scenes: null })}\n\n`);
            resp.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
            return resp.end();
          }
          const n = Number(parsed.message?.match(/\d/)?.[0] || 3);
          resp.writeHead(200, { "Content-Type": "text/event-stream" });
          resp.write(`data: ${JSON.stringify({ type: "text", text: "Here are a few supportive picks — the Savannah is ready in your size 8." })}\n\n`);
          resp.write(`data: ${JSON.stringify({ type: "products", products: cards.slice(0, n) })}\n\n`);
          if (n === 1) resp.write(`data: ${JSON.stringify({ type: "visualize_cta", productHandle: cards[0].handle, productTitle: cards[0].title, productImage: img, label: "See It Styled", scenes: null })}\n\n`);
          resp.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
          return resp.end();
        }
        const m = u.pathname.match(/^\/products\/([^/.]+)\.js$/);
        if (m) return PRODUCTS[m[1]] ? send(200, "application/json", JSON.stringify(PRODUCTS[m[1]])) : send(404, "application/json", "{}");
        if (u.pathname === "/cart/add.js") {
          const items = JSON.parse(body).items;
          cartLog.push(items[0].id);
          if (items[0].id === 999999) return send(422, "application/json", JSON.stringify({ status: 422, description: "Sold out" }));
          return send(200, "application/json", JSON.stringify({ items }));
        }
        if (u.pathname === "/cart.js") return send(200, "application/json", JSON.stringify({ item_count: cartLog.length }));
        if (u.pathname === "/cart/update.js") return send(200, "application/json", "{}");
        send(404, "text/plain", "nf " + u.pathname);
      });
    });
    srv.listen(port, () => res({ srv, PRODUCTS }));
  });
}
