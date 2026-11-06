// The page Shopify's sign-in lands on when the chat opened it in a small
// window: it tells the chat the shopper is signed in and closes. Shopify's
// sign-in pages cut the link back to the opening tab (Cross-Origin-Opener-
// Policy), so the message also goes out on a same-origin BroadcastChannel and
// localStorage, which every tab of the store hears. In the small window
// (popup) it closes itself — or, when the sign-in pages have made that
// impossible, says the shopper can close it: the chat on the store's page
// has heard, or asks the store itself every few seconds. Opened in the same
// tab instead (a pop-up blocker), it goes back to the page the shopper was
// on, where the chat picks up.
export function signedInPage(back, popup = false) {
  // Only a path on this store — never another site.
  const safeBack = /^\/(?!\/)[^\s]*$/.test(String(back || "")) ? String(back) : "/";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signed in</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:500 16px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#171717;background:#fff}</style></head>
<body><p id="m">You're signed in — returning to the chat…</p>
<script>
(function(){
  var back=${JSON.stringify(safeBack).replace(/</g, "\\u003c")},popup=${popup ? "true" : "false"};
  var told=false;
  try{if(window.opener&&window.opener.location.origin===location.origin){window.opener.postMessage({type:"hajirai-signed-in"},location.origin);told=true}}catch(e){}
  try{var bc=new BroadcastChannel("hajirai");bc.postMessage({type:"hajirai-signed-in"});bc.close();told=true}catch(e){}
  try{localStorage.setItem("hajirai_signed_in",String(Date.now()));told=true}catch(e){}
  if(told){try{window.close()}catch(e){}}
  if(popup){
    setTimeout(function(){
      document.getElementById("m").textContent="You're signed in — you can close this window and go back to the chat.";
      try{window.close()}catch(e){}
    },500);
    return;
  }
  setTimeout(function(){location.replace(back)},400);
})();
</script></body></html>`;
}
