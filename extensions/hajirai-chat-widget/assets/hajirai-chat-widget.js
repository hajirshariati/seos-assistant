(function(){
'use strict';

/* Build marker — bump on widget changes so a live deploy can be verified
   in DevTools console. If you don't see this line after `shopify app deploy`
   + hard refresh, the new bundle isn't live (stale checkout or CDN cache). */
try{console.log('[hajirai-widget] build 2026-10-19 orb-art');}catch(e){}

/* Visual config comes from theme editor (liquid-injected as window.__AI_CHAT_CONFIG).
   Chat server URL is handled internally via app proxy at /apps/hajirai/chat. */
var C=window.__AI_CHAT_CONFIG||{};

var CHAT_URL='/apps/hajirai/chat';
var FEEDBACK_URL='/apps/hajirai/feedback';
var CONFIG_URL='/apps/hajirai/widget-config';
var VISUALIZE_URL='/apps/hajirai/visualize';
(function(){try{if(document.getElementById('ai-chat-viz-keyframes-style'))return;var st=document.createElement('style');st.id='ai-chat-viz-keyframes-style';st.textContent='@keyframes aiChatViz{0%{background-position:100% 0}100%{background-position:-100% 0}}@keyframes aiChatVizSpin{to{transform:rotate(360deg)}}';(document.head||document.documentElement).appendChild(st)}catch(e){}})();
var HRK='hajirai_hide_rules';
var PCSK='hajirai_product_card_style';

function matchesHideRule(rules){
  if(!rules||!rules.length)return false;
  var path=window.location.pathname;
  for(var i=0;i<rules.length;i++){
    var r=rules[i];
    if(r.matchType==='equals'&&path===r.pattern)return true;
    if(r.matchType==='contains'&&path.indexOf(r.pattern)!==-1)return true;
  }
  return false;
}

/* Set when this page is one the store hides the assistant on. */
var HIDDEN_BY_URL=false;
var _cachedRules=null;
try{_cachedRules=JSON.parse(sessionStorage.getItem(HRK))}catch(e){}
if(_cachedRules&&matchesHideRule(_cachedRules))return;

/* ?cta= is the welcome line shown here, so its translations match it. */
fetch(CONFIG_URL+'?cta='+encodeURIComponent(C.greetingCta||'What can I help you find today?')).then(function(r){return r.json()}).then(function(d){
  if(d.showFeedback===false)SHOW_FEEDBACK=false;
  /* Settings → Support link wins over the theme editor's. */
  if(typeof d.supportUrl==='string'&&d.supportUrl)SUPPORT_URL=d.supportUrl;
  if(typeof d.supportLabel==='string'&&d.supportLabel)SUPPORT_LABEL=d.supportLabel;
  if(d.klaviyoCompanyId)KLAVIYO_COMPANY_ID=d.klaviyoCompanyId;
  if(d.klaviyoListId)KLAVIYO_LIST_ID=d.klaviyoListId;
  if(typeof d.productCardStyle==='string')PRODUCT_CARD_STYLE=d.productCardStyle==='showcase'?'showcase':'horizontal';
  if(typeof d.welcomeGlowStyle==='string')WELCOME_INTRO=d.welcomeGlowStyle!=='none';
  /* Welcome-CTA translations from server. Theme block toggle wins over
     the server echo (both must agree to enable rotation). When ready,
     append translations to the frames array — the running rotator
     picks them up on its next tick. */
  if(GREET_CTA_ROTATE && d.rotateGreetingCta!==false && Array.isArray(d.greetingCtaTranslations) && d.greetingCtaTranslations.length>0){
    GREET_CTA_FRAMES=[{text:GREETCTA,dir:'ltr',code:'en'}].concat(d.greetingCtaTranslations);
  }
  /* Cache so the next page load knows the style synchronously,
     before history is restored. Otherwise saved product cards
     render in default style until the fetch resolves. */
  try{localStorage.setItem(PCSK,PRODUCT_CARD_STYLE)}catch(e){}
  if(d.showLoginPill===false){
    var pill=document.querySelector('.ai-chat-header__login-pill,.ai-chat-header__vip-pill');
    if(pill)pill.style.display='none';
  }
  var rules=d.hideOnUrls||[];
  try{sessionStorage.setItem(HRK,JSON.stringify(rules))}catch(e){}
  if(matchesHideRule(rules)){
    HIDDEN_BY_URL=true;
    if(isOpen&&typeof toggle==='function')toggle(false);
    var l=document.querySelector('.ai-chat-launcher');
    var p=document.querySelector('.ai-chat-panel');
    var o=document.querySelector('.ai-chat-overlay');
    if(l)l.style.display='none';
    if(p)p.style.display='none';
    if(o)o.style.display='none';
  }
}).catch(function(){});
var SHOP=C.shopDomain||'';
var GREET=C.greeting||'Hi! I\'m your personal shopping assistant.';
var GREET_LOGGED=C.greetingLoggedIn||'';
var GREETCTA=C.greetingCta||'What can I help you find today?';
var AVATAR=C.avatarUrl||'';
var BANNER=C.bannerUrl||'';
var NAME=C.assistantName||'AI Shopping Assistant';
var LPLACE=C.launcherPlaceholder||'How can I help you today?';
var IPLACE=C.inputPlaceholder||'How can I help you today?';
var POS=C.widgetPosition||'bottom-center';
var CTA1L=C.cta1Label||'';var CTA1M=C.cta1Message||'';var CTA1I=C.cta1Icon||'';
var CTA2L=C.cta2Label||'';var CTA2M=C.cta2Message||'';var CTA2I=C.cta2Icon||'';
var CTA3L=C.cta3Label||'';var CTA3M=C.cta3Message||'';var CTA3I=C.cta3Icon||'';
var CTA4L=C.cta4Label||'';var CTA4M=C.cta4Message||'';var CTA4I=C.cta4Icon||'';
var HINT=C.ctaHint||'';
var HINT_LOGGED=C.ctaHintLoggedIn||'';
var QP1L=C.quickPick1Label||'';var QP1M=C.quickPick1Message||'';
var QP2L=C.quickPick2Label||'';var QP2M=C.quickPick2Message||'';
var QP3L=C.quickPick3Label||'';var QP3M=C.quickPick3Message||'';
var QP4L=C.quickPick4Label||'';var QP4M=C.quickPick4Message||'';
var SHOWBAN=C.showBanner!==false;
var DISCL=C.disclaimerText||'';
var PRIVURL=C.privacyUrl||'/pages/privacy-policy';
var LWIDTH=C.launcherWidth||'500';
var CWIDTH=C.chatWidth||LWIDTH;
var HIDE_MOBILE=C.hideOnMobile===true;
var SUPPORT_URL=C.supportUrl||'';
/* The button's text comes from the app's Settings → Support link (widget-config). */
var SUPPORT_LABEL='Chat with Aetrex Support';
var CUST_LOGGED_IN=C.customerLoggedIn===true;
var CUST_NAME=C.customerFirstName||'';
var CUST_LOGIN_URL=C.customerLoginUrl||'/account/login';
var CUST_LOGOUT_URL=C.customerLogoutUrl||'/account/logout';
/* Log in and come back to this page. */
function loginUrl(){return CUST_LOGIN_URL+(CUST_LOGIN_URL.indexOf('?')>-1?'&':'?')+'return_url='+encodeURIComponent(location.pathname+location.search)}
// "horizontal" = legacy thumbnail-left layout, capped at 3 cards.
// "showcase" = square image on top, scroll-snap row, up to 10 cards.
// Set from /widget-config response; merchants pick this in the admin.
// Hydrated synchronously from localStorage so restored history on
// page refresh renders with the right style before fetch resolves.
var PRODUCT_CARD_STYLE='horizontal';
try{var _cachedStyle=localStorage.getItem(PCSK);if(_cachedStyle==='showcase')PRODUCT_CARD_STYLE='showcase'}catch(e){}
/* Helpful / Not helpful under replies — the admin's "feedback buttons" setting. */
var SHOW_FEEDBACK=true;
var KLAVIYO_COMPANY_ID='';
var KLAVIYO_LIST_ID='';
/* Welcome-panel intro effect. Overridden by /widget-config response.
   Style: "none" disables; "internal" renders a gradient ring INSIDE
   the panel; "external" renders a blurred halo OUTSIDE it.
   Tuning fields control thickness, halo extent, animation speed,
   and the three timing phases (fade-in / hold / fade-out). */
var WELCOME_INTRO=true;
var SK='hajirai_chat_session';
var HK='hajirai_chat_history';

function $(s,c){return(c||document).querySelector(s)}
function el(t,cl,h){var e=document.createElement(t);if(cl)e.className=cl;if(h)e.innerHTML=h;return e}
/* esc() output is interpolated into double- AND single-quoted HTML
   attributes throughout this file (data-message, alt, aria-label,
   src), so it must escape quotes too — text-node serialization only
   covers & < >, and a product title like `10" Boot` (or any server
   string containing a quote) would otherwise break out of the
   attribute and inject markup. */
function esc(s){var d=document.createElement('div');d.appendChild(document.createTextNode(s));return d.innerHTML.replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function fmt(c){return'$'+(c/100).toFixed(2)}
function safeUrl(u){var s=String(u||'').replace(/\s+/g,'');return /^(https?:\/\/|\/)/i.test(s)?s.replace(/"/g,'&quot;'):''}
/* Links the assistant writes: never protocol-relative (//other-site). */
function safeLink(u){var s=String(u||'').replace(/\s+/g,'');return /^\/\//.test(s)?'':safeUrl(s)}
function md(t){if(!t)return'';return t.replace(/^\s*\|[\s\-:|]+\|\s*$/gm,'').replace(/\|[\s\-:|]{3,}\|/g,'').replace(/\|([^|\n]+(?:\|[^|\n]+)+)\|/g,function(_,row){var cells=row.split('|').map(function(s){return s.trim()}).filter(Boolean);if(cells.length<2)return cells.join('');return '\n- **'+cells[0]+'** — '+cells.slice(1).join(' — ')}).replace(/([^\n])[ \t]+(\*\*[^*\n]+?:\*\*)/g,'$1\n\n$2').replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\*(.+?)\*/g,'<em>$1</em>').replace(/\[([^\]]+)\]\(([^)]+)\)/g,function(_,txt,url){var u=safeLink(url);return u?'<a href="'+u+'" target="_blank" rel="noopener">'+txt+'</a>':txt}).replace(/^[-*] (.+)$/gm,'<li>$1</li>').replace(/(<li>.*<\/li>)/gs,'<ul>$1</ul>').replace(/\n{2,}/g,'</p><p>').replace(/\n/g,'<br>')}

/* Storage can be blocked (private modes, strict cookie settings): the
   session id then lives in memory for this page. */
var _memSess='';
function getSess(){var id='';try{id=localStorage.getItem(SK)||''}catch(e){}if(!id)id=_memSess;if(!id){id='sess_'+Date.now()+'_'+Math.random().toString(36).slice(2,10);try{localStorage.setItem(SK,id)}catch(e){}}_memSess=id;return id}
function saveH(m){try{localStorage.setItem(HK,JSON.stringify(m.slice(-50)))}catch(e){}}
function loadH(){try{return JSON.parse(localStorage.getItem(HK))||[]}catch(e){return[]}}

/* Storefront root (Shopify Markets can serve the shop under /en-ca/ etc.). */
var SHOP_ROOT=(window.Shopify&&window.Shopify.routes&&window.Shopify.routes.root)||'/';
/* Tag the cart so an order that follows a chat add/click is attributed
   ("SEoS" order tag via the orders/create webhook). Best-effort. */
function markChatAttributed(){
  try{fetch(SHOP_ROOT+'cart/update.js',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({attributes:{_seos_attributed:'1'}}),keepalive:true,credentials:'same-origin'}).catch(function(){})}catch(_){}
}
/* Add one variant to the cart. Resolves with the added line; rejects with
   Shopify's own message (e.g. "only 2 left") on a 422. */
function addToCart(vid,qty){
return fetch(SHOP_ROOT+'cart/add.js',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({items:[{id:parseInt(vid,10),quantity:qty||1}]})})
.then(function(r){return r.json().catch(function(){return{}}).then(function(d){if(!r.ok){var err=new Error(d.description||d.message||'Could not add to cart');err.status=r.status;throw err}return d})})
.then(function(d){markChatAttributed();document.dispatchEvent(new CustomEvent('cart:refresh'));document.dispatchEvent(new CustomEvent('cart:updated'));return fetch(SHOP_ROOT+'cart.js',{credentials:'same-origin'}).then(function(r){return r.json()}).then(function(cart){document.querySelectorAll('[data-cart-count],.cart-count,.header__cart-count,.cart-count-bubble span[aria-hidden]').forEach(function(e){e.textContent=cart.item_count});return d}).catch(function(){return d})})
}

var assistantBubbleAvatar=AVATAR?'<img src="'+safeUrl(AVATAR)+'" alt="" role="presentation" aria-hidden="true" style="width:100%;height:100%;object-fit:cover;border-radius:50%">':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" role="presentation" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

/* A clean AI sparkle: one four-point star and a small twinkle. */
function aiSparkle(){return '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11 3.5Q11.9 11.1 19.5 12 11.9 12.9 11 20.5 10.1 12.9 2.5 12 10.1 11.1 11 3.5Z"/><path class="ai-chat-twinkle" d="M19 2.5Q19.35 4.65 21.5 5 19.35 5.35 19 7.5 18.65 5.35 16.5 5 18.65 4.65 19 2.5Z"/></svg>';}
/* The assistant's mark: an airy glass bubble holding a soft folded ribbon
   whose edges blush pink, violet and cyan (Siri-like, on light). It's alive:
   the ribbon keeps reshaping, a faint second ribbon moves out of step, the
   edge colors drift, the whole turns slowly and a highlight glides around
   the bubble's rim. In the text box only the ribbon shows — no circle, no
   rim. Still for shoppers who prefer reduced motion. `id` keeps each copy's
   gradients separate. */
var ORB_STILL=!!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches);
function aiOrb(id,rim){
  /* The store's orb artwork (assets/assistant-orb.png), animated in the
     stylesheet; the drawn version below is the fallback. */
  if(safeUrl(C.orbUrl))return '<span class="ai-orb ai-orb--img" aria-hidden="true"><img src="'+safeUrl(C.orbUrl)+'" alt="" draggable="false"></span>';
  var g=function(n){return 'url(#'+id+n+')'};
  var A=['M11.5 24.5C8.8 15.5 15 9 22 10C28.2 10.9 31.3 15.9 29.3 21C27.9 24.6 24.4 26.6 21.3 26.5C23.9 24.1 24.4 20.5 21.8 18.9C18.8 17.1 14.5 19.2 11.5 24.5Z',
         'M10.5 23C9.5 13.5 16.5 8 23 9.5C29.5 11 32 17 29.8 22C28 25.8 24 27.5 20.8 27C23.5 24.5 23.6 21 21.2 19.6C18 17.8 13.5 19 10.5 23Z',
         'M12.5 25.5C9 17 14 10.5 21 10.8C27.5 11 30.5 14.8 29.6 19.8C28.8 24 25.5 26.8 22 27.2C24.6 24.6 25.2 21 22.6 19.4C19.5 17.5 15.5 20 12.5 25.5Z'];
  var B=['M20.3 18.9C23.2 20.3 23.1 24.2 20.8 26.6C19.2 28.8 17 30.5 14.5 31.2C17.4 29 19 25.9 18.9 22.8C18.8 21.2 19.2 19.7 20.3 18.9Z',
         'M21 19.6C24.3 21.4 24 25.6 21.5 27.8C19.6 29.7 17.2 31 14.2 31.2C17.6 29.4 19.6 26.4 19.7 23.3C19.8 21.7 20 20.4 21 19.6Z',
         'M19.8 18.6C22.6 19.8 22.3 23.5 20.1 25.9C18.6 28 16.6 29.8 15.2 31.6C17.1 29.2 18.4 25.6 18.3 22.4C18.3 20.8 18.8 19.3 19.8 18.6Z'];
  var spline='keyTimes="0;.33;.66;1" calcMode="spline" keySplines=".45 0 .55 1;.45 0 .55 1;.45 0 .55 1"';
  var morph=function(v,dur,begin){return ORB_STILL?'':'<animate attributeName="d" values="'+v[0]+';'+v[1]+';'+v[2]+';'+v[0]+'" dur="'+dur+'s" begin="'+(begin||0)+'s" repeatCount="indefinite" '+spline+'/>'};
  var hue=function(vals,dur){return ORB_STILL?'':'<animate attributeName="stop-color" values="'+vals+'" dur="'+dur+'s" repeatCount="indefinite"/>'};
  var path=function(v,fill,op,sw,dur,begin){return '<path d="'+v[0]+'" fill="'+g(fill)+'" stroke="'+g('e')+'" stroke-opacity="'+op+'" stroke-width="'+sw+'">'+morph(v,dur,begin)+'</path>'};
  return '<svg class="ai-orb'+(rim?' has-rim':'')+'" viewBox="'+(rim?'0 0 40 40':'7 7 26 26')+'" aria-hidden="true" focusable="false"><defs>'+
    '<radialGradient id="'+id+'r"><stop offset=".72" stop-color="#fff" stop-opacity="0"/><stop offset=".9" stop-color="#ddd2ff" stop-opacity=".4"/><stop offset="1" stop-color="#c2b2ff" stop-opacity=".6"/></radialGradient>'+
    '<linearGradient id="'+id+'h" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#ff9fd0" stop-opacity=".9"/><stop offset=".75" stop-color="#7fe8ff" stop-opacity=".8"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>'+
    '<linearGradient id="'+id+'t" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff7ac0" stop-opacity=".38">'+hue('#ff7ac0;#b48bff;#6fdcff;#ff7ac0',9)+'</stop><stop offset=".55" stop-color="#b48bff" stop-opacity=".24">'+hue('#b48bff;#6fdcff;#ff7ac0;#b48bff',9)+'</stop><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>'+
    '<linearGradient id="'+id+'u" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#5fe3ff" stop-opacity=".38">'+hue('#5fe3ff;#ff8ccc;#a07bff;#5fe3ff',9)+'</stop></linearGradient>'+
    '<linearGradient id="'+id+'e" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff5fae">'+hue('#ff5fae;#8a5cff;#3fd6ff;#ff5fae',7)+'</stop><stop offset=".5" stop-color="#8a5cff">'+hue('#8a5cff;#3fd6ff;#ff5fae;#8a5cff',7)+'</stop><stop offset="1" stop-color="#3fd6ff">'+hue('#3fd6ff;#ff5fae;#8a5cff;#3fd6ff',7)+'</stop></linearGradient>'+
    '<filter id="'+id+'b" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation=".22"/></filter>'+
    '</defs>'+
    (rim?'<circle cx="20" cy="20" r="19" fill="'+g('r')+'"/><circle cx="20" cy="20" r="18.6" fill="none" stroke="#c7b6ff" stroke-opacity=".35" stroke-width=".5"/>'+
      '<g class="ai-orb__shine"><circle cx="20" cy="20" r="18.4" fill="none" stroke="'+g('h')+'" stroke-width=".9" stroke-linecap="round" stroke-dasharray="22 94"/></g>':'')+
    '<g class="ai-orb__spin"><g class="ai-orb__ghost" transform="rotate(165 20 20)" opacity=".38" filter="'+g('b')+'">'+path(A,'t',.4,.35,8.5,-3)+'</g>'+
    '<g class="ai-orb__ribbon" filter="'+g('b')+'">'+path(A,'t',.5,.45,7)+path(B,'u',.45,.4,7)+'</g></g></svg>';
}
/* Build launcher */
var launcher=el('div','ai-chat-launcher ai-chat-launcher--'+POS);
launcher.style.width=LWIDTH+'px';
launcher.style.maxWidth='calc(100vw - 32px)';
/* Bar: avatar, prompt, ×. The × folds it into a round bubble (the orb) —
   a small dark circle with a softly breathing AI sparkle — remembered
   across pages. */
