// The page Shopify's sign-in lands on when the chat opened it in a small
// window: it tells the chat the shopper is signed in and closes. Opened in
// the same tab instead (a pop-up blocker), it goes back to the page the
// shopper was on, where the chat picks up the conversation.
export function signedInPage(back) {
  // Only a path on this store — never another site.
  const safeBack = /^\/(?!\/)[^\s]*$/.test(String(back || "")) ? String(back) : "/";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signed in</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:500 16px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#171717;background:#fff}</style></head>
<body><p>You're signed in — returning to the chat…</p>
<script>
(function(){
  var back=${JSON.stringify(safeBack).replace(/</g, "\\u003c")};
  try{if(window.opener&&window.opener.location.origin===location.origin){window.opener.postMessage({type:"hajirai-signed-in"},location.origin);window.close();return}}catch(e){}
  location.replace(back);
})();
</script></body></html>`;
}
