// Mock storefront for the widget browser tests: serves the real widget JS/CSS
// on a page shaped like the live theme, and stands in for the app proxy
// (/apps/hajirai/*), the cart API and FITFinder.
import http from "node:http";
import fs from "node:fs";
const W = new URL("../../../extensions/hajirai-chat-widget/assets/", import.meta.url).pathname;
export const cartLog = [];
export const chatBodies = [];
export const fitSaves = [];
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
  "jillian-black": product("jillian-black", "Jillian Braided Quarter Strap Sandal - Black", 119.95),
  "orthotic-one": { id: 9, handle: "orthotic-one", title: "Women's Casual Orthotics", price: 6995, options: [{ name: "Title", values: ["Default Title"] }], variants: [{ id: 5555, title: "Default Title", options: ["Default Title"], available: true, price: 6995 }] },
};
const img = "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#f1ede6"/><path d="M30 130 Q100 60 170 120 L170 140 L30 140Z" fill="#8a2b2b"/></svg>');
const cards = [
  { title: PRODUCTS["savannah-red"].title, handle: "savannah-red", url: "/products/savannah-red", image: img, price: "129.95", price_formatted: "$129.95", preselect: { Size: "8 US", Width: "Medium" }, choose: ["Size", "Width"], kind: "footwear" },
  { title: PRODUCTS["jillian-black"].title, handle: "jillian-black", url: "/products/jillian-black", image: img, price: "119.95", price_formatted: "$119.95", choose: ["Size", "Width"], kind: "footwear" },
  { title: PRODUCTS["orthotic-one"].title, handle: "orthotic-one", url: "/products/orthotic-one", image: img, price: "69.95", price_formatted: "$69.95", kind: "orthotic" },
];
const page = (style) => `<!doctype html><script>setTimeout(function(){var d=document.createElement("div");d.id="floater";d.style.cssText="position:fixed;right:16px;bottom:16px;width:48px;height:48px;z-index:999999;pointer-events:none";var f=document.createElement("iframe");f.style.cssText="width:48px;height:48px;border:0;border-radius:50%;background:#333;pointer-events:auto";d.appendChild(f);document.body.appendChild(d)},6000)</script><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/w.css">
<script>window.Shopify={routes:{root:"/"}};window.__AI_CHAT_CONFIG={assistantName:"The Fit Concierge",greeting:"Hi!",position:"right"};try{localStorage.setItem("hajirai_product_card_style","${style}")}catch(e){}</script></head>
<body style="font-family:-apple-system,Helvetica,Arial;margin:0;background:#fafafa"><div style="padding:20px">Store page <span class="cart-count">0</span></div><script src="/w.js"></script></body></html>`;
const AVATAR = "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#d9c7b8"/><circle cx="40" cy="32" r="15" fill="#8c6b55"/><rect x="18" y="52" width="44" height="30" rx="14" fill="#5f8f8a"/></svg>');
const fullPage = () => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/w.css">${themeBlockStyle()}
<script>window.Shopify={routes:{root:"/"}};window.__AI_CHAT_CONFIG={assistantName:"AI Shopping Assistant",avatarUrl:${JSON.stringify(AVATAR)},greeting:"Hi! I'm your personal shopping assistant.",greetingCta:"What can I help you find today?",cta1Label:"Find my orthotic",cta1Message:"which orthotic is right for me?",cta2Label:"Shop sneakers",cta2Message:"show me sneakers",quickPick1Label:"Sandals",quickPick1Message:"sandals",quickPick2Label:"Heel pain",quickPick2Message:"heel pain",quickPick3Label:"Wide fit",quickPick3Message:"wide shoes",ctaHint:"Log in for faster checkout",disclaimerText:"This chatbot uses AI and may make mistakes.",widgetPosition:"bottom-center"};try{localStorage.setItem("hajirai_product_card_style","showcase")}catch(e){}</script></head>
<body style="font-family:-apple-system,Helvetica,Arial;margin:0;background:#fafafa"><div style="padding:20px;height:2000px;background:linear-gradient(#f3efe9,#e9e4dc)">Store page <span class="cart-count">0</span></div><script src="/w.js"></script></body></html>`;
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
${tf === "absent" ? "" : `window.AetrexTrueFitTile={state:{busy:false,finderOpen:false,recommendation:null},open:function(){
  var s=this.state;window.__tfOpens=(window.__tfOpens||0)+1;
  if(${JSON.stringify(tf === "none")}){document.getElementById("size-chart").hidden=false;return Promise.resolve()}
  s.busy=true;
  return new Promise(function(r){setTimeout(function(){
    s.busy=false;s.finderOpen=true;document.body.classList.add("tfc-show-modal");window.__tfChatOpenDuringFinder=document.querySelector(".ai-chat-panel.open")?1:0;r();
    setTimeout(function(){document.body.classList.remove("tfc-show-modal");s.finderOpen=false;setTimeout(function(){s.recommendation="9 - 9.5 US"},800)},1200);
  },300)})}};`}
</script><script src="/w.js"></script></body></html>`;
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
        if (u.pathname === "/full" || u.pathname === "/hidden-page") return send(200, "text/html", fullPage());
        const shoe = u.pathname.match(/^\/products\/([^/.]+)$/);
        if (shoe) return send(200, "text/html", shoePage(shoe[1], shoe[1] === "orthotic-one" ? "absent" : u.searchParams.get("tf")));
        if (u.pathname === "/w.js") return send(200, "application/javascript; charset=utf-8", fs.readFileSync(W + "hajirai-chat-widget.js"));
        if (u.pathname === "/w.css") return send(200, "text/css", fs.readFileSync(W + "hajirai-chat-widget.css"));
        if (u.pathname.startsWith("/apps/hajirai/widget-config")) return send(200, "application/json", JSON.stringify({ productCardStyle: String(req.headers.referer || "").includes("horizontal") ? "horizontal" : "showcase", hideOnUrls: [{ matchType: "contains", pattern: "hidden-page" }] }));
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