launcher.innerHTML='<div class="ai-chat-launcher__icon is-orb" aria-hidden="true">'+aiOrb('aio1',false)+'</div><button type="button" class="ai-chat-launcher__text" aria-label="'+esc(LPLACE)+' — open the shopping assistant">'+esc(LPLACE)+'</button><button type="button" class="ai-chat-launcher__close" aria-label="Minimize to a bubble"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>'+
  '<span class="ai-chat-launcher__orb" aria-hidden="true">'+aiOrb('aio2',true)+'</span>';

/* Build panel */
var panel=el('div','ai-chat-panel ai-chat-panel--'+POS);
var panelW=Math.max(parseInt(CWIDTH)||parseInt(LWIDTH)||500,360);
panel.style.width=panelW+'px';
panel.style.maxWidth='calc(100vw - 16px)';
panel.setAttribute('role','dialog');
panel.setAttribute('aria-label','AI Shopping Assistant');
panel.setAttribute('aria-modal','true');
// Inherit page language so screen readers announce content correctly.
// Falls back to <html lang> or 'en' if neither is set.
panel.setAttribute('lang',(document.documentElement.getAttribute('lang')||navigator.language||'en').split('-')[0]);

var headerAv=safeUrl(AVATAR)?'<div class="ai-chat-header__avatar"><img src="'+safeUrl(AVATAR)+'" alt="'+esc(NAME)+'"></div>':'<div class="ai-chat-header__avatar ai-chat-header__avatar--placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div>';

var loginPillHtml='';
if(CUST_LOGGED_IN&&CUST_NAME){
  loginPillHtml='<span class="ai-chat-header__vip-pill" title="Logged in">Hi '+esc(CUST_NAME)+'!</span>';
}else if(!CUST_LOGGED_IN){
  loginPillHtml='<a class="ai-chat-header__login-pill" href="'+esc(loginUrl())+'">Log in</a>';
}

panel.innerHTML=
'<div class="ai-chat-header">'+headerAv+'<div class="ai-chat-header__info"><div class="ai-chat-header__name">'+esc(NAME)+'</div></div><div class="ai-chat-header__actions">'+loginPillHtml+'<button class="ai-chat-header__btn ai-chat-menu-btn" aria-label="Menu" title="Options"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg></button><button class="ai-chat-header__btn ai-chat-close-btn" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div></div>'+
'<div class="ai-chat-messages" role="log" aria-live="polite"></div>'+
'<div class="ai-chat-typing"><div class="ai-chat-msg-avatar">'+assistantBubbleAvatar+'</div><div class="ai-chat-typing-dots"><span class="ai-chat-typing-dot"></span><span class="ai-chat-typing-dot"></span><span class="ai-chat-typing-dot"></span></div><span class="ai-chat-typing-text" aria-live="polite"></span></div>'+
'<div class="ai-chat-input-area"><div class="ai-chat-input-wrap"><div class="ai-chat-input-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></div><textarea class="ai-chat-input" rows="1" placeholder="'+esc(IPLACE)+'" aria-label="Type your message" autocorrect="off" autocapitalize="off" spellcheck="false"></textarea></div><button class="ai-chat-send" aria-label="Send"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button></div>'+
(DISCL?'<div class="ai-chat-footer">'+esc(DISCL)+' <a href="'+(safeUrl(PRIVURL)||'/policies/privacy-policy')+'">Privacy Policy</a></div>':'');

/* Build overlay */
var overlay=el('div','ai-chat-overlay');

/* Menu dropdown */
var menu=el('div','ai-chat-menu');
menu.setAttribute('role','menu');
menu.style.display='none';
/* Built each time it opens, so it matches who's here and what's saved. */
function menuHtml(){
  var MI={
    chat:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    fit:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0115.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 01-15.5 6.2L3 16"/><path d="M3 21v-5h5"/></svg>',
    user:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0116 0"/></svg>',
    out:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3"/><path d="M10 17l-5-5 5-5"/><path d="M5 12h11"/></svg>'
  };
  function item(action,icon,label){return '<button type="button" role="menuitem" class="ai-chat-menu-item" data-action="'+action+'">'+icon+'<span>'+esc(label)+'</span></button>'}
  var h=item('clear',MI.chat,'Start a new chat');
  if(ff&&savedFit())h+=item('refit',MI.fit,'Retake my orthotic FIT');
  h+='<div class="ai-chat-menu-sep" role="separator"></div>';
  if(CUST_LOGGED_IN)h+=(CUST_NAME?'<div class="ai-chat-menu-who">Signed in as '+esc(CUST_NAME)+'</div>':'')+item('logout',MI.out,'Log out');
  else h+=item('login',MI.user,'Log in');
  return h;
}
panel.style.position='fixed';
panel.appendChild(menu);

document.body.appendChild(overlay);
document.body.appendChild(panel);
document.body.appendChild(launcher);

/* Bubble mode: the × folds the bar into a bubble for the rest of this
   visit. Tapping the bubble opens the chat and brings the bar back; a new
   visit starts with the bar. The bubble keeps clear of other apps'
   floating buttons in its corner (help chat, feedback tabs): it sits just
   above the highest one it would otherwise overlap. */
var LBUBBLE_KEY='hajirai_launcher_bubble';
try{localStorage.removeItem(LBUBBLE_KEY)}catch(e){}/* was remembered forever */
/* The bar holds two buttons (open, minimize), so the bar itself isn't one;
   the round bubble is a single control, so it is the button. */
function launcherA11y(){
  if(launcher.classList.contains('is-bubble')){launcher.setAttribute('role','button');launcher.setAttribute('tabindex','0');launcher.setAttribute('aria-label','Open the AI shopping assistant')}
  else{launcher.removeAttribute('role');launcher.removeAttribute('tabindex');launcher.removeAttribute('aria-label')}
}
function setLauncherBubble(on){
  try{if(on)sessionStorage.setItem(LBUBBLE_KEY,'1');else sessionStorage.removeItem(LBUBBLE_KEY)}catch(e){}
  launcher.classList.toggle('is-bubble',!!on);
  launcherA11y();
  if(on)launcher.title='Ask AI';else launcher.removeAttribute('title');
  placeLauncher();
}
function floatingAt(x,y){
  var found=[];
  var list=document.elementsFromPoint?document.elementsFromPoint(x,y):[];
  var vw=window.innerWidth,vh=window.innerHeight;
  for(var i=0;i<list.length;i++){
    var el=list[i];
    if(el===document.body||el===document.documentElement||launcher.contains(el)||panel.contains(el)||el===overlay)continue;
    var r=el.getBoundingClientRect();
    if(r.width*r.height>vw*vh*0.25)continue;/* page content, not a floating button */
    for(var a=el;a&&a!==document.body;a=a.parentElement){
      var pos=getComputedStyle(a).position;
      if(pos==='fixed'||pos==='sticky'){found.push(r);break}
    }
  }
  return found;
}
/* Fixed-position floating things near the bubble (direct children of <body>
   and any fixed iframes — help-chat widgets are usually one of those). */
function floatingNear(r){
  var out=[];
  var cands=[].slice.call(document.body.children).concat([].slice.call(document.querySelectorAll('iframe')));
  for(var i=0;i<cands.length;i++){
    var el=cands[i];
    if(el===launcher||el===panel||el===overlay||launcher.contains(el)||panel.contains(el))continue;
    var cs=getComputedStyle(el);
    if(cs.position!=='fixed'||cs.display==='none'||cs.visibility==='hidden'||+cs.opacity===0)continue;
    var b=el.getBoundingClientRect();
    if(!b.width||!b.height||b.width*b.height>window.innerWidth*window.innerHeight*0.25)continue;
    if(b.right<=r.left||b.left>=r.right||b.bottom<=r.top||b.top>=r.bottom)continue;
    out.push(b);
  }
  return out;
}
function placeLauncher(){
  launcher.style.bottom='';
  if(!launcher.classList.contains('is-bubble'))return;
  for(var pass=0;pass<4;pass++){
    var r=launcher.getBoundingClientRect();
    var hits=[].concat(floatingNear(r),floatingAt(r.left+r.width/2,r.top+r.height/2),floatingAt(r.left+6,r.top+6),floatingAt(r.right-6,r.bottom-6));
    if(!hits.length)return;
    var top=Math.min.apply(null,hits.map(function(h){return h.top}));
    launcher.style.bottom=Math.round(window.innerHeight-top+12)+'px';
  }
}
try{if(sessionStorage.getItem(LBUBBLE_KEY)==='1'){launcher.classList.add('is-bubble');launcher.title='Ask AI'}}catch(e){}
launcherA11y();
window.addEventListener('resize',placeLauncher);
/* Other apps' buttons (Zendesk and the like) load late — often only after
   the first scroll or tap — and fade or slide in, so no single moment is
   the right one to look. While the bubble shows, check every couple of
   seconds (a few rectangle reads; nothing moves unless it has to). */
setInterval(function(){
  if(launcher.classList.contains('is-bubble')&&!document.hidden)placeLauncher();
},2000);

/* Hide on mobile if configured */
var isMobileHidden=false;
function checkMobileHide(){
  if(!HIDE_MOBILE)return;
  var mobile=window.innerWidth<768;
  if(mobile&&!isMobileHidden){
    launcher.style.display='none';
    panel.style.display='none';
    overlay.style.display='none';
    isMobileHidden=true;
  }else if(!mobile&&isMobileHidden&&!HIDDEN_BY_URL){
    launcher.style.display='';
    panel.style.display='';
    overlay.style.display='';
    isMobileHidden=false;
  }
}
checkMobileHide();
window.addEventListener('resize',checkMobileHide);

/* Custom launcher: any element with data-open-ai-chat opens the chatbot */
document.addEventListener('click',function(e){
  var trigger=e.target.closest('[data-open-ai-chat]');
  if(!trigger)return;
  e.preventDefault();
  if(HIDDEN_BY_URL)return;
  if(isMobileHidden){
    launcher.style.display='';panel.style.display='';overlay.style.display='';isMobileHidden=false;
  }
  if(typeof toggle==='function')toggle(true);
});

/* Cache refs */
var msgsEl=$('.ai-chat-messages',panel);
var typingEl=$('.ai-chat-typing',panel);
var typingTextEl=$('.ai-chat-typing-text',panel);
var inputEl=$('.ai-chat-input',panel);
var sendBtn=$('.ai-chat-send',panel);
var closeBtn=$('.ai-chat-close-btn',panel);
var menuBtn=$('.ai-chat-menu-btn',panel);

/* Typing hint rotator — shows reassuring text after 4s, rotates every 4s */
var TYPING_HINTS=['Still looking…','Almost there…','Just a moment…','Thanks for your patience…'];
var typingHintTimer=null,typingHintIdx=0;
function clearTypingHints(){
  if(typingHintTimer){clearTimeout(typingHintTimer);typingHintTimer=null}
  typingHintIdx=0;
  if(typingTextEl){typingTextEl.textContent='';typingTextEl.classList.remove('visible')}
}
function scheduleTypingHint(delay){
  typingHintTimer=setTimeout(function tick(){
    if(!typingEl.classList.contains('visible')){clearTypingHints();return}
    if(typingTextEl){
      typingTextEl.textContent=TYPING_HINTS[typingHintIdx%TYPING_HINTS.length];
      typingTextEl.classList.add('visible');
    }
    typingHintIdx++;
    typingHintTimer=setTimeout(tick,4000);
  },delay);
}
try{
  var typingObserver=new MutationObserver(function(){
    if(typingEl.classList.contains('visible')){clearTypingHints();scheduleTypingHint(4000)}
    else{clearTypingHints()}
  });
  typingObserver.observe(typingEl,{attributes:true,attributeFilter:['class']});
}catch(e){}

/* The chat belongs to whoever was signed in when it happened. When that
   customer signs out (or someone else signs in on this device), their chat
   and size history don't follow to the next person. */
var OWNER_KEY='hajirai_chat_owner',TF_LAST='hajirai_tf_last';
function forgetPersonal(){try{localStorage.removeItem(HK);localStorage.removeItem(SK);localStorage.removeItem(TF_LAST)}catch(e){}_memSess=''}
(function(){
  var now=CUST_LOGGED_IN?'c:'+String(C.customerId||CUST_NAME||'1'):'guest',was=null;
  try{was=localStorage.getItem(OWNER_KEY)}catch(e){}
  if(was&&was!=='guest'&&was!==now)forgetPersonal();
  try{localStorage.setItem(OWNER_KEY,now)}catch(e){}
})();
var isOpen=false,isStreaming=false,messages=loadH(),abortCtrl=null;
var lastUserMessage='',errorRetryCount=0;
/* An old "away for a while" marker from earlier versions — not used. */
try{localStorage.removeItem('hajirai_chat_last_msg')}catch(e){}

/* Multilingual rotator for the welcome CTA. Lead frame is whatever
   the merchant typed in the theme block (defaults to English). The
   remaining frames are fixed translations of the default phrase
   ("What can I help you find today?") into Spanish, Arabic, Japanese,
   Hebrew, Hindi, and Farsi. RTL languages get dir="rtl" so they align
   correctly. The rotator stops on its own when the welcome screen
   leaves the DOM (first user message, refresh, etc.) and is restarted
   each time buildWelcome runs. */
/* Frame 0 is the merchant's English (preserves any custom text).
   Frames 1..N come from /widget-config — server-side Haiku translations
   of the merchant's actual greetingCta, cached on ShopConfig and
   regenerated whenever the phrase changes. We start English-only;
   the running rotator picks up new frames on its next tick once the
   widget-config fetch resolves. */
var GREET_CTA_FRAMES=[{text:GREETCTA,dir:'ltr',code:'en'}];
var GREET_CTA_ROTATE=C.rotateGreetingCta!==false;
var greetCtaTimer=null;
var greetCtaIdx=0;
function stopGreetCtaRotator(){if(greetCtaTimer){clearTimeout(greetCtaTimer);greetCtaTimer=null}}
/* Every time the home screen is seen it opens in English and holds it for
   3s, then shows the other languages; each return to English holds 3s
   again. It only runs while the chat is open. */
var GREET_EN_HOLD=3000,GREET_OTHER_HOLD=2200,greetGen=0;
function showGreetFrame(node,f,fade){
  if(!fade){node.textContent=f.text;node.setAttribute('dir',f.dir);node.setAttribute('lang',f.code);node.classList.remove('is-fading');return}
  node.classList.add('is-fading');
  var gen=greetGen;
  setTimeout(function(){
    if(!node.isConnected||gen!==greetGen)return;
    node.textContent=f.text;node.setAttribute('dir',f.dir);node.setAttribute('lang',f.code);
    node.classList.remove('is-fading');
  },250);
}
function startGreetCtaRotator(){
  stopGreetCtaRotator();
  greetGen++;
  greetCtaIdx=0;
  var node=$('.ai-chat-welcome__greeting-cta',msgsEl);
  if(node)showGreetFrame(node,GREET_CTA_FRAMES[0],false);
  if(!GREET_CTA_ROTATE||!isOpen)return;
  /* Translations arrive with widget-config; until then English just stays. */
  greetCtaTimer=setTimeout(function tick(){
    var n=$('.ai-chat-welcome__greeting-cta',msgsEl);
    if(!n||!isOpen){stopGreetCtaRotator();return}
    if(GREET_CTA_FRAMES.length>1){
      greetCtaIdx=(greetCtaIdx+1)%GREET_CTA_FRAMES.length;
      showGreetFrame(n,GREET_CTA_FRAMES[greetCtaIdx],true);
    }
    greetCtaTimer=setTimeout(tick,greetCtaIdx===0?GREET_EN_HOLD:GREET_OTHER_HOLD);
  },GREET_EN_HOLD);
}

/* Welcome: banner, a greeting, the two personal fit tools (True Fit for
   shoe sizes, FITFinder for orthotics \u2014 shown only where the store has them),
   then the store's starting questions and quick picks. One column, one
   type scale, one card style. */
var WI={
  arrow:'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9 6l6 6-6 6"/></svg>',
  ruler:'<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><g transform="rotate(-45 12 12)"><rect x="1.5" y="8.5" width="21" height="7" rx="2"/><path d="M6 8.5v2.5M10 8.5v3.5M14 8.5v2.5M18 8.5v3.5"/></g></svg>',
  shoe:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 16.5V8.4c0-.7.6-1.2 1.3-1 1.3.4 1.9 1.8 3.2 1.8 1 0 1.3-2.7 2.6-2.7 1.2 0 2 2.3 3.6 3.4 1.6 1.1 4.3 1.4 6 2 1.1.4 1.6 1.4 1.6 2.6v2"/><path d="M3 16.5h18.3"/><path d="M3 16.5v.7c0 .7.6 1.3 1.3 1.3h15.6c.8 0 1.4-.6 1.4-1.4v-.6"/></svg>',
  /* A pair of orthotic insoles, arch support shaded on the inner sides. */
  insole:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><g transform="translate(12.7 2.55)"><path d="M3.6.3C6 0 7.8 1.8 7.9 4.4 8 6.8 7.2 8.6 7.1 10.6 7 12.6 7.6 14.4 7.3 16.2 7 18 5.8 18.9 4.4 18.9 2.9 18.9 1.8 18 1.7 16.4 1.6 14.8 2.6 13.4 2.6 11.8 2.6 10.3 1.2 9.2.6 7.2 0 5 .9.7 3.6.3z"/><path d="M.9 8.2C2 9.6 2.7 10.6 2.6 11.8c0 1.6-1 3-.9 4.4.9-.8 2.2-2.2 2.3-4.2.1-1.6-1.4-3-3.1-3.8z" fill="currentColor" stroke="none" opacity=".16"/></g><g transform="translate(11.3 2.55) scale(-1 1)"><path d="M3.6.3C6 0 7.8 1.8 7.9 4.4 8 6.8 7.2 8.6 7.1 10.6 7 12.6 7.6 14.4 7.3 16.2 7 18 5.8 18.9 4.4 18.9 2.9 18.9 1.8 18 1.7 16.4 1.6 14.8 2.6 13.4 2.6 11.8 2.6 10.3 1.2 9.2.6 7.2 0 5 .9.7 3.6.3z"/><path d="M.9 8.2C2 9.6 2.7 10.6 2.6 11.8c0 1.6-1 3-.9 4.4.9-.8 2.2-2.2 2.3-4.2.1-1.6-1.4-3-3.1-3.8z" fill="currentColor" stroke="none" opacity=".16"/></g></svg>',
  box:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/></svg>',
  tag:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20.6 13.4l-7.2 7.2a2 2 0 01-2.8 0L3 13V3h10l7.6 7.6a2 2 0 010 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>',
  ret:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 010 10h-3"/></svg>',
  search:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>',
  target:'<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/></svg>',
  spark:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 3l1.8 4.9L19 9.7l-4.9 1.8L12 16.4l-1.8-4.9L5 9.7l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>',
  truck:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2 6h11v10H2z"/><path d="M13 9h4.5l3.5 3.5V16h-8"/><circle cx="6.5" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/></svg>',
  gift:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3" y="8" width="18" height="4" rx="1"/><path d="M5 12v8h14v-8M12 8v12"/><path d="M12 8C10.5 4 7 4.5 7 6.5S10 8 12 8zm0 0c1.5-4 5-3.5 5-1.5S14 8 12 8z"/></svg>',
  heart:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 20s-7.5-4.6-9.2-9.3C1.7 7.5 3.8 4.5 7 4.5c2 0 3.4 1.1 5 3 1.6-1.9 3-3 5-3 3.2 0 5.3 3 4.2 6.2C19.5 15.4 12 20 12 20z"/></svg>',
  star:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>',
  chat:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 15a2 2 0 01-2 2H8l-4 3.5V6a2 2 0 012-2h12a2 2 0 012 2z"/></svg>',
  pin:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0113 0c0 4.8-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></svg>'
};
/* Icons a store can pick for each "Start here" button (theme editor). */
var CTA_ICONS={search:'search',sizing:'ruler',shoe:'shoe',orthotic:'insole',order:'box',shipping:'truck',returns:'ret',deals:'tag',gift:'gift',heart:'heart',star:'star',support:'chat',store:'pin',sparkle:'spark'};
/* True Fit's own mark, as on the product pages' "Find my size" tile. */
function tfLogo(size){
  return C.trueFitLogo?'<img class="ai-chat-tf-logo" src="'+safeUrl(C.trueFitLogo)+'" alt="" width="'+size+'" height="'+size+'" aria-hidden="true">':WI.ruler.replace(/22/g,String(size));
}
function ctaIcon(label,pick){
  var key=CTA_ICONS[String(pick||'')];
  if(key)return key==='ruler'?WI.ruler.replace(/22/g,'18'):WI[key];
  /* Automatic: chosen from the button's words. */
  var l=String(label||'').toLowerCase();
  if(/orthotic|insole|insert|footbed/.test(l))return WI.insole;
  if(/siz|fit/.test(l))return WI.ruler.replace(/22/g,'18');
  if(/order|track|ship|deliver/.test(l))return WI.box;
  if(/sale|deal|offer|discount/.test(l))return WI.tag;
  if(/return|exchange|refund/.test(l))return WI.ret;
  if(/shoe|sneaker|sandal|boot|footwear/.test(l))return WI.shoe;
  if(/find|product|search|shop|browse/.test(l))return WI.search;
  return WI.spark;
}
function buildWelcome(){
var hasBanner=!!(SHOWBAN&&BANNER&&safeUrl(BANNER));
var h='<div class="ai-chat-welcome'+(hasBanner?' has-banner':'')+'">';
if(SHOWBAN&&BANNER){
  h+='<div class="ai-chat-welcome__banner"><img src="'+safeUrl(BANNER)+'" alt=""></div>';
}
var welcomeGreeting=(CUST_LOGGED_IN&&CUST_NAME&&GREET_LOGGED&&GREET_LOGGED.trim())
  ? GREET_LOGGED.replace(/\{name\}/gi,CUST_NAME)
  : GREET;
/* The assistant's face greets the shopper here; the header shows it only
   once the chat starts (it flies up there — see flyAvatarToHeader). */
var welcomeAv=safeUrl(AVATAR)?'<img src="'+safeUrl(AVATAR)+'" alt="">':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
h+='<div class="ai-chat-welcome__intro"><div class="ai-chat-welcome__avatar-wrap" aria-hidden="true"><i class="ai-chat-avatar-glow"></i><div class="ai-chat-welcome__avatar'+(safeUrl(AVATAR)?'':' is-placeholder')+'">'+welcomeAv+'</div></div><div class="ai-chat-welcome__intro-text"><h2 class="ai-chat-welcome__title">'+esc(welcomeGreeting||('Hi, I\'m '+NAME))+'</h2>'+
   (GREETCTA?'<p class="ai-chat-welcome__greeting-cta">'+esc(GREETCTA)+'</p>':'')+'</div></div>';
h+='<div class="ai-chat-welcome__helpers" hidden></div>';
var ctas=[];
if(CTA1L&&CTA1M)ctas.push({l:CTA1L,m:CTA1M,i:CTA1I});
if(CTA2L&&CTA2M)ctas.push({l:CTA2L,m:CTA2M,i:CTA2I});
if(CTA3L&&CTA3M)ctas.push({l:CTA3L,m:CTA3M,i:CTA3I});
if(CTA4L&&CTA4M)ctas.push({l:CTA4L,m:CTA4M,i:CTA4I});
if(ctas.length){
  h+='<div class="ai-chat-welcome__section"><div class="ai-chat-welcome__label">Start here</div><div class="ai-chat-welcome__ctas">';
  for(var i=0;i<ctas.length;i++){
    h+='<button type="button" class="ai-chat-welcome__cta-btn" data-message="'+esc(ctas[i].m)+'"><span class="ai-chat-welcome__cta-icon">'+ctaIcon(ctas[i].l,ctas[i].i)+'</span><span class="ai-chat-welcome__cta-label">'+esc(ctas[i].l)+'</span><span class="ai-chat-welcome__cta-go">'+WI.arrow+'</span></button>';
  }
  h+='</div></div>';
}
var qps=[];
if(QP1L&&QP1M)qps.push({l:QP1L,m:QP1M});
if(QP2L&&QP2M)qps.push({l:QP2L,m:QP2M});
if(QP3L&&QP3M)qps.push({l:QP3L,m:QP3M});
if(QP4L&&QP4M)qps.push({l:QP4L,m:QP4M});
if(qps.length){
  h+='<div class="ai-chat-welcome__section"><div class="ai-chat-welcome__label">Popular</div><div class="ai-chat-welcome__quickpicks">';
  for(var j=0;j<qps.length;j++){
    h+='<button type="button" class="ai-chat-welcome__qp-btn" data-message="'+esc(qps[j].m)+'">'+esc(qps[j].l)+'</button>';
  }
  h+='</div></div>';
}
if(CUST_LOGGED_IN){
  if(HINT_LOGGED&&HINT_LOGGED.trim()){
    var loggedHint=HINT_LOGGED.replace(/\{name\}/gi,CUST_NAME||'');
    h+='<div class="ai-chat-welcome__hint">'+esc(loggedHint)+'</div>';
  }
}else if(HINT){
  h+='<a class="ai-chat-welcome__hint ai-chat-welcome__hint--link" href="'+esc(loginUrl())+'">'+esc(HINT)+'</a>';
}
h+='</div>';
msgsEl.innerHTML=h;
msgsEl.classList.add('is-welcome');
panel.classList.add('is-home');
renderHelpers();
/* FITFinder's config loads when the chat opens; the tool appears then. */
if(ffLoading)ffLoading.then(renderHelpers);
if(GREETCTA)startGreetCtaRotator();
}

/* The fit tools, each only where it belongs: True Fit sizes shoes (when the
   store has it), FITFinder picks orthotics (when the store has it). */
function pageTitle(){
  var og=document.querySelector('meta[property="og:title"]');
  return (og&&og.getAttribute('content'))||((document.querySelector('h1')||{}).textContent||'').trim();
}
/* A fit card: one main action; when the tool already knows the shopper, a
   small second action (Update / Retake) sits in its corner. */
function helperHtml(kind,title,sub,icon,alt){
  return '<div class="ai-chat-helper-wrap'+(alt?' has-alt':'')+'"><button type="button" class="ai-chat-helper ai-chat-helper--'+kind+(alt?' is-known':'')+'" data-helper="'+kind+'"><span class="ai-chat-helper__icon">'+icon+'</span><span class="ai-chat-helper__text"><span class="ai-chat-helper__title">'+esc(title)+'</span><span class="ai-chat-helper__sub">'+esc(sub)+'</span></span><span class="ai-chat-helper__go">'+WI.arrow+'</span></button>'+
    (alt?'<button type="button" class="ai-chat-helper__alt" data-helper="'+alt.kind+'" aria-label="'+esc(alt.aria)+'">'+esc(alt.label)+'</button>':'')+'</div>';
}
var fitResult=null;
function fitCardHtml(f){
  return '<div class="ai-chat-fit-result" role="status"><div class="ai-chat-fit-result__badge">'+esc(f.label)+'</div>'+
    '<div class="ai-chat-fit-result__text"><div class="ai-chat-fit-result__eyebrow">Your FIT \u00b7 FITFinder</div>'+
    '<div class="ai-chat-fit-result__name">'+esc(f.name||f.label)+'</div>'+
    (f.description?'<div class="ai-chat-fit-result__desc">'+esc(f.description)+'</div>':'')+
    '<div class="ai-chat-fit-result__saved">Saved \u2014 orthotic pages open on your FIT</div></div></div>';
}
function savedFit(){
  if(!ff)return null;
  var local=ffStored(),key=(local&&local.key)||ff.saved;
  for(var i=0;i<ff.fits.length;i++){if(ff.fits[i].key===key)return ff.fits[i]}
  return null;
}
/* "FIT B" → "B", for the badge. */
function fitLetter(f){var m=String(f.label||f.key||'').match(/([A-Z0-9]+)\s*$/i);return m?m[1].toUpperCase():'FIT'}
function fitTitle(f){var l=String(f.label||f.key||'');return /^fit\b/i.test(l)?l.replace(/^fit/i,'FIT'):'FIT '+l}
var helperSig='';
function helperState(){var mine=ff&&savedFit();return [tfPayload()?'tf':'',tfSizeHere(),tfKnown()?'k':'',ff?'ff':'',mine?mine.key:''].join('|')}
function renderHelpers(){
  var box=msgsEl&&msgsEl.querySelector('.ai-chat-welcome__helpers');
  if(!box)return;
  helperSig=helperState();
  var items='';
  if(tfPayload()){
    var onShoe=tfHere()&&pageHandle(),size=onShoe?tfSizeHere():'';
    if(size)items+=helperHtml('truefit','Size '+size,'Your True Fit size',tfLogo(24),{kind:'truefit-update',label:'Update',aria:'Update my size with True Fit'});
    else if(onShoe)items+=helperHtml('truefit','Find my size','True Fit \u00b7 for this shoe',tfLogo(24));
    else items+=helperHtml('truefit','Find my shoe size',tfKnown()||tfLast()?'True Fit knows your fit':'with True Fit',tfLogo(24));
  }
  if(ff){
    var mine=savedFit();
    if(mine)items+=helperHtml('fitfinder',mine.name||fitTitle(mine),'Your '+fitTitle(mine),'<span class="ai-chat-helper__mono is-letter">'+esc(fitLetter(mine))+'</span>',{kind:'fitfinder-retake',label:'Retake',aria:'Retake my orthotic FIT'});
    else items+=helperHtml('fitfinder','Find my orthotic FIT',ff.questions.length?'FITFinder \u00b7 '+ff.questions.length+' quick question'+(ff.questions.length===1?'':'s'):'with FITFinder','<span class="ai-chat-helper__mono">FIT</span>');
  }
  if(!items){box.hidden=true;box.innerHTML='';return}
  box.innerHTML='<div class="ai-chat-welcome__helper-grid">'+items+'</div>';
  box.hidden=false;
}
/* True Fit marks a known shopper's size a few seconds after the page loads,
   and a FIT can be saved on another tab: keep the cards current while the
   welcome screen is open. */
setInterval(function(){
  if(isOpen&&msgsEl&&msgsEl.classList.contains('is-welcome')&&helperState()!==helperSig)renderHelpers();
},1500);
var ffRetake=false;
function startHelper(kind){
  inputEl.disabled=false;inputEl.placeholder=IPLACE;sendBtn.disabled=false;
  var mine=savedFit(),size=tfHere()&&pageHandle()?tfSizeHere():'';
  if(kind==='truefit-update'){runTrueFit(pageTitle());return}
  if(kind==='truefit'){
    if(size)inputEl.value='True Fit recommends size '+size+' for me in the '+pageTitle()+'.';
    else if(tfHere()&&pageHandle()){runTrueFit(pageTitle());return}
    else inputEl.value='Help me find my shoe size with True Fit.';
  }else if(kind==='fitfinder-retake'||(kind==='refit')){
    ffRetake=true;
    inputEl.value='I\'d like to retake my orthotic FIT.';
  }else{
    inputEl.value=mine?'Show me orthotics in my '+fitTitle(mine)+'.':'Help me find my orthotic FIT.';
  }
  sendMessage();
}

/* Opening animation: the welcome content rises in, line by line, as the
   panel springs open (both in the stylesheet, under "OPENING ANIMATION").
   Only on the welcome screen — a chat with history opens instantly — and
   never for shoppers who prefer reduced motion (CSS media query). */
function playWelcomeIntro(){
  if(!WELCOME_INTRO)return;
  var welcomeEl=msgsEl&&msgsEl.querySelector('.ai-chat-welcome');
  if(!welcomeEl)return;
  welcomeEl.classList.remove('is-intro');
  void welcomeEl.offsetWidth;/* restart the animation on every open */
  welcomeEl.classList.add('is-intro');
  setTimeout(function(){welcomeEl.classList.remove('is-intro')},1400);
}

/* Other apps' floating buttons (help chat, accessibility, reviews) can sit
   above every layer of the page; blurred behind the open chat they show up
   as smudges on top of it. Hide those while the chat is open, restore after. */
var hiddenFloaters=[];
function hideFloaters(){
  var ours=parseInt(getComputedStyle(overlay).zIndex,10)||0;
  var kids=document.body.children;
  for(var i=0;i<kids.length;i++){
    var el=kids[i];
    if(el===panel||el===overlay||el===launcher||el.contains(panel))continue;
    var cs=getComputedStyle(el);
    if((cs.position==='fixed'||cs.position==='sticky')&&cs.visibility!=='hidden'&&(parseInt(cs.zIndex,10)||0)>=ours){
      hiddenFloaters.push([el,el.style.visibility]);
      el.style.visibility='hidden';
    }
  }
}
/* While the chat is open, the page behind it can't be reached: no tabbing
   into it, and on iPhone the keyboard bar's up/down arrows have nowhere to
   jump (they'd otherwise move the cursor to the site's search box behind
   the chat). */
var inertEls=[];
function inertPage(on){
  if(!on){for(var j=0;j<inertEls.length;j++)inertEls[j].inert=false;inertEls=[];return}
  var kids=document.body.children;
  for(var i=0;i<kids.length;i++){
    var el=kids[i];
    if(el===panel||el===overlay||el===launcher||el.contains(panel)||el.inert||/^(SCRIPT|STYLE|LINK|TEMPLATE|NOSCRIPT)$/.test(el.tagName))continue;
    el.inert=true;inertEls.push(el);
  }
}
function restoreFloaters(){
  for(var i=0;i<hiddenFloaters.length;i++)hiddenFloaters[i][0].style.visibility=hiddenFloaters[i][1];
  hiddenFloaters=[];
}

/* Keyboard: Tab stays inside the open chat, and closing returns focus to
   what opened it. The faded-out launcher can't be tabbed to. */
var focusBeforeOpen=null;
function focusables(){return [].filter.call(panel.querySelectorAll('a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'),function(n){return n.offsetParent!==null})}
panel.addEventListener('keydown',function(e){
  if(e.key!=='Tab'||!isOpen)return;
  var f=focusables();if(!f.length)return;
  var first=f[0],last=f[f.length-1];
  if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}
  else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}
});
/* Phones: iOS keeps the page height when the keyboard opens and simply
   covers the bottom of it. Size the chat to what's actually visible so the
   message bar sits right on the keyboard, with no gap and nothing hidden. */
var KB_MQ=window.matchMedia?window.matchMedia('(max-width: 600px)'):null;
function fitToKeyboard(){
  var vv=window.visualViewport;
  var kb=!!(vv&&isOpen&&KB_MQ&&KB_MQ.matches&&window.innerHeight-vv.height>120);
  panel.classList.toggle('is-kb',kb);
  if(kb){
    panel.style.setProperty('height',vv.height+'px','important');
    panel.style.setProperty('max-height',vv.height+'px','important');
    panel.style.setProperty('top',vv.offsetTop+'px','important');
    scrollBottom();
  }else{
    panel.style.removeProperty('height');panel.style.removeProperty('max-height');panel.style.removeProperty('top');
  }
}
if(window.visualViewport){
  window.visualViewport.addEventListener('resize',fitToKeyboard);
  window.visualViewport.addEventListener('scroll',fitToKeyboard);
}
function toggle(force){
var want=typeof force==='boolean'?force:!isOpen;
if(want&&HIDDEN_BY_URL)return;
isOpen=want;
if(isOpen){
  focusBeforeOpen=document.activeElement;
  loadFitfinder().then(renderHelpers);
  launcher.classList.add('hidden');
  launcher.inert=true;launcher.setAttribute('aria-hidden','true');
  panel.classList.add('open');
  overlay.classList.add('visible');
  document.body.classList.add('ai-chat-blurred');
  hideFloaters();
  inertPage(true);
  setTimeout(function(){inputEl.focus()},400);
  setTimeout(function(){inputEl.focus()},800);
  playWelcomeIntro();
  if(GREETCTA)startGreetCtaRotator();
}else{
  stopGreetCtaRotator();
  panel.classList.remove('open');
  overlay.classList.remove('visible');
  launcher.classList.remove('hidden');
  launcher.inert=false;launcher.removeAttribute('aria-hidden');
  document.body.classList.remove('ai-chat-blurred');
  restoreFloaters();
  inertPage(false);
  menu.style.display='none';
  var back=focusBeforeOpen&&document.body.contains(focusBeforeOpen)&&focusBeforeOpen!==document.body?focusBeforeOpen:(launcher.classList.contains('is-bubble')?launcher:$('.ai-chat-launcher__text',launcher)||launcher);
  focusBeforeOpen=null;
  try{back.focus({preventScroll:true})}catch(e){}
}
fitToKeyboard();
}

function scrollBottom(){requestAnimationFrame(function(){msgsEl.scrollTop=msgsEl.scrollHeight})}
/* Align the top of a message with the top of the visible area so the
   reader sees the answer first instead of landing on the feedback CTAs
   at the bottom (especially noticeable on mobile with tall answers). */
function scrollMsgTop(elm){
  if(!elm||!msgsEl)return scrollBottom();
  /* Use getBoundingClientRect-based delta — .ai-chat-messages has no
     position: relative, so elm.offsetTop is measured against a wrong
     ancestor (panel/body) and would produce a stale scrollTop value. */
  function go(){
    var elmR=elm.getBoundingClientRect();
    var msgsR=msgsEl.getBoundingClientRect();
    var top=Math.max(0,msgsEl.scrollTop+(elmR.top-msgsR.top)-8);
    if(typeof msgsEl.scrollTo==='function'){msgsEl.scrollTo({top:top,behavior:'smooth'})}
    else{msgsEl.scrollTop=top}
  }
  requestAnimationFrame(go);
  /* Re-align after product images settle — image aspect-ratio + late
     paint can shift the message position by 100s of px on mobile. */
  setTimeout(go,250);
}

/* Showcase navigation arrows.
   - Wraps the .ai-chat-products--showcase row in a positioned container.
   - Vertical position is anchored to the first card's image so the arrows
     land on the photo, not the title/CTA, at any card width.
   - Left arrow hides at scrollLeft 0; right arrow hides at end of scroll.
   - CSS scopes the visible state to >=768px hover devices. */
var ARROW_CHEVRON_PREV='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
var ARROW_CHEVRON_NEXT='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';

function showcaseWrap(productsHtml){
  return '<div class="ai-chat-products-wrap">'+
    '<button class="ai-chat-products-arrow ai-chat-products-arrow--prev" type="button" aria-label="Scroll left" hidden>'+ARROW_CHEVRON_PREV+'</button>'+
    productsHtml+
    '<button class="ai-chat-products-arrow ai-chat-products-arrow--next" type="button" aria-label="Scroll right">'+ARROW_CHEVRON_NEXT+'</button>'+
  '</div>';
}

function choicesWrap(choicesHtml){
  return '<div class="ai-chat-choices-wrap">'+
    '<button class="ai-chat-choices-arrow ai-chat-choices-arrow--prev" type="button" aria-label="Scroll choices left" hidden>'+ARROW_CHEVRON_PREV+'</button>'+
    choicesHtml+
    '<button class="ai-chat-choices-arrow ai-chat-choices-arrow--next" type="button" aria-label="Scroll choices right" hidden>'+ARROW_CHEVRON_NEXT+'</button>'+
  '</div>';
}

function updateShowcaseArrows(wrap){
  var row=wrap.querySelector('.ai-chat-products--showcase');
  if(!row||!row.clientWidth)return;
  /* Anchor on the first card's vertical center (not just the image)
     so the arrow lands in the middle of the visible card —
     between the shoe and the title — at any card width. */
  var firstCard=row.querySelector('.ai-chat-product-card');
  if(firstCard&&firstCard.offsetHeight){
    var cardR=firstCard.getBoundingClientRect();
    var wrapR=wrap.getBoundingClientRect();
    wrap.style.setProperty('--arrow-top',((cardR.top-wrapR.top)+cardR.height/2)+'px');
  }
  var prev=wrap.querySelector('.ai-chat-products-arrow--prev');
  var next=wrap.querySelector('.ai-chat-products-arrow--next');
  /* 8px tolerance — scroll-snap snaps to the first card's snap point,
     which sits at the showcase's 4px left-padding offset, not 0. */
  var atStart=row.scrollLeft<=8;
  var atEnd=row.scrollLeft+row.clientWidth>=row.scrollWidth-8;
  if(prev)prev.hidden=atStart;
  if(next)next.hidden=atEnd;
}

function initShowcaseArrows(wrap){
  var row=wrap.querySelector('.ai-chat-products--showcase');
  if(!row)return;
  var prev=wrap.querySelector('.ai-chat-products-arrow--prev');
  var next=wrap.querySelector('.ai-chat-products-arrow--next');
  function step(dir){
    var card=row.querySelector('.ai-chat-product-card');
    var delta=(card?card.offsetWidth+10:row.clientWidth*0.8)*dir;
    if(typeof row.scrollBy==='function')row.scrollBy({left:delta,behavior:'smooth'});
    else row.scrollLeft+=delta;
  }
  if(prev)prev.addEventListener('click',function(e){e.preventDefault();step(-1)});
  if(next)next.addEventListener('click',function(e){e.preventDefault();step(1)});
  row.addEventListener('scroll',function(){updateShowcaseArrows(wrap)},{passive:true});
  requestAnimationFrame(function(){updateShowcaseArrows(wrap)});
  /* Safety-net update for layouts that haven't fully settled by the
     first paint (image aspect-ratio sometimes resolves a frame late). */
  setTimeout(function(){updateShowcaseArrows(wrap)},150);
}

/* Single global resize listener — recompute arrow Y for every active wrap
   instead of leaking one listener per render. */
window.addEventListener('resize',function(){
  var wraps=document.querySelectorAll('.ai-chat-products-wrap');
  for(var i=0;i<wraps.length;i++)updateShowcaseArrows(wraps[i]);
});

/* Initialize a chip choices row for horizontal scroll feedback.
   Toggles three classes on the container based on real overflow:
     .has-overflow  — content extends past clientWidth (scroll possible)
     .at-start      — scrolled to leftmost
     .at-end        — scrolled to rightmost
   CSS uses these to:
     - hide edge fades when there's nothing to scroll into,
     - hide the right-edge fade when at-end (and left-edge when at-start),
     - show a slim scroll-position indicator (the .ai-chat-choices-track) only when has-overflow.
   The track is appended once and updated as the user scrolls. */
function initChoicesScroll(container){
  if(!container||container._choicesInited)return;
  container._choicesInited=true;
  var wrap=container.closest?container.closest('.ai-chat-choices-wrap'):null;
  var prev=wrap?wrap.querySelector('.ai-chat-choices-arrow--prev'):null;
  var next=wrap?wrap.querySelector('.ai-chat-choices-arrow--next'):null;
  /* The progress track sits AFTER the row, not inside it (so it doesn't
     scroll with the chips). It's a visible "you are here" hint. */
  var track=document.createElement('div');
  track.className='ai-chat-choices-track';
  track.innerHTML='<span class="ai-chat-choices-thumb"></span>';
  if(wrap&&wrap.parentNode)wrap.parentNode.insertBefore(track,wrap.nextSibling);
  else container.parentNode.insertBefore(track,container.nextSibling);
  var thumb=track.querySelector('.ai-chat-choices-thumb');
  function update(){
    var overflow=container.scrollWidth>container.clientWidth+1;
    container.classList.toggle('has-overflow',overflow);
    if(wrap)wrap.classList.toggle('has-overflow',overflow);
    if(!overflow){
      track.style.display='none';
      if(prev)prev.hidden=true;
      if(next)next.hidden=true;
      return
    }
    track.style.display='';
    var atStart=container.scrollLeft<=1;
    var atEnd=container.scrollLeft+container.clientWidth>=container.scrollWidth-1;
    container.classList.toggle('at-start',atStart);
    container.classList.toggle('at-end',atEnd);
    if(wrap){
      wrap.classList.toggle('at-start',atStart);
      wrap.classList.toggle('at-end',atEnd);
    }
    if(prev)prev.hidden=atStart;
    if(next)next.hidden=atEnd;
    /* Thumb width = visible / total. Position = scroll / max-scroll. */
    var ratio=container.clientWidth/container.scrollWidth;
    var thumbPct=Math.max(15,ratio*100);
    var maxScroll=container.scrollWidth-container.clientWidth;
    var posPct=maxScroll>0?(container.scrollLeft/maxScroll)*(100-thumbPct):0;
    thumb.style.width=thumbPct+'%';
    thumb.style.left=posPct+'%';
  }
  function step(dir){
    var chip=container.querySelector('.ai-chat-choice-btn');
    var delta=(chip?chip.offsetWidth+8:container.clientWidth*0.75)*dir;
    if(typeof container.scrollBy==='function')container.scrollBy({left:delta,behavior:'smooth'});
    else container.scrollLeft+=delta;
  }
  if(prev)prev.addEventListener('click',function(e){e.preventDefault();step(-1)});
  if(next)next.addEventListener('click',function(e){e.preventDefault();step(1)});
  container.addEventListener('scroll',update,{passive:true});
  /* One window listener per row, removed once the row leaves the page. */
  function onResize(){if(!document.body.contains(container)){window.removeEventListener('resize',onResize);return}update()}
  window.addEventListener('resize',onResize);
  /* Initial paint may not have measured layout yet — defer one frame. */
  requestAnimationFrame(update);
  setTimeout(update,150);
}

function choiceButtonsHtml(options){
  var ch='<div class="ai-chat-choices">';
  for(var ci=0;ci<options.length;ci++){
    ch+='<button class="ai-chat-choice-btn" data-message="'+esc(options[ci])+'">'+esc(options[ci])+'</button>';
  }
  ch+='</div>';
  return choicesWrap(ch);
}

function vizIcon(){return aiSparkle().replace('<svg ','<svg width="15" height="15" ');}
function vizImageIcon(){return '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>';}
function vizLoadingHtml(step){
  // Reuses the `.ai-chat-viz-result` shell so the loading state occupies the
  // SAME footprint as the finished image (no collapse, no layout jump).
  // IMPORTANT: the old full-card shimmer ran an infinite background-position
  // animation across a large area — a heavy repaint loop that could peg the
  // main thread and trigger "Page Unresponsive". This is now a STATIC fill with
  // a single small spinner (`.ai-chat-viz-spin`, reduced-motion aware).
  return '<div class="ai-chat-viz-result ai-chat-viz-loading">'+
    '<div style="display:flex;align-items:center;gap:8px;padding:14px 14px 10px">'+
      '<span class="ai-chat-viz-spin"></span>'+
      '<span class="ai-chat-viz-step" style="font-size:13px;color:#1d1d1f;font-weight:600">'+esc(step)+'</span>'+
    '</div>'+
    '<div class="ai-chat-viz-loading-fill">'+
      '<span style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#b8b8b8;display:flex;flex-direction:column;align-items:center;gap:4px">'+vizImageIcon()+'<span style="font-size:11px;color:#a0a0a0">Creating your preview…</span></span>'+
    '</div>'+
  '</div>';
}
function vizResultHtml(src){
  // Stable classes (not just inline styles) so the injected layout CSS controls
  // the height/fill behavior. The image lives in its OWN wrapper (flex:1) that
  // grows to fill the card, with the caption a separate flex:0 row pinned at the
  // bottom — the caption is never overlaid on the image.
  return '<div class="ai-chat-viz-result">'+
    '<div class="ai-chat-viz-result-imgwrap"><img class="ai-chat-viz-result-img" src="'+esc(src)+'" alt="AI style preview"/></div>'+
    '<div class="ai-chat-viz-disclaimer">AI style preview. Product details may vary.</div>'+
  '</div>';
}
function vizErrorHtml(msg){
  return '<div style="margin-top:10px;border:1px solid rgba(0,0,0,.1);border-radius:12px;padding:13px 15px;background:#fff">'+
    '<div style="font-size:13px;color:#555;margin-bottom:9px">'+esc(msg||'Could not create the preview.')+'</div>'+
    '<button class="ai-chat-viz-retry" type="button" style="display:inline-flex;align-items:center;gap:6px;padding:9px 14px;border:0;border-radius:999px;cursor:pointer;font-size:13px;font-weight:600;color:#fff;background:var(--ai-chat-primary,#2d6b4f)">Try again</button>'+
  '</div>';
}

/* "Visualize My Look" CTA — a clean, full-width button rendered BELOW
   the product card at the bubble level. On click it replaces itself
   with the loading box, then the generated image, directly below the
   card. Kept out of the card's tap-target so the card layout is
   untouched. */
/* Inject the "Visualize My Look" button as a full-width row INSIDE the
   product card. The card is display:flex/flex-wrap, so a child with
   flex-basis:100% wraps cleanly to its own row at the bottom of the
   card's box (no cramping). The button stops click propagation so a
   tap never reaches the card's own click handling.
   The generated image renders BELOW the card (see runVisualize). */
/* The label set in the app's Settings, exactly (the server resolves the default). */
function vizLabel(cta){return (cta&&cta.label)||'See It Styled'}
function injectVizButton(card,cta){
  if(!card||card.querySelector('.ai-chat-viz-btn'))return;
  // "See It Styled" is a SECONDARY action sitting BESIDE "Add to cart" (the
  // primary): a quiet outline button (.ai-chat-viz-btn in the stylesheet) that
  // must never read as the main buy CTA. The button stops click propagation
  // so it never triggers the card's other actions.
  var viz=document.createElement('button');
  viz.type='button';
  viz.className='ai-chat-viz-btn';
  viz.innerHTML=vizIcon()+'<span>'+esc(vizLabel(cta))+'</span>';
  var go=function(e){if(e){e.preventDefault();e.stopPropagation();}runVisualize(cta,card)};
  viz.addEventListener('click',go);
  var viewCta=card.querySelector('.ai-chat-product-cta');
  var buyRow=viewCta&&viewCta.parentNode&&viewCta.parentNode.classList.contains('ai-chat-buy-row')?viewCta.parentNode:null;
  if(buyRow){
    /* The buy button already shares a row with the fit tool: join it. */
    buyRow.insertBefore(viz,viewCta.nextSibling);
  }else if(viewCta&&viewCta.parentNode&&getComputedStyle(viewCta).display!=='none'){
    // Wrap "Add to cart" + "See It Styled" in a single flex row so they sit
    // side by side when there's room and STACK (See It Styled under Add to
    // cart) when the card is too narrow / on mobile.
    var row=document.createElement('div');
    row.className='ai-chat-viz-actions';
    viewCta.parentNode.insertBefore(row,viewCta);
    row.appendChild(viewCta);
    row.appendChild(viz);
  }else{
    // Legacy layout hides "View product" — fall back to placing the
    // button in the info area.
    var info=card.querySelector('.ai-chat-product-info')||card;
    info.appendChild(viz);
  }
}
// Inject the expanded-preview layout CSS once, carried WITH the widget JS (not
// the separate stylesheet) so there's no second asset to cache-bust. Uses CSS
// GRID with minmax(0,…) columns — unlike flexbox, a grid track can't be blown
// wide by the product card's content (the flex min-content problem that kept
// the card ~600px and pushed the image below). The card rules use !important so
// the showcase/carousel CSS (the viewport-driven :only-child featured layout)
// can never win once the card sits in the controls column.
function injectVizStyleOnce(){
  if(document.getElementById('ai-chat-viz-layout-style'))return;
  var css=
    // Two-column grid: a compact left rail (product card + Style the look panel)
    // and a flexible right column holding the generated image. align-items:stretch
    // puts BOTH columns in the same grid row and makes the right preview match the
    // FULL height of the left stack — if the product title wraps and the left grows,
    // the image card grows to the same vertical line. The left stack drives the
    // row height (the right column only fills it), so there's no empty area below
    // the left column. Pure CSS — no ResizeObserver / JS height hack.
    // STABLE WIDTH (belt-and-suspenders for the JS pin in runVisualize): the chat
    // bubble shrink-wraps to content, so a narrow loading box made the whole grid
    // narrow, then it JUMPED wider when the big image loaded. Force any message /
    // bubble that contains the visualizer to its full available width so the 1fr
    // preview column is the SAME width from loading through the final image.
    '.ai-chat-msg:has(.ai-chat-viz-host){width:100%}'+
    '.ai-chat-msg-bubble:has(.ai-chat-viz-host){width:100%;box-sizing:border-box}'+
    '.ai-chat-viz-expanded{display:grid;grid-template-columns:minmax(0,220px) minmax(0,1fr);gap:16px;align-items:stretch;width:100%;margin-top:10px;box-sizing:border-box}'+
    // Left column: a vertical stack at natural content height, pinned to the top
    // (extra row height, if any, stays below — content never stretches weirdly).
    '.ai-chat-viz-controls{display:flex;flex-direction:column;gap:10px;min-width:0;justify-content:flex-start}'+
    // Right column + image host both fill the grid-row height so the result card
    // can resolve height:100% against a definite height.
    '.ai-chat-viz-preview{min-width:0;width:100%;height:100%}'+
    '.ai-chat-viz-image{min-width:0;width:100%;height:100%;min-height:260px;display:flex;flex-direction:column}'+
    // Compact product card — small reference content, NOT the hero. Vertical
    // block: image on top, info below. Image is a short fixed band so a tall
    // product photo can't blow the card up.
    '.ai-chat-viz-controls .ai-chat-product-card{display:block!important;width:100%!important;max-width:220px!important;min-width:0!important;padding:0!important;margin:0!important;overflow:hidden!important;border:1px solid rgba(0,0,0,.08)!important;border-radius:12px!important;background:#fff!important}'+
    '.ai-chat-viz-controls .ai-chat-product-img{width:100%!important;height:130px!important;aspect-ratio:auto!important;border-radius:0!important;overflow:hidden!important;background:#fff!important}'+
    // Product photos MUST be object-fit:contain — cover crops shoes and looks wrong.
    '.ai-chat-viz-controls .ai-chat-product-img img{width:100%!important;height:100%!important;object-fit:contain!important;display:block}'+
    '.ai-chat-viz-controls .ai-chat-product-info{box-sizing:border-box;padding:12px!important;display:flex!important;flex-direction:column!important;gap:6px!important}'+
    '.ai-chat-viz-controls .ai-chat-product-title{font-size:14px!important;line-height:1.25!important}'+
    '.ai-chat-viz-controls .ai-chat-product-price{font-size:15px!important}'+
    '.ai-chat-viz-controls .ai-chat-product-cta{display:inline-flex!important;align-items:center;justify-content:center;align-self:flex-start!important;width:auto!important;margin-top:2px!important;padding:9px 14px!important;background:#000!important;color:#fff!important;border-radius:8px!important;font-size:13px!important;font-weight:600!important;text-decoration:none!important}'+
    // Generated-image card = the hero. On desktop it FILLS the grid row height
    // (height:100% resolves against the stretched .ai-chat-viz-image), so its
    // bottom edge lands exactly at the bottom of the left Style-the-look panel.
    // Column flex layout: image wrapper grows, disclaimer pinned at the bottom.
    '.ai-chat-viz-result{width:100%;height:100%;min-height:100%;display:flex;flex-direction:column;border:1px solid rgba(0,0,0,.08);border-radius:14px;overflow:hidden;background:#fff}'+
    // Image wrapper takes all space above the caption; image covers it. Bottom
    // object-position keeps the shoe in frame when the row gets tall.
    '.ai-chat-viz-result-imgwrap{flex:1 1 auto;min-height:0;width:100%;position:relative;overflow:hidden}'+
    '.ai-chat-viz-result-img{width:100%;height:100%;object-fit:cover;object-position:center bottom;display:block}'+
    '.ai-chat-viz-disclaimer{flex:0 0 auto;padding:7px 10px;font-size:11px;color:#9a9a9a;text-align:center;line-height:1.35}'+
    // Quiet, Apple-style scene controls — small rounded pills, NOT CTA blocks.
    '.ai-chat-viz-options{padding:10px!important;gap:7px!important;border-radius:12px!important}'+
    '.ai-chat-viz-options-title{font-size:12px!important;font-weight:700!important}'+
    '.ai-chat-viz-options-help{font-size:10.5px!important}'+
    '.ai-chat-viz-seg{gap:6px!important}'+
    '.ai-chat-viz-opt{min-height:30px!important;padding:5px 10px!important;font-size:12px!important;border-radius:999px!important}'+
    '.ai-chat-viz-opt[disabled]{opacity:.5!important;pointer-events:none!important;cursor:default!important}'+
    // Lightweight loading: a STATIC soft fill (no full-card shimmer repaint loop
    // that pegged the main thread / froze the page) plus one small spinner.
    // The loading fill is the SAME box as the final image wrapper — full width
    // and grows to fill the card — so the loading state and the finished image
    // occupy an identical footprint (no narrow/short loading block).
    '.ai-chat-viz-loading-fill{position:relative;flex:1 1 auto;width:100%;min-height:200px;overflow:hidden;background:#f4f4f5}'+
    '.ai-chat-viz-spin{width:16px;height:16px;border:2px solid var(--ai-chat-primary,#2d6b4f);border-top-color:transparent;border-radius:50%;display:inline-block;animation:aiChatVizSpin .8s linear infinite;flex:none}'+
    // Respect reduced-motion: stop the spinner from animating at all.
    '@media (prefers-reduced-motion:reduce){.ai-chat-viz-spin{animation:none!important}}'+
    // Mobile/tablet (<700px): stack card → scene controls → image and DROP the
    // equal-height behavior. Single column, top-aligned, and the preview uses a
    // natural 4/5 aspect ratio instead of filling a (now non-existent) row.
    '@media (max-width:699px){'+
      '.ai-chat-viz-expanded{grid-template-columns:1fr;align-items:start}'+
      '.ai-chat-viz-controls{gap:8px}'+
      // Compact HORIZONTAL product row (image left, title/price/CTA right) so the
      // mobile card reads like a shopping row, not a tall card with whitespace.
      // box-sizing + min-width:0 on the text column prevent horizontal overflow.
      '.ai-chat-viz-controls .ai-chat-product-card{display:grid!important;grid-template-columns:96px 1fr!important;gap:12px!important;align-items:center!important;padding:14px!important;max-width:100%!important;box-sizing:border-box!important}'+
      '.ai-chat-viz-controls .ai-chat-product-img{width:96px!important;height:96px!important;border-radius:10px!important}'+
      '.ai-chat-viz-controls .ai-chat-product-info{padding:0!important;min-width:0!important;gap:4px!important}'+
      // Title up to 2 lines, then ellipsis — keeps the row short.
      '.ai-chat-viz-controls .ai-chat-product-title{display:-webkit-box!important;-webkit-line-clamp:2!important;-webkit-box-orient:vertical!important;overflow:hidden!important}'+
      // CTA compact but tappable (~40px), sized to content (capped at 160px).
      '.ai-chat-viz-controls .ai-chat-product-cta{min-height:40px!important;max-width:160px!important;margin-top:4px!important}'+
      '.ai-chat-viz-preview{height:auto}'+
      '.ai-chat-viz-image{height:auto;min-height:0}'+
      '.ai-chat-viz-result{height:auto;min-height:0;aspect-ratio:4/5}'+
    '}';
  var st=document.createElement('style');
  st.id='ai-chat-viz-layout-style';
  st.textContent=css;
  (document.head||document.documentElement).appendChild(st);
}
function runVisualize(cta,card){
  if(!cta||!cta.productHandle||!card)return;
  // SINGLE-FLIGHT: a card visualizes at most once. If it's already loading or
  // expanded (host built), a repeat CTA tap must NOT build a second host or
  // start another request/timer/interval — just scroll to the existing preview.
  // This is the main guard against stacked fetches and the runaway repaint loop
  // that froze the page.
  if(card._aiVizHost||card.dataset.vizState==='loading'||card.dataset.vizState==='ready'){
    if(card._aiVizHost){try{card._aiVizHost.scrollIntoView({behavior:'smooth',block:'nearest'})}catch(e){scrollBottom()}}
    return;
  }
  card.dataset.vizState='loading';
  injectVizStyleOnce();
  // HIDE the in-card CTA once tapped — in the expanded state the scene selector
  // replaces the need for a second "See It Styled" button.
  var viz=card&&card.querySelector('.ai-chat-viz-btn');
  if(viz)viz.style.display='none';
  if(!card||!card.parentNode){card.dataset.vizState='';return;}
  // Build the two-column expanded layout, anchored OUTSIDE the products
  // container so the carousel/scroll CSS can't constrain it. The grid CSS above
  // owns the columns: left = controls (compact card at natural height + the
  // scene panel below it), right = the large generated image. On a narrow
  // widget (<640px) the grid collapses to one column → card, controls, image
  // stack cleanly. NO inline layout styles here — the injected grid CSS rules.
  var origContainer=card.parentNode;
  var anchor=card.closest('.ai-chat-products-wrap')||card.closest('.ai-chat-products')||card;
  var host=document.createElement('div');
  host.className='ai-chat-viz-host ai-chat-viz-expanded';
  var leftCol=document.createElement('div');
  leftCol.className='ai-chat-viz-controls';
  var rightCol=document.createElement('div');
  rightCol.className='ai-chat-viz-preview';
  var imgWrap=document.createElement('div');
  imgWrap.className='ai-chat-viz-image';
  imgWrap.setAttribute('role','status');imgWrap.setAttribute('aria-live','polite');imgWrap.setAttribute('aria-label','Creating your styling preview');
  rightCol.appendChild(imgWrap);
  // Place the wrapper AFTER the outermost products container, then move the card
  // into the left column. The injected `.ai-chat-viz-controls .ai-chat-product-card`
  // rules (with !important) reset it to a clean compact card.
  if(anchor&&anchor.parentNode)anchor.parentNode.insertBefore(host,anchor.nextSibling);
  else origContainer.appendChild(host);
  leftCol.appendChild(card);
  host.appendChild(leftCol);
  host.appendChild(rightCol);
  // Hide the now-empty products container(s) so they don't leave a blank gap.
  if(origContainer&&!origContainer.querySelector('.ai-chat-product-card'))origContainer.style.display='none';
  if(anchor&&anchor!==origContainer&&!anchor.querySelector('.ai-chat-product-card'))anchor.style.display='none';
  // STABLE WIDTH: the chat bubble shrink-wraps to its content, so during loading
  // (a narrow spinner box) the whole two-column grid was narrow, then JUMPED
  // wider once the large generated image loaded. Pin the message + bubble to
  // their full available width (capped by the message max-width) the moment the
  // visualizer mounts, so the 1fr preview column is the SAME width from the
  // loading state through the final image.
  var vizMsg=host.closest('.ai-chat-msg');
  if(vizMsg)vizMsg.style.width='100%';
  var vizBubble=host.closest('.ai-chat-msg-bubble');
  if(vizBubble){vizBubble.style.width='100%';vizBubble.style.boxSizing='border-box';}
  // Remember the host so a repeat CTA tap scrolls here instead of rebuilding.
  card._aiVizHost=host;
  // Inject the "Style the look" panel NOW (not only after the first image) so the
  // left column is at its full height (card + settings) during loading. That makes
  // the stretched right card the right height from the start — the loading preview
  // doesn't jump when the image arrives. The pills start disabled (vizFetch).
  injectVizOptions(host,cta,card);
  vizFetch(host,cta,card);
}
// Fallback scene set when the server didn't send one (older config/cache).
var DEFAULT_VIZ_SCENES=[
  {label:'Walking',ctx:'a scenic outdoor walking path'},
  {label:'Travel',ctx:'a stylish city street while traveling'},
  {label:'Errands',ctx:'a bright casual everyday errands setting'},
  {label:'Workday',ctx:'a polished everyday workday setting'}
];
// The element inside the host that holds the loading box / generated image /
// error — kept SEPARATE from the scene selector so re-generating a scene swaps
// only the image and the selector (with its active state) persists.
function vizImageHost(host){return (host&&host.querySelector('.ai-chat-viz-image'))||host;}
// Render the scene selector as its own panel in the LEFT controls column,
// directly BELOW the product card — never inside the card's tap target. It's a
// visually distinct, Apple-style panel: small "Style the look" header, a
// "Choose a setting" helper, then warm-gold pills (selected = filled gold,
// unselected = white with a soft gold border). Picking one re-generates the
// SAME product in that setting; clicks never reach the card.
function injectVizOptions(host,cta,card){
  if(!host||host.querySelector('.ai-chat-viz-options'))return;
  // Place it in the left controls column (below the card); fall back to host.
  var mount=host.querySelector('.ai-chat-viz-controls')||host;
  var scenes=(cta&&cta.scenes&&cta.scenes.length)?cta.scenes:DEFAULT_VIZ_SCENES;
  var wrap=document.createElement('div');
  wrap.className='ai-chat-viz-options';
  wrap.style.cssText='display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid rgba(0,0,0,.08);border-radius:18px;background:#fff;box-sizing:border-box';
  var head=document.createElement('div');
  head.className='ai-chat-viz-options-title';
  head.textContent='Style the look';
  head.style.cssText='font-size:13px;color:#1d1d1f;font-weight:600;letter-spacing:-.01em';
  var help=document.createElement('div');
  help.className='ai-chat-viz-options-help';
  help.textContent='Choose a setting';
  help.style.cssText='font-size:11px;color:#6e6e73;margin-top:-4px';
  wrap.appendChild(head);
  wrap.appendChild(help);
  var seg=document.createElement('div');
  seg.className='ai-chat-viz-seg';
  seg.style.cssText='display:flex;flex-wrap:wrap;gap:8px';
  scenes.forEach(function(s){
    var chip=document.createElement('button');
    chip.type='button';
    chip.className='ai-chat-viz-opt';
    chip.setAttribute('data-scene',s.label);
    chip.setAttribute('aria-pressed','false');
    chip.textContent=s.label;
    // Quiet, Apple-style pill — small (~32px) and fully rounded, not a CTA block.
    // Wraps cleanly. (The .ai-chat-viz-opt rule also enforces this with !important.)
    chip.style.cssText='display:inline-flex;align-items:center;justify-content:center;min-height:30px;padding:5px 10px;border:1px solid rgba(0,0,0,.16);border-radius:999px;background:#fff;color:#1d1d1f;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;line-height:1.2;white-space:nowrap;box-sizing:border-box;transition:background .15s,color .15s';
    chip.addEventListener('click',function(e){
      if(e){e.preventDefault();e.stopPropagation();}
      var kids=seg.children;
      for(var i=0;i<kids.length;i++){kids[i].style.background='#fff';kids[i].style.color='#1d1d1f';kids[i].setAttribute('aria-pressed','false');}
      chip.style.background='#0d0d12';chip.style.color='#fff';chip.setAttribute('aria-pressed','true');
      var c2={productHandle:cta.productHandle,productTitle:cta.productTitle||'',styleContext:s.ctx,label:cta.label,scenes:cta.scenes};
      vizFetch(host,c2,card);
    });
    seg.appendChild(chip);
  });
  wrap.appendChild(seg);
  mount.appendChild(wrap);
}
// Tear down any in-flight request/timers parked on a host (abort the fetch,
// clear the step interval and the timeout). Idempotent.
function vizFetchCleanup(host){
  if(!host)return;
  if(host._vizIv){clearInterval(host._vizIv);host._vizIv=null;}
  if(host._vizTo){clearTimeout(host._vizTo);host._vizTo=null;}
  if(host._vizAbort){try{host._vizAbort.abort()}catch(e){}host._vizAbort=null;}
}
// Enable/disable the scene pills while a request is in flight so repeated taps
// can't queue stacked fetches.
function vizSetSceneDisabled(host,disabled){
  if(!host)return;
  var opts=host.querySelectorAll('.ai-chat-viz-opt');
  for(var i=0;i<opts.length;i++){opts[i].disabled=!!disabled;if(disabled)opts[i].setAttribute('disabled','disabled');else opts[i].removeAttribute('disabled');}
}
// Loading → fetch → result/error. Runs INDEPENDENTLY of the chat stream
// (own fetch, no input lock), so the customer can keep chatting while
// the preview renders. 60s ceiling so a hung provider can't spin forever.
// Re-entrant by design (the scene pills re-call it): each call CANCELS the
// previous request/timers for this host and tags itself with a request id so
// only the latest response is allowed to render — no stacked fetches/timers.
function vizFetch(host,cta,card){
  if(!host)return;
  // Cancel whatever was running for this host, then claim the latest request id.
  vizFetchCleanup(host);
  var reqId=(host._vizReqId=(host._vizReqId||0)+1);
  if(card)card.dataset.vizState='loading';
  vizSetSceneDisabled(host,true);
  var imgHost=vizImageHost(host);
  var steps=['Analyzing the product…','Composing the scene…','Styling the look…','Rendering your preview…'];
  var si=0;imgHost.innerHTML=vizLoadingHtml(steps[0]);scrollBottom();
  host._vizIv=setInterval(function(){si=Math.min(si+1,steps.length-1);var l=imgHost.querySelector('.ai-chat-viz-step');if(l)l.textContent=steps[si]},2200);
  var ctrl=(typeof AbortController!=='undefined')?new AbortController():null;
  host._vizAbort=ctrl;
  host._vizTo=setTimeout(function(){if(ctrl){try{ctrl.abort()}catch(e){}}},60000);
  var opts={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({productHandle:cta.productHandle,styleContext:cta.styleContext||''})};
  if(ctrl)opts.signal=ctrl.signal;
  fetch(VISUALIZE_URL,opts)
    .then(function(r){return r.json().catch(function(){return{}})})
    .then(function(d){
      // Stale response — a newer request superseded this one; drop it silently.
      if(reqId!==host._vizReqId)return;
      vizFetchCleanup(host);vizSetSceneDisabled(host,false);
      if(card)card.dataset.vizState='ready';
      if(d&&d.ok&&d.imageDataUrl){imgHost.innerHTML=vizResultHtml(d.imageDataUrl);injectVizOptions(host,cta,card)}
      else{vizError(host,cta,(d&&d.message)||'Could not create the preview right now.',card)}
      scrollBottom();
    })
    .catch(function(e){
      if(reqId!==host._vizReqId)return;
      vizFetchCleanup(host);vizSetSceneDisabled(host,false);
      if(card)card.dataset.vizState='ready';
      vizError(host,cta,(e&&e.name==='AbortError')?'That took too long — please try again.':'Connection issue. Please try again.',card);
      scrollBottom();
    });
}
function vizError(host,cta,msg,card){
  var imgHost=vizImageHost(host);
  imgHost.innerHTML=vizErrorHtml(msg);
  var r=imgHost.querySelector('.ai-chat-viz-retry');
  if(r)r.addEventListener('click',function(){vizFetch(host,cta,card)});
}
function ctaHtml(linkCTA){
return '<a class="ai-chat-cta-btn" style="display:block;margin-top:12px;padding:14px 16px;background:var(--ai-chat-primary,#2d6b4f);color:#fff;border-radius:10px;text-decoration:none;text-align:center;font-size:14px;font-weight:600;line-height:1.3" href="'+esc(safeUrl(linkCTA.url)||'#')+'" target="_blank" rel="noopener">'+esc(linkCTA.label||'Visit Support Hub')+' &rarr;</a>';
}
// Central support-chat opener. Prefer a live-chat provider (Zendesk, Intercom,
// Gorgias) and only fall back to the Support Hub URL when none is present.
// Every support path — the dead-end button and the handoff support_cta — calls
// this so they all behave identically.
function openSupportChat(fallbackUrl){
  var url=fallbackUrl||SUPPORT_URL||'';
  if(typeof window.zE==='function'){toggle(false);try{window.zE('webWidget','show');window.zE('webWidget','open');return}catch(e){}}
  /* Other chat apps are hidden behind ours while it's open: step aside first. */
  if(typeof window.Intercom==='function'){toggle(false);try{window.Intercom('show');return}catch(e){}}
  if(typeof window.GorgiasChat!=='undefined'&&window.GorgiasChat&&typeof window.GorgiasChat.open==='function'){toggle(false);try{window.GorgiasChat.open();return}catch(e){}}
  if(url)window.open(url,'_blank','noopener');
}
// Handoff support CTA rendered as a BUTTON (not an anchor) so the click opens
// live chat via openSupportChat rather than navigating to the Support Hub URL.
function supportCtaHtml(s){
return '<button type="button" class="ai-chat-cta-btn ai-chat-support-cta" data-support-cta="1" data-fallback="'+esc(s.fallbackUrl||'')+'" style="display:block;width:100%;margin-top:12px;padding:14px 16px;background:var(--ai-chat-primary,#2d6b4f);color:#fff;border:none;border-radius:10px;text-align:center;font-size:14px;font-weight:600;line-height:1.3;cursor:pointer;font-family:inherit">'+esc(s.label||'Chat with Aetrex Support')+'</button>';
}

/* ── True Fit: the store's size finder, opened from the chat ──
   On shoe pages the theme's "Find my size" tile drives True Fit
   (window.AetrexTrueFitTile). When a shopper asks about size, the assistant
   offers a button; it opens that same finder (the chat steps aside so the
   finder is visible), then brings True Fit's size back into the chat, where
   the shoe comes back ready to add in that size. For another shoe, the button
   opens that shoe's page and the finder starts there. */
var TF_PENDING='hajirai_tf_pending',TF_SITE='hajirai_tf_site',tfRun=null;
function tfTile(){return document.querySelector('[data-tf-size-tile]')}
function pageHandle(){var m=location.pathname.match(/\/products\/([^/?#]+)/);try{return m?decodeURIComponent(m[1]):''}catch(e){return ''}}
function tfHere(){return !!(window.AetrexTrueFitTile&&window.AetrexTrueFitTile.state&&tfTile())}
/* The size True Fit has marked on this shoe's page ("9 - 9.5 US"), if any. */
function tfSizeHere(){var st=tfHere()&&window.AetrexTrueFitTile.state,r=st&&st.recommendation;return typeof r==='string'?r.trim().slice(0,40):''}
/* True Fit already knows this shopper (the theme's tile remembers it). */
function tfKnown(){try{return localStorage.getItem('tfTileProfile')==='1'}catch(e){return false}}
function tfLast(){try{var v=JSON.parse(localStorage.getItem(TF_LAST)||'null');return v&&v.size?v:null}catch(e){return null}}
function tfRemember(size,title){try{localStorage.setItem(TF_LAST,JSON.stringify({size:size,title:title||'',handle:pageHandle(),at:Date.now()}))}catch(e){}}
function tfPayload(){
  var here=tfHere(),seen=false;
  try{if(here)localStorage.setItem(TF_SITE,'1');seen=localStorage.getItem(TF_SITE)==='1'}catch(e){}
  if(!here&&!seen&&C.trueFit!==true)return null;
  return{provider:'truefit',page_handle:here?pageHandle():''};
}
function trueFitBtnHtml(f){
return '<button type="button" class="ai-chat-cta-btn ai-chat-truefit-cta" data-truefit="'+esc(f.handle)+'" data-title="'+esc(f.title||'')+'">'+
  tfLogo(20)+'<span>Find my size with True Fit</span></button>';
}
function tfNote(text){messages.push({role:'assistant',content:text});saveH(messages);appendMsg('assistant',text);scrollBottom()}
function trueFitFor(handle,title){
  if(!handle||tfRun)return;
  if(handle===pageHandle()&&tfHere()){runTrueFit(title);return}
  try{sessionStorage.setItem(TF_PENDING,JSON.stringify({handle:handle,title:title,at:Date.now()}))}catch(e){}
  location.href=SHOP_ROOT+'products/'+encodeURIComponent(handle);
}
function runTrueFit(title){
  var api=window.AetrexTrueFitTile,tile=tfTile();
  if(!api||!tile||tfRun)return;
  tfRun={title:title,started:Date.now()};
  toggle(false);
  Promise.resolve().then(function(){return api.open(tile)}).catch(function(){}).then(function(){
    var st=api.state,seen=false,closedAt=0;
    var timer=setInterval(function(){
      var open=document.body.classList.contains('tfc-show-modal')||st.finderOpen||st.busy;
      if(open&&Date.now()-tfRun.started<30*60*1000){seen=true;closedAt=0;return}
      if(!closedAt)closedAt=Date.now();
      /* True Fit redraws its answer a moment after the finder closes. */
      if(!st.recommendation&&seen&&Date.now()-closedAt<4000)return;
      clearInterval(timer);
      var run=tfRun;tfRun=null;
      var size=st.recommendation;
      /* No finder and no size: True Fit has no data for this style and the
         theme opened its size chart instead — leave the shopper there. */
      if(!seen&&!size)return;
      toggle(true);
      if(size){
        tfRemember(size,run.title);
        inputEl.disabled=false;inputEl.placeholder=IPLACE;
        inputEl.value='True Fit recommends size '+size+' for me'+(run.title?' in the '+run.title:'')+'.';
        sendMessage();
      }else tfNote('True Fit didn\'t give a size this time. Tap Find my size to try again, or tell me your usual size and I\'ll help from there.');
    },400);
  });
}
/* Arrived from the chat's True Fit button on another page: start the finder here. */
function tfResume(){
  var p=null;
  try{p=JSON.parse(sessionStorage.getItem(TF_PENDING)||'null');sessionStorage.removeItem(TF_PENDING)}catch(e){}
  if(!p||!p.handle||Date.now()-p.at>10*60*1000||p.handle!==pageHandle())return;
  var tries=0;
  (function wait(){
    if(tfHere()){runTrueFit(p.title||'');return}
    if(++tries<24){setTimeout(wait,250);return}
    toggle(true);
    tfNote('True Fit isn\'t available for this style. The size chart on this page can help — or tell me your usual size and I\'ll suggest one.');
  })();
}

function appendMsg(role,content,products){
var isU=role==='user';
var d=el('div','ai-chat-msg ai-chat-msg--'+role);
var avatarHtml=isU?'':'<div class="ai-chat-msg-avatar">'+assistantBubbleAvatar+'</div>';
d.innerHTML=avatarHtml+'<div class="ai-chat-msg-bubble"><p>'+md(esc(content))+'</p></div>';
if(products&&products.length){
  var b=$('.ai-chat-msg-bubble',d);
  var isShowcase=PRODUCT_CARD_STYLE==='showcase';
  var styleSuffix=isShowcase?' ai-chat-products--showcase':'';
  var ph='<div class="ai-chat-products'+styleSuffix+'">';
  for(var i=0;i<products.length;i++)ph+=prodCard(products[i]);
  ph+='</div>';
  b.insertAdjacentHTML('beforeend',isShowcase?showcaseWrap(ph):ph);
  if(isShowcase){var w=b.querySelector('.ai-chat-products-wrap');if(w)initShowcaseArrows(w)}
}
msgsEl.appendChild(d);
scrollBottom();
return d;
}

/* Product card: image + title link to the product; "Add to cart" is the
   primary action (.ai-chat-product-cta keeps every layout's CTA placement),
   "View product" a quiet underlined link. When the chat already knows the
   customer's size/width, the card carries it (data-preselect) and shows it
   under the price — one tap adds that exact variant. */
/* Each card offers the fit tool that belongs to it — True Fit on shoes,
   FITFinder on orthotics (until the shopper has a FIT), never the other way —
   as a round icon button beside the buy button, so the card doesn't grow. */
function cardHelper(p,t){
  if(!p||!p.handle)return '';
  if(p.kind==='footwear'&&tfPayload())return '<button type="button" class="ai-chat-card-fit" data-truefit="'+esc(p.handle)+'" data-title="'+t+'" aria-label="Find my size with True Fit" title="Find my size \u00b7 True Fit">'+tfLogo(20)+'</button>';
  if(p.kind==='orthotic'&&ff&&!savedFit())return '<button type="button" class="ai-chat-card-fit ai-chat-card-fit--fit" data-helper="fitfinder" aria-label="Find my orthotic FIT with FITFinder" title="Find my FIT \u00b7 FITFinder"><span aria-hidden="true">FIT</span></button>';
  return '';
}
function prodCard(p){
var img=p.image||p.featured_image||'';
var t=esc(p.title||'');
var u=safeUrl(p.url)||(p.handle?(SHOP_ROOT+'products/'+encodeURIComponent(p.handle)):'#');
var pr=esc(p.price_formatted||(p.price?fmt(p.price):''));
var cp=p.compare_at_price?esc(fmt(p.compare_at_price)):'';
var pre=(p.preselect&&typeof p.preselect==='object')?p.preselect:null;
var preKeys=pre?Object.keys(pre):[];
var preLabel=preKeys.map(function(k){return esc(String(pre[k]))}).join(' \u00b7 ');
/* "Select size" until every option the product has (size, width…) is known. */
var toPick=(Array.isArray(p.choose)?p.choose:[]).filter(function(n){return !preKeys.some(function(k){return k.toLowerCase()===String(n).toLowerCase()})});
/* One short label for every card ("Select size"); the picker asks for the rest. */
var firstPick=toPick.filter(function(n){return /size/i.test(n)})[0]||toPick[0];
var ctaText=toPick.length?'Select '+String(firstPick).toLowerCase():'Add to cart';
var buyBtn='<button type="button" class="ai-chat-product-cta ai-chat-atc" data-atc aria-label="'+(toPick.length?esc(ctaText)+' for '+t:'Add '+t+(preLabel?', '+preLabel+',':'')+' to cart')+'">'+esc(ctaText)+'</button>';
var fitBtn=cardHelper(p,t);
/* With a fit tool, the buy button and the tool share one row. */
var buyHtml=fitBtn?'<div class="ai-chat-viz-actions ai-chat-buy-row">'+buyBtn+fitBtn+'</div>':buyBtn;
var imgHtml=img?'<a class="ai-chat-product-img" href="'+esc(u)+'" tabindex="-1" aria-hidden="true"><img src="'+esc(img)+'" alt="" loading="lazy"></a>':'';
var infoHtml='<div class="ai-chat-product-info">'+
  '<a class="ai-chat-product-title" href="'+esc(u)+'">'+t+'</a>'+
  '<div class="ai-chat-product-price">'+pr+(cp?'<span class="compare-at">'+cp+'</span>':'')+(preLabel?'<span class="ai-chat-product-variant">'+preLabel+'</span>':'')+'</div>'+
  buyHtml+
  '<a class="ai-chat-view-link" href="'+esc(u)+'">View product</a>'+
'</div>';
return '<div class="ai-chat-product-card" data-handle="'+esc(p.handle||'')+'" data-title="'+t+'" data-url="'+esc(u)+'" data-image="'+esc(img)+'"'+(pre?' data-preselect="'+esc(JSON.stringify(pre))+'"':'')+'>'+imgHtml+infoHtml+'</div>';
}

/* ── Add to cart inside the chat ────────────────────────────────────────
   Options and stock are read LIVE from the store (/products/<handle>.js) at
   the moment of the tap, never from the nightly copy — so a size that just
   sold out can't be added. If the card already knows the customer's size and
   that exact variant is in stock, one tap adds it; otherwise an option picker
   opens right under the cards. */
var productJsCache={};
function fetchProductJs(handle){
  var hit=productJsCache[handle];
  if(hit&&Date.now()-hit.at<60000)return hit.promise;
  var promise=fetch(SHOP_ROOT+'products/'+encodeURIComponent(handle)+'.js',{credentials:'same-origin',headers:{'Accept':'application/json'}})
    .then(function(r){if(!r.ok)throw new Error('product '+r.status);return r.json()});
  productJsCache[handle]={at:Date.now(),promise:promise};
  promise.catch(function(){delete productJsCache[handle]});
  return promise;
}
function optModel(product){
  var raw=Array.isArray(product.options)?product.options:[];
  var variants=Array.isArray(product.variants)?product.variants:[];
  var vopts=function(v){return Array.isArray(v.options)?v.options:[v.option1,v.option2,v.option3].filter(function(x){return x!=null})};
  var opts=raw.map(function(o,i){
    var name=typeof o==='string'?o:(o&&o.name)||('Option '+(i+1));
    var values=(o&&typeof o==='object'&&Array.isArray(o.values))?o.values.slice():[];
    if(!values.length)variants.forEach(function(v){var x=vopts(v)[i];if(x!=null&&values.indexOf(x)<0)values.push(x)});
    return{name:name,values:values};
  });
  return{opts:opts,variants:variants,vopts:vopts};
}
function variantFor(m,sel){
  return m.variants.filter(function(v){var o=m.vopts(v);return m.opts.every(function(op,i){return sel[op.name]===o[i]})})[0]||null;
}
function valueAvailable(m,sel,name,value){
  return m.variants.some(function(v){
    if(!v.available)return false;
    var o=m.vopts(v);
    return m.opts.every(function(op,i){return op.name===name?o[i]===value:(!sel[op.name]||o[i]===sel[op.name])});
  });
}
// The card's known size/width → this product's exact option values (live).
function initialSelection(m,pre){
  var sel={};
  m.opts.forEach(function(op){if(op.values.length===1)sel[op.name]=op.values[0]});
  if(pre)Object.keys(pre).forEach(function(k){
    var op=m.opts.filter(function(o){return o.name.toLowerCase()===String(k).toLowerCase()})[0];
    if(op&&op.values.indexOf(pre[k])>=0)sel[op.name]=pre[k];
  });
  return sel;
}
function selectionComplete(m,sel){return m.opts.every(function(op){return !!sel[op.name]})}
function setBusy(btn,busy){
  if(!btn)return;
  if(busy){btn.setAttribute('aria-busy','true');btn.disabled=true;btn.classList.add('is-busy')}
  else{btn.removeAttribute('aria-busy');btn.disabled=false;btn.classList.remove('is-busy')}
}
function startAddToCart(card,btn){
  if(!card)return;
  var handle=card.getAttribute('data-handle');
  var pre=null;try{pre=JSON.parse(card.getAttribute('data-preselect')||'null')}catch(_){}
  setBusy(btn,true);
  fetchProductJs(handle).then(function(product){
    var m=optModel(product);
    var sel=initialSelection(m,pre);
    if(selectionComplete(m,sel)){
      var v=variantFor(m,sel);
      if(v&&v.available){
        return addToCart(v.id,1).then(function(){setBusy(btn,false);openAtcPanel(card,product,m,sel,{added:v})})
          .catch(function(err){setBusy(btn,false);openAtcPanel(card,product,m,sel,{error:err.message})});
      }
      setBusy(btn,false);
      // The known size is sold out right now — let them pick another.
      var soldOut=m.opts.filter(function(op){return m.opts.length>0&&op.values.length>1}).map(function(op){return sel[op.name]}).join(' \u00b7 ');
      var keep={};m.opts.forEach(function(op){if(op.values.length===1)keep[op.name]=sel[op.name]});
      openAtcPanel(card,product,m,keep,{note:(soldOut?soldOut+' is sold out right now':'That option is sold out right now')+' \u2014 choose another.'});
      return;
    }
    setBusy(btn,false);
    openAtcPanel(card,product,m,sel,{});
  }).catch(function(){
    setBusy(btn,false);
    openAtcPanel(card,null,null,{},{error:'We couldn\u2019t load the sizes right now.'});
  });
}
function closeAtcPanel(panel){
  if(!panel)return;
  var card=panel._card;if(card){card.classList.remove('is-picking');card.classList.remove('has-inline-picker')}
  if(panel.parentNode)panel.parentNode.removeChild(panel);
}
function openAtcPanel(card,product,m,sel,state){
  var bubble=card.closest('.ai-chat-msg-bubble')||card.parentNode;
  var existing=bubble.querySelector('.ai-chat-atc-panel');
  if(existing)closeAtcPanel(existing);
  var panel=document.createElement('div');
  panel.className='ai-chat-atc-panel';
  panel.setAttribute('role','region');
  panel._card=card;
  card.classList.add('is-picking');
  var title=card.getAttribute('data-title')||'';
  var url=card.getAttribute('data-url')||'#';
  var img=card.getAttribute('data-image')||'';
  /* A lone card opens its picker inside itself (one tidy unit); with
     several cards it opens under the row, naming the product. */
  var inline=!card.closest('.ai-chat-viz-host')&&card.parentNode&&card.parentNode.children.length===1;
  if(inline){
    panel.classList.add('is-inline');
    card.classList.add('has-inline-picker');
    card.appendChild(panel);
  }else{
    var anchor=card.closest('.ai-chat-viz-host')||card.closest('.ai-chat-products-wrap')||card.closest('.ai-chat-products')||card;
    if(anchor.parentNode)anchor.parentNode.insertBefore(panel,anchor.nextSibling);else bubble.appendChild(panel);
  }
  var priceOf=function(){var v=m&&selectionComplete(m,sel)?variantFor(m,sel):null;return v?fmt(v.price):(product?fmt(product.price):'')};
  function head(){
    if(inline)return '';
    return '<div class="ai-chat-atc-head">'+
      (img?'<img class="ai-chat-atc-thumb" src="'+esc(img)+'" alt="">':'')+
      '<div class="ai-chat-atc-headtext"><div class="ai-chat-atc-title">'+esc(title)+'</div><div class="ai-chat-atc-price">'+esc(priceOf())+'</div></div>'+
      '<button type="button" class="ai-chat-atc-close" data-atc-close aria-label="Close">'+
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>'+
    '</div>';
  }
  function render(st){
    st=st||{};
    panel.setAttribute('aria-label',(st.added?'Added to cart: ':'Choose options for ')+title);
    if(st.added){
      var chosen=m?m.opts.filter(function(op){return op.values.length>1}).map(function(op){return esc(sel[op.name])}).join(' \u00b7 '):'';
      panel.innerHTML=head()+
        '<div class="ai-chat-atc-done" role="status">'+
          '<span class="ai-chat-atc-check" aria-hidden="true"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6 9 17l-5-5"/></svg></span>'+
          '<span>Added to your cart'+(chosen?' \u2014 <strong>'+chosen+'</strong>':'')+'</span>'+
        '</div>'+
        '<div class="ai-chat-atc-actions">'+
          '<a class="ai-chat-atc-primary" href="'+esc(SHOP_ROOT+'checkout')+'">Checkout</a>'+
          '<a class="ai-chat-atc-secondary" href="'+esc(SHOP_ROOT+'cart')+'">View cart</a>'+
          '<button type="button" class="ai-chat-atc-text" data-atc-close>Keep shopping</button>'+
        '</div>';
      return;
    }
    if(!m){
      panel.innerHTML=head()+'<div class="ai-chat-atc-note is-error" role="alert">'+esc(st.error||'Something went wrong.')+' <a href="'+esc(url)+'">Open the product page</a></div>';
      return;
    }
    var groups=m.opts.filter(function(op){return op.values.length>1}).map(function(op){
      var current=sel[op.name]||'';
      var buttons=op.values.map(function(val){
        var avail=valueAvailable(m,sel,op.name,val);
        var on=current===val;
        return '<button type="button" class="ai-chat-atc-val'+(on?' is-on':'')+(avail?'':' is-out')+'" role="radio" aria-checked="'+(on?'true':'false')+'"'+(avail?'':' aria-disabled="true" title="Sold out"')+' data-opt="'+esc(op.name)+'" data-val="'+esc(val)+'">'+esc(val)+'</button>';
      }).join('');
      return '<div class="ai-chat-atc-group"><div class="ai-chat-atc-label">'+esc(op.name)+(current?': <strong>'+esc(current)+'</strong>':'')+'</div>'+
        '<div class="ai-chat-atc-values" role="radiogroup" aria-label="'+esc(op.name)+'">'+buttons+'</div></div>';
    }).join('');
    var complete=selectionComplete(m,sel);
    var v=complete?variantFor(m,sel):null;
    var canAdd=!!(v&&v.available);
    var missing=m.opts.filter(function(op){return !sel[op.name]}).map(function(op){return op.name.toLowerCase()});
    var addLabel=canAdd?'Add to cart \u00b7 '+esc(fmt(v.price)):(complete?'Sold out':'Select '+esc(missing.join(' & ')));
    panel.innerHTML=head()+
      (st.note||st.error?'<div class="ai-chat-atc-note'+(st.error?' is-error':'')+'" role="'+(st.error?'alert':'status')+'">'+esc(st.error||st.note)+'</div>':'')+
      groups+
      '<div class="ai-chat-atc-addrow">'+
        '<button type="button" class="ai-chat-atc-add" data-atc-add'+(canAdd?'':' disabled')+'>'+addLabel+'</button>'+
        (inline?'<button type="button" class="ai-chat-atc-text" data-atc-close>Cancel</button>':'')+
      '</div>';
  }
  panel.addEventListener('click',function(e){
    e.stopPropagation();
    if(e.target.closest('[data-atc-close]')){e.preventDefault();closeAtcPanel(panel);return}
    var val=e.target.closest('[data-opt]');
    if(val){
      e.preventDefault();
      if(val.getAttribute('aria-disabled')==='true')return;
      var name=val.getAttribute('data-opt'),value=val.getAttribute('data-val');
      sel[name]=sel[name]===value?'':value;
      // Drop other choices that no longer exist with this one.
      m.opts.forEach(function(op){if(op.name!==name&&sel[op.name]&&!valueAvailable(m,sel,op.name,sel[op.name])&&op.values.length>1)sel[op.name]=''});
      render({});
      var again=panel.querySelector('[data-opt="'+(window.CSS&&CSS.escape?CSS.escape(name):name)+'"][data-val="'+(window.CSS&&CSS.escape?CSS.escape(value):value)+'"]');
      if(again)again.focus();
      return;
    }
    var add=e.target.closest('[data-atc-add]');
    if(add&&!add.disabled){
      e.preventDefault();
      var v=variantFor(m,sel);
      if(!v||!v.available)return;
      setBusy(add,true);add.textContent='Adding\u2026';
      addToCart(v.id,1).then(function(){render({added:v})}).catch(function(err){
        delete productJsCache[card.getAttribute('data-handle')];
        render({error:err.message||'Could not add to cart.'});
      });
    }
  });
  panel.addEventListener('keydown',function(e){if(e.key==='Escape'){e.stopPropagation();closeAtcPanel(panel);var b=card.querySelector('[data-atc]');if(b)b.focus()}});
  render(state);
  try{panel.scrollIntoView({block:'nearest',behavior:'smooth'})}catch(_){panel.scrollIntoView(false)}
  var first=panel.querySelector('.ai-chat-atc-val:not(.is-out),.ai-chat-atc-primary,.ai-chat-atc-add:not([disabled])');
  if(first&&first.focus)try{first.focus({preventScroll:true})}catch(_){first.focus()}
}

/* Home → chat: the avatar beside the greeting flies up into the header
   while the name slides over to make room for it. The header avatar's final
   spot is measured with the layout already settled, then both move together.
   No flight for reduced motion, a closed chat, or an avatar off screen. */
function leaveHome(fromRect){
  if(!panel.classList.contains('is-home'))return;
  var hdr=$('.ai-chat-header__avatar',panel);
  var reduce=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(!hdr||!fromRect||!fromRect.width||reduce){panel.classList.remove('is-home');return}
  panel.classList.add('is-measuring');
  panel.classList.remove('is-home');
  var to=hdr.getBoundingClientRect();
  panel.classList.add('is-home');
  void panel.offsetWidth;
  panel.classList.remove('is-measuring');
  panel.classList.add('is-avatar-flying');
  panel.classList.remove('is-home');
  var ghost=el('div','ai-chat-avatar-ghost'+(hdr.classList.contains('ai-chat-header__avatar--placeholder')?' is-placeholder':''),hdr.innerHTML);
  ghost.style.cssText='left:'+fromRect.left+'px;top:'+fromRect.top+'px;width:'+fromRect.width+'px;height:'+fromRect.height+'px';
  document.body.appendChild(ghost);
  var dx=to.left-fromRect.left,dy=to.top-fromRect.top,sc=to.width/fromRect.width;
  var done=function(){if(ghost.parentNode)ghost.parentNode.removeChild(ghost);panel.classList.remove('is-avatar-flying')};
  if(ghost.animate){
    var a=ghost.animate([
      {transform:'translate(0,0) scale(1)'},
      {transform:'translate('+dx+'px,'+dy+'px) scale('+sc+')'}
    ],{duration:520,easing:'cubic-bezier(.2,.8,.2,1)',fill:'forwards'});
    a.onfinish=done;
    setTimeout(done,900);
  }else done();
}
function sendMessage(){
var text=inputEl.value.trim();
if(!text||isStreaming)return;
var w=$('.ai-chat-welcome',msgsEl);
var homeAv=w&&isOpen?$('.ai-chat-welcome__avatar',w):null;
var fromRect=homeAv?homeAv.getBoundingClientRect():null;
if(w)w.remove();
msgsEl.classList.remove('is-welcome');
leaveHome(fromRect);
/* Deactivate any prior choice/suggestion chip rows so chips from
   earlier turns can no longer be tapped — the visible history stays
   readable, but only the latest assistant turn's chips are live. */
var stale=msgsEl.querySelectorAll('.ai-chat-choices, .ai-chat-suggestions, .ai-chat-welcome__qps, .ai-chat-welcome__ctas, .ai-chat-dead-end');
for(var si=0;si<stale.length;si++){stale[si].classList.add('is-stale')}
lastUserMessage=text;
messages.push({role:'user',content:text});
appendMsg('user',text);
saveH(messages);
inputEl.value='';inputEl.style.height='auto';
sendBtn.disabled=true;isStreaming=true;
typingEl.classList.add('visible');
scrollBottom();
streamResponse(text);
}

function deadEndHtml(){
var s='<div class="ai-chat-dead-end">';
s+='<button class="ai-chat-dead-end__btn ai-chat-dead-end__btn--support" data-dead-end="support">'+esc(SUPPORT_LABEL)+'</button>';
s+='<button class="ai-chat-dead-end__btn ai-chat-dead-end__btn--new" data-dead-end="new-chat">Start a new chat</button>';
s+='</div>';
return s;
}

function isCreditOrCriticalError(t){return /temporarily unavailable|credit balance|insufficient|billing/i.test(t||'')}
function isRateLimitError(t){return /high traffic|rate limit|getting a lot of/i.test(t||'')}
function retryRowHtml(){
var btn='<button class="ai-chat-retry-btn" data-retry="1" style="padding:8px 14px;border:1px solid currentColor;background:transparent;color:inherit;border-radius:8px;cursor:pointer;font-size:13px;font-family:inherit">↻ Try again</button>';
if(SUPPORT_URL){
  btn+='<button class="ai-chat-retry-support-btn" data-dead-end="support" style="padding:8px 14px;border:1px solid currentColor;background:transparent;color:inherit;border-radius:8px;cursor:pointer;font-size:13px;font-family:inherit">'+esc(SUPPORT_LABEL)+'</button>';
}
return '<div class="ai-chat-retry-row" style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">'+btn+'</div>';
}
// Append either retry button or support escalation to an error bubble.
// 3-strike rule: after 3 errors on the same chain, escalate to support.
// Critical errors (credit/billing) escalate immediately — retry won't help.
function attachErrorRecovery(bubble,errText){
if(!bubble)return;
errorRetryCount++;
var critical=isCreditOrCriticalError(errText);
var rate=isRateLimitError(errText);
if(critical||errorRetryCount>=3||!lastUserMessage){
  /* Offer support or a fresh start — but the shopper can still type. */
  bubble.insertAdjacentHTML('beforeend',deadEndHtml());
  return;
}
bubble.insertAdjacentHTML('beforeend',retryRowHtml());
if(rate){
  var btn=bubble.querySelector('.ai-chat-retry-btn');
  if(btn){
    var sec=10;btn.disabled=true;btn.style.opacity='0.6';btn.textContent='Wait '+sec+'s…';
    var iv=setInterval(function(){
      sec--;
      if(sec<=0){clearInterval(iv);btn.textContent='↻ Try again';btn.disabled=false;btn.style.opacity='1';return}
      btn.textContent='Wait '+sec+'s…';
    },1000);
  }
}
}
function showStreamError(em){
isStreaming=false;sendBtn.disabled=false;
typingEl.classList.remove('visible');
var md=appendMsg('assistant',em);
/* Shown, not saved: an error isn't something the assistant said, and the
   history is sent back to the model with the next message. */
var bb=$('.ai-chat-msg-bubble',md);
attachErrorRecovery(bb,em);
scrollBottom();
}

function showKlaviyoForm(label){
if(!KLAVIYO_COMPANY_ID||!KLAVIYO_LIST_ID)return;
var d=appendMsg('assistant',label||'Stay Connected');
var b=$('.ai-chat-msg-bubble',d);
if(!b)return;
var formHtml='<div class="ai-chat-klaviyo-form" style="margin-top:12px;padding:16px;background:#f8f8f8;border-radius:10px">'
+'<input type="email" class="ai-kl-email" placeholder="Email address" aria-label="Email address" autocomplete="email" required style="display:block;width:100%;padding:10px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;font-family:inherit;margin-bottom:8px;box-sizing:border-box" />'
+'<input type="tel" class="ai-kl-phone" placeholder="Phone number (optional)" aria-label="Phone number, optional" autocomplete="tel" style="display:block;width:100%;padding:10px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;font-family:inherit;margin-bottom:10px;box-sizing:border-box" />'
+'<button class="ai-kl-submit" type="submit" style="display:block;width:100%;padding:12px;background:var(--ai-chat-primary,#2d6b4f);color:#fff;border:none;border-radius:999px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit">Subscribe</button>'
+'<div class="ai-kl-status" role="status" aria-live="polite" style="font-size:12px;margin-top:8px;text-align:center;display:none"></div>'
+'</div>';
b.insertAdjacentHTML('beforeend',formHtml);
var form=$('.ai-chat-klaviyo-form',b);
var emailIn=$('.ai-kl-email',form);
var phoneIn=$('.ai-kl-phone',form);
var submitBtn=$('.ai-kl-submit',form);
var statusEl=$('.ai-kl-status',form);
submitBtn.addEventListener('click',function(){
  var email=(emailIn.value||'').trim();
  if(!email||email.indexOf('@')===-1){statusEl.style.display='block';statusEl.style.color='#c00';statusEl.textContent='Please enter a valid email.';return}
  submitBtn.disabled=true;submitBtn.textContent='Subscribing...';
  var phone=(phoneIn.value||'').trim();
  var profileAttrs={email:email};
  if(phone)profileAttrs.phone_number=phone;
  fetch('https://a.klaviyo.com/client/subscriptions/?company_id='+encodeURIComponent(KLAVIYO_COMPANY_ID),{
    method:'POST',
    headers:{'Content-Type':'application/json','revision':'2024-10-15'},
    body:JSON.stringify({data:{type:'subscription',attributes:{custom_source:'SEoS Assistant Chat',profile:{data:{type:'profile',attributes:profileAttrs}}},relationships:{list:{data:{type:'list',id:KLAVIYO_LIST_ID}}}}})
  }).then(function(r){
    if(r.ok||r.status===202){
      form.innerHTML='<div style="text-align:center;padding:12px;color:#1d1d1f;font-weight:600;font-size:14px">You\'re subscribed!</div>';
    } else {
      r.text().then(function(t){console.error('[klaviyo] status='+r.status,t)});
      statusEl.style.display='block';statusEl.style.color='#c00';statusEl.textContent='Something went wrong ('+r.status+'). Please try again.';
      submitBtn.disabled=false;submitBtn.textContent='Subscribe';
    }
  }).catch(function(){
    statusEl.style.display='block';statusEl.style.color='#c00';statusEl.textContent='Connection error. Please try again.';
    submitBtn.disabled=false;submitBtn.textContent='Subscribe';
  });
});
scrollBottom();
}

function showHighTraffic(){
showStreamError('I\'m experiencing high traffic right now. Please try again in a moment.');
if(errorRetryCount>=3){later(function(){showKlaviyoForm('Stay Connected')},500)}
}

/* ── FITFinder: the shopper's FIT and the store's FIT names ──
   FITFinder (Aetrex's product-page fit quiz) keeps each shopper's FIT in
   fitfinder_fit (session/local storage) and, for logged-in shoppers, on their
   profile. Its storefront config carries the store's FIT names, copy and quiz
   questions. Sent with each message so the assistant speaks in FITs and skips
   questions the shopper already answered; a FIT worked out in the chat is
   saved back so product pages open on it. No FITFinder → nothing changes. */
var FF_KEY='fitfinder_fit',ff=null,ffLoading=null;
function loadFitfinder(){
  if(ffLoading)return ffLoading;
  ffLoading=fetch(SHOP_ROOT+'apps/fitfinder/config?type=Orthotics&visitor='+encodeURIComponent(getSess()),{credentials:'same-origin',headers:{'Accept':'application/json'}})
    .then(function(r){return r.ok?r.json():null})
    .then(function(d){
      if(!d||d.enabled!==true||!Array.isArray(d.fits)||!d.fits.length)return null;
      ff={
        fits:d.fits.map(function(f){return{key:f.key,label:f.label,code:f.code,name:f.name,description:f.description}}),
        questions:((d.quiz&&d.quiz.questions)||[]).map(function(q){return{text:q.text,helpText:q.helpText,options:(q.options||[]).map(function(o){return{label:o.label,sublabel:o.sublabel}})}}),
        saved:d.savedFit&&d.savedFit.key?String(d.savedFit.key):null,
        loggedIn:d.loggedIn===true
      };
      return ff;
    })
    .catch(function(){return null});
  return ffLoading;
}
function ffStored(){
  var raw=null;
  try{raw=sessionStorage.getItem(FF_KEY)}catch(e){}
  if(raw==null){try{raw=localStorage.getItem(FF_KEY)}catch(e){}}
  try{var v=JSON.parse(raw||'null');return v&&v.key&&v.hint!==true?v:null}catch(e){return null}
}
function ffPayload(){
  if(!ff)return null;
  var local=ffStored();/* a save on this device is the newest choice */
  /* "Retake my FIT": this one message goes without the saved FIT, so the
     questions are asked again; the new answer is saved as usual. */
  if(ffRetake){ffRetake=false;return{fits:ff.fits,questions:ff.questions,saved:{key:''},retake:true}}
  return{fits:ff.fits,questions:ff.questions,saved:{key:(local&&local.key)||ff.saved||''}};
}
/* The same consent rule FITFinder follows: remember across visits only when
   preference cookies are allowed (OneTrust group C0003 or Shopify's banner). */
function ffMayRemember(){
  var g=window.OnetrustActiveGroups||window.OptanonActiveGroups;
  if(typeof g==='string')return g.indexOf('C0003')!==-1;
  try{var cp=window.Shopify&&window.Shopify.customerPrivacy;if(cp&&typeof cp.preferencesProcessingAllowed==='function')return cp.preferencesProcessingAllowed()===true}catch(e){}
  return false;
}
function ffSave(key){
  if(!ff)return;
  var f=null;
  for(var i=0;i<ff.fits.length;i++){if(ff.fits[i].key===key)f=ff.fits[i]}
  if(!f)return;
  var v=JSON.stringify({key:f.key,label:f.label,code:f.code,savedAt:Date.now()});
  try{sessionStorage.setItem(FF_KEY,v)}catch(e){}
  if(ffMayRemember()){try{localStorage.setItem(FF_KEY,v)}catch(e){}}
  if(ff.loggedIn){
    fetch(SHOP_ROOT+'apps/fitfinder/fit',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({fitKey:f.key})}).catch(function(){});
  }
  ff.saved=f.key;
  /* They have a FIT now: earlier cards stop offering to find one. */
  var stale=msgsEl.querySelectorAll('.ai-chat-card-fit[data-helper="fitfinder"]');
  for(var si=0;si<stale.length;si++)stale[si].parentNode.removeChild(stale[si]);
}

var streamWatchdog=null;
/* The last 20 turns before this message (it's sent separately). */
function historyFor(msg){var h=messages.slice(-21);var last=h[h.length-1];if(last&&last.role==='user'&&last.content===msg)h.pop();return h.slice(-20)}
function clearWatchdog(){if(streamWatchdog){clearTimeout(streamWatchdog);streamWatchdog=null}}
/* Gives up only after 90s with nothing from the server — the server sends a
   keep-alive every few seconds, so a long but healthy answer never trips it. */
function armWatchdog(){
clearWatchdog();
streamWatchdog=setTimeout(function(){
  if(isStreaming&&abortCtrl){
    try{abortCtrl.abort()}catch(e){}
    showStreamError('This is taking longer than expected. Please try again.');
  }
},90000);
}
function streamResponse(msg){
if(abortCtrl)abortCtrl.abort();
abortCtrl=new AbortController();
armWatchdog();
var body={message:msg,session_id:getSess(),shop_domain:SHOP,assistant_name:NAME,history:historyFor(msg).map(function(m){var out={role:m.role,content:m.content};if(m.role==='assistant'&&m.products&&m.products.length){out.products=m.products.slice(0,10).map(function(p){return{handle:p.handle||'',title:p.title||'',url:p.url||'',image:p.image||'',price:p.price||'',price_formatted:p.price_formatted||'',compare_at_price:p.compare_at_price||'',category:p.category||p._category||'',gender:p.gender||p._gender||''}})}return out})};
if(SUPPORT_URL)body.support_url=SUPPORT_URL;
if(SUPPORT_LABEL)body.support_label=SUPPORT_LABEL;
var ffData=ffPayload();
var tfData=tfPayload();
if(tfData)body.size_finder=tfData;
if(ffData)body.fitfinder=ffData;
else loadFitfinder();
fetch(CHAT_URL,{method:'POST',headers:{'Content-Type':'application/json','Accept':'text/event-stream'},body:JSON.stringify(body),signal:abortCtrl.signal}).then(function(r){
if(!r.ok){
  if(r.headers.get('content-type')&&r.headers.get('content-type').includes('text/event-stream'))return handleSSE(r);
  return r.json().catch(function(){return{}}).then(function(d){
    var err=new Error(d.message||'');err.status=r.status;err.code=d.error||'';throw err;
  });
}
var ct=r.headers.get('content-type')||'';
if(ct.includes('text/event-stream')||ct.includes('text/plain'))return handleSSE(r);
return r.json().then(function(d){handleJSON(d)});
}).catch(function(e){
clearWatchdog();
if(e.name==='AbortError')return;
typingEl.classList.remove('visible');isStreaming=false;sendBtn.disabled=false;
/* The store's own limits and settings: say so plainly — retrying won't help. */
if(e.status===429&&e.code==='rate_limited'){showStreamError('You\'re sending messages quickly — please wait a few seconds and try again.');return}
if(e.status===402||e.status===503||(e.status===429&&e.code==='daily_cap_reached')){showStreamError(e.message||'The assistant isn\'t available right now. Our customer service team will be glad to help.');return}
if(e.status===413||e.status===400){showStreamError('That message couldn\'t be sent. Please try a shorter question, or start a new chat from the menu.');return}
showHighTraffic();
});
}

function handleSSE(response){
var reader=response.body.getReader();
var decoder=new TextDecoder();
var buf='',full='',prods=[],msgDiv=null,buffSugg=[],buffChoices=[],linkCTA=null,fitReport=null,vizCta=null,supportCta=null,sizeFinder=null;
fitResult=null;
function proc(chunk){
buf+=chunk;var lines=buf.split('\n');buf=lines.pop()||'';
for(var i=0;i<lines.length;i++){
var line=lines[i].trim();
if(!line.startsWith('data: '))continue;
var data=line.slice(6);
try{
var p=JSON.parse(data);
if(p.type==='text'){
  full+=p.text||'';
}
if(p.type==='products'&&p.products){
  /* Each products event is the FULL card set (server contract: last one wins) — replace, never append. */
  prods=p.products.slice();
}
if(p.type==='link'&&p.url){
  linkCTA={url:p.url,label:p.label||'Visit Support Hub'};
}
if(p.type==='support_cta'){
  supportCta={label:p.label||SUPPORT_LABEL,fallbackUrl:p.fallbackUrl||SUPPORT_URL||''};
}
if(p.type==='suggestions'&&p.questions&&p.questions.length){
  buffSugg=p.questions;
}
if(p.type==='fit_report'&&p.recommendedSize){
  var _d=p.display==='percent'?'percent':(p.display==='hide'?'hide':'bar');
  fitReport={handle:p.handle||'',productTitle:p.productTitle||'',size:p.recommendedSize,confidence:Math.max(0,Math.min(100,parseInt(p.confidence,10)||0)),reasons:Array.isArray(p.reasons)?p.reasons:[],display:_d};
}
if(p.type==='fitfinder_fit'&&p.key){
  ffSave(String(p.key));
  fitResult=String(p.key);
}
if(p.type==='size_finder'&&p.handle){
  sizeFinder={handle:String(p.handle),title:String(p.title||'')};
}
if(p.type==='klaviyo_form'){
  later(function(){showKlaviyoForm('Stay Connected')},300);
}
if(p.type==='visualize_cta'&&p.productHandle){
  vizCta={productHandle:p.productHandle,productTitle:p.productTitle||'',styleContext:p.styleContext||'',label:p.label||'See It Styled',scenes:(p.scenes&&p.scenes.length)?p.scenes:null,sceneGroup:p.sceneGroup||'',productCategory:p.productCategory||''};
}
if(p.type==='done'){finish(full,prods,msgDiv,buffSugg,linkCTA,fitReport,buffChoices,vizCta,supportCta,sizeFinder);return true}
if(p.type==='error'){
  showStreamError(p.message||'I\'m sorry, I\'m having trouble right now. Please try again in a moment.');
  return true;
}
}catch(e){}
}return false}
function read(){reader.read().then(function(r){armWatchdog();if(r.done){if(full)finish(full,prods,msgDiv,buffSugg,linkCTA,fitReport,buffChoices,vizCta,supportCta,sizeFinder);else showStreamError('I\'m having trouble right now. Please try again.');return}var done=proc(decoder.decode(r.value,{stream:true}));if(!done)read()}).catch(function(e){if(e.name!=='AbortError'){if(full)finish(full,prods,msgDiv,buffSugg,linkCTA,fitReport,buffChoices,vizCta,supportCta,sizeFinder);else showStreamError('Connection lost. Please try again.')}})}
read();
}

function handleJSON(d){
typingEl.classList.remove('visible');
var c=d.message||d.response||d.text||'Sorry, no response. Try again.';
var p=d.products||[];
messages.push({role:'assistant',content:c,products:p});
appendMsg('assistant',c,p);saveH(messages);
isStreaming=false;sendBtn.disabled=false;
}

function fitSnippetHtml(fr){
if(!fr||!fr.size)return '';
var conf=fr.confidence||0;
var confBlock='';
if(fr.display==='percent'){
  confBlock='<div class="ai-chat-product-fit-pct">'+conf+'% sure</div>';
}else if(fr.display!=='hide'){
  confBlock='<div class="ai-chat-product-fit-bar" role="progressbar" aria-valuenow="'+conf+'" aria-valuemin="0" aria-valuemax="100"><div class="ai-chat-product-fit-bar-fill" style="width:'+conf+'%"></div></div><div class="ai-chat-product-fit-pct">'+conf+'% sure</div>';
}
return '<div class="ai-chat-product-fit" aria-label="Size recommendation">'+
  '<span class="ai-chat-product-fit-label">▸ FIT FINDER</span>'+
  '<div class="ai-chat-product-fit-size">Size <strong>'+esc(fr.size)+'</strong></div>'+
  confBlock+
'</div>';
}

function fitReportHtml(fr){
if(!fr||!fr.size)return '';
var conf=fr.confidence||0;
var confBlock='';
if(fr.display!=='hide'){
  var bar=fr.display==='percent'?'<div class="ai-chat-fit-percent">'+conf+'%</div>':'<div class="ai-chat-fit-bar" role="progressbar" aria-valuenow="'+conf+'" aria-valuemin="0" aria-valuemax="100"><div class="ai-chat-fit-bar-fill" style="width:'+conf+'%"></div><span class="ai-chat-fit-bar-val">'+conf+'%</span></div>';
  confBlock='<div class="ai-chat-fit-conf-label">Confidence</div>'+bar;
}
var reasonsHtml='';
if(fr.reasons&&fr.reasons.length){
  reasonsHtml='<ul class="ai-chat-fit-reasons">';
  for(var i=0;i<fr.reasons.length;i++){reasonsHtml+='<li>'+esc(fr.reasons[i])+'</li>'}
  reasonsHtml+='</ul>';
}
var forLine=fr.productTitle?'<div class="ai-chat-fit-for">For <strong>'+esc(fr.productTitle)+'</strong></div>':'';
return '<div class="ai-chat-fit-card" role="region" aria-label="Size recommendation for '+esc(fr.productTitle||'product')+'">'+
  '<div class="ai-chat-fit-head"><span class="ai-chat-fit-icon" aria-hidden="true">▸</span><span class="ai-chat-fit-title">Fit finder</span></div>'+
  forLine+
  '<div class="ai-chat-fit-size">Recommended size <strong>'+esc(fr.size)+'</strong></div>'+
  confBlock+
  reasonsHtml+
'</div>';
}

// Remove orphaned/empty markdown emphasis so stray ** or * never render
// to the customer. Targets the cases left behind by chip removal: empty
// runs (**, ****, ** **), a marker floating between spaces/punctuation,
// and any line that ends up with an odd (unbalanced) count of ** or *.
function stripDanglingMd(s){
  s=String(s||'');
  s=s.replace(/\*\*\s*\*\*/g,'').replace(/__\s*__/g,'');
  s=s.replace(/(^|[\s—–-])\*\*(?=[\s.,!?;:)]|$)/g,'$1');
  s=s.replace(/(^|[\s—–-])\*(?=[\s.,!?;:)]|$)/g,'$1');
  s=s.split('\n').map(function(ln){
    if(((ln.match(/\*\*/g)||[]).length)%2)ln=ln.replace(/\*\*/g,'');
    /* Lone * (not part of **): an odd count means a stray one — drop them. */
    if(((ln.match(/\*+/g)||[]).filter(function(r){return r.length===1}).length)%2)ln=ln.replace(/\*+/g,function(r){return r.length===1?'':r});
    return ln;
  }).join('\n');
  return s.replace(/[ \t]{2,}/g,' ').replace(/[ \t]+([.,!?;:])/g,'$1').replace(/([—–-])\s+([.,!?;:])/g,'$2').trim();
}
function finish(text,prods,md2,sugg,linkCTA,fitReport,sseChoices,vizCta,supportCta,sizeFinder){clearWatchdog();
typingEl.classList.remove('visible');isStreaming=false;sendBtn.disabled=false;
errorRetryCount=0;
var mDiv=md2;
var choices=[];
var cleanText=text||'';
var choiceRe=/<<([^<>]+)>>/g;
var cm;while((cm=choiceRe.exec(cleanText))!==null){choices.push(cm[1])}
if(choices.length>0)cleanText=cleanText.replace(/\s*<<[^<>]+>>/g,'').trim();
// Removing <<chips>> can leave orphaned markdown emphasis behind when the
// model wrapped the chips (or words it placed them among) in ** ** — e.g.
// "interested in — **<<Men's>><<Women's>>** styles?" becomes "— ** styles?".
// Strip any dangling/empty bold or italic markers so they never render raw.
cleanText=stripDanglingMd(cleanText);
// SSE-delivered choices (engine browse-clarifier) merge into the
// same chip set as in-text <<...>> markers. finish() owns the
// bubble's final HTML — no other code path inserts chips.
if(Array.isArray(sseChoices)&&sseChoices.length){
  for(var sc=0;sc<sseChoices.length;sc++){
    var c=String(sseChoices[sc]||'').trim();
    if(c&&choices.indexOf(c)===-1)choices.push(c);
  }
}
if(cleanText){
  if(!mDiv)mDiv=appendMsg('assistant',cleanText,prods);
  else{var b=$('.ai-chat-msg-bubble',mDiv);if(b){b.innerHTML='<p>'+md(esc(cleanText))+'</p>';if(prods&&prods.length){var isShowcase2=PRODUCT_CARD_STYLE==='showcase';var styleSuffix2=isShowcase2?' ai-chat-products--showcase':'';var ph='<div class="ai-chat-products'+styleSuffix2+'">';for(var pi=0;pi<prods.length;pi++)ph+=prodCard(prods[pi]);ph+='</div>';b.insertAdjacentHTML('beforeend',isShowcase2?showcaseWrap(ph):ph);if(isShowcase2){var w2=b.querySelector('.ai-chat-products-wrap');if(w2)initShowcaseArrows(w2)}}}}
  var _saved={role:'assistant',content:cleanText,products:prods||[]};
  if(linkCTA&&linkCTA.url)_saved.linkCTA={url:linkCTA.url,label:linkCTA.label||''};
  messages.push(_saved);saveH(messages)
}
if(vizCta&&vizCta.productHandle&&mDiv){
  var _vh=(vizCta.productHandle||'').replace(/"/g,'');
  var _vcard=mDiv.querySelector('.ai-chat-product-card[data-handle="'+_vh+'"]');
  if(_vcard)injectVizButton(_vcard,vizCta);
}
if(choices.length>0&&mDiv){
  var cb=$('.ai-chat-msg-bubble',mDiv);
  if(cb){cb.insertAdjacentHTML('beforeend',choiceButtonsHtml(choices));var lc2=cb.querySelector('.ai-chat-choices:last-of-type');if(lc2)initChoicesScroll(lc2)}
}
if(linkCTA&&linkCTA.url&&mDiv){
  var lb=$('.ai-chat-msg-bubble',mDiv);
  if(lb)lb.insertAdjacentHTML('beforeend',ctaHtml(linkCTA));
}
if(supportCta&&mDiv){
  var scb=$('.ai-chat-msg-bubble',mDiv);
  if(scb)scb.insertAdjacentHTML('beforeend',supportCtaHtml(supportCta));
}
if(fitResult&&mDiv){
  var fitP=$('.ai-chat-msg-bubble > p',mDiv),fitObj=null;
  for(var fi=0;ff&&fi<ff.fits.length;fi++){if(ff.fits[fi].key===fitResult)fitObj=ff.fits[fi]}
  if(fitP&&fitObj)fitP.insertAdjacentHTML('afterend',fitCardHtml(fitObj));
  fitResult=null;
}
if(sizeFinder&&mDiv){
  var tfb=$('.ai-chat-msg-bubble',mDiv);
  if(tfb)tfb.insertAdjacentHTML('beforeend',trueFitBtnHtml(sizeFinder));
}
if(fitReport&&fitReport.size&&mDiv){
  var frb=$('.ai-chat-msg-bubble',mDiv);
  if(frb){
    var _h=(fitReport.handle||'').replace(/"/g,'');
    var matchProd=_h?frb.querySelector('.ai-chat-product-card[data-handle="'+_h+'"]'):null;
    /* Showcase cards have no room for the inline snippet (hidden there):
       show the full fit card under the reply instead. */
    if(matchProd&&!matchProd.closest('.ai-chat-products--showcase')){
      matchProd.classList.add('has-fit');
      matchProd.insertAdjacentHTML('beforeend',fitSnippetHtml(fitReport));
    }else{
      var tmp=document.createElement('div');
      tmp.innerHTML=fitReportHtml(fitReport);
      var fitEl=tmp.firstChild;
      if(fitEl)frb.appendChild(fitEl);
    }
  }
}
if(sugg&&sugg.length>0&&mDiv){
  var sb=$('.ai-chat-msg-bubble',mDiv);
  // Subtle "Quick replies" header above the follow-up
  // suggestion chips. Was "Customers also asked" originally — but
  // production showed the AI generates not just questions, but full
  // reply phrasings ("I have flat feet and my ankles roll inward..."),
  // condition descriptions, and "yes / no" answers. The "customers
  // also asked" framing implied social proof for content that's
  // actually AI-suggested next-replies. "Quick Replies" matches the
  // iMessage / WhatsApp / Messenger UX pattern users already
  // recognize as 'tap to send' and works for any reply shape.
  if(sb){var sg='<div class="ai-chat-suggestions"><div class="ai-chat-suggestions-label">Quick replies</div>';for(var si=0;si<sugg.length;si++){sg+='<button class="ai-chat-suggest-btn" data-message="'+esc(sugg[si])+'"><span class="suggest-plus">+</span> '+esc(sugg[si])+'</button>'}sg+='</div>';sb.insertAdjacentHTML('beforeend',sg)}
}
if(prods&&prods.length>0&&mDiv){
  var fb=$('.ai-chat-msg-bubble',mDiv);
  if(SHOW_FEEDBACK&&fb&&!$('.ai-chat-feedback',fb)){
    fb.insertAdjacentHTML('beforeend','<div class="ai-chat-feedback"><button class="ai-chat-fb-btn" data-vote="up"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg> Helpful</button><button class="ai-chat-fb-btn" data-vote="down"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/><path d="M17 2h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3"/></svg> Not helpful</button></div>');
    fb.querySelectorAll('.ai-chat-fb-btn').forEach(function(btn){
      btn.addEventListener('click',function(){
        var vote=this.getAttribute('data-vote');
        var wrap=this.closest('.ai-chat-feedback');
        wrap.innerHTML='<span class="ai-chat-fb-thanks">'+(vote==='up'?'Thanks for the feedback!':'Sorry about that, we\'ll improve!')+'</span>';
        var payload={vote:vote,session:getSess(),botResponse:(text||'').slice(0,500),products:(prods||[]).map(function(p){return p.title||''}).slice(0,5)};
        if(vote==='down'){payload.conversation=messages.slice(-10).map(function(m){return{role:m.role,content:(m.content||'').slice(0,300)}})}
        try{fetch(FEEDBACK_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})}catch(e){}
      });
    });
  }
}
scrollMsgTop(mDiv);
}

/* Delayed UI for the current chat only — "Clear chat" cancels it. */
var chatGen=0;
function later(fn,ms){var g=chatGen;setTimeout(function(){if(g===chatGen)fn()},ms)}
function clearChat(){
chatGen++;clearWatchdog();
messages=[];_memSess='';try{localStorage.removeItem(HK);localStorage.removeItem(SK)}catch(e){}
msgsEl.innerHTML='';buildWelcome();
if(isOpen)playWelcomeIntro();
if(abortCtrl){abortCtrl.abort();abortCtrl=null}
isStreaming=false;typingEl.classList.remove('visible');

errorRetryCount=0;lastUserMessage='';
/* Always restore the input — dead-end paths (error retries, banned-
   reply fallbacks, support/new-chat dead-ends) disable inputEl and
   set a "Choose an option above" placeholder. Without this reset the
   input stays locked after a refresh, leaving the customer unable to
   type. */
inputEl.disabled=false;inputEl.placeholder=IPLACE;inputEl.value='';
inputEl.style.height='auto';
sendBtn.disabled=false;
}

/* Events */
launcher.addEventListener('click',function(e){
if(e.target.closest('.ai-chat-launcher__close')){e.stopPropagation();setLauncherBubble(true);return}
if(launcher.classList.contains('is-bubble'))setLauncherBubble(false);
toggle(true);
});
closeBtn.addEventListener('click',function(){toggle(false)});
launcher.addEventListener('keydown',function(e){if((e.key==='Enter'||e.key===' ')&&!e.target.closest('.ai-chat-launcher__close')){e.preventDefault();if(launcher.classList.contains('is-bubble'))setLauncherBubble(false);toggle(true)}});
overlay.addEventListener('click',function(){toggle(false)});
sendBtn.addEventListener('click',sendMessage);
inputEl.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage()}});
inputEl.addEventListener('input',function(){this.style.height='auto';this.style.height=Math.min(this.scrollHeight,100)+'px'});
document.addEventListener('keydown',function(e){if(e.key==='Escape'&&isOpen)toggle(false)});
menuBtn.setAttribute('aria-haspopup','true');menuBtn.setAttribute('aria-expanded','false');
menuBtn.addEventListener('click',function(e){e.stopPropagation();var show=menu.style.display==='none';if(show)menu.innerHTML=menuHtml();menu.style.display=show?'block':'none';menuBtn.setAttribute('aria-expanded',show?'true':'false');if(show){var first=menu.querySelector('.ai-chat-menu-item');if(first)first.focus({preventScroll:true})}});
menu.addEventListener('click',function(e){
  var item=e.target.closest('[data-action]');if(!item)return;
  var a=item.dataset.action;
  menu.style.display='none';menuBtn.setAttribute('aria-expanded','false');
  if(a==='clear')clearChat();
  else if(a==='refit'){if(!isStreaming)startHelper('refit')}
  else if(a==='login')location.href=loginUrl();
  /* Signing out takes this customer's chat and sizes with it. */
  else if(a==='logout'){forgetPersonal();try{localStorage.setItem(OWNER_KEY,'guest')}catch(e){}location.href=CUST_LOGOUT_URL}
});
menu.addEventListener('keydown',function(e){
  if(e.key==='Escape'){menu.style.display='none';menuBtn.setAttribute('aria-expanded','false');menuBtn.focus();return}
  if(e.key!=='ArrowDown'&&e.key!=='ArrowUp')return;
  e.preventDefault();
  var list=[].slice.call(menu.querySelectorAll('.ai-chat-menu-item')),i=list.indexOf(document.activeElement);
  var n=list[(i+(e.key==='ArrowDown'?1:-1)+list.length)%list.length];if(n)n.focus();
});
document.addEventListener('click',function(){menu.style.display='none'});
msgsEl.addEventListener('click',function(e){
var retryBtn=e.target.closest('[data-retry]');
if(retryBtn){
  if(retryBtn.disabled||isStreaming||!lastUserMessage)return;
  var row=retryBtn.closest('.ai-chat-retry-row');
  if(row&&row.parentNode)row.parentNode.removeChild(row);
  inputEl.disabled=false;inputEl.placeholder=IPLACE;sendBtn.disabled=false;
  /* The failed message is sent again — not stacked twice in the history. */
  var lm=messages[messages.length-1];
  if(lm&&lm.role==='user'&&lm.content===lastUserMessage){messages.pop();saveH(messages)}
  inputEl.value=lastUserMessage;sendMessage();
  return;
}
var atcBtn=e.target.closest('[data-atc]');
if(atcBtn){e.preventDefault();e.stopPropagation();startAddToCart(atcBtn.closest('.ai-chat-product-card'),atcBtn);return}
// Handoff support CTA button → live chat (Zendesk/Intercom/Gorgias), Support
// Hub URL only as fallback.
var helperBtn=e.target.closest('[data-helper]');
if(helperBtn){e.preventDefault();if(!isStreaming)startHelper(helperBtn.getAttribute('data-helper'));return;}
var tfBtn=e.target.closest('[data-truefit]');
if(tfBtn){e.preventDefault();trueFitFor(tfBtn.getAttribute('data-truefit'),tfBtn.getAttribute('data-title')||'');return;}
var supportCtaBtn=e.target.closest('[data-support-cta]');
if(supportCtaBtn){e.preventDefault();openSupportChat(supportCtaBtn.getAttribute('data-fallback'));return;}
var deadEnd=e.target.closest('[data-dead-end]');
if(deadEnd){
  var action=deadEnd.getAttribute('data-dead-end');
  if(action==='support'){openSupportChat(SUPPORT_URL);}
  if(action==='new-chat'){clearChat();inputEl.disabled=false;inputEl.placeholder=IPLACE;sendBtn.disabled=false}
  return;
}
var cta=e.target.closest('[data-message]');
if(cta){var t=cta.getAttribute('data-message');if(t){inputEl.disabled=false;inputEl.placeholder=IPLACE;sendBtn.disabled=false;inputEl.value=t;sendMessage()}}
/* Chat product link clicks → set a cart attribute so the orders/create
   webhook can tag the resulting order "SEoS". keepalive lets the POST
   complete even though the browser is navigating away. Best-effort —
   any failure is silent (we don't block navigation on a tracking call). */
var prodLink=e.target.closest('.ai-chat-product-card a[href]');
if(prodLink)markChatAttributed();
});

/* Init */
setTimeout(tfResume,0);
if(messages.length===0)buildWelcome();
else for(var i=0;i<messages.length;i++){
  var _md=appendMsg(messages[i].role,messages[i].content,messages[i].products);
  var _cta=messages[i].linkCTA;
  if(_cta&&_cta.url&&_md){var _lb=$('.ai-chat-msg-bubble',_md);if(_lb)_lb.insertAdjacentHTML('beforeend',ctaHtml(_cta))}
}

})();
