(function(){
'use strict';

/* Build marker — bump on widget changes so a live deploy can be verified
   in DevTools console. If you don't see this line after `shopify app deploy`
   + hard refresh, the new bundle isn't live (stale checkout or CDN cache). */
try{console.log('[hajirai-widget] build 2026-10-30 focus-home');}catch(e){}

/* Visual config comes from theme editor (liquid-injected as window.__AI_CHAT_CONFIG).
   Chat server URL is handled internally via app proxy at /apps/hajirai/chat. */
var C=window.__AI_CHAT_CONFIG||{};

var CHAT_URL='/apps/hajirai/chat';
var FEEDBACK_URL='/apps/hajirai/feedback';
var CONFIG_URL='/apps/hajirai/widget-config';
/* Settings → Peak Mode → Preview: ?ava_preview=<token> on any page shows the
   peak home to this browser for the session, whatever the switch says. */
var PREVIEW='';
try{var _pv=(location.search.match(/[?&]ava_preview=([0-9a-f]{32})/)||[])[1];if(_pv){PREVIEW=_pv;sessionStorage.setItem('hajirai_preview',_pv)}else PREVIEW=sessionStorage.getItem('hajirai_preview')||''}catch(e){}
var VISUALIZE_URL='/apps/hajirai/visualize';
var ACTIVITY_URL='/apps/hajirai/activity';
(function(){try{if(document.getElementById('ai-chat-viz-keyframes-style'))return;var st=document.createElement('style');st.id='ai-chat-viz-keyframes-style';st.textContent='@keyframes aiChatViz{0%{background-position:100% 0}100%{background-position:-100% 0}}@keyframes aiChatVizSpin{to{transform:rotate(360deg)}}';(document.head||document.documentElement).appendChild(st)}catch(e){}})();
var HRK='hajirai_hide_rules';
var PCSK='hajirai_product_card_style';

/* The rule for this page (Settings → Showing the chat → Hide on pages):
   each hides the chat here, or shows it minimized (mode "compact"). */
function hideRuleFor(rules){
  if(!rules||!rules.length)return null;
  var path=window.location.pathname;
  for(var i=0;i<rules.length;i++){
    var r=rules[i];if(!r)continue;
    if(r.matchType==='equals'&&path===r.pattern)return r;
    if(r.matchType==='contains'&&path.indexOf(r.pattern)!==-1)return r;
  }
  return null;
}
function matchesHideRule(rules){var r=hideRuleFor(rules);return !!r&&r.mode!=='compact'}
function compactRuleFor(rules){var r=hideRuleFor(rules);return !!r&&r.mode==='compact'}
/* Set when this page shows the chat minimized: the bar stays a bubble here. */
var COMPACT_BY_URL=false;

/* Set when the assistant is hidden here: a page the store hides it on, or a
   shopper outside the store's home countries. */
var HIDDEN_BY_URL=false;
var _cachedRules=null;
try{_cachedRules=JSON.parse(sessionStorage.getItem(HRK))}catch(e){}
if(_cachedRules&&matchesHideRule(_cachedRules))return;

/* International shoppers (Settings → Showing the chat): the shopper's country
   as Global-e sets it (its GlobalE_Data cookie), else Shopify Markets'. No
   country known: treat as home. The store's choice is remembered, so later
   pages skip the chat entirely. */
var INTL_KEY='hajirai_intl';
function shopperCountry(){
  try{
    var m=document.cookie.match(/(?:^|;\s*)GlobalE_Data=([^;]+)/);
    if(m){var raw=decodeURIComponent(m[1]);if(raw.charAt(0)==='%')raw=decodeURIComponent(raw);var g=JSON.parse(raw);if(g&&/^[A-Za-z]{2}$/.test(g.countryISO||''))return g.countryISO.toUpperCase()}
  }catch(e){}
  try{var c=window.Shopify&&window.Shopify.country;if(c&&/^[A-Za-z]{2}$/.test(c))return String(c).toUpperCase()}catch(e){}
  return '';
}
function isAbroad(cfg){
  if(!cfg||cfg.hide!==true)return false;
  var c=shopperCountry(),home=Array.isArray(cfg.home)&&cfg.home.length?cfg.home:['US'];
  return !!c&&home.indexOf(c)<0;
}
try{if(isAbroad(JSON.parse(localStorage.getItem(INTL_KEY)||'null')))return}catch(e){}
function hideAssistant(){
  HIDDEN_BY_URL=true;
  if(isOpen&&typeof toggle==='function')toggle(false);
  ['.ai-chat-launcher','.ai-chat-panel','.ai-chat-overlay'].forEach(function(sel){var el=document.querySelector(sel);if(el)el.style.display='none'});
}

/* ?cta= is the welcome line shown here, so its translations match it. */
fetch(CONFIG_URL+'?cta='+encodeURIComponent(C.greetingCta||'What can I help you find today?')+'&av='+encodeURIComponent(C.avatarUrl||'')+(PREVIEW?'&preview='+PREVIEW:'')).then(function(r){return r.json()}).then(function(d){
  if(d.showFeedback===false){SHOW_FEEDBACK=false;var _fr=msgsEl.querySelectorAll('.ai-chat-feedback');for(var _fi=0;_fi<_fr.length;_fi++)_fr[_fi].remove()}
  if(d.chatRating&&typeof d.chatRating==='object'){RATE_ON=d.chatRating.on!==false;var _ra=parseInt(d.chatRating.after,10);if(_ra>=2&&_ra<=8)RATE_AFTER=_ra}
  if(d.orbColors!==undefined)setOrbColors(d.orbColors);
  if(d.orbBackground!==undefined)setOrbBackground(d.orbBackground);
  if(d.launcherMark&&typeof d.launcherMark==='object')setLauncherMark(d.launcherMark);
  if(d.recording&&typeof d.recording==='object'){REC_ON=d.recording.on===true;REC_SCOPE=d.recording.scope==='everyone'?'everyone':'testers'}
  REWARDS=d.rewards&&typeof d.rewards==='object'&&d.rewards.title?d.rewards:null;
  HUMAN=d.human&&typeof d.human==='object'?d.human:null;
  RETURNS=d.returns&&typeof d.returns==='object'?d.returns:null;
  DEALS=d.deals&&typeof d.deals==='object'?d.deals:null;
  FOCUS_COLLECTIONS=d.focusCollections!==false;
  var _pk=d.peak&&typeof d.peak==='object'?d.peak:null,_pkWas=JSON.stringify(PEAK);
  try{if(_pk)sessionStorage.setItem(PEAK_KEY,JSON.stringify(_pk));else sessionStorage.removeItem(PEAK_KEY)}catch(e){}
  if(JSON.stringify(_pk)!==_pkWas){PEAK=_pk;applyPeakColors();setAvatar(PEAK&&PEAK.avatar&&safeUrl(PEAK.avatar)?PEAK.avatar:AVATAR_USUAL);if(typeof msgsEl!=='undefined'&&msgsEl&&msgsEl.classList.contains('is-welcome')&&typeof buildWelcome==='function')buildWelcome()}
  if(RETURNS&&RETURNS.pages&&!Object.keys(ordPages).length)ordPages=cleanPages(RETURNS.pages);
  /* The home's links row may already be drawn: give it the My rewards button.
     And a restored chat's cards, drawn before these settings arrived, go in now. */
  if(typeof msgsEl!=='undefined'&&msgsEl){
    if(msgsEl.classList.contains('is-welcome')){var _lk=msgsEl.querySelector('.ai-chat-focus__links');if(_lk)_lk.innerHTML=focusLinksHtml()}
    var _ms=msgsEl.querySelectorAll('.ai-chat-msg--assistant');
    for(var _i=0;_i<_ms.length;_i++){var _mm=_ms[_i].__msg,_bb=_ms[_i].querySelector('.ai-chat-msg-bubble');if(!_mm||!_bb)continue;
      if(_mm.rewards&&REWARDS&&!_bb.querySelector('.ai-rw')){_bb.insertAdjacentHTML('beforeend',rewardsCardHtml(REWARDS));var _rc=_bb.querySelector('[data-rw]');if(_rc)rwFillBalance(_rc)}
      if(_mm.human&&HUMAN&&!_bb.querySelector('.ai-hh'))_bb.insertAdjacentHTML('beforeend',humanCardHtml(HUMAN));
      if(_mm.returns&&RETURNS&&!_bb.querySelector('.ai-rt')){_bb.insertAdjacentHTML('beforeend',returnsCardHtml(_mm));rtFill(_bb.querySelector('[data-rt]'),_mm)}
      if(_mm.deals&&DEALS&&!_bb.querySelector('.ai-dl')){dlInsert(_bb,_mm);dlFill(_bb.querySelector('[data-dl]'),_mm)}}
  }
  if(d.voiceInput===false){VOICE_OFF=true;if(typeof showMic==='function')showMic()}
  /* Settings → Support link wins over the theme editor's. */
  if(typeof d.supportUrl==='string'&&d.supportUrl)SUPPORT_URL=d.supportUrl;
  if(typeof d.supportLabel==='string'&&d.supportLabel)SUPPORT_LABEL=d.supportLabel;
  var wo=d.whichOrthotic&&typeof d.whichOrthotic==='object'?d.whichOrthotic:null;
  WO_FORM=wo&&/^[A-Za-z0-9]{4,32}$/.test(String(wo.form||''))?String(wo.form):'';WO_LABEL=String((wo&&wo.label)||'').trim().slice(0,40)||'Identify my orthotic';
  if(d.feedbackSurvey&&typeof d.feedbackSurvey==='object'){
    var hb={fb:d.feedbackSurvey,hideChat:d.hideLiveChatButton===true},was=[FB_ON,FB_FORM,FB_LABEL,FB_COLOR,FB_ICON,FB_HIDE_AFTER].join('|');
    try{localStorage.setItem(HOST_KEY,JSON.stringify(hb))}catch(e){}
    applyHostButtons(hb);
    if(was!==[FB_ON,FB_FORM,FB_LABEL,FB_COLOR,FB_ICON,FB_HIDE_AFTER].join('|')&&typeof refreshWelcomeCtas==='function')refreshWelcomeCtas();
  }
  if(d.chatTexts&&typeof d.chatTexts==='object'){
    var txtNow=function(){return [NAME,NAME_SUB,GREET,GREET_LOGGED,LPLACE,IPLACE,START_LBL,POP_LBL,FIT_LBL,GREETCTA,DISCL,JSON.stringify(FT)].join('|')},txtWas=txtNow(),inWas=IPLACE;
    try{localStorage.setItem(TXT_KEY,JSON.stringify(d.chatTexts))}catch(e){}
    setTexts(d.chatTexts);
    if(txtWas!==txtNow()&&typeof refreshTexts==='function')refreshTexts(inWas);
  }
  if(d.appPromo&&typeof d.appPromo==='object')APP_PROMO={on:d.appPromo.on!==false,ios:String(d.appPromo.ios||''),android:String(d.appPromo.android||''),text:String(d.appPromo.text||'').slice(0,60),button:String(d.appPromo.button||'').slice(0,16),image:/^\/apps\/hajirai\/app-image\?v=[a-z0-9]{1,16}$/.test(String(d.appPromo.image||''))?String(d.appPromo.image):''};
  if(d.seasonalCta&&typeof d.seasonalCta==='object'){
    var seaWas=[SEA_ON,SEA_ICON,SEA_COLOR,SEA_LABEL].join('|');
    try{localStorage.setItem(SEA_KEY,JSON.stringify(d.seasonalCta))}catch(e){}
    applySeasonal(d.seasonalCta);
    if(seaWas!==[SEA_ON,SEA_ICON,SEA_COLOR,SEA_LABEL].join('|')&&typeof refreshWelcomeCtas==='function')refreshWelcomeCtas();
  }
  appearConfig(d.appearDelay);
  if(d.startTheme==='light'||d.startTheme==='dark'){
    try{localStorage.setItem(THEME_START_KEY,d.startTheme)}catch(e){}
    if(!THEME_PICKED&&THEME!==d.startTheme&&typeof applyTheme==='function')applyTheme(d.startTheme);
  }
  if(d.klaviyoCompanyId)KLAVIYO_COMPANY_ID=d.klaviyoCompanyId;
  if(d.klaviyoListId)KLAVIYO_LIST_ID=d.klaviyoListId;
  if(typeof d.productCardStyle==='string')PRODUCT_CARD_STYLE=d.productCardStyle==='showcase'?'showcase':'horizontal';
  if(typeof d.fitConfidence==='boolean'){FITC_ON=d.fitConfidence;try{localStorage.setItem(FITC_KEY,FITC_ON?'1':'0')}catch(e){}}
  if(Array.isArray(d.fitLevels)){setFitLevels(d.fitLevels);try{localStorage.setItem(FITL_KEY,JSON.stringify(Object.keys(FITC_LEVELS)))}catch(e){}}
  if(d.buyNow&&typeof d.buyNow==='object'){setBuyNow(d.buyNow);try{localStorage.setItem(BUY_KEY,JSON.stringify({on:BUY_ON,code:BUY_CODE}))}catch(e){}}
  if(typeof d.appEvents==='boolean'){APP_EVENTS=d.appEvents;try{localStorage.setItem(AEV_KEY,APP_EVENTS?'1':'0')}catch(e){}}
  if(typeof d.welcomeGlowStyle==='string')WELCOME_INTRO=d.welcomeGlowStyle!=='none';
  /* Welcome-CTA translations from server. Theme block toggle wins over
     the server echo (both must agree to enable rotation). When ready,
     append translations to the frames array — the running rotator
     picks them up on its next tick. */
  FOCUS_ROTATE=d.rotateGreetingCta!==false;
  /* Settings → Focus home: pictures for the Footwear and Orthotics cards. */
  if(d.focusImages&&typeof d.focusImages==='object'){FOCUS_PICS={pain:safeUrl(d.focusImages.pain),footwear:safeUrl(d.focusImages.footwear),orthotics:safeUrl(d.focusImages.orthotics)};try{localStorage.setItem(FOCUS_PICS_KEY,JSON.stringify(FOCUS_PICS))}catch(e){}if(FOCUS)focusRefreshPics()}
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
  if(matchesHideRule(rules))hideAssistant();
  else if(compactRuleFor(rules))compactAssistant();
  if(d.international&&typeof d.international==='object'){
    var intl={hide:d.international.hide===true,home:Array.isArray(d.international.home)?d.international.home:['US']};
    try{localStorage.setItem(INTL_KEY,JSON.stringify(intl))}catch(e){}
    if(isAbroad(intl))hideAssistant();
    /* Global-e may set its country a moment after the page loads. */
    else if(intl.hide)setTimeout(function(){if(!HIDDEN_BY_URL&&isAbroad(intl))hideAssistant()},2500);
  }
}).catch(function(){});
var SHOP=C.shopDomain||'';
var GREET=C.greeting||'Hi! I\'m your personal shopping assistant.';
var GREET_LOGGED=C.greetingLoggedIn||'';
var GREETCTA=C.greetingCta||'What can I help you find today?';
var AVATAR=C.avatarUrl||'';
/* Peak Mode's home (Settings → Peak Mode → The home on peak days): the
   promotion blocks and the peak picture, from the settings read — kept for
   the session so the home opens with them (no banner flashing first). */
var PEAK_KEY='hajirai_peak',PEAK=null;
try{PEAK=JSON.parse(sessionStorage.getItem(PEAK_KEY)||'null');if(PEAK&&typeof PEAK!=='object')PEAK=null}catch(e){PEAK=null}
/* The assistant's usual picture; the peak one stands in while Peak Mode is on. */
var AVATAR_USUAL=AVATAR;
if(PEAK&&PEAK.avatar&&safeUrl(PEAK.avatar))AVATAR=PEAK.avatar;
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
/* Settings → Look & feel → Chat text: the store's own words win over the
   theme editor's; a blank one keeps the theme editor's (or the default).
   Remembered, so the next page shows them from the start. */
var TXT_KEY='hajirai_texts',START_LBL='Start here',POP_LBL='Popular',FIT_LBL='Check fit & size',NAME_SUB='';
var DISCL=C.disclaimerText||'';
var TXT_BASE={name:NAME,greeting:GREET,greetingLoggedIn:GREET_LOGGED,greetingCta:GREETCTA,launcher:LPLACE,input:IPLACE,disclaimer:DISCL};
/* The Focus home's words (Settings → Look & feel → Focus home); blank → built in. */
var FT_DEF={homePainEyebrow:'Help me with',homePainTitle:'Foot pain',homePainTitleWide:'Let\u2019s talk about your foot pain.',homePainSub:'Say where it hurts and what you wear. A few taps, then Ava\u2019s best match.',homePainCta:'Start',
  homeFootwearEyebrow:'Help me find',homeFootwearTitle:'Footwear',homeFootwearSub:'Sneakers, sandals, boots and more \u2014 support built in.',homeFootwearCta:'Browse',
  homeOrthoticsEyebrow:'Help me find',homeOrthoticsTitle:'Orthotics',homeOrthoticsSub:'Inserts for the shoes you already own, matched to your arch.',homeOrthoticsCta:'Browse',
  homeLink1Label:'',homeLink1Message:'',homeLink2Label:'Returns & exchanges',homeLink2Message:'I\u2019d like to return or exchange something.',homeLink3Label:'Deals',homeLink3Message:'What deals are running right now?'};
var FT={};for(var _fk in FT_DEF)FT[_fk]=FT_DEF[_fk];
function setTexts(t){
  t=t&&typeof t==='object'?t:{};
  var v=function(k,max){var x=t[k];return typeof x==='string'&&x.trim()?x.replace(/\s+/g,' ').trim().slice(0,max):''};
  NAME=v('name',60)||TXT_BASE.name;NAME_SUB=v('nameSub',60);GREET=v('greeting',120)||TXT_BASE.greeting;GREET_LOGGED=v('greetingLoggedIn',120)||TXT_BASE.greetingLoggedIn;
  LPLACE=v('launcher',60)||TXT_BASE.launcher;IPLACE=v('input',60)||TXT_BASE.input;
  START_LBL=v('startHeading',30)||'Start here';POP_LBL=v('popularHeading',30)||'Popular';
  FIT_LBL=v('fitButton',24)||'Check fit & size';
  GREETCTA=v('greetingCta',80)||TXT_BASE.greetingCta;DISCL=v('disclaimer',300)||TXT_BASE.disclaimer;
  if(typeof GREET_CTA_FRAMES!=='undefined'&&GREET_CTA_FRAMES&&GREET_CTA_FRAMES[0]&&GREET_CTA_FRAMES[0].code==='en')GREET_CTA_FRAMES[0].text=GREETCTA;
  for(var fk in FT_DEF)FT[fk]=v(fk,fk.indexOf('Message')>0?160:fk.indexOf('Sub')>0?120:60)||FT_DEF[fk];
}
try{setTexts(JSON.parse(localStorage.getItem(TXT_KEY)||'null'))}catch(e){}
var PRIVURL=C.privacyUrl||'/pages/privacy-policy';
var LWIDTH=C.launcherWidth||'500';
var CWIDTH=C.chatWidth||LWIDTH;
var HIDE_MOBILE=C.hideOnMobile===true;
var SUPPORT_URL=C.supportUrl||'';
/* Theme editor → Home layout. "focus" is the foot-pain-first home (the
   question, six places it can hurt, the two product lines as single cards
   whose tools open in a sheet) with Ava's face on the header line; anything
   else is the classic home, exactly as before. */
var FOCUS=C.homeLayout==='focus';
/* Settings → Feedback survey and live chat. The store's Typeform survey as
   Start here button 4, opening inside the chat; and hiding the separate
   live chat button (live chat itself still opens from the assistant, see
   openSupportChat). Remembered from the last visit so a page shows the
   right buttons straight away; the config call keeps it current. */
var HOST_KEY='hajirai_host_buttons';
var FB_ON=false,FB_FORM='',FB_LABEL='Share feedback',FB_COLOR='teal',FB_ICON='feedback',FB_HIDE_AFTER=true,HIDE_LIVECHAT=false;
/* Settings → Which orthotic do I have?: the Typeform quiz (a row in the Focus Orthotics sheet). */
var WO_FORM='',WO_LABEL='Identify my orthotic';
function applyHostButtons(cfg){
  cfg=cfg||{};var fb=cfg.fb||{};
  FB_FORM=/^[A-Za-z0-9]{4,32}$/.test(String(fb.form||''))?String(fb.form):'';
  FB_ON=fb.on===true&&!!FB_FORM;
  FB_LABEL=String(fb.label||'').trim().slice(0,40)||'Share feedback';
  /* Its look (Settings): a tint from a fixed set, and an icon. */
  FB_COLOR=/^(teal|green|blue|purple|rose|amber|plain)$/.test(String(fb.color||''))?String(fb.color):'teal';
  FB_ICON=/^[a-z]{3,12}$/.test(String(fb.icon||''))?String(fb.icon):'feedback';
  /* Off: the button stays after it's sent (a quiz people come back to). */
  FB_HIDE_AFTER=fb.hideAfter!==false;
  HIDE_LIVECHAT=cfg.hideChat===true;
  /* The store's own buttons this replaces: its floating Feedback button
     (when the survey lives in the chat) and, if asked, live chat's. */
  var css='';
  if(FB_ON)css+='.aetrex-tf-cta,.tf-v1-sidetab,.tf-v1-popover{display:none!important}';
  if(HIDE_LIVECHAT)css+='iframe#launcher,iframe[title="Button to launch messaging window"]{display:none!important}';
  var st=document.getElementById('ai-chat-host-buttons');
  if(!st&&css){st=document.createElement('style');st.id='ai-chat-host-buttons';(document.head||document.documentElement).appendChild(st)}
  if(st)st.textContent=css;
}
try{applyHostButtons(JSON.parse(localStorage.getItem(HOST_KEY)||'null'))}catch(e){applyHostButtons(null)}
/* Settings → Seasonal button: the first Start here button features one of
   the store's collections, with a season icon and tint. Remembered from the
   last visit so the welcome draws it straight away. */
var SEA_KEY='hajirai_seasonal_cta',SEA_ON=false,SEA_ICON='fall',SEA_COLOR='fall',SEA_LABEL='',SEA_TAP='';
/* A button is sending the next message (its words, not the shopper's), and
   whether the last message sent was typed (or spoken) by the shopper. */
var BTN_SEND=false,SENT_TYPED=true;
function applySeasonal(s){
  s=s&&typeof s==='object'?s:{};
  SEA_ICON=/^(fall|winter|spring|summer)$/.test(String(s.icon||''))?String(s.icon):'fall';
  SEA_COLOR=/^(fall|winter|spring|summer|plain)$/.test(String(s.color||''))?String(s.color):SEA_ICON;
  SEA_LABEL=String(s.label||'').replace(/\s+/g,' ').trim().slice(0,40);
  SEA_ON=s.on===true&&!!SEA_LABEL;
}
try{applySeasonal(JSON.parse(localStorage.getItem(SEA_KEY)||'null'))}catch(e){applySeasonal(null)}
/* The button's text comes from the app's Settings → Support link (widget-config). */
var SUPPORT_LABEL='Chat with Aetrex Support';
var CUST_LOGGED_IN=C.customerLoggedIn===true;
var CUST_TAGS=(Array.isArray(C.customerTags)?C.customerTags:[]).map(function(t){return String(t).trim().toLowerCase()}).filter(Boolean);
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
/* Fit confidence on (widget-config, remembered so saved cards draw right
   from the start): cards show the Fit and size tiles under the buy button. */
var FITC_KEY='hajirai_fitc',FITC_ON=false;
try{FITC_ON=localStorage.getItem(FITC_KEY)==='1'}catch(e){}
/* …and which of its levels the cards show (the store's choice; High and Mid
   until it says): a style at another level shows only the size tool. */
var FITL_KEY='hajirai_fitl',FITC_LEVELS={high:1,mid:1};
function setFitLevels(a){var o={};for(var i=0;Array.isArray(a)&&i<a.length;i++)if(a[i]==='high'||a[i]==='mid'||a[i]==='fair')o[a[i]]=1;FITC_LEVELS=o}
try{var savedFitl=JSON.parse(localStorage.getItem(FITL_KEY)||'null');if(Array.isArray(savedFitl))setFitLevels(savedFitl)}catch(e){}
/* Buy now (Settings → Shopping tools, off unless turned on; remembered the
   same way): the cards' one-tap checkout, and the store's code for it. */
var BUY_KEY='hajirai_buynow',BUY_ON=false,BUY_CODE='';
function setBuyNow(b){
  b=b&&typeof b==='object'?b:{};
  BUY_ON=b.on===true;
  BUY_CODE=BUY_ON&&typeof b.code==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(b.code)?b.code:'';
}
try{setBuyNow(JSON.parse(localStorage.getItem(BUY_KEY)||'null'))}catch(e){}
/* AVA in Shopify Analytics (Settings → Integrations, on unless turned off;
   remembered the same way): the chat says when a shopper adds to the cart or
   heads to checkout from it — the server builds the event from the store's
   own catalog. Never waits, never in the way, gone with the page if need be. */
var AEV_KEY='hajirai_appev',APP_EVENTS=true;
try{if(localStorage.getItem(AEV_KEY)==='0')APP_EVENTS=false}catch(e){}
function avaActivity(o){
  if(!APP_EVENTS)return;
  postActivity(o);
}
/* The same post for the customer service log (a person asked for), which
   isn't analytics and isn't switched off with it. */
function postActivity(o){
  try{
    o.id=((window.crypto&&crypto.randomUUID)?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2,12)).replace(/[^A-Za-z0-9_-]/g,'').slice(0,64);
    var body=JSON.stringify(o);
    if(navigator.sendBeacon&&navigator.sendBeacon(ACTIVITY_URL,new Blob([body],{type:'text/plain'})))return;
    fetch(ACTIVITY_URL,{method:'POST',headers:{'Content-Type':'text/plain'},body:body,keepalive:true,credentials:'same-origin'}).catch(function(){});
  }catch(e){}
}
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
/* Recording. Opening the store with ?hajirai_tester=Name marks this
   browser as a tester for two weeks (?hajirai_tester=off clears it). While
   the store records, testers' chats are saved for review. Ordinary shoppers
   are only recorded if the store chose "everyone". (The chat's footer
   already says chats may be kept, so there's no separate note.) */
var TESTER_KEY='hajirai_tester',TESTER='',REC_ON=false,REC_SCOPE='testers';
(function(){
  try{
    var q=new URLSearchParams(location.search).get('hajirai_tester');
    if(q!==null){
      var name=String(q).replace(/[^A-Za-z0-9 ._\u00C0-\u024F-]/g,'').trim().slice(0,40);
      if(!name||/^(0|off|false|no)$/i.test(name))localStorage.removeItem(TESTER_KEY);
      else localStorage.setItem(TESTER_KEY,JSON.stringify({name:/^(1|true|yes|on)$/i.test(name)?'Tester':name,until:Date.now()+14*864e5}));
    }
    var t=JSON.parse(localStorage.getItem(TESTER_KEY)||'null');
    if(t&&t.name&&t.until>Date.now())TESTER=String(t.name).slice(0,40);else if(t)localStorage.removeItem(TESTER_KEY);
  }catch(e){}
})();
/* My rewards (Settings → Shopping tools) and Talk to a person (Settings →
   Customer care): instant cards, no AI. A random id names this browser in
   the customer service log — no name, no account, nothing to trace. */
var REWARDS=null,HUMAN=null,RETURNS=null,DEALS=null,VISITOR_KEY='hajirai_visitor',VISITOR='';
try{VISITOR=localStorage.getItem(VISITOR_KEY)||'';if(!/^v_[a-z0-9]{8,40}$/.test(VISITOR)){VISITOR='v_'+Date.now().toString(36)+Math.random().toString(36).slice(2,12);localStorage.setItem(VISITOR_KEY,VISITOR)}}catch(e){}
/* The look the chat starts in: the shopper's own pick (sun/moon) if they've
   made one, else the store's choice (Settings → Showing the chat, remembered
   here so the next page starts in it), else dark. */
var THEME_KEY='hajirai_theme_pick',THEME_START_KEY='hajirai_theme_start',THEME='dark',THEME_PICKED=false;
try{
  var _tp=localStorage.getItem(THEME_KEY);
  if(_tp==='light'||_tp==='dark'){THEME=_tp;THEME_PICKED=true}
  else if(localStorage.getItem(THEME_START_KEY)==='light')THEME='light';
}catch(e){}
function applyTheme(next,save){
  THEME=next==='light'?'light':'dark';
  if(save){THEME_PICKED=true;try{localStorage.setItem(THEME_KEY,THEME)}catch(e){}}
  var els=[launcher,panel,overlay];
  for(var i=0;i<els.length;i++)if(els[i])els[i].setAttribute('data-theme',THEME);
  if(glowGL&&glowGL.dLoc)glowGL.gl.uniform1f(glowGL.dLoc,THEME==='dark'?1:0);
  var tb=panel&&panel.querySelector('.ai-chat-theme-btn');
  if(tb){var lbl=THEME==='dark'?'Switch to light mode':'Switch to dark mode';tb.setAttribute('aria-label',lbl);tb.setAttribute('title',lbl)}
  /* The page behind a phone's keyboard bar follows the chat's new color. */
  if(typeof paintPageBg==='function'){paintPageBg();setTimeout(paintPageBg,400)}
}
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
/* An order looked up without signing in is never written to the browser. */
function saveH(m){try{localStorage.setItem(HK,JSON.stringify(m.filter(function(x){return !x.guestOrder}).slice(-50)));localStorage.setItem(HK_AT,String(Date.now()))}catch(e){}}
/* A chat left alone for a day starts fresh: a shopper who comes back next
   week sees the chat's home screen, not last week's conversation. "Alone"
   is from the last message either way. A chat saved before this was added
   gets its clock started now. */
var HK_AT='hajirai_chat_at',CHAT_IDLE_MS=24*3600*1000;
function chatStale(){
  try{
    var at=parseInt(localStorage.getItem(HK_AT),10);
    if(!at){if(localStorage.getItem(HK))localStorage.setItem(HK_AT,String(Date.now()));return false}
    return Date.now()-at>CHAT_IDLE_MS;
  }catch(e){return false}
}
function dropStaleChat(){
  if(!chatStale())return false;
  try{localStorage.removeItem(HK);localStorage.removeItem(SK);localStorage.removeItem(HK_AT);localStorage.removeItem('hajirai_ret_progress')}catch(e){}
  _memSess='';
  return true;
}
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
.then(function(d){markChatAttributed();avaActivity({kind:'add_to_cart',variant:String(vid),quantity:qty||1});rateNote('cart');later(maybeAskRating,0);return syncThemeCart().then(function(){return d},function(){return d})})
}
/* After an add from the chat, bring the store's own cart UI up to date in
   the background — header and dock counts, the cart drawer's contents — so
   the item is there when the shopper closes the chat. Never opens the drawer.
   Themes with a pubsub cart (Aetrex's) get the update they publish for their
   own adds, with the drawer's section HTML attached (their drawer reads it);
   others get the common refresh events and count selectors. */
function syncThemeCart(){
  var ids=[],nodes=document.querySelectorAll('cart-items[data-section-id]'),i;
  for(i=0;i<nodes.length;i++){var id=nodes[i].getAttribute('data-section-id');if(id&&ids.indexOf(id)===-1)ids.push(id)}
  ids=ids.slice(0,5);
  var cartP=fetch(SHOP_ROOT+'cart.js',{credentials:'same-origin',cache:'no-store',headers:{'Accept':'application/json'}}).then(function(r){return r.json()});
  var secP=ids.length?fetch(location.pathname+'?sections='+encodeURIComponent(ids.join(',')),{credentials:'same-origin'}).then(function(r){return r.ok?r.json():{}}).catch(function(){return{}}):Promise.resolve({});
  return Promise.all([cartP,secP]).then(function(res){
    var cart=res[0]||{},sec=res[1]||{},ps=window.theme&&window.theme.pubsub;
    var focus=document.activeElement,inChat=!!(focus&&panel&&panel.contains(focus));
    /* Every drawer/cart section must have fresh HTML, or the theme would
       read a missing one as an empty cart. */
    var complete=ids.every(function(id){return typeof sec[id]==='string'});
    var published=false;
    if(ps&&ps.PUB_SUB_EVENTS&&ps.PUB_SUB_EVENTS.cartUpdate&&typeof ps.publish==='function'&&complete&&!cart.errors){
      cart.sections=sec;
      try{ps.publish(ps.PUB_SUB_EVENTS.cartUpdate,{source:'chat-widget',cart:cart});published=true}catch(e){}
    }
    if(!published){
      try{document.dispatchEvent(new CustomEvent('cart:refresh',{detail:{open:false}}))}catch(e){}
      try{document.dispatchEvent(new CustomEvent('cart:updated',{detail:{cart:cart}}))}catch(e){}
    }
    if(typeof cart.item_count==='number'){
      document.querySelectorAll('cart-count,[data-cart-count],.cart-count,.header__cart-count,.cart-count-bubble span[aria-hidden]').forEach(function(e){
        e.textContent=cart.item_count;
        if(e.tagName.toLowerCase()==='cart-count')e.hidden=cart.item_count===0;
      });
    }
    /* The theme's cart code can move focus into its (closed) drawer. */
    if(inChat&&document.activeElement!==focus&&focus.focus){try{focus.focus({preventScroll:true})}catch(e){}}
  });
}

/* A new picture for the assistant everywhere it shows: the header's face,
   the bar's photo, the replies' small one (new replies), the home's. */
function setAvatar(url){
  if(url===AVATAR)return;
  AVATAR=url;
  assistantBubbleAvatar=AVATAR?'<img src="'+safeUrl(AVATAR)+'" alt="" role="presentation" aria-hidden="true" style="width:100%;height:100%;object-fit:cover;border-radius:50%">':assistantBubbleAvatar.replace(/^<img[^>]*>$/,'');
  var hp=document.querySelector('.ai-chat-hero__photo');if(hp){var hi=hp.querySelector('img');if(safeUrl(AVATAR)){if(hi)hi.src=safeUrl(AVATAR);else hp.innerHTML='<img src="'+safeUrl(AVATAR)+'" alt="">'}}
  var lp=document.querySelector('.ai-chat-launcher__photo');if(lp&&safeUrl(AVATAR))lp.src=safeUrl(AVATAR);
  var wa=document.querySelector('.ai-chat-welcome__avatar img');if(wa&&safeUrl(AVATAR))wa.src=safeUrl(AVATAR);
}
/* The peak blocks this shopper sees: everyone's; signed out, the signed-out
   ones; signed in, the signed-in ones and a tag's when they carry it. */
function peakBlocks(){
  if(!PEAK||!Array.isArray(PEAK.blocks))return [];
  return PEAK.blocks.filter(function(b){
    if(!b||!((b.image&&safeUrl(b.image))||(b.video&&safeUrl(b.video))))return false;
    var a=b.audience||'all';
    if(a==='all')return true;
    if(a==='guest')return !CUST_LOGGED_IN;
    if(!CUST_LOGGED_IN)return false;
    if(a==='signed')return true;
    return a==='tag'&&!!b.tag&&CUST_TAGS.indexOf(String(b.tag).trim().toLowerCase())>=0;
  }).slice(0,6);
}
/* The pictures where the banner was — each just a picture: a link, a
   question to the assistant, or nothing — as a rail that scrolls sideways
   (two and a half in view on a computer, one and a quarter on a phone, no
   arrows), a mosaic (the first big, the rest around it) or a grid (two
   across); every tile the shape chosen in Settings. Its name is only for
   screen readers. */
var PEAK_SHAPES={wide:'16 / 9',standard:'4 / 3',square:'1 / 1'};
function peakTilesHtml(blocks){
  var layout=PEAK&&/^(rail|mosaic|grid)$/.test(String(PEAK.layout))?PEAK.layout:'rail',ar=PEAK_SHAPES[PEAK&&PEAK.shape]||PEAK_SHAPES.wide;
  var h='<div class="ai-chat-peak ai-chat-peak--'+layout+'" data-peak role="region" aria-label="Today\u2019s offers" style="--ai-peak-ar:'+ar+'"><div class="ai-chat-peak__tiles" data-n="'+blocks.length+'">';
  var still=!focusMotionOk();
  for(var i=0;i<blocks.length;i++){var b=blocks[i],pic=b.image?safeUrl(b.image):'',vid=b.video?safeUrl(b.video):'',url=b.url&&safeUrl(b.url)?safeUrl(b.url):'',label=esc(b.title||('Offer '+(i+1))),img;
    /* A video plays by itself, silent and looping (not for shoppers who prefer reduced motion: its first frame, or its picture, stays); its picture is the poster. */
    /* Where the picture is anchored in the tile's crop (Settings): the centre as usual, or an edge or corner. */
    var at=/^(center|left|right|top|bottom|top left|top right|bottom left|bottom right)$/.test(String(b.focus))&&b.focus!=='center'?' style="object-position:'+b.focus+'"':'';
    if(vid)img='<video class="ai-chat-peak__video" muted loop playsinline preload="metadata"'+(still?'':' autoplay')+(pic?' poster="'+pic+'"':'')+at+' aria-hidden="true" tabindex="-1"><source src="'+vid+'" type="'+(/\.webm(\?|$)/i.test(vid)?'video/webm':'video/mp4')+'"></video>';
    else img='<img src="'+pic+'" alt="" loading="lazy" draggable="false"'+at+'>';
    if(b.message)h+='<button type="button" class="ai-chat-peak__tile" data-message="'+esc(b.message)+'" aria-label="'+label+'">'+img+'</button>';
    else if(url)h+='<a class="ai-chat-peak__tile" href="'+url+'"'+(/^https?:/i.test(url)?' target="_blank" rel="noopener"':'')+' aria-label="'+label+'">'+img+'</a>';
    else h+='<div class="ai-chat-peak__tile is-still" role="img" aria-label="'+label+'">'+img+'</div>'}
  return h+'</div></div>';
}
/* The tiles' videos play only while in view (the home open, the tile on
   screen): off screen, minimized or behind a chat, they pause. */
var peakVidObs=null;
function peakVideosWatch(){
  var vids=msgsEl?msgsEl.querySelectorAll('.ai-chat-peak__video'):[];
  if(peakVidObs){peakVidObs.disconnect();peakVidObs=null}
  if(!vids.length||!('IntersectionObserver' in window)||!focusMotionOk())return;
  peakVidObs=new IntersectionObserver(function(es){for(var i=0;i<es.length;i++){var v=es[i].target;try{if(es[i].isIntersecting){var p=v.play();if(p&&p.catch)p.catch(function(){})}else v.pause()}catch(e){}}},{threshold:0.2});
  for(var j=0;j<vids.length;j++)peakVidObs.observe(vids[j]);
}
/* Her colours on peak days (Settings → Peak Mode): up to four, standing in
   for the usual pink, violet, blue and teal in the glow around her face,
   the minimized pill's glow, the ring and the line (fewer than four
   repeat). Nothing set: the usual ones. */
var GLOW_USUAL=['#ff4fa3','#a35cff','#3d7bff','#29e0d0'];
function peakGlow(){
  var c=[],src=PEAK&&Array.isArray(PEAK.colors)?PEAK.colors:[];
  for(var i=0;i<src.length&&c.length<4;i++)if(/^#[0-9a-f]{6}$/i.test(String(src[i])))c.push(String(src[i]).toLowerCase());
  if(!c.length)return null;
  var n=c.length;while(c.length<4)c.push(c[c.length-n]);
  return c;
}
function applyPeakColors(){
  var own=peakGlow(),g=own||GLOW_USUAL;
  FOCUS_BAND=g.slice();
  var els=[typeof panel!=='undefined'?panel:null,typeof launcher!=='undefined'?launcher:null];
  for(var k=0;k<els.length;k++){if(!els[k])continue;for(var i=0;i<4;i++){if(own)els[k].style.setProperty('--ai-glow-'+(i+1),g[i]);else els[k].style.removeProperty('--ai-glow-'+(i+1))}}
  var stops=document.querySelectorAll('#ai-chat-band-g stop');for(var j=0;j<stops.length;j++)stops[j].setAttribute('stop-color',g[j%4]);
  /* Her look on peak days: the panel marked (the header's grey line goes
     at home), the ring's weight (a multiplier on its strokes), the line
     of gold, the tint behind the header. */
  var p=typeof panel!=='undefined'?panel:null;if(!p)return;
  if(PEAK)p.setAttribute('data-peak','1');else p.removeAttribute('data-peak');
  var ring={fine:1,regular:1.8,bold:2.8}[PEAK&&PEAK.ring]||1;
  if(ring!==1)p.style.setProperty('--ai-ring-k',String(ring));else p.style.removeProperty('--ai-ring-k');
  if(PEAK&&PEAK.tint===true)p.setAttribute('data-peak-tint','1');else p.removeAttribute('data-peak-tint');
  peakDecoRender();
}
/* The line under the header on peak days (Settings → Peak Mode → The line
   under the header): a curved line of the set's gold at the right, where
   the header's grey line was — so it covers nothing — with a soft glow
   and a highlight that drifts along it now and then. Drawn here, so it
   fits any width. */
function decoLineHtml(){
  var d='M0 23 C 150 23,260 14,420 14 C 530 14,620 19,700 18';
  return '<div class="ai-chat-deco ai-chat-deco--line" aria-hidden="true"><svg viewBox="0 0 700 28" preserveAspectRatio="none">'+
    '<defs><linearGradient id="ai-deco-gold" x1="0" y1="0" x2="1" y2="0"><stop offset="0" class="d-gold-stop" stop-opacity="0"/><stop offset=".3" class="d-gold-stop" stop-opacity=".75"/><stop offset=".62" class="d-gold-stop" stop-opacity="1"/><stop offset="1" class="d-gold-stop" stop-opacity=".55"/></linearGradient>'+
    '<linearGradient id="ai-deco-sheen" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".9"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>'+
    '<path class="d-gold-s" d="'+d+'" fill="none" stroke-width="7" opacity=".10" vector-effect="non-scaling-stroke"/>'+
    '<path class="d-gold-s" d="'+d+'" fill="none" stroke-width="3" opacity=".22" vector-effect="non-scaling-stroke"/>'+
    '<path d="'+d+'" fill="none" stroke="url(#ai-deco-gold)" stroke-width="1.2" vector-effect="non-scaling-stroke"/>'+
    '<path class="ai-chat-deco__sheen" d="'+d+'" fill="none" stroke="url(#ai-deco-sheen)" stroke-width="1" vector-effect="non-scaling-stroke" pathLength="100" stroke-dasharray="22 100"/>'+
  '</svg></div>';
}
/* Draws (or removes) the line to match the setting. */
function peakDecoRender(){
  var p=typeof panel!=='undefined'?panel:null;if(!p)return;
  var want=PEAK&&PEAK.decor==='line';
  var hdr=p.querySelector('.ai-chat-header'),old=hdr?hdr.querySelector('.ai-chat-deco--line'):null;
  if(want){if(hdr&&!old){hdr.insertAdjacentHTML('beforeend',decoLineHtml());
    /* Measured again once the panel or header finishes moving (opening
       animates the header's words), so the line sits by the words at rest. */
    if(!peakDecoRender.bound){peakDecoRender.bound=true;var fit=function(ev){if(ev.target===p||hdr.contains(ev.target))peakDecoFit()};p.addEventListener('transitionend',fit);p.addEventListener('animationend',fit)}}}
  else if(old)old.remove();
  if(want)p.setAttribute('data-peak-decor','line');else p.removeAttribute('data-peak-decor');
  peakDecoFit();
}
/* Where the line starts: just past the end of the header's words (the
   greeting at home), measured — so it runs under nothing at any width or
   wording, only under the controls. Measured again whenever the header is
   (opening, resize, new words). */
function peakDecoFit(){
  var p=typeof panel!=='undefined'?panel:null,hdr=p&&p.querySelector('.ai-chat-header'),line=hdr&&hdr.querySelector('.ai-chat-deco--line');
  if(!line)return;
  var hr=hdr.getBoundingClientRect(),W=hdr.clientWidth;if(!hr.width||!W)return;
  var t=hdr.querySelector('.ai-chat-header__title--home')||hdr.querySelector('.ai-chat-header__name'),right=hr.left;
  if(t&&t.firstChild){try{var r=document.createRange();r.selectNodeContents(t);var tr=r.getBoundingClientRect();right=tr.width?tr.right:t.getBoundingClientRect().right}catch(e){right=t.getBoundingClientRect().right}}
  /* As a share of the header's width, so a measure taken while the panel is
     still scaling open comes out right. */
  var left=Math.max(0,Math.round((right-hr.left)/hr.width*W+16)),least=Math.min(140,W*0.3);
  if(W-left<least)left=Math.max(0,Math.round(W-least));
  line.style.left=left+'px';
}
try{if(document.fonts&&document.fonts.ready)document.fonts.ready.then(function(){peakDecoFit()})}catch(e){}

var assistantBubbleAvatar=AVATAR?'<img src="'+safeUrl(AVATAR)+'" alt="" role="presentation" aria-hidden="true" style="width:100%;height:100%;object-fit:cover;border-radius:50%">':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" role="presentation" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

/* A clean AI sparkle: one four-point star and a small twinkle. */
/* The assistant's mark, after the classic Siri orb: a dark glass sphere
   (in both themes) holding thin curved sheets of light that pass through
   its center and turn in 3D. A sheet face-on is a broad translucent lobe;
   edge-on it is a sharp spike, and star-point sheets have concave sides that
   taper to needle tips. Colored light adds where sheets cross, building to a
   white burst at the center; each sheet is brightest near the center and
   deepens toward its far end; the sphere's rim catches a faint tint. One
   shared WebGL surface is drawn per frame and copied into each canvas;
   random seed per visit and incommensurate rates, so no visible loop. Idle
   while the chat is open or the tab is hidden; one still frame for reduced
   motion. Without WebGL, a soft 2D glow in a dark circle stands in. */
/* The five colors of the sheets (Settings → Assistant look): Siri's red,
   blue, cyan, green and pink unless the store picks its own. Cached so the
   next page starts in the store's colors before widget-config answers. */
var ORB_DEFAULT=['#ff1f33','#1a4dff','#33dbff','#14d999','#ff4780'],ORB_KEY='hajirai_orb_colors',ORB_COLORS=ORB_DEFAULT.slice();
/* The globe's own color behind the light (Settings → Assistant look). */
var ORB_BG_DEFAULT='#05050a',ORB_BG_KEY='hajirai_orb_bg',ORB_BG=ORB_BG_DEFAULT;
/* What sits in the chat bar (Settings → AVA mark): AVA's light, or the
   assistant's photo from the theme editor. With the photo, the × folds the
   bar into a small text button in the store's words ("Ask AI" unless set)
   instead of the round light. No photo set, or one that won't load: the
   light stays. Remembered, so the next page starts in the store's look. */
var MARK_KEY='hajirai_launcher_mark',MARK_PHOTO=false,MARK_TEXT='Ask AI',MARK_BROKEN=false;
function markRead(m){
  MARK_PHOTO=!!(m&&m.mark==='avatar');
  var t=m&&typeof m.text==='string'?m.text.replace(/[<>]/g,'').replace(/\s+/g,' ').trim().slice(0,24).trim():'';
  MARK_TEXT=t||'Ask AI';
}
try{markRead(JSON.parse(localStorage.getItem(MARK_KEY)||'null'))}catch(e){}
function photoMark(){return MARK_PHOTO&&!MARK_BROKEN&&!!safeUrl(AVATAR)}
function setLauncherMark(m){
  var was=[MARK_PHOTO,MARK_TEXT].join('|');
  markRead(m);
  try{if(MARK_PHOTO)localStorage.setItem(MARK_KEY,JSON.stringify({mark:'avatar',text:MARK_TEXT}));else localStorage.removeItem(MARK_KEY)}catch(e){}
  if(was!==[MARK_PHOTO,MARK_TEXT].join('|')&&typeof launcher!=='undefined'&&launcher){cancelMorph();applyMark();placeLauncher()}
}
function orbParse(v){
  if(!v||typeof v!=='object'||v.length!==5)return null;
  var out=[];
  for(var i=0;i<5;i++){if(typeof v[i]!=='string'||!/^#[0-9a-f]{6}$/i.test(v[i]))return null;out.push(v[i].toLowerCase())}
  return out;
}
try{var _oc=orbParse(JSON.parse(localStorage.getItem(ORB_KEY)));if(_oc)ORB_COLORS=_oc}catch(e){}
try{var _ob=localStorage.getItem(ORB_BG_KEY);if(_ob&&/^#[0-9a-f]{6}$/i.test(_ob))ORB_BG=_ob.toLowerCase()}catch(e){}
function hexRgb(h){return [parseInt(h.substr(1,2),16),parseInt(h.substr(3,2),16),parseInt(h.substr(5,2),16)]}
function orbUniforms(){
  if(!glowGL||!glowGL.cLocs)return;
  for(var i=0;i<5;i++){var c=hexRgb(ORB_COLORS[i]);glowGL.gl.uniform3f(glowGL.cLocs[i],c[0]/255,c[1]/255,c[2]/255)}
  var bg=hexRgb(ORB_BG);if(glowGL.bgLoc)glowGL.gl.uniform3f(glowGL.bgLoc,bg[0]/255,bg[1]/255,bg[2]/255);
}
function setOrbBackground(v){
  var ok=typeof v==='string'&&/^#[0-9a-f]{6}$/i.test(v);
  ORB_BG=ok?v.toLowerCase():ORB_BG_DEFAULT;
  try{if(ok&&ORB_BG!==ORB_BG_DEFAULT)localStorage.setItem(ORB_BG_KEY,ORB_BG);else localStorage.removeItem(ORB_BG_KEY)}catch(e){}
  orbUniforms();
  if(GLOW_STILL&&glows.length)paintGlows(GLOW_SEED);
}
function orbCssVars(){
  for(var i=0;i<5;i++){
    if(panel)panel.style.setProperty('--orb-c'+i,ORB_COLORS[i]);
    if(launcher)launcher.style.setProperty('--orb-c'+i,ORB_COLORS[i]);
  }
}
function setOrbColors(v){
  var c=orbParse(v);
  ORB_COLORS=c||ORB_DEFAULT.slice();
  try{if(c)localStorage.setItem(ORB_KEY,JSON.stringify(c));else localStorage.removeItem(ORB_KEY)}catch(e){}
  orbUniforms();orbCssVars();
  if(GLOW_STILL&&glows.length)paintGlows(GLOW_SEED);
}
var GLOW_STILL=!!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches);
var GLOW_SEED=Math.random()*100;
var glows=[],glowGL=null;
var GLOW_FRAG=[
'precision mediump float;',
'uniform float t;uniform float seed;uniform vec2 res;uniform float dark;',
'uniform vec3 c0;uniform vec3 c1;uniform vec3 c2;uniform vec3 c3;uniform vec3 c4;uniform vec3 cbg;',
/* one sheet in its own frame: x along its length from -L1 to L2, widest at
   uc. p shapes the sides: below 1 a rounded lobe, above 1 concave sides
   tapering to a needle tip (a star point). bend curves it; roll turns it
   about its long axis (width x |cos roll|). Returns (coverage, bright edge,
   edge-on-ness). */
'vec3 sheet(vec2 q,float ang,float roll,float L1,float L2,float W,float uc,float pw,float bend,float e){',
' float c=cos(ang),s=sin(ang);',
' vec2 p=vec2(c*q.x+s*q.y,-s*q.x+c*q.y);',
' p.y-=bend*(p.x*p.x-.1);',
' float u=(p.x+L1)/(L1+L2);',
' float in1=step(0.,u)*step(u,1.);float uu=clamp(u,0.,1.);',
' float f=uu<uc?uu/uc:(1.-uu)/(1.-uc);',
' float h=W*pow(sin(1.5708*f),pw);',
' float wf=max(abs(cos(roll)),.05);',
' float hw=h*wf;float ay=abs(p.y);',
' float m=(1.-smoothstep(hw-e,hw+e,ay))*in1;',
' float edge=m*(1.-smoothstep(0.,.07+e,hw-ay));',
' return vec3(m,edge,1.-wf);}',
'void main(){',
' vec2 uv=(gl_FragCoord.xy/res)*2.-1.;float r=length(uv);',
' float T=t*.85+seed*7.;',
' vec2 q=uv/.9;float rq=length(q);float e=.03;',
' vec3 red=c0,blue=c1,cyan=c2,green=c3,pink=c4;',
/* brighter toward the center, deeper toward the far ends */
' float rad=mix(.45,1.1,exp(-rq*rq*2.2));',
' vec3 L=vec3(0.);vec3 k;',
/* broad lobes, anchored near the center and spreading outward */
' k=sheet(q,-.16*T+3.6+.6*sin(T*.19+2.),.42*T+2.1+.5*sin(T*.27+1.),.12,1.02,.86,.58,.5,-.25*sin(T*.33+1.),e);',
' L+=blue*(k.x*mix(.42,.95,k.z)+k.y*.22);',
' k=sheet(q,.2*T+.6*sin(T*.21),.5*T+.5*sin(T*.3),.15,.98,.76,.6,.5,.25*sin(T*.4),e);',
' L+=red*(k.x*mix(.4,.95,k.z)+k.y*.2);',
' k=sheet(q,-.22*T+9.+.6*sin(T*.17+5.),.57*T+5.3+.5*sin(T*.29+3.),.2,.94,.62,.55,.6,-.2*sin(T*.41+3.),e);',
' L+=green*(k.x*mix(.34,.9,k.z)+k.y*.18);',
/* star points: through the center, concave sides, needle tips */
' k=sheet(q,.27*T+6.8+.6*sin(T*.23+4.),.74*T+4.+.5*sin(T*.31+2.),.95,.97,.46,.5,2.2,.22*sin(T*.37+2.),e);',
' L+=cyan*(k.x*mix(.6,1.25,k.z)+k.y*.25);',
' k=sheet(q,.31*T+2.2+.6*sin(T*.27+6.),.66*T+1.3+.5*sin(T*.35+4.),.88,.95,.36,.5,2.2,-.25*sin(T*.39+4.),e);',
' L+=pink*(k.x*mix(.58,1.2,k.z)+k.y*.25);',
' k=sheet(q,-.29*T+4.7+.6*sin(T*.25+1.),.79*T+3.2+.5*sin(T*.33+5.),.7,.96,.3,.45,2.4,.3*sin(T*.29+5.),e);',
' L+=blue*(k.x*mix(.55,1.15,k.z)+k.y*.22);',
' k=sheet(q,.24*T+7.9+.6*sin(T*.2+3.),.7*T+.4+.5*sin(T*.37+6.),.62,.95,.26,.42,2.4,-.28*sin(T*.31+6.),e);',
' L+=red*(k.x*mix(.55,1.15,k.z)+k.y*.22);',
' L*=rad*.78*(1.-smoothstep(.86,1.,r));',
/* the white burst where the sheets meet */
' float core=exp(-rq*rq*22.);float halo=exp(-rq*rq*5.);',
' L+=vec3(1.)*(core*.75+halo*.08);',
/* strong light turns white, as overlapping colored light does */
' float wv=max(0.,(L.r+L.g+L.b)/3.-.95);',
' vec3 col=1.-exp(-(L+vec3(wv*.6))*1.3);',
/* the glass: the globe color, a faint tinted rim and a soft lift at the edge */
' float sph=1.-smoothstep(.955,.995,r);',
' float lb=dot(cbg,vec3(.299,.587,.114));',
/* the store's globe color: a touch lighter toward the rim on dark glass, a
   touch deeper on light glass */
' vec3 rimc=lb>.5?cbg*.93:cbg+vec3(.023,.023,.035);',
' vec3 body=mix(cbg,rimc,smoothstep(.3,.95,r));',
' float ang=atan(uv.y,uv.x);',
' vec3 tint=mix(blue,red,.5+.5*sin(ang+T*.23))*.9+cyan*.1;',
' float ring=smoothstep(.86,.97,r)*(1.-smoothstep(.97,.995,r));',
' body+=tint*ring*.1;',
/* the light over the glass (premultiplied: col is the light, its brightest
   channel how much it covers), so it stays vivid on a light globe too */
' float la=max(col.r,max(col.g,col.b));',
/* on a light globe the light needs more body to read: stronger coverage and
   slightly deeper color, while the white heart stays white */
' float lite=smoothstep(.35,.65,lb);',
' vec3 hue=col/max(la,.001);',
' hue=mix(hue,mix(hue*.8,hue,smoothstep(.45,.85,min(hue.r,min(hue.g,hue.b)))),lite);',
' float cov=min(1.,la*mix(1.,1.7,lite));',
' col=hue*cov+body*(1.-cov);',
' gl_FragColor=vec4(col*sph,sph);',
'}'].join('\n');
function initGlowGL(){
  try{
    var c=document.createElement('canvas');c.width=c.height=160;
    var gl=c.getContext('webgl',{premultipliedAlpha:true,alpha:true,antialias:true})||c.getContext('experimental-webgl',{premultipliedAlpha:true,alpha:true});
    if(!gl)return null;
    var mk=function(type,src){var sh=gl.createShader(type);gl.shaderSource(sh,src);gl.compileShader(sh);if(!gl.getShaderParameter(sh,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(sh));return sh};
    var pr=gl.createProgram();
    gl.attachShader(pr,mk(gl.VERTEX_SHADER,'attribute vec2 v;void main(){gl_Position=vec4(v,0.,1.);}'));
    gl.attachShader(pr,mk(gl.FRAGMENT_SHADER,GLOW_FRAG));
    gl.linkProgram(pr);if(!gl.getProgramParameter(pr,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(pr));
    gl.useProgram(pr);
    var buf=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buf);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
    var loc=gl.getAttribLocation(pr,'v');gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);
    gl.uniform2f(gl.getUniformLocation(pr,'res'),c.width,c.height);
    gl.uniform1f(gl.getUniformLocation(pr,'seed'),GLOW_SEED);
    gl.viewport(0,0,c.width,c.height);
    var dLoc=gl.getUniformLocation(pr,'dark');gl.uniform1f(dLoc,THEME==='dark'?1:0);
    var cLocs=[];for(var ci=0;ci<5;ci++)cLocs.push(gl.getUniformLocation(pr,'c'+ci));
    var g={canvas:c,gl:gl,tLoc:gl.getUniformLocation(pr,'t'),dLoc:dLoc,cLocs:cLocs};
    for(var cj=0;cj<5;cj++){var rgb=hexRgb(ORB_COLORS[cj]);gl.uniform3f(cLocs[cj],rgb[0]/255,rgb[1]/255,rgb[2]/255)}
    g.bgLoc=gl.getUniformLocation(pr,'cbg');var bgc=hexRgb(ORB_BG);gl.uniform3f(g.bgLoc,bgc[0]/255,bgc[1]/255,bgc[2]/255);
    return g;
  }catch(e){return null}
}
function renderGlowGL(t){
  var g=glowGL;g.gl.uniform1f(g.tLoc,t);g.gl.drawArrays(g.gl.TRIANGLE_STRIP,0,4);
}
/* Fallback without WebGL: soft drifting lights on a 2D canvas. */
function glowColor(u){
  var n=ORB_COLORS.length,k=((u%n)+n)%n,i=Math.floor(k),f=k-i,a=hexRgb(ORB_COLORS[i]),b=hexRgb(ORB_COLORS[(i+1)%n]);
  f=f*f*(3-2*f);
  return [Math.round(a[0]+(b[0]-a[0])*f),Math.round(a[1]+(b[1]-a[1])*f),Math.round(a[2]+(b[2]-a[2])*f)];
}
function drawGlow2D(g,t){
  var ctx=g.ctx,s=g.px,S=Math.sin;
  ctx.globalCompositeOperation='source-over';ctx.clearRect(0,0,s,s);
  ctx.fillStyle=ORB_BG;ctx.beginPath();ctx.arc(s/2,s/2,s/2-.5,0,6.2832);ctx.fill();
  ctx.globalCompositeOperation='lighter';
  for(var i=0;i<g.lights.length;i++){
    var l=g.lights[i];
    var x=s*(.5+l.spread*(S(t*l.fx1+l.px1)*.62+S(t*l.fx2+l.px2)*.38));
    var y=s*(.5+l.spread*(S(t*l.fy1+l.py1)*.62+S(t*l.fy2+l.py2)*.38));
    var rad=s*(l.radius+l.breath*S(t*l.fr+l.pr));
    var c=glowColor(l.pc+t*l.fc),rgb=c[0]+','+c[1]+','+c[2];
    var grd=ctx.createRadialGradient(x,y,0,x,y,rad);
    grd.addColorStop(0,'rgba('+rgb+','+l.alpha+')');grd.addColorStop(.45,'rgba('+rgb+','+(l.alpha*.42)+')');grd.addColorStop(1,'rgba('+rgb+',0)');
    ctx.fillStyle=grd;ctx.fillRect(0,0,s,s);
  }
  ctx.globalCompositeOperation='destination-in';
  ctx.fillStyle='#000';ctx.beginPath();ctx.arc(s/2,s/2,s/2-.5,0,6.2832);ctx.fill();
}
function makeGlow(size,inPanel){
  var c=document.createElement('canvas');
  c.className='ai-chat-glow';c.setAttribute('aria-hidden','true');
  var dpr=Math.min(window.devicePixelRatio||1,3),px=Math.round(size*dpr);
  c.width=px;c.height=px;c.style.width=size+'px';c.style.height=size+'px';
  var r=function(a,b){return a+Math.random()*(b-a)},lights=[];
  for(var i=0;i<5;i++)lights.push({fx1:r(.045,.075),fx2:r(.09,.125),fy1:r(.04,.07),fy2:r(.085,.12),fr:r(.05,.09),fc:r(.012,.02),px1:r(0,6.3),px2:r(0,6.3),py1:r(0,6.3),py2:r(0,6.3),pr:r(0,6.3),pc:i+r(-.3,.3),spread:r(.24,.36),radius:r(.24,.34),breath:r(.05,.09),alpha:r(.55,.75)});
  var g={el:c,ctx:c.getContext('2d'),px:px,lights:lights,t0:r(0,1000),inPanel:!!inPanel};
  glows.push(g);
  return c;
}
function paintGlows(t){
  if(glowGL===null)glowGL=initGlowGL()||false;
  if(glowGL)renderGlowGL(t);
  for(var i=0;i<glows.length;i++){
    var g=glows[i];
    if(glowGL){g.ctx.clearRect(0,0,g.px,g.px);g.ctx.drawImage(glowGL.canvas,0,0,g.px,g.px)}
    else drawGlow2D(g,t+g.t0);
  }
}
function glowLoop(){
  /* In-chat orbs (the image generator's) leave the list once they're gone. */
  for(var gi=glows.length-1;gi>=0;gi--)if(glows[gi].inPanel&&!glows[gi].el.isConnected)glows.splice(gi,1);
  var inChat=false;for(var gj=0;gj<glows.length;gj++)if(glows[gj].inPanel){inChat=true;break}
  /* The bar showing the photo has no light of its own to draw. */
  var idle=document.hidden||(!inChat&&(launcher.classList.contains('hidden')||launcher.classList.contains('is-photo')));
  if(!idle)paintGlows(performance.now()/1000);
  if(idle)setTimeout(glowLoop,300);else requestAnimationFrame(glowLoop);
}
/* Build launcher */
var launcher=el('div','ai-chat-launcher ai-chat-launcher--'+POS);
launcher.style.width=LWIDTH+'px';
launcher.style.maxWidth='calc(100vw - 32px)';
/* Bar: avatar, prompt, ×. The × folds it into a round bubble (the orb) —
   a small dark circle with a softly breathing AI sparkle — remembered
   across pages. */
launcher.innerHTML='<div class="ai-chat-launcher__icon is-orb" aria-hidden="true"></div><button type="button" class="ai-chat-launcher__text" aria-label="'+esc(LPLACE)+' — open the shopping assistant">'+esc(LPLACE)+'</button><button type="button" class="ai-chat-launcher__close" aria-label="Minimize to a bubble"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>'+
  '<span class="ai-chat-launcher__orb" aria-hidden="true"></span><span class="ai-chat-launcher__pill" aria-hidden="true"></span>';
$('.ai-chat-launcher__icon',launcher).appendChild(makeGlow(40));
$('.ai-chat-launcher__orb',launcher).appendChild(makeGlow(48));
if(GLOW_STILL)paintGlows(GLOW_SEED);else requestAnimationFrame(glowLoop);

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


var loginPillHtml='';
if(CUST_LOGGED_IN&&CUST_NAME){
  loginPillHtml='<span class="ai-chat-header__vip-pill" title="Logged in">Hi '+esc(CUST_NAME)+'!</span>';
}else if(!CUST_LOGGED_IN){
  loginPillHtml='<a class="ai-chat-header__login-pill" href="'+esc(loginUrl())+'">Log in</a>';
}

panel.innerHTML=
'<div class="ai-chat-header"><div class="ai-chat-header__info"><div class="ai-chat-header__name">'+esc(NAME)+'</div><div class="ai-chat-header__sub"'+(NAME_SUB?'':' hidden')+'>'+esc(NAME_SUB)+'</div></div><div class="ai-chat-header__actions">'+loginPillHtml+'<button type="button" class="ai-chat-header__btn ai-chat-theme-btn" aria-label="Switch to light mode" title="Switch to light mode"><svg class="ai-chat-theme-btn__sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></svg><svg class="ai-chat-theme-btn__moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg></button><button class="ai-chat-header__btn ai-chat-menu-btn" aria-label="Menu" title="Options"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg></button><button class="ai-chat-header__btn ai-chat-close-btn" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div></div>'+
'<div class="ai-chat-messages" role="log" aria-live="polite"></div>'+
'<div class="ai-chat-typing"><div class="ai-chat-msg-avatar">'+assistantBubbleAvatar+'</div><div class="ai-chat-typing-dots"><span class="ai-chat-typing-dot"></span><span class="ai-chat-typing-dot"></span><span class="ai-chat-typing-dot"></span></div><span class="ai-chat-typing-text" aria-live="polite"></span></div>'+
'<div class="ai-chat-input-area"><div class="ai-chat-input-wrap"><div class="ai-chat-input-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></div><div class="ai-chat-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><textarea class="ai-chat-input" rows="1" placeholder="'+esc(IPLACE)+'" aria-label="Type your message" autocorrect="off" autocapitalize="off" spellcheck="false"></textarea><button type="button" class="ai-chat-voice-cancel" aria-label="Cancel voice input" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="17" y1="7" x2="7" y2="17"/><line x1="7" y1="7" x2="17" y2="17"/></svg></button><span class="ai-chat-voice-status" aria-live="polite"></span>'+
'<span class="ai-chat-action"><button type="button" class="ai-chat-mic" aria-label="Talk instead of typing" aria-pressed="false" hidden><svg class="ai-chat-mic__mic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11.5" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><line x1="12" y1="18" x2="12" y2="21"/></svg><svg class="ai-chat-mic__stop" viewBox="0 0 24 24" fill="currentColor"><rect x="7.5" y="7.5" width="9" height="9" rx="2.2"/></svg></button><button class="ai-chat-send" aria-label="Send"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5.5"/><polyline points="6 11.5 12 5.5 18 11.5"/></svg></button></span></div></div>'+
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
    person:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11a9 9 0 0118 0v5a2 2 0 01-2 2h-1v-6h3M3 11v6a2 2 0 002 2h1v-6H3"/><path d="M12 21h4"/></svg>',
    out:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3"/><path d="M10 17l-5-5 5-5"/><path d="M5 12h11"/></svg>'
  };
  function item(action,icon,label){return '<button type="button" role="menuitem" class="ai-chat-menu-item" data-action="'+action+'">'+icon+'<span>'+esc(label)+'</span></button>'}
  var h=HUMAN?item('human',MI.person,'Talk to a person'):'';
  h+=item('clear',MI.chat,'Start a new chat');
  if(ff&&savedFit())h+=item('refit',MI.fit,'Retake my orthotic FIT');
  /* Feedback (Focus): the store's survey (Settings → Feedback button), opened inside the chat. */
  if(FOCUS&&fbShown()&&!fbOrthotic())h+=item('survey',fbIcon(),FB_LABEL);
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
applyTheme(THEME);orbCssVars();

/* Settings → Showing the chat: the store can have the chat appear a few
   seconds after each page loads. The setting is remembered on this device,
   so the wait starts the moment the page does; on a first visit the chat
   waits (briefly) for the store's answer before it shows. Opening the chat
   any other way (a link, a resumed return) ends the wait. */
var APPEAR_KEY='hajirai_appear',APPEAR_T0=Date.now(),appearTimer=null;
function launcherWait(ms){
  clearTimeout(appearTimer);
  launcher.classList.add('is-waiting');launcher.inert=true;launcher.setAttribute('aria-hidden','true');
  appearTimer=setTimeout(revealLauncher,Math.max(0,ms));
}
function revealLauncher(){
  clearTimeout(appearTimer);appearTimer=null;
  if(!launcher.classList.contains('is-waiting'))return;
  launcher.classList.remove('is-waiting');
  if(!isOpen){
    launcher.inert=false;launcher.removeAttribute('aria-hidden');
    launcher.classList.add('is-arriving');
    setTimeout(function(){launcher.classList.remove('is-arriving')},600);
  }
}
function appearConfig(a){
  var ap={on:!!(a&&a.on===true),sec:Math.min(60,Math.max(1,parseInt(a&&a.sec,10)||3))};
  try{localStorage.setItem(APPEAR_KEY,JSON.stringify(ap))}catch(e){}
  if(typeof launcher==='undefined'||!launcher.classList.contains('is-waiting'))return;
  var left=ap.on?ap.sec*1000-(Date.now()-APPEAR_T0):0;
  if(left>0)launcherWait(left);else revealLauncher();
}
(function(){
  var ap=null;try{ap=JSON.parse(localStorage.getItem(APPEAR_KEY)||'null')}catch(e){}
  if(ap&&ap.on)launcherWait(Math.min(60,Math.max(1,parseInt(ap.sec,10)||3))*1000);
  else if(!ap)launcherWait(1500);
})();

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
  if(launcher.classList.contains('is-bubble')){
    /* The text button says its own words; the round light gets a tooltip. */
    var photo=launcher.classList.contains('is-photo');
    launcher.setAttribute('role','button');launcher.setAttribute('tabindex','0');
    launcher.setAttribute('aria-label',photo?MARK_TEXT+' — open the AI shopping assistant':'Open the AI shopping assistant');
    if(photo)launcher.removeAttribute('title');else launcher.title='Ask AI';
  }
  else{launcher.removeAttribute('role');launcher.removeAttribute('tabindex');launcher.removeAttribute('aria-label');launcher.removeAttribute('title')}
}
/* The bar's mark and its minimized look, as Settings → AVA mark has them:
   the photo in the bar's round end and the text button, or the light. */
function applyMark(){
  var photo=photoMark(),ic=$('.ai-chat-launcher__icon',launcher),img=$('.ai-chat-launcher__photo',ic);
  if(photo&&!img){
    img=document.createElement('img');img.className='ai-chat-launcher__photo';img.alt='';img.decoding='async';
    img.onerror=function(){if(!img.isConnected)return;MARK_BROKEN=true;cancelMorph();applyMark();placeLauncher()};
    img.src=safeUrl(AVATAR);
    ic.appendChild(img);
  }
  if(img&&!photo)img.remove();
  ic.classList.toggle('is-orb',!photo);ic.classList.toggle('is-photo',photo);
  launcher.classList.toggle('is-photo',photo);
  $('.ai-chat-launcher__pill',launcher).textContent=MARK_TEXT;
  var x=$('.ai-chat-launcher__close',launcher);if(x)x.setAttribute('aria-label',photo?'Minimize':'Minimize to a bubble');
  launcherA11y();
}
/* This page shows the chat minimized: the bubble, kept through opens and
   closes (the chat itself opens as always). */
function compactAssistant(){
  COMPACT_BY_URL=true;
  if(typeof launcher==='undefined'||!launcher||launcher.classList.contains('is-bubble'))return;
  cancelMorph();launcher.classList.add('is-bubble');launcher.classList.remove('is-tucked');tucked=false;tuckWant=false;launcherA11y();placeLauncher();
}
function setLauncherBubble(on,animate){
  /* A page shown minimized keeps the bubble, and that's this page's doing —
     not remembered for the pages after it. */
  if(COMPACT_BY_URL)on=true;
  else try{if(on)sessionStorage.setItem(LBUBBLE_KEY,'1');else sessionStorage.removeItem(LBUBBLE_KEY)}catch(e){}
  var apply=function(){
    launcher.classList.toggle('is-bubble',!!on);
    launcher.classList.remove('is-tucked');tucked=false;tuckWant=false;
    launcherA11y();
    placeLauncher();
  };
  if(animate)morphLauncher(apply);else{cancelMorph();apply()}
}
/* The bar ⇄ bubble morph. The launcher's two looks are set by CSS, so the
   change itself is instant; to make it fluid, a stand-in measured at both
   ends carries the shape (position, size, corners, colour) from one to the
   other while the live orb glides to its new spot and the words fade, then
   hands over to the real launcher, already in place, without a seam. */
var morphAnim=null;
var MORPH_MS=620,MORPH_EASE='cubic-bezier(0.32, 0.72, 0, 1)';
function launcherShown(){
  if(launcher.classList.contains('hidden'))return false;
  var r=launcher.getBoundingClientRect(),cs=getComputedStyle(launcher);
  return r.width>0&&r.height>0&&cs.visibility!=='hidden'&&cs.display!=='none'&&parseFloat(cs.opacity)>0.05;
}
function launcherLook(){
  var r=launcher.getBoundingClientRect(),cs=getComputedStyle(launcher),bubble=launcher.classList.contains('is-bubble');
  var ic=bubble?$('.ai-chat-launcher__orb',launcher):$('.ai-chat-launcher__icon',launcher),ir=ic?ic.getBoundingClientRect():null;
  var tx=bubble?null:$('.ai-chat-launcher__text',launcher),tr=tx?tx.getBoundingClientRect():null,tcs=tx?getComputedStyle(tx):null;
  var xs=bubble?null:$('.ai-chat-launcher__close svg',launcher),xr=xs?xs.getBoundingClientRect():null;
  var photo=launcher.classList.contains('is-photo'),ph=photo&&!bubble?$('.ai-chat-launcher__photo',launcher):null,phr=ph?ph.getBoundingClientRect():null;
  var pl=photo&&bubble?$('.ai-chat-launcher__pill',launcher):null,plr=pl?pl.getBoundingClientRect():null,plcs=pl?getComputedStyle(pl):null;
  /* The text button's capsule is its ::after (its glow lies beneath it). */
  return {r:r,bg:photo&&bubble?getComputedStyle(launcher,'::after').backgroundColor:cs.backgroundColor,shadow:cs.boxShadow,radius:Math.min(parseFloat(cs.borderTopLeftRadius)||0,r.height/2),z:cs.zIndex,
    bw:cs.borderTopStyle==='none'?'0px':cs.borderTopWidth,bc:cs.borderTopColor,
    close:xr&&xr.width?{x:xr.left-r.left,y:xr.top-r.top,w:xr.width,h:xr.height,svg:xs.outerHTML,color:getComputedStyle(xs).color}:null,
    icon:ir&&ir.width?{x:ir.left-r.left,y:ir.top-r.top,s:ir.width,bg:getComputedStyle(ic).backgroundColor,filter:glowFilter(ic)}:null,
    text:tr&&tr.width?{x:tr.left-r.left,y:tr.top-r.top,h:tr.height,label:tx.textContent,color:tcs.color,font:tcs.font,pad:tcs.paddingLeft}:null,
    photo:phr&&phr.width?{x:phr.left-r.left,y:phr.top-r.top,s:phr.width,src:ph.currentSrc||ph.src}:null,
    pill:plr&&plr.width?{x:plr.left-r.left,y:plr.top-r.top,w:plr.width,h:plr.height,label:pl.textContent,color:plcs.color,font:plcs.font,ls:plcs.letterSpacing}:null};
}
function glowFilter(ic){var c=$('.ai-chat-glow',ic),f=c?getComputedStyle(c).filter:'';return f&&f!=='none'?f:'drop-shadow(0 0 0 rgba(0,0,0,0))'}
/* Shadows blend layer by layer in list order, and the bar and the bubble
   list theirs differently (drop shadow first vs. hairline ring first), so a
   plain blend turns one into the other mid-way: the shadow seems to blink.
   Pair the layers by kind instead (ring, drop shadow, glow), with a clear
   copy standing in for a layer one end doesn't have. */
function shadowLayers(v){
  var out=[];if(!v||v==='none')return out;
  var parts=[],depth=0,cur='';
  for(var i=0;i<v.length;i++){var ch=v[i];if(ch==='(')depth++;else if(ch===')')depth--;if(ch===','&&!depth){parts.push(cur);cur=''}else cur+=ch}
  parts.push(cur);
  for(var j=0;j<parts.length;j++){
    var p=parts[j].trim(),col=(p.match(/rgba?\([^)]*\)/)||['rgba(0, 0, 0, 0)'])[0],n=p.replace(col,'').replace('inset','').trim().split(/\s+/).map(parseFloat);
    var L={inset:/\binset\b/.test(p),color:col,x:n[0]||0,y:n[1]||0,blur:n[2]||0,spread:n[3]||0};
    L.kind=L.inset?'inset':!L.blur?'ring':(L.y?'drop':'glow');
    out.push(L);
  }
  return out;
}
function pairShadows(a,b){
  var A=shadowLayers(a),B=shadowLayers(b),fa=[],fb=[];
  /* In the end look's order, so the hand-over is exact. */
  var kinds=[];B.concat(A).forEach(function(L){if(kinds.indexOf(L.kind)<0)kinds.push(L.kind)});
  var css=function(L){return (L.inset?'inset ':'')+L.x+'px '+L.y+'px '+L.blur+'px '+L.spread+'px '+L.color};
  var clear=function(L){var c=L.color.replace(/rgba?\(([^,]+),([^,]+),([^,)]+)(,[^)]*)?\)/,'rgba($1,$2,$3, 0)');return {inset:L.inset,color:c,x:L.x,y:L.y,blur:L.blur,spread:L.spread}};
  kinds.forEach(function(k){
    var la=A.filter(function(L){return L.kind===k}),lb=B.filter(function(L){return L.kind===k});
    for(var i=0;i<Math.max(la.length,lb.length);i++){
      var x=la[i]||clear(lb[i]),y=lb[i]||clear(la[i]);
      fa.push(css(x));fb.push(css(y));
    }
  });
  return fa.length?[fa.join(', '),fb.join(', ')]:['none','none'];
}
function cancelMorph(){if(morphAnim){var m=morphAnim;morphAnim=null;m.stop()}}
function morphLauncher(apply,done){
  cancelMorph();
  var reduce=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(reduce||!launcher.animate||!launcherShown()){apply();if(done)done();return}
  var A=launcherLook();
  /* The real launcher waits, invisible and untouchable, in its new place —
     with its own CSS transitions off, which would otherwise fade it in. */
  launcher.style.setProperty('transition','none','important');
  launcher.style.setProperty('opacity','0','important');launcher.style.setProperty('pointer-events','none','important');
  apply();var B=launcherLook();
  if(!B.r.width||(Math.abs(A.r.left-B.r.left)<1&&Math.abs(A.r.width-B.r.width)<1&&Math.abs(A.r.top-B.r.top)<1)){['transition','opacity','pointer-events'].forEach(function(k){launcher.style.removeProperty(k)});if(done)done();return}
  var g=document.createElement('div');g.className='ai-chat-morph';g.setAttribute('aria-hidden','true');
  g.style.cssText='position:fixed;left:0;top:0;margin:0;padding:0;overflow:hidden;box-sizing:border-box;pointer-events:none;contain:layout paint;will-change:transform,width,height;z-index:'+((parseInt(B.z,10)||999)+1);
  var anims=[],o={duration:MORPH_MS,easing:MORPH_EASE,fill:'both'},sh=pairShadows(A.shadow,B.shadow);
  var at=function(L){return 'translate3d('+L.r.left+'px,'+L.r.top+'px,0)'};
  anims.push(g.animate([
    {transform:at(A),width:A.r.width+'px',height:A.r.height+'px',borderRadius:A.radius+'px',backgroundColor:A.bg,boxShadow:sh[0]},
    {transform:at(B),width:B.r.width+'px',height:B.r.height+'px',borderRadius:B.radius+'px',backgroundColor:B.bg,boxShadow:sh[1]}],o));
  /* Its hairline edge, drawn inside so nothing in it shifts. */
  var edge=document.createElement('span');edge.style.cssText='position:absolute;left:0;top:0;right:0;bottom:0;border-style:solid;border-radius:inherit;box-sizing:border-box;pointer-events:none';
  g.appendChild(edge);
  /* An edge only one end has thins away in its own color (a borderless
     end's color is just the text color: it would show as a dark ring). */
  var bcA=A.bw==='0px'?B.bc:A.bc,bcB=B.bw==='0px'?A.bc:B.bc;
  anims.push(edge.animate([{borderWidth:A.bw,borderColor:bcA},{borderWidth:B.bw,borderColor:bcB}],o));
  /* The orb: the live glow, gliding from its spot in one look to the other. */
  if(A.icon&&B.icon){
    var ob=document.createElement('span');ob.style.cssText='position:absolute;left:0;top:0;border-radius:50%;overflow:hidden;display:block';
    var gl=makeGlow(Math.max(A.icon.s,B.icon.s),true);gl.style.width='100%';gl.style.height='100%';gl.style.display='block';ob.appendChild(gl);g.appendChild(ob);
    /* A new canvas is blank until the next glow frame: start it with the
       live orb's picture so the first frame isn't a dark blink. */
    var src=$('.ai-chat-glow',launcher);
    if(src)try{gl.getContext('2d').drawImage(src,0,0,gl.width,gl.height)}catch(e){}
    anims.push(gl.animate([{filter:A.icon.filter},{filter:B.icon.filter}],o));
    var ip=function(L){return 'translate3d('+L.icon.x+'px,'+L.icon.y+'px,0)'};
    anims.push(ob.animate([{transform:ip(A),width:A.icon.s+'px',height:A.icon.s+'px',backgroundColor:A.icon.bg},{transform:ip(B),width:B.icon.s+'px',height:B.icon.s+'px',backgroundColor:B.icon.bg}],o));
  }
  /* The photo shrinks away as the bar folds into the text button, and grows
     back as it opens out. */
  var PH=A.photo||B.photo;
  if(PH){
    var pi=document.createElement('img');pi.alt='';pi.src=PH.src;
    pi.style.cssText='position:absolute;left:'+PH.x+'px;top:'+PH.y+'px;width:'+PH.s+'px;height:'+PH.s+'px;margin:0;border-radius:50%;object-fit:cover;display:block';
    g.appendChild(pi);
    anims.push(pi.animate(A.photo?[{opacity:1,transform:'scale(1)'},{opacity:0,transform:'scale(0.5)',offset:0.32},{opacity:0,transform:'scale(0.5)'}]:[{opacity:0,transform:'scale(0.5)'},{opacity:0,transform:'scale(0.5)',offset:0.55},{opacity:1,transform:'scale(1)'}],{duration:MORPH_MS,easing:'ease-out',fill:'both'}));
  }
  /* The text button's words: in late as it folds up, out early as it opens. */
  var Q=A.pill||B.pill;
  if(Q){
    var pt=document.createElement('span');pt.textContent=Q.label;
    pt.style.cssText='position:absolute;left:'+Q.x+'px;top:'+Q.y+'px;width:'+Q.w+'px;height:'+Q.h+'px;display:flex;align-items:center;justify-content:center;white-space:nowrap;font:'+Q.font+';letter-spacing:'+Q.ls+';color:'+Q.color;
    g.appendChild(pt);
    anims.push(pt.animate(A.pill?[{opacity:1},{opacity:0,offset:0.25},{opacity:0}]:[{opacity:0},{opacity:0,offset:0.3},{opacity:1,offset:0.7},{opacity:1}],{duration:MORPH_MS,easing:'ease-out',fill:'both'}));
  }
  /* The words: fade out early when folding up, in late when opening out. */
  var T=A.text||B.text;
  if(T){
    var tx=document.createElement('span');tx.textContent=T.label;
    tx.style.cssText='position:absolute;left:'+T.x+'px;top:'+T.y+'px;height:'+T.h+'px;display:flex;align-items:center;white-space:nowrap;padding-left:'+T.pad+';font:'+T.font+';color:'+T.color;
    g.appendChild(tx);
    anims.push(tx.animate(A.text?[{opacity:1},{opacity:0,offset:0.3},{opacity:0}]:[{opacity:0},{opacity:0,offset:0.6},{opacity:1}],{duration:MORPH_MS,easing:'ease-out',fill:'both'}));
  }
  /* The bar's × goes with the words. */
  var X=A.close||B.close;
  if(X){
    var xb=document.createElement('span');xb.innerHTML=X.svg;
    xb.style.cssText='position:absolute;left:'+X.x+'px;top:'+X.y+'px;width:'+X.w+'px;height:'+X.h+'px;display:block;line-height:0;color:'+X.color;
    var sv=xb.firstChild;if(sv&&sv.style){sv.style.width='100%';sv.style.height='100%';sv.style.display='block'}
    g.appendChild(xb);
    anims.push(xb.animate(A.close?[{opacity:1},{opacity:0,offset:0.3},{opacity:0}]:[{opacity:0},{opacity:0,offset:0.6},{opacity:1}],{duration:MORPH_MS,easing:'ease-out',fill:'both'}));
  }
  document.body.appendChild(g);
  var finished=false,timer=0;
  var end=function(){
    if(finished)return;finished=true;clearTimeout(timer);
    launcher.style.removeProperty('opacity');launcher.style.removeProperty('pointer-events');
    void launcher.offsetWidth;launcher.style.removeProperty('transition');
    /* The stand-in ends exactly as the launcher looks, so they swap in one
       frame. Any fade between them would show through (or double the
       shadow) for a moment: a flash. */
    g.remove();
    if(morphAnim===me)morphAnim=null;
    if(done)done();
  };
  var me={stop:function(){for(var i=0;i<anims.length;i++)anims[i].cancel();end()}};
  morphAnim=me;
  anims[0].onfinish=function(){end()};
  timer=setTimeout(end,MORPH_MS+400);
}
/* At the very end of the page the bar folds into the bubble, out of the way
   of the footer; the moment the shopper scrolls back up it opens out again.
   Only when the shopper hasn't folded it themselves, the chat is closed and
   the page is long enough to scroll. */
var tucked=false,tuckBusy=false,tuckWant=false;
function setTucked(on){
  tuckWant=on;
  if(tuckBusy||on===tucked)return;
  tuckBusy=true;tucked=on;
  morphLauncher(function(){
    launcher.classList.toggle('is-bubble',on);launcher.classList.toggle('is-tucked',on);
    launcherA11y();
    placeLauncher();
  },function(){tuckBusy=false;if(tuckWant!==tucked)setTucked(tuckWant)});
}
(function(){
  var lastY=window.scrollY||0,upBy=0,ticking=false;
  function check(){
    ticking=false;
    var y=window.scrollY||window.pageYOffset||0,dy=y-lastY;lastY=y;
    var max=Math.max(document.documentElement.scrollHeight,document.body.scrollHeight)-window.innerHeight;
    if(isOpen||launcher.classList.contains('hidden'))return;
    if(launcher.classList.contains('is-bubble')&&!launcher.classList.contains('is-tucked'))return;/* folded by the shopper */
    if(max<240){if(tucked)setTucked(false);return}/* nothing to scroll */
    var atEnd=y>=max-24;
    if(dy>0){upBy=0;if(atEnd)setTucked(true)}
    else if(dy<0){
      /* iOS's bounce at the bottom scrolls "up" without the shopper doing it. */
      if(y>=max-2)return;
      upBy-=dy;
      if(upBy>=12)setTucked(false);
    }
  }
  window.addEventListener('scroll',function(){if(!ticking){ticking=true;requestAnimationFrame(check)}},{passive:true});
})();
function floatingAt(x,y){
  var found=[];
  var list=document.elementsFromPoint?document.elementsFromPoint(x,y):[];
  var vw=window.innerWidth,vh=window.innerHeight;
  for(var i=0;i<list.length;i++){
    var el=list[i];
    if(el===document.body||el===document.documentElement||launcher.contains(el)||panel.contains(el)||el===overlay||inConsentUi(el))continue;
    var r=el.getBoundingClientRect();
    if(r.width*r.height>vw*vh*0.25)continue;/* page content, not a floating button */
    /* Floating = fixed, or sticky to the bottom of the screen. A column that
       sticks as the page scrolls (a product page's details) is page content,
       not something floating over the bar. */
    for(var a=el;a&&a!==document.body;a=a.parentElement){
      var acs=getComputedStyle(a),pos=acs.position;
      if(pos==='fixed'||(pos==='sticky'&&acs.bottom!=='auto'&&acs.top==='auto')){found.push(r);break}
      if(pos==='sticky')break;
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
    if(el===launcher||el===panel||el===overlay||launcher.contains(el)||panel.contains(el)||inConsentUi(el))continue;
    var cs=getComputedStyle(el);
    if(cs.position!=='fixed'||cs.display==='none'||cs.visibility==='hidden'||+cs.opacity===0||cs.pointerEvents==='none')continue;
    var b=el.getBoundingClientRect();
    if(!b.width||!b.height||b.width*b.height>window.innerWidth*window.innerHeight*0.25)continue;
    if(b.right<=r.left||b.left>=r.right||b.bottom<=r.top||b.top>=r.bottom)continue;
    out.push(b);
  }
  return out;
}
/* Other apps' floating buttons (help chat, feedback tabs) sit above the bar
   and bubble; when one overlaps, the bar or bubble moves up just above it
   (on phones the bar spans the width, so it lifts over them). Cookie
   banners are left to cover it — it never jumps over those. */
function inConsentUi(el){for(var a=el;a&&a!==document.body;a=a.parentElement){if(isConsentUi(a))return true}return false}
/* Phones: the bar is the bottom row. Only a full-width bar pinned to the
   bottom (a sticky Add to cart) sits below it; other apps' small buttons
   (help chat, Feedback, a cart pill) are lifted above it instead — with the
   CSS translate property, so the scripts that place them keep working. */
var PHONE_BAR=window.matchMedia?window.matchMedia('(max-width: 600px)'):null;
function phoneBar(){return !!(PHONE_BAR&&PHONE_BAR.matches)&&!launcher.classList.contains('is-bubble')}
function placeLauncher(){
  /* Behind a drawer or pop-up: stay put (its rows aren't buttons to clear). */
  if(underLayer)return;
  launcher.style.bottom='';
  if(launcher.classList.contains('hidden')){liftFloaters(false);return}
  var phone=phoneBar(),vw=window.innerWidth;
  for(var pass=0;pass<4;pass++){
    var r=launcher.getBoundingClientRect();
    var hits=[].concat(floatingNear(r),floatingAt(r.left+r.width/2,r.top+r.height/2),floatingAt(r.left+6,r.top+6),floatingAt(r.right-6,r.bottom-6));
    if(phone)hits=hits.filter(function(h){return h.width>=vw*0.6&&!isLifted(h)});
    if(!hits.length)break;
    var top=Math.min.apply(null,hits.map(function(h){return h.top}));
    var want=Math.round(window.innerHeight-top+12);
    /* Never climb into the middle of the screen: if that's what it would
       take, stay at the bottom. */
    if(want>window.innerHeight*0.4){launcher.style.bottom='';break}
    launcher.style.bottom=want+'px';
  }
  liftFloaters(phone);
}
var liftedEls=[];
function isLifted(rect){for(var i=0;i<liftedEls.length;i++){var b=liftedEls[i].el.getBoundingClientRect();if(b.top===rect.top&&b.left===rect.left)return true}return false}
function liftOf(el){for(var i=0;i<liftedEls.length;i++)if(liftedEls[i].el===el)return liftedEls[i];return null}
function setLift(el,by){
  var rec=liftOf(el);
  if(!rec){rec={el:el,by:0,was:el.style.getPropertyValue('translate')};liftedEls.push(rec)}
  if(rec.by!==by){rec.by=by;el.style.setProperty('translate','0 '+(-by)+'px','important')}
  return rec;
}
function dropLift(rec){
  if(rec.was)rec.el.style.setProperty('translate',rec.was);else rec.el.style.removeProperty('translate');
}
function liftFloaters(on){
  var keep=[];
  if(on){
    var b=launcher.getBoundingClientRect(),vw=window.innerWidth,vh=window.innerHeight,line=b.top-10;
    var cands=[].slice.call(document.body.children).concat([].slice.call(document.querySelectorAll('iframe')));
    for(var i=0;i<cands.length;i++){
      var el=cands[i];
      if(el===launcher||el===panel||el===overlay||launcher.contains(el)||panel.contains(el)||inConsentUi(el)||keep.indexOf(el)!==-1)continue;
      var cs=getComputedStyle(el);
      if(cs.position!=='fixed'||cs.display==='none'||cs.visibility==='hidden'||+cs.opacity===0||cs.pointerEvents==='none')continue;
      var r=el.getBoundingClientRect();
      if(!r.width||!r.height||r.width>=vw*0.6||r.width*r.height>vw*vh*0.25)continue;
      if(r.right<=b.left||r.left>=b.right)continue;
      var rec=liftOf(el),by=rec?rec.by:0,natTop=r.top+by,natBottom=r.bottom+by;
      if(natBottom<=line+2||natTop>=vh)continue;/* clear of the bar where it stands */
      /* Lift only as far as needed; once clear, hold still (its own script
         may line it up with its neighbours from there). */
      if(r.bottom>line+2)by=Math.round(natBottom-line);
      if(natTop-by<vh*0.3)continue;/* would end up mid-screen: leave it */
      setLift(el,by);keep.push(el);
    }
  }
  liftedEls=liftedEls.filter(function(rec){if(keep.indexOf(rec.el)!==-1)return true;dropLift(rec);return false});
}
try{if(sessionStorage.getItem(LBUBBLE_KEY)==='1')launcher.classList.add('is-bubble')}catch(e){}
/* A page remembered as minimized starts so — no bar flashing first. */
if(_cachedRules&&compactRuleFor(_cachedRules))compactAssistant();
applyMark();
window.addEventListener('resize',placeLauncher);
setTimeout(placeLauncher,600);
/* Other apps' buttons (Zendesk and the like) load late — often only after
   the first scroll or tap — and fade or slide in, so no single moment is
   the right one to look. While the bar or bubble shows, check every couple of
   seconds (a few rectangle reads; nothing moves unless it has to). */
var placeTicks=0;
setInterval(function(){
  if(document.hidden)return;
  /* Phones: a sticky Add to cart bar or a help button can appear at any
     moment, so look often (a few rectangle reads); elsewhere every 2s. */
  placeTicks+=1;
  if(phoneBar()||placeTicks%7===0||liftedEls.length)placeLauncher();
},300);
var placeFrame=0;
window.addEventListener('scroll',function(){
  if(placeFrame||!phoneBar())return;
  placeFrame=requestAnimationFrame(function(){placeFrame=0;placeLauncher()});
},{passive:true});

/* A drawer, pop-up or modal of the page opened over the bar (the theme's
   menu, search or filters, a quick view, another app's pop-up): the bar
   steps behind it, as it does for the cart drawer. Seen from the bar's own
   spot: the topmost thing there, other than the bar, is a layer fixed to the
   screen that covers most of it and takes taps (a closed drawer is
   invisible, or lets taps through). The bar drops just below that layer's
   level; when that isn't enough to get under it, it fades out until the
   layer closes. Only while the chat is closed — the open chat is on top. */
var underLayer=false;
function ownEl(el){return launcher.contains(el)||panel.contains(el)||el===overlay||!!(el.closest&&el.closest('[class^="ai-chat"],[class*=" ai-chat"]'))}
function coverAt(list){
  var vw=window.innerWidth,vh=window.innerHeight;
  for(var i=0;i<list.length;i++){
    var el=list[i];
    if(el===document.body||el===document.documentElement||ownEl(el))continue;
    if(inConsentUi(el))return null;/* consent banners cover the bar on their own */
    for(var a=el;a&&a!==document.body&&a!==document.documentElement;a=a.parentElement){
      if(getComputedStyle(a).position!=='fixed')continue;
      var b=a.getBoundingClientRect();
      if(b.width<vw*0.6||b.height<vh*0.5)return null;
      /* A backdrop the page draws behind itself (a negative z-index) isn't over anything. */
      var z=layerZ(a);
      return z!==null&&z<0?null:{el:el,layer:a,at:i};
    }
    return null;/* page content is the top thing there: nothing covers the bar */
  }
  return null;
}
/* The z-index a layer competes with at the page's top level. */
function layerZ(el){
  var z=null;
  for(var a=el;a&&a!==document.body&&a!==document.documentElement;a=a.parentElement){
    var cs=getComputedStyle(a);
    if(cs.position!=='static'&&cs.zIndex!=='auto'){var n=parseInt(cs.zIndex,10);if(!isNaN(n))z=n}
  }
  return z;
}
function barIndex(list){for(var i=0;i<list.length;i++)if(launcher.contains(list[i]))return i;return -1}
function setUnder(mode,z){
  launcher.classList.toggle('is-under',mode==='hide');
  if(mode==='z')launcher.style.setProperty('z-index',String(z),'important');else launcher.style.removeProperty('z-index');
  underLayer=!!mode;
}
function stepBehind(){
  if(isOpen||launcher.classList.contains('hidden')||!document.elementsFromPoint){if(underLayer)setUnder(null);return}
  var r=launcher.getBoundingClientRect();
  if(!r.width||!r.height){if(underLayer)setUnder(null);return}
  var x=r.left+r.width/2,y=r.top+r.height/2;
  var list=document.elementsFromPoint(x,y),c=coverAt(list);
  if(!c){if(underLayer)setUnder(null);return}
  var bar=barIndex(list);
  if(bar===-1||bar>c.at)return;/* already under it (or faded out) */
  var z=layerZ(c.layer);
  if(z!==null&&z>1&&z<=1000){
    setUnder('z',z-1);
    list=document.elementsFromPoint(x,y);
    var cc=coverAt(list);bar=barIndex(list);
    if(cc&&bar!==-1&&bar<cc.at)setUnder('hide');
  }else setUnder('hide');
}
setInterval(function(){if(!document.hidden)stepBehind()},300);
/* Drawers open on a tap: look right after it, and again once they've slid in. */
['click','keyup'].forEach(function(t){document.addEventListener(t,function(){setTimeout(stepBehind,60);setTimeout(stepBehind,450)},true)});

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
/* The panel never scrolls; only its message list does. Focus or a stray
   scrollIntoView can still shift it and hide the header, so undo that. */
panel.addEventListener('scroll',function(){if(panel.scrollTop||panel.scrollLeft){panel.scrollTop=0;panel.scrollLeft=0}});
var typingEl=$('.ai-chat-typing',panel);
var typingTextEl=$('.ai-chat-typing-text',panel);
var inputEl=$('.ai-chat-input',panel);
/* A chat the guard ended stays paused through a reload until its time. */
if(chatPausedUntil())setTimeout(function(){var t=chatPausedUntil();if(t)pauseChat(t)},0);
var sendBtn=$('.ai-chat-send',panel);
/* The band: one SVG in the header. Two shapes — the colour ring around the
   face at home, and the line along the header's bottom in a chat — on one
   gradient that slides slowly along them, faster while Ava is writing.
   Home → chat: the ring fades out with the face while the line lights up
   from the left, its light reaching the far end with a long soft tail (a
   mask that travels along it). Chat → home: the light withdraws the same way
   and the ring fades back in around the face. Touch screens get no blurred
   stroke (CSS). Reduced motion gets the end states at once. */
var FOCUS_SW=3;/* the stroke */
var FOCUS_BAND=GLOW_USUAL.slice();applyPeakColors();
var FOCUS_TAIL=0.55;/* the light's tail, as a share of the header's width */
var focusG={W:0,cy:0,hx:54,R:34};/* measured: the header's width, the line, the face's centre and radius */
var focusS={ro:1,lit:0,fs:1,fo:1};/* now: the ring's opacity, how far the line is lit (0–1), the face's scale and opacity */
var focusAnim=null,focusMorphGen=0,focusEls=null,focusFace={t:'',o:''},focusLitLast=-1,focusRoLast=-1;
var focusPhase=0,focusSpeed=0,focusLast=0,focusFlowOn=false;
/* Two shapes on one gradient: the ring around the face, and the line along
   the header's bottom. The line (and its glow) is seen through a mask — a
   second gradient, white to black over the tail, that travels along it:
   where it is white the line is lit. */
function focusBandHtml(){
  var stops='';for(var i=0;i<=8;i++)stops+='<stop offset="'+(i/8)+'" stop-color="'+FOCUS_BAND[i%4]+'"/>';
  var sweep='',ease=[[0,255],[0.2,236],[0.4,180],[0.6,96],[0.8,30],[1,0]];
  for(var j=0;j<ease.length;j++){var v=ease[j][1];sweep+='<stop offset="'+ease[j][0]+'" stop-color="rgb('+v+','+v+','+v+')"/>'}
  /* Four strokes of one path, wide and faint to narrow and dim: a soft glow with no hard line. */
  var lay=function(cls,id){var h='';for(var k=4;k>=1;k--)h+='<use class="'+cls+' '+cls+'--'+k+(k===1&&cls==='ai-chat-band__linel'?' ai-chat-band__line':'')+'" href="#'+id+'" xlink:href="#'+id+'" stroke="url(#ai-chat-band-g)"/>';return h};
  return '<svg class="ai-chat-band" xmlns:xlink="http://www.w3.org/1999/xlink" aria-hidden="true"><defs><linearGradient id="ai-chat-band-g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="0">'+stops+'</linearGradient><linearGradient id="ai-chat-band-s" gradientUnits="userSpaceOnUse" x1="-1000" y1="0" x2="-999" y2="0">'+sweep+'</linearGradient><mask id="ai-chat-band-m" maskUnits="userSpaceOnUse" x="-100" y="-100" width="6000" height="1000"><rect x="-100" y="-100" width="6000" height="1000" fill="url(#ai-chat-band-s)"/></mask><path id="ai-chat-band-lp" d=""/><path id="ai-chat-band-rp" d=""/></defs><g class="ai-chat-band__lit" mask="url(#ai-chat-band-m)">'+lay('ai-chat-band__linel','ai-chat-band-lp')+'</g><g class="ai-chat-band__ring">'+lay('ai-chat-band__ringl','ai-chat-band-rp')+'</g></svg>';
}
function focusParts(){
  if(focusEls)return focusEls;
  var hdr=$('.ai-chat-header',panel),band=hdr&&$('.ai-chat-band',hdr),hero=hdr&&$('.ai-chat-hero',hdr);
  if(!band||!hero)return null;
  return focusEls={hdr:hdr,band:band,ring:$('.ai-chat-band__ring',band),halo:$('.ai-chat-hero__halo',hero),ringPath:$('#ai-chat-band-rp',band),linePath:$('#ai-chat-band-lp',band),line:$('.ai-chat-band__line',band),grad:$('#ai-chat-band-g',band),sweep:$('#ai-chat-band-s',band),hero:hero,photo:$('.ai-chat-hero__photo',hero)};
}
function focusMotionOk(){try{return !matchMedia('(prefers-reduced-motion: reduce)').matches}catch(e){return true}}
/* A cubic-bezier timing curve, the same ones CSS uses. */
function focusBez(x1,y1,x2,y2){
  return function(t){
    if(t<=0)return 0;if(t>=1)return 1;
    var lo=0,hi=1,u,x;
    for(var i=0;i<22;i++){u=(lo+hi)/2;x=3*u*(1-u)*(1-u)*x1+3*u*u*(1-u)*x2+u*u*u;if(x<t)lo=u;else hi=u}
    u=(lo+hi)/2;return 3*u*(1-u)*(1-u)*y1+3*u*u*(1-u)*y2+u*u*u;
  };
}
var FOCUS_EASE_OUT=focusBez(0.2,0.7,0.2,1),FOCUS_EASE_INOUT=focusBez(0.45,0,0.2,1);
/* Where things are: the line (the header's bottom), the face's centre and
   radius — read from the styles, so a closed panel measures right too. */
function focusMeasure(){
  var e=focusParts();if(!e)return;
  var sub=$('.ai-chat-header__sub',e.hdr);if(sub)sub.hidden=true;
  var cy=e.hdr.clientHeight;
  e.hdr.style.setProperty('--ai-focus-line',cy+'px');
  if(typeof peakDecoFit==='function')peakDecoFit();
  var R=(parseFloat(getComputedStyle(panel).getPropertyValue('--ai-hero'))||68)/2;
  var left=parseFloat(getComputedStyle(e.hero).left);if(isNaN(left))left=20;
  focusG={W:e.hdr.clientWidth,cy:cy,hx:left+R,R:R};
  if(!focusAnim)focusRest(panel.classList.contains('is-chatting'));
}
/* The ring's path around the face, and the line's, edge to edge. */
function focusCirclePath(cx,cy,r){
  var f=function(n){return Math.round(n*100)/100};
  return 'M'+f(cx-r)+' '+f(cy)+'A'+f(r)+' '+f(r)+' 0 1 0 '+f(cx+r)+' '+f(cy)+'A'+f(r)+' '+f(r)+' 0 1 0 '+f(cx-r)+' '+f(cy)+'Z';
}
function focusLinePath(W,cy){var f=function(n){return Math.round(n*100)/100};return 'M'+f(-FOCUS_SW)+' '+f(cy)+'L'+f(W+FOCUS_SW)+' '+f(cy)}
function focusDraw(){
  var e=focusParts();if(!e)return;
  var g=focusG,s=focusS,r=Math.max(1,g.R-FOCUS_SW/2);
  e.ringPath.setAttribute('d',focusCirclePath(g.hx,g.cy,r));
  e.linePath.setAttribute('d',focusLinePath(g.W,g.cy));
  /* The light: at 0 the mask is dark along the whole line; at 1 its white
     end has passed the line's end, the tail and all. */
  var tail=Math.max(80,g.W*FOCUS_TAIL),head=-FOCUS_SW+s.lit*(g.W+2*FOCUS_SW+tail);
  if(s.lit!==focusLitLast){e.sweep.setAttribute('x1',(head-tail).toFixed(2));e.sweep.setAttribute('x2',head.toFixed(2));focusLitLast=s.lit}
  if(s.ro!==focusRoLast){var ro=s.ro>=0.999?'':s.ro.toFixed(3);e.ring.style.opacity=ro;if(e.halo)e.halo.style.setProperty('--ro',ro||'1');focusRoLast=s.ro}
  /* The colours: two bands' worth across twice the shape showing, slid by the phase — one band shows, and it loops without a seam. */
  var onLine=s.lit>0||panel.classList.contains('is-chatting'),L=Math.max(1,onLine?g.W+2*FOCUS_SW:2*r),x0=onLine?-FOCUS_SW:g.hx-r,x1=x0-L*focusPhase;
  e.grad.setAttribute('x1',x1.toFixed(2));e.grad.setAttribute('x2',(x1+2*L).toFixed(2));
  var t=s.fs>=0.999?'':'scale('+s.fs.toFixed(3)+')',o=s.fo>=0.999?'':s.fo.toFixed(3);
  if(t!==focusFace.t){e.photo.style.transform=t;focusFace.t=t}
  if(o!==focusFace.o){e.photo.style.opacity=o;focusFace.o=o}
}
/* At rest: the ring around the face and the line dark, or the line lit
   edge to edge and the ring out. */
function focusRest(chat){
  var s=focusS;
  if(chat){s.ro=0;s.lit=1;s.fs=0.6;s.fo=0}
  else{s.ro=1;s.lit=0;s.fs=1;s.fo=1}
  focusDraw();
}
function focusSetChatting(on){
  focusAnim=null;++focusMorphGen;
  focusChatClass(on);
  var e=focusParts();if(e)e.hero.classList.toggle('is-gone',!!on);
  focusRest(!!on);
}
/* Plays tracks that overlap in time — each eases its own part of the
   shape from wherever that is when the track begins, so steps blend into
   one continuous motion and an interrupted journey turns around cleanly. */
function focusPlay(tracks,done){
  var gen=++focusMorphGen,t0=0,end=0;
  focusAnim={gen:gen};
  for(var i=0;i<tracks.length;i++)end=Math.max(end,tracks[i].at+tracks[i].dur);
  function frame(now){
    if(!focusAnim||focusAnim.gen!==gen)return;
    if(!t0)t0=now;
    var t=now-t0;
    for(var i=0;i<tracks.length;i++){
      var k=tracks[i];
      if(t<k.at||k.over)continue;
      if(!k.from){if(k.start)k.start();k.from={ro:focusS.ro,lit:focusS.lit,fs:focusS.fs,fo:focusS.fo};k.target=k.to()}
      var u=k.ease(Math.min(1,(t-k.at)/k.dur));
      for(var key in k.target)focusS[key]=k.from[key]+(k.target[key]-k.from[key])*u;
      if(k.link)k.link();
      if(t-k.at>=k.dur)k.over=true;
    }
    focusDraw();
    if(t>=end){focusAnim=null;done();return}
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
/* Home → chat: the ring fades out as the face eases back and fades; from
   the left, the line lights up — its light setting off gently, travelling
   to the far end with a long soft tail and slowing as it arrives — the name
   sliding over with it. */
function focusRingToLine(){
  var e=focusParts();if(!e||panel.classList.contains('is-chatting'))return;
  focusMeasure();
  if(!focusMotionOk()||typeof requestAnimationFrame!=='function'){focusSetChatting(true);return}
  focusPlay([
    {at:0,dur:340,ease:FOCUS_EASE_INOUT,to:function(){return {ro:0}}},
    {at:40,dur:300,ease:FOCUS_EASE_INOUT,to:function(){return {fs:0.72,fo:0}}},
    {at:120,dur:1300,ease:FOCUS_EASE_INOUT,start:function(){focusChatClass(true)},to:function(){return {lit:1}}}
  ],function(){focusSetChatting(true)});
}
/* Chat → home: the light withdraws to the left the same way; as it goes
   the face eases in and its ring fades up around it. */
function focusLineToRing(){
  var e=focusParts();if(!e||!panel.classList.contains('is-chatting'))return;
  focusMeasure();
  if(!focusMotionOk()||typeof requestAnimationFrame!=='function'){focusSetChatting(false);return}
  focusPlay([
    {at:0,dur:760,ease:FOCUS_EASE_INOUT,start:function(){focusChatClass(false)},to:function(){return {lit:0}}},
    {at:380,dur:380,ease:FOCUS_EASE_OUT,start:function(){focusS.fs=0.72;focusS.fo=0;focusDraw();e.hero.classList.remove('is-gone')},to:function(){return {fs:1,fo:1}}},
    {at:380,dur:420,ease:FOCUS_EASE_INOUT,to:function(){return {ro:1}}}
  ],function(){focusSetChatting(false)});
}
/* The colours' slow slide: one frame loop, asleep while the chat is closed
   or the tab hidden. Its speed eases between the states, so nothing jumps. */
function focusFlowStart(){if(focusFlowOn||typeof requestAnimationFrame!=='function')return;focusFlowOn=true;requestAnimationFrame(focusFlow)}
function focusFlow(now){
  if(!isOpen||document.hidden){focusLast=0;setTimeout(function(){requestAnimationFrame(focusFlow)},250);return}
  var dt=focusLast?Math.min(64,now-focusLast):16;focusLast=now;
  var chat=panel.classList.contains('is-chatting'),fast=chat&&panel.classList.contains('is-streaming');
  var want=!focusMotionOk()?0:fast?1/4000:chat?1/10000:1/18000;
  focusSpeed+=(want-focusSpeed)*Math.min(1,dt/500);
  focusPhase=(focusPhase+focusSpeed*dt)%1;
  if(!focusAnim&&focusSpeed>1e-7)focusDraw();
  requestAnimationFrame(focusFlow);
}
/* Focus home: the face sits on the header's line while the shopper is at
   home; once a chat starts its colour ring gives way to the line, lit from
   the left — a soft light that flows while Ava is answering (focusRingToLine). */
if(FOCUS){
  panel.classList.add('is-focus');
  focusTitleBuild();
  var _fhdr=$('.ai-chat-header',panel);
  if(_fhdr)_fhdr.insertAdjacentHTML('beforeend',focusBandHtml()+'<div class="ai-chat-hero" aria-hidden="true"><span class="ai-chat-hero__halo"></span><span class="ai-chat-hero__photo">'+(AVATAR&&safeUrl(AVATAR)?'<img src="'+safeUrl(AVATAR)+'" alt="">':'<span class="ai-chat-hero__mono">'+esc(String(NAME||'A').replace(/^ask\s+/i,'').charAt(0).toUpperCase()||'A')+'</span>')+'</span></div>');
  /* One row: the name and the controls, the face on the header's bottom
     line. The name's second line stays out of it; the greeting takes its
     place at the top of the home, where it scrolls away with the page. */
  focusMeasure();
  focusFlowStart();
  if(typeof ResizeObserver!=='undefined')new ResizeObserver(focusMeasure).observe(_fhdr);
  /* The line glows more while a reply is being written. */
  if(typeof MutationObserver!=='undefined')new MutationObserver(function(){panel.classList.toggle('is-streaming',typingEl.classList.contains('visible'))}).observe(typingEl,{attributes:true,attributeFilter:['class']});
}
var closeBtn=$('.ai-chat-close-btn',panel);
var menuBtn=$('.ai-chat-menu-btn',panel);
/* Sun/moon: switches light / dark with a short cross-fade of the colors. */
$('.ai-chat-theme-btn',panel).addEventListener('click',function(e){
  e.stopPropagation();
  var els=[launcher,panel];
  for(var i=0;i<els.length;i++)els[i].classList.add('ai-chat-theming');
  applyTheme(THEME==='dark'?'light':'dark',true);
  setTimeout(function(){for(var i=0;i<els.length;i++)els[i].classList.remove('ai-chat-theming')},420);
});

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
function forgetPersonal(){try{localStorage.removeItem(HK);localStorage.removeItem(SK);localStorage.removeItem(TF_LAST);localStorage.removeItem('hajirai_ret_progress');localStorage.removeItem('hajirai_ret_done')}catch(e){}_memSess=''}
(function(){
  var now=CUST_LOGGED_IN?'c:'+String(C.customerId||CUST_NAME||'1'):'guest',was=null;
  try{was=localStorage.getItem(OWNER_KEY)}catch(e){}
  if(was&&was!=='guest'&&was!==now)forgetPersonal();
  try{localStorage.setItem(OWNER_KEY,now)}catch(e){}
})();
dropStaleChat();
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
  feedback:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 15a2 2 0 01-2 2H8l-4 3.5V6a2 2 0 012-2h12a2 2 0 012 2z"/><path d="M8.5 10.5h.01M12 10.5h.01M15.5 10.5h.01" stroke-width="2.4"/></svg>',
  ret:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 010 10h-3"/></svg>',
  search:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>',
  target:'<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/></svg>',
  spark:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 3l1.8 4.9L19 9.7l-4.9 1.8L12 16.4l-1.8-4.9L5 9.7l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>',
  truck:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2 6h11v10H2z"/><path d="M13 9h4.5l3.5 3.5V16h-8"/><circle cx="6.5" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/></svg>',
  gift:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3" y="8" width="18" height="4" rx="1"/><path d="M5 12v8h14v-8M12 8v12"/><path d="M12 8C10.5 4 7 4.5 7 6.5S10 8 12 8zm0 0c1.5-4 5-3.5 5-1.5S14 8 12 8z"/></svg>',
  heart:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 20s-7.5-4.6-9.2-9.3C1.7 7.5 3.8 4.5 7 4.5c2 0 3.4 1.1 5 3 1.6-1.9 3-3 5-3 3.2 0 5.3 3 4.2 6.2C19.5 15.4 12 20 12 20z"/></svg>',
  star:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>',
  chat:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 15a2 2 0 01-2 2H8l-4 3.5V6a2 2 0 012-2h12a2 2 0 012 2z"/></svg>',
  /* A footprint, the sore spot marked at the heel. */
  foot:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9.6 22.2c-2.7 0-4.3-1.9-4.3-4.4 0-1.7.8-2.9 1.1-4.4.4-1.9-.7-3.6-.7-5.6C5.7 4.7 7.5 2.6 10 2.6c2.8 0 4.6 2.5 4.6 5.7 0 2.2-1 3.9-1 6.1 0 1.6.9 2.7.9 4.3 0 2.1-1.9 3.5-4.9 3.5z"/><circle cx="17.6" cy="4.6" r="1.3"/><circle cx="19.6" cy="7.6" r="1"/><circle cx="20.4" cy="10.6" r=".9"/><circle cx="9.3" cy="17.6" r="1.7" fill="currentColor" stroke="none"/></svg>',
  check:'<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
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
function ctaTileHtml(c){
  return '<button type="button" class="ai-chat-welcome__cta-btn" data-message="'+esc(c.m)+'"><span class="ai-chat-welcome__cta-icon">'+ctaIcon(c.l,c.i)+'</span><span class="ai-chat-welcome__cta-label">'+esc(c.l)+'</span><span class="ai-chat-welcome__cta-go">'+WI.arrow+'</span></button>';
}
var SEASON_ICONS={fall:"<svg class=\"ai-sea-ic ai-sea-ic--fall\" viewBox=\"0 0 24 24\" width=\"20\" height=\"20\" fill=\"none\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\" focusable=\"false\"><path class=\"sx-f sx-o\" stroke-width=\"1.5\" d=\"M12 2.6l1.6 3.3 2.2-1-.6 4.1 3.1-2.3.9 1.9 2.4-.4-1 3.2 1.3 1-4.4 3.4.6 1.7-4.5-.8-1.6.9-1.6-.9-4.5.8.6-1.7-4.4-3.4 1.3-1-1-3.2 2.4.4.9-1.9 3.1 2.3-.6-4.1 2.2 1z\"/><path class=\"sx-d\" stroke-width=\"1.15\" d=\"M12 16.4V8.3M12 12.8l4-2.6M12 12.8l-4-2.6\"/><path class=\"sx-o\" stroke-width=\"1.5\" d=\"M12 17.6c0 1.5-.2 2.8-.8 3.9\"/></svg>",winter:"<svg class=\"ai-sea-ic ai-sea-ic--winter\" viewBox=\"0 0 24 24\" width=\"20\" height=\"20\" fill=\"none\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\" focusable=\"false\"><path class=\"sx-f\" d=\"M12 9.5l2.2 1.25v2.5L12 14.5l-2.2-1.25v-2.5z\"/><g transform=\"rotate(0 12 12)\"><path class=\"sx-o\" stroke-width=\"1.5\" d=\"M12 2.7v18.6M9.7 4.8L12 7l2.3-2.2M9.7 19.2L12 17l2.3 2.2\"/></g><g transform=\"rotate(60 12 12)\"><path class=\"sx-o\" stroke-width=\"1.5\" d=\"M12 2.7v18.6M9.7 4.8L12 7l2.3-2.2M9.7 19.2L12 17l2.3 2.2\"/></g><g transform=\"rotate(120 12 12)\"><path class=\"sx-o\" stroke-width=\"1.5\" d=\"M12 2.7v18.6M9.7 4.8L12 7l2.3-2.2M9.7 19.2L12 17l2.3 2.2\"/></g></svg>",spring:"<svg class=\"ai-sea-ic ai-sea-ic--spring\" viewBox=\"0 0 24 24\" width=\"20\" height=\"20\" fill=\"none\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\" focusable=\"false\"><path class=\"sx-f sx-o\" stroke-width=\"1.35\" transform=\"rotate(0 12 12)\" d=\"M12 10.3C9.7 9.4 8.7 6.8 9.6 4.8 10.2 3.6 11.2 3.6 12 4.6 12.8 3.6 13.8 3.6 14.4 4.8 15.3 6.8 14.3 9.4 12 10.3z\"/><path class=\"sx-f sx-o\" stroke-width=\"1.35\" transform=\"rotate(72 12 12)\" d=\"M12 10.3C9.7 9.4 8.7 6.8 9.6 4.8 10.2 3.6 11.2 3.6 12 4.6 12.8 3.6 13.8 3.6 14.4 4.8 15.3 6.8 14.3 9.4 12 10.3z\"/><path class=\"sx-f sx-o\" stroke-width=\"1.35\" transform=\"rotate(144 12 12)\" d=\"M12 10.3C9.7 9.4 8.7 6.8 9.6 4.8 10.2 3.6 11.2 3.6 12 4.6 12.8 3.6 13.8 3.6 14.4 4.8 15.3 6.8 14.3 9.4 12 10.3z\"/><path class=\"sx-f sx-o\" stroke-width=\"1.35\" transform=\"rotate(216 12 12)\" d=\"M12 10.3C9.7 9.4 8.7 6.8 9.6 4.8 10.2 3.6 11.2 3.6 12 4.6 12.8 3.6 13.8 3.6 14.4 4.8 15.3 6.8 14.3 9.4 12 10.3z\"/><path class=\"sx-f sx-o\" stroke-width=\"1.35\" transform=\"rotate(288 12 12)\" d=\"M12 10.3C9.7 9.4 8.7 6.8 9.6 4.8 10.2 3.6 11.2 3.6 12 4.6 12.8 3.6 13.8 3.6 14.4 4.8 15.3 6.8 14.3 9.4 12 10.3z\"/><circle class=\"sx-a\" cx=\"12\" cy=\"12\" r=\"2.1\"/></svg>",summer:"<svg class=\"ai-sea-ic ai-sea-ic--summer\" viewBox=\"0 0 24 24\" width=\"20\" height=\"20\" fill=\"none\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\" focusable=\"false\"><circle class=\"sx-a sx-o\" stroke-width=\"1.5\" cx=\"12\" cy=\"12\" r=\"4.1\"/><path class=\"sx-d\" stroke-width=\"1.6\" d=\"M12 2.6v2.4M12 19v2.4M2.6 12H5M19 12h2.4M5.4 5.4l1.7 1.7M16.9 16.9l1.7 1.7M5.4 18.6l1.7-1.7M16.9 7.1l1.7-1.7\"/></svg>"};
/* The seasonal tile: the season's icon in color and a soft tint. Tapping it
   sends its words, marked so the chat shows the collection behind it. */
function seaTileHtml(){
  var tint=SEA_COLOR!=='plain'?' sea-'+SEA_COLOR:'';
  return '<button type="button" class="ai-chat-welcome__cta-btn is-season'+tint+'" data-message="'+esc(SEA_LABEL)+'" data-seasonal="1"><span class="ai-chat-welcome__cta-icon">'+(SEASON_ICONS[SEA_ICON]||SEASON_ICONS.fall)+'</span><span class="ai-chat-welcome__cta-label">'+esc(SEA_LABEL)+'</span><span class="ai-chat-welcome__cta-go">'+WI.arrow+'</span></button>';
}
function fbIcon(){
  var key=FB_ICON==='feedback'?'feedback':CTA_ICONS[FB_ICON];
  return !key?WI.feedback:key==='ruler'?WI.ruler.replace(/22/g,'18'):WI[key];
}
function fbTileHtml(){
  var ic=fbIcon();
  return '<button type="button" class="ai-chat-welcome__cta-btn is-feedback'+(FB_COLOR!=='teal'?' fb-'+FB_COLOR:'')+'" data-feedback="1" aria-haspopup="dialog"><span class="ai-chat-welcome__cta-icon">'+ic+'</span><span class="ai-chat-welcome__cta-label">'+esc(FB_LABEL)+'</span><span class="ai-chat-welcome__cta-go">'+WI.arrow+'</span></button>';
}
/* A Popular button: sends its message, or, when the message is a Typeform
   link, opens that form in the chat — that one gets an icon, chosen from
   its words (insoles for an orthotic quiz). The theme block has no room for
   more settings (Shopify allows 40), so the icon needs none. */
function qpHtml(q){
  var form=formIdOf(q.m);
  var ic=form?'<span class="ai-chat-welcome__qp-icon">'+ctaIcon(q.l,'').replace(/(width|height)="\d+"/g,'$1="15"')+'</span>':'';
  var act=form?'data-form="'+esc(form)+'" data-form-label="'+esc(q.l)+'" aria-haspopup="dialog"':'data-message="'+esc(q.m)+'"';
  return '<button type="button" class="ai-chat-welcome__qp-btn'+(ic?' has-icon':'')+'" '+act+'>'+ic+'<span>'+esc(q.l)+'</span></button>';
}
function welcomeCtas(){
  var ctas=[];
  if(CTA1L&&CTA1M)ctas.push({l:CTA1L,m:CTA1M,i:CTA1I});
  if(CTA2L&&CTA2M)ctas.push({l:CTA2L,m:CTA2M,i:CTA2I});
  if(CTA3L&&CTA3M)ctas.push({l:CTA3L,m:CTA3M,i:CTA3I});
  if(CTA4L&&CTA4M)ctas.push({l:CTA4L,m:CTA4M,i:CTA4I});
  /* Feedback takes the fourth place, until this shopper has sent it. */
  if(fbShown())ctas.splice(3,1,{fb:true});
  /* The seasonal button takes the first. */
  if(SEA_ON){if(ctas.length&&!ctas[0].fb)ctas[0]={sea:true};else ctas.unshift({sea:true})}
  return ctas;
}
function welcomeCtasHtml(ctas){
  var h='';for(var i=0;i<ctas.length;i++)h+=ctas[i].sea?seaTileHtml():ctas[i].fb?fbTileHtml():ctaTileHtml(ctas[i]);return h;
}
function welcomeGreetingText(){
  return (CUST_LOGGED_IN&&CUST_NAME&&GREET_LOGGED&&GREET_LOGGED.trim())?GREET_LOGGED.replace(/\{name\}/gi,CUST_NAME):GREET;
}
/* Settings' chat text arrived after the chat was drawn: put it in place. */
function refreshTexts(inWas){
  var hn=$('.ai-chat-header__name',panel);if(hn){if(FOCUS)focusTitleBuild();else hn.textContent=NAME}
  var hs=$('.ai-chat-header__sub',panel);if(hs){hs.textContent=NAME_SUB;hs.hidden=!NAME_SUB}
  if(FOCUS){focusGreetRender();focusMeasure()}
  var lt=$('.ai-chat-launcher__text',launcher);if(lt){lt.textContent=LPLACE;lt.setAttribute('aria-label',LPLACE+' — open the shopping assistant')}
  if(inputEl&&inputEl.getAttribute('placeholder')===inWas)inputEl.setAttribute('placeholder',IPLACE);
  var wt=$('.ai-chat-welcome__title',panel);if(wt)wt.textContent=welcomeGreetingText()||('Hi, I\'m '+NAME);
  var ls=$('[data-wl="start"]',panel);if(ls)ls.textContent=START_LBL;
  var lp=$('[data-wl="popular"]',panel);if(lp)lp.textContent=POP_LBL;
  var fq=panel.querySelectorAll('[data-fitq]');
  for(var i=0;i<fq.length;i++){var fc=fq[i].closest('.ai-chat-product-card');fq[i].innerHTML=fitqLabel();fq[i].setAttribute('aria-label',fitqName(fc?fc.getAttribute('data-title')||'':''))}
  if(FOCUS){
    var fcs=$('.ai-chat-focus__cards',panel);if(fcs)fcs.innerHTML=focusCardHtml('pain')+focusCardHtml('footwear')+focusCardHtml('orthotics');
    var fls=$('.ai-chat-focus__links',panel);if(fls)fls.innerHTML=focusLinksHtml();
  }
  var ft=$('.ai-chat-footer',panel),fth=esc(DISCL)+' <a href="'+(safeUrl(PRIVURL)||'/policies/privacy-policy')+'">Privacy Policy</a>';
  if(ft&&DISCL)ft.innerHTML=fth;
  else if(!ft&&DISCL){var ia=$('.ai-chat-input-area',panel);if(ia)ia.insertAdjacentHTML('afterend','<div class="ai-chat-footer">'+fth+'</div>')}
}
/* The settings arrived after the welcome was drawn: redraw just the buttons. */
function refreshWelcomeCtas(){
  var box=$('.ai-chat-welcome__ctas',panel);
  if(box)box.innerHTML=welcomeCtasHtml(welcomeCtas());
}
/* ── Focus home (Theme editor → Home layout → Focus) ──
   The foot-pain specialist first: three cards whose tools open in a sheet.
   Foot pain is a guided flow — where it hurts, footwear or orthotics, the
   shoes, arch, ball of foot — that writes one message with everything Ava
   needs, so she answers with products instead of questions. Footwear and
   Orthotics: Women / Men, the store's own helpers (True Fit, FITFinder,
   its visual quizzes), and Browse by, from the store's menu. The three
   links right above the text box each send their question. Classic is
   untouched. */
var FOCUS_TITLE='Where does it hurt?';
var FOCUS_HINT='Tap all that apply.';
var FOCUS_ROTATE=true;/* Settings → rotate the welcome line (arrives with widget-config). */
/* Where it hurts: the place, what it usually is, and how the shopper would
   say it — the words Ava reads ("heel pain (plantar fasciitis)"). */
var FOCUS_WHERE=[
  ['heel','Heel','Plantar fasciitis, heel spurs','heel pain (plantar fasciitis)'],
  ['arch','Arch','Arch pain, flat feet','arch pain'],
  ['ball','Ball of foot','Burning under the toes','pain under the ball of my foot (metatarsalgia)'],
  ['toes','Toes & bunions','Bunions, hammertoes','bunions and sore toes'],
  ['whole','Whole foot','Tired, aching or swollen','tired, aching feet by the end of the day'],
  ['none','No pain','Just comfort and support','']
];
/* Footwear or orthotics (or let Ava weigh it up). */
var FOCUS_WHAT=[
  ['footwear','Footwear','Shoes built for your feet'],
  ['orthotics','Orthotics','Insoles for shoes you own'],
  ['both','Not sure — show me both','Ava weighs up what fits best']
];
/* The kinds of shoes the store's own menu lists for each line, and the
   word for the message. */
function focusKinds(g){
  var k=g==='men'
    ?[['sneakers','Sneakers','sneakers'],['sandals','Sandals','sandals'],['clogs','Clogs','clogs']]
    :[['sneakers','Sneakers','sneakers'],['sandals','Sandals','sandals'],['loafers','Loafers & oxfords','loafers or oxfords'],['slipons','Slip-ons','slip-ons'],['maryjanes','Mary Janes','Mary Janes'],['boots','Boots','boots'],['slippers','Slippers','slippers'],['clogs','Clogs','clogs'],['heels','Wedges & heels','wedges or heels']];
  k.push(['any','Any kind','Show me what fits best','shoes']);
  return k;
}
var FOCUS_WIDTH=[['regular','Regular width',''],['wide','Wide','Roomier through the foot'],['narrow','Narrow',''],['unsure','Not sure','']];
/* The shoes an orthotic goes in — the lines' own "Best for" (sneakers and
   everyday shoes, running, training, dress, work boots, hiking and golf,
   winter boots, cleats) — and the words for the message. */
var FOCUS_SHOES=[
  ['everyday','Sneakers & everyday shoes','Walking, casual','my sneakers and everyday shoes'],
  ['running','Running shoes','','running shoes'],
  ['gym','Gym & training shoes','','gym and training shoes'],
  ['dress','Dress shoes & heels','Slim, or no removable insole','dress shoes and heels'],
  ['work','Work boots','On my feet all day','work boots (I’m on my feet all day)'],
  ['hike','Hiking & golf shoes','','hiking and golf shoes'],
  ['winter','Winter boots','','winter boots'],
  ['cleats','Cleats','','cleats']
];
var FOCUS_ARCH=[['flat_low','Flat or low','My feet roll inward'],['medium_high','Medium or high','A clear arch'],['not_sure','Not sure','Ava can help']];
var FOCUS_BALL=[['yes','Yes',''],['no','No','']];
/* Browse by: the store's own menu (aetrex.com) for the line and the
   gender picked — one group per tab, each chip a question to ask. The
   women's and men's footwear menus differ (women's has more shoe kinds);
   orthotics share one menu, sized by gender. */
var FOCUS_GENDER_KEY='hajirai_focus_gender',focusGender='women';
try{if(localStorage.getItem(FOCUS_GENDER_KEY)==='men')focusGender='men'}catch(e){}
function focusGenderWord(g){return g==='men'?'men\u2019s':'women\u2019s'}
function focusBrowseGroups(kind,g){
  var G=focusGenderWord(g),Gc=G.charAt(0).toUpperCase()+G.slice(1);
  if(kind==='orthotics')return [
    ['Condition',[['Plantar fasciitis',Gc+' orthotics for plantar fasciitis'],['Ball of foot',Gc+' orthotics for ball-of-foot discomfort'],['Flat feet',Gc+' orthotics for flat feet'],['High arches',Gc+' orthotics for high arches'],['Heel spurs',Gc+' orthotics for heel spurs'],['Overpronation',Gc+' orthotics for overpronation'],['Bunions',Gc+' orthotics for bunions'],['Diabetes',Gc+' orthotics for diabetes']]],
    ['Activity',[['Casual everyday',Gc+' orthotics for casual everyday wear'],['All-day standing',Gc+' orthotics for standing all day'],['Walking',Gc+' orthotics for walking'],['Running',Gc+' orthotics for running'],['Dress shoes',Gc+' orthotics for dress shoes'],['Golf',Gc+' orthotics for golf'],['Gym & training',Gc+' orthotics for the gym'],['Tennis & pickleball',Gc+' orthotics for tennis and pickleball'],['Cleats',Gc+' orthotics for cleats']]],
    ['Collections',[['Premium Memory Foam','Show me the '+G+' Premium Memory Foam orthotics'],['Essentials','Show me the '+G+' Essentials orthotics'],['Compete','Show me the '+G+' Compete orthotics'],['Speed','Show me the '+G+' Speed orthotics'],['Active','Show me the '+G+' Active orthotics'],['Train','Show me the '+G+' Train orthotics'],['Casual Comfort','Show me the '+G+' Casual Comfort orthotics'],['Fashion','Show me the '+G+' Fashion orthotics'],['Work','Show me the '+G+' Work orthotics'],['Kids','Show me the kids orthotics']]]
  ];
  if(g==='men')return [
    ['Shoes',[['Sneakers','Show me men\u2019s sneakers'],['Sandals','Show me men\u2019s sandals'],['Clogs','Show me men\u2019s clogs']]],
    ['Condition',[['Plantar fasciitis','Men\u2019s shoes for plantar fasciitis'],['Metatarsalgia','Men\u2019s shoes for metatarsalgia'],['Flat feet','Men\u2019s shoes for flat feet'],['High arch','Men\u2019s shoes for high arches'],['Bunions','Men\u2019s shoes for bunions']]],
    ['Collections',[['New arrivals','Show me the men\u2019s new arrivals'],['Last chance','Show me men\u2019s shoes on sale']]]
  ];
  return [
    ['Shoes',[['Sneakers','Show me women\u2019s sneakers'],['Sandals','Show me women\u2019s sandals'],['Loafers & oxfords','Show me women\u2019s loafers and oxfords'],['Slip-ons','Show me women\u2019s slip-ons'],['Mary Janes','Show me women\u2019s Mary Janes'],['Boots','Show me women\u2019s boots'],['Slippers','Show me women\u2019s slippers'],['Clogs','Show me women\u2019s clogs'],['Wedges & heels','Show me women\u2019s wedges and heels'],['Platforms','Show me women\u2019s platform sandals']]],
    ['Condition',[['Plantar fasciitis','Women\u2019s shoes for plantar fasciitis'],['Metatarsalgia','Women\u2019s shoes for metatarsalgia'],['Flat feet','Women\u2019s shoes for flat feet'],['High arch','Women\u2019s shoes for high arches'],['Bunions','Women\u2019s shoes for bunions'],['Arthritis','Women\u2019s shoes for arthritis'],['Swollen feet','Women\u2019s shoes for swollen feet'],['Wide width','Women\u2019s shoes in wide widths']]],
    ['Collections',[['New arrivals','Show me the women\u2019s new arrivals'],['Best sellers','Show me the best-selling women\u2019s shoes'],['Jillian','Show me the Jillian collection'],['Heelium','Show me the women\u2019s Heelium collection'],['SkyTech','Show me the women\u2019s SkyTech collection'],['BioRocker','Show me the BioRocker collection'],['Water-friendly','Show me women\u2019s water-friendly shoes'],['Last chance','Show me women\u2019s shoes on sale']]]
  ];
}
var FOCUS_FIT_QUIZ=/orthotic|insole|\barch|\bfit\b/i;
var FOCUS_QUIZ_ICON='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/><path d="M8.5 11h5M11 8.5v5"/></svg>';
/* Each place's picture (the extension's own: a foot with the sore spot
   glowing red), in a small round coin on the chip. */
var FOCUS_PAIN_IMG=(C.focusPainImages&&typeof C.focusPainImages==='object')?C.focusPainImages:{};
function focusZone(kind){
  var u=safeUrl(FOCUS_PAIN_IMG[kind]||'');
  return u?'<span class="ai-chat-focus__coin"><img src="'+u+'" alt="" width="38" height="38" decoding="async"></span>':'';
}
/* The cards' pictures: the two lines' from Settings → Focus home, Foot
   pain's the heel picture above; line drawings without. */
var FOCUS_PICS_KEY='hajirai_focus_pics',FOCUS_PICS={pain:'',footwear:'',orthotics:''};
try{var _fpics=JSON.parse(localStorage.getItem(FOCUS_PICS_KEY)||'null');if(_fpics&&typeof _fpics==='object')FOCUS_PICS={pain:safeUrl(_fpics.pain),footwear:safeUrl(_fpics.footwear),orthotics:safeUrl(_fpics.orthotics)}}catch(e){}
/* The store's picture for the card (Settings → Focus home); Foot pain falls back to the heel picture built in. */
function focusPicOf(kind){return FOCUS_PICS[kind]||(kind==='pain'?safeUrl(FOCUS_PAIN_IMG.heel||''):'')}
function focusLineIcon(kind,size){
  var pic=focusPicOf(kind);
  return pic?'<img src="'+pic+'" alt="" decoding="async">':(kind==='footwear'?WI.shoe:kind==='pain'?WI.foot:WI.insole).replace(/(width|height)="\d+"/g,'$1="'+size+'"');
}
function focusRefreshPics(){
  var boxes=panel.querySelectorAll('.ai-chat-focus__card-ico[data-kind]');
  for(var i=0;i<boxes.length;i++){var k=boxes[i].getAttribute('data-kind');boxes[i].innerHTML=focusLineIcon(k,boxes[i].getAttribute('data-size')||30);boxes[i].classList.toggle('has-pic',!!focusPicOf(k))}
}
function focusIcoBox(kind,size){return '<span class="ai-chat-focus__card-ico'+(focusPicOf(kind)?' has-pic':'')+'" data-kind="'+kind+'" data-size="'+size+'">'+focusLineIcon(kind,size)+'</span>'}
function focusFtKey(kind){return kind==='pain'?'homePain':kind==='footwear'?'homeFootwear':'homeOrthotics'}
function focusCardWords(kind){var k=focusFtKey(kind);return [esc(FT[k+'Eyebrow']),esc(FT[k+'Title'])]}
/* One line under each card's name on what it does. */
function focusCardSub(kind){return esc(FT[focusFtKey(kind)+'Sub'])}
/* The small call to action in each card's corner. */
function focusCardCta(kind){return esc(FT[focusFtKey(kind)+'Cta'])}
var FOCUS_CHEV='<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
/* Words on the left, the picture filling the right side, the call to action under the words. */
/* The Foot pain card's title on a computer, where the card is the wide one
   in the middle of the row (the short one on phones, and in its sheet). */
function focusCardHtml(kind){
  var w=focusCardWords(kind),title=kind==='pain'?'<span class="is-short">'+w[1]+'</span><span class="is-long">'+esc(FT.homePainTitleWide)+'</span>':w[1];
  return '<button type="button" class="ai-chat-focus__card ai-chat-focus__card--'+kind+'" data-focus-sheet="'+kind+'" aria-haspopup="dialog"><span class="ai-chat-focus__card-text"><span class="ai-chat-focus__card-eyebrow">'+w[0]+'</span><span class="ai-chat-focus__card-title">'+title+'</span><span class="ai-chat-focus__card-sub">'+focusCardSub(kind)+'</span><span class="ai-chat-focus__card-cta"><span>'+focusCardCta(kind)+FOCUS_CHEV+'</span></span></span>'+focusIcoBox(kind,30)+'</button>';
}
/* The three links above the message box: what each says, what it sends. */
/* The pills above the box, all alike: My rewards and Returns & exchanges
   (instant cards, no AI), then the store's own links (Settings) — minus a
   returns one when the card stands in for it. */
function focusLinksHtml(){var h='';if(REWARDS)h+='<button type="button" data-rewards-open="1">My rewards</button>';if(RETURNS)h+='<button type="button" data-returns-open="1">Returns &amp; exchanges</button>';for(var i=1;i<=3;i++){var l=FT['homeLink'+i+'Label'],m=FT['homeLink'+i+'Message'];if(l&&m&&!(RETURNS&&/return|exchange/i.test(l))&&!(DEALS&&/deal|sale|promo|offer/i.test(l)))h+='<button type="button" data-message="'+esc(m)+'">'+esc(l)+'</button>'}if(DEALS)h+='<button type="button" data-deals-open="1">'+esc(DEALS.label||'Deals')+'</button>';return h}
function buildFocusHome(){
  var pk=peakBlocks(),banner=!pk.length&&!!(SHOWBAN&&BANNER&&safeUrl(BANNER));
  var h='<div class="ai-chat-welcome ai-chat-welcome--focus'+(banner?' has-banner':'')+(pk.length?' has-peak':'')+'">';
  h+='<div class="ai-chat-focus__greet"></div>';
  if(pk.length)h+=peakTilesHtml(pk);
  else if(banner)h+='<div class="ai-chat-welcome__banner"><img src="'+safeUrl(BANNER)+'" alt=""></div>';
  h+='<div class="ai-chat-focus__cards">'+focusCardHtml('pain')+focusCardHtml('footwear')+focusCardHtml('orthotics')+'</div>';
  h+='<div class="ai-chat-focus__links">'+focusLinksHtml()+'</div>';
  h+='</div>';
  msgsEl.innerHTML=h;
  msgsEl.classList.add('is-welcome');
  panel.classList.add('is-home');
  peakVideosWatch();
  focusMeasure();
  focusGreetRender();
  focusGreetStart();
  focusLineToRing();
}
/* The greeting ("How can I help you today?") at the top of the home, under
   the name, beside the face — sliding through its languages while the
   shopper is at home, the same frames and the same Settings switch as the
   classic home. It scrolls away with the page and leaves with the home. */
var focusGreetGen=0,focusGreetIdx=0;
function focusGreetFrames(){return GREET_CTA_FRAMES&&GREET_CTA_FRAMES.length?GREET_CTA_FRAMES:[{text:GREETCTA,dir:'ltr',code:'en'}]}
function focusGreetItem(f,cls){return '<span class="ai-chat-greet__item '+cls+'" dir="'+esc(f.dir||'ltr')+'" lang="'+esc(f.code||'en')+'">'+esc(f.text)+'</span>'}
function focusGreetRender(){
  var el=$('.ai-chat-focus__greet',panel);if(!el)return;
  var f=focusGreetFrames()[0];
  if(!f||!f.text){el.innerHTML='';return}
  var cur=$('.ai-chat-greet__item.is-in',el);
  if(cur&&cur.textContent===f.text)return;
  focusGreetIdx=0;
  el.innerHTML='<span class="ai-chat-greet">'+focusGreetItem(f,'is-in')+'</span>';
}
function focusGreetShow(i){
  var box=$('.ai-chat-focus__greet .ai-chat-greet',panel);if(!box)return;
  var frames=focusGreetFrames(),f=frames[i%frames.length];if(!f)return;
  var old=$('.ai-chat-greet__item.is-in',box);
  if(old&&old.textContent===f.text)return;
  focusGreetIdx=i%frames.length;
  box.insertAdjacentHTML('beforeend',focusGreetItem(f,'is-below'));
  var nu=box.lastElementChild;
  void nu.offsetWidth;
  nu.classList.remove('is-below');nu.classList.add('is-in');
  if(old){old.classList.remove('is-in');old.classList.add('is-above');setTimeout(function(){if(old.parentNode)old.remove()},480)}
}
function focusGreetStart(){
  var gen=++focusGreetGen;
  focusGreetShow(focusGreetIdx);
  var tick=function(){
    if(gen!==focusGreetGen)return;
    if(!panel.classList.contains('is-home')){return}
    var frames=focusGreetFrames();
    if(!isOpen||!FOCUS_ROTATE||!GREET_CTA_ROTATE||frames.length<2){setTimeout(tick,1500);return}
    focusGreetShow(focusGreetIdx+1);
    setTimeout(tick,focusGreetIdx===0?7000:3200);
  };
  setTimeout(tick,7000);
}
/* The chat opened at home: the greeting starts over in the store's own words. */
function focusGreetReset(){
  if(!panel.classList.contains('is-home'))return;
  focusGreetIdx=0;
  var el=$('.ai-chat-focus__greet',panel),cur=el&&$('.ai-chat-greet__item.is-in',el),f=focusGreetFrames()[0];
  if(el&&f&&f.text&&!(cur&&cur.textContent===f.text))el.innerHTML='<span class="ai-chat-greet">'+focusGreetItem(f,'is-in')+'</span>';
  focusGreetStart();
}
/* The header's words (Focus): at home, the store's greeting — its signed-in
   one, with the shopper's name, for a known shopper — where the name was;
   once a chat starts, the assistant's name. Both sit in the name's box, so
   the header keeps its height; the CSS trades them with the name's slide
   to the left (is-chatting), and only the one showing is read out. The
   classic header keeps the plain name. */
function focusHomeTitle(){return welcomeGreetingText()||NAME}
function focusTitleBuild(){
  var hn=$('.ai-chat-header__name',panel);if(!hn)return;
  hn.innerHTML='<span class="ai-chat-header__title ai-chat-header__title--chat">'+esc(NAME)+'</span><span class="ai-chat-header__title ai-chat-header__title--home">'+esc(focusHomeTitle())+'</span>';
  focusTitleSync();
}
function focusTitleSync(){
  var chat=panel.classList.contains('is-chatting'),c=$('.ai-chat-header__title--chat',panel),h=$('.ai-chat-header__title--home',panel);
  if(c)c.setAttribute('aria-hidden',chat?'false':'true');
  if(h)h.setAttribute('aria-hidden',chat?'true':'false');
}
function focusChatClass(on){panel.classList.toggle('is-chatting',!!on);focusTitleSync()}
/* The store's survey (Settings → Feedback button) in the Focus layout: the
   ⋮ menu's feedback line, opening inside the chat. One that reads as an
   orthotic quiz instead (the quiz kept in that setting) is a row in the
   Orthotics sheet. Nothing of it on the home. */
function fbOrthotic(){return FB_ICON==='orthotic'||/orthotic|insole|\bfit\b/i.test(FB_LABEL)}
/* The sheet for one product line. Its helper rows are the chat's own
   (the same True Fit and FITFinder rows as the classic home). */
var focusSheetEl=null,focusSheetOpener=null,focusSheetShut=0,focusPick={footwear:{a:-1,b:[]},orthotics:{a:-1,b:[]}};
function focusPickClear(kind){focusPick[kind]={a:-1,b:[]}}
function focusHelperRow(attrs,icon,title,sub,cls){return '<button type="button" class="ai-chat-helper'+(cls?' '+cls:'')+'" '+attrs+'><span class="ai-chat-helper__icon">'+icon+'</span><span class="ai-chat-helper__text"><span class="ai-chat-helper__title">'+esc(title)+'</span><span class="ai-chat-helper__sub">'+esc(sub)+'</span></span><span class="ai-chat-helper__go">'+WI.arrow+'</span></button>'}
function focusSheetRows(kind){
  var rows='';
  if(kind==='footwear'&&tfPayload()){
    /* The same words as the classic home's True Fit row. */
    var onShoe=tfHere()&&pageHandle(),size=onShoe?tfSizeHere():'';
    if(size)rows+=focusHelperRow('data-helper="truefit"',tfLogo(24),'Size '+size,'Your True Fit size');
    else if(onShoe)rows+=focusHelperRow('data-helper="truefit"',tfLogo(24),'Find my size','True Fit · for this shoe');
    else rows+=focusHelperRow('data-helper="truefit"',tfLogo(24),'Find my shoe size','True Fit · pick a shoe, get its size');
  }
  /* The seasonal button (Settings → Seasonal button), as a row like the
     classic home's tile: its words, the season's icon on its tint; a tap
     sends its words marked as the seasonal button, so the chat shows its
     collection. */
  if(kind==='footwear'&&SEA_ON)rows+=focusHelperRow('data-message="'+esc(SEA_LABEL)+'" data-seasonal="1"',SEASON_ICONS[SEA_ICON]||SEASON_ICONS.fall,SEA_LABEL,'This season\u2019s picks','ai-chat-helper--season'+(SEA_COLOR!=='plain'?' sea-'+SEA_COLOR:''));
  if(kind==='orthotics'){
    if(ff){
      var mine=savedFit();
      if(mine)rows+=focusHelperRow('data-helper="fitfinder"','<span class="ai-chat-helper__mono is-letter">'+esc(fitLetter(mine))+'</span>',mine.name||fitTitle(mine),'Your '+fitTitle(mine));
      else rows+=focusHelperRow('data-helper="fitfinder"','<span class="ai-chat-helper__mono">FIT</span>','Find my orthotic FIT',ff.questions&&ff.questions.length?'FITFinder · '+ff.questions.length+' quick question'+(ff.questions.length===1?'':'s'):'with FITFinder');
    }
    /* The "which orthotic do I have?" quiz (Settings → Which orthotic do I
       have?; or the survey setting when that holds it), once — a Popular
       button opening the same form folds into it. */
    var seen={};
    if(fbShown()&&fbOrthotic()){rows+=focusHelperRow('data-survey="1" aria-haspopup="dialog"',fbIcon(),FB_LABEL,'A quick visual quiz, right here');seen[FB_FORM]=1}
    if(WO_FORM&&!seen[WO_FORM]){rows+=focusHelperRow('data-form="'+esc(WO_FORM)+'" data-form-label="'+esc(WO_LABEL)+'" aria-haspopup="dialog"',WI.insole,WO_LABEL,'A quick visual quiz, right here');seen[WO_FORM]=1}
    var qps=[[QP1L,QP1M],[QP2L,QP2M],[QP3L,QP3M],[QP4L,QP4M]];
    /* Only the Popular buttons that are about orthotics (an orthotic, insole,
       arch or FIT quiz) — never the feedback survey or another form. */
    for(var i=0;i<qps.length;i++){var f=formIdOf(qps[i][1]);if(qps[i][0]&&f&&!seen[f]&&f!==FB_FORM&&FOCUS_FIT_QUIZ.test(qps[i][0])){seen[f]=1;rows+=focusHelperRow('data-form="'+esc(f)+'" data-form-label="'+esc(qps[i][0])+'" aria-haspopup="dialog"',FOCUS_QUIZ_ICON,qps[i][0],'A quick visual quiz, right here')}}
  }
  return rows;
}
/* The helper rows in one box: side by side where the sheet is wide enough
   for two, stacked on a phone (CSS). */
function focusHelpersHtml(kind){var rows=focusSheetRows(kind);return rows?'<div class="ai-chat-focus__helpers">'+rows+'</div>':''}
function focusSegHtml(cls,items,on,attr){
  var h='<div class="ai-chat-focus__seg'+(cls?' '+cls:'')+'" role="tablist" style="--seg-n:'+items.length+';--seg-i:'+on+'"><span class="ai-chat-focus__seg-thumb" aria-hidden="true"></span>';
  for(var i=0;i<items.length;i++)h+='<button type="button" role="tab" aria-selected="'+(i===on?'true':'false')+'" '+attr(i)+(i===on?' class="is-on"':'')+'>'+esc(items[i])+'</button>';
  return h+'</div>';
}
/* The chips of a section: a tap sends the chip's words — the arrow says so. */
function focusChipsHtml(chips){
  var h='';for(var j=0;j<chips.length;j++)h+='<button type="button" data-message="'+esc(chips[j][1])+'"><span>'+esc(chips[j][0])+'</span><span class="ai-chat-focus__chip-go" aria-hidden="true">'+WI.arrow+'</span></button>';
  return h;
}
/* ── Pick & go ──
   Two rows of chips — footwear: the kind of shoe and the condition;
   orthotics: the activity and the condition — one pick each, either or
   both, and a Go button that says the sentence the picks make and sends
   it. The groups left over (Collections; men's Occasion) stay as sections
   of chips that send on a tap. */
/* Settings → Focus home → Collections: the one-tap section can be switched off. */
var FOCUS_COLLECTIONS=C.focusCollections!==false;
function focusPickParts(kind,g){
  var groups=focusBrowseGroups(kind,g),names=kind==='orthotics'?['Activity','Condition']:['Shoes','Condition'],by={},rest=[];
  for(var i=0;i<groups.length;i++){if(names.indexOf(groups[i][0])>=0)by[groups[i][0]]=groups[i][1];else if(FOCUS_COLLECTIONS||groups[i][0]!=='Collections')rest.push(groups[i])}
  return {a:by[names[0]]||[],b:by[names[1]]||[],keys:kind==='orthotics'?['Activity','For']:['Shoe','For'],rest:rest};
}
/* The sentence the picks make — what the Ask box says, and sends. Each
   chip's own words give the part it adds ("Show me women’s sneakers" →
   sneakers; "Women’s shoes for bunions" → bunions; "Women’s shoes in
   wide widths" → in wide widths). The second row may hold several: they
   read as a list ("for plantar fasciitis and bunions"), anything that isn't
   a "for" after it. */
function focusListJoin(a){return a.length<2?a.join(''):a.slice(0,-1).join(', ')+' and '+a[a.length-1]}
function focusPickSentence(kind,g,a,bs){
  var p=focusPickParts(kind,g),ca=a>=0?p.a[a]:null,G=focusGenderWord(g),cbs=[],i;
  for(i=0;i<(bs||[]).length;i++)if(p.b[bs[i]])cbs.push(p.b[bs[i]]);
  if(!ca&&!cbs.length)return '';
  if(kind==='orthotics'){
    var act=ca?ca[1].replace(/^\S+\s+orthotics\s+/,''):'',conds=[];
    for(i=0;i<cbs.length;i++)conds.push(cbs[i][1].replace(/^\S+\s+orthotics\s+for\s+/,''));
    var cond=focusListJoin(conds);
    return 'Show me '+G+' orthotics '+(ca&&cond?act+' with '+cond:ca?act:'for '+cond);
  }
  var noun=ca?ca[1].replace(/^Show me \S+\s+/,''):'shoes',fors=[],more=[];
  for(i=0;i<cbs.length;i++){var ph=cbs[i][1].replace(/^\S+\s+shoes\s+/,'');if(/^for\s/.test(ph))fors.push(ph.replace(/^for\s+/,''));else more.push(ph)}
  return 'Show me '+G+' '+noun+(fors.length?' for '+focusListJoin(fors):'')+(more.length?' '+more.join(' '):'');
}
/* The Ask box's placeholder, until the picks (or the shopper) fill it. */
function focusPickHint(){return 'Pick above, or type here'}
/* "Ask Ava" — the assistant's first name when it has one. */
var ASK_WORDS=/^\S+$/.test(NAME)?'Ask '+NAME:'Ask';
/* A row of the card: its key, with how many to pick under it in small
   type, and its chips (one pressed in the first row; any number in the
   second). */
function focusPickRow(key,hint,chips,which,on){
  var h='<div class="ai-chat-focus__pick-row" role="group" aria-label="'+esc(key+' — '+hint)+'"><span class="ai-chat-focus__pick-key" aria-hidden="true"><b>'+esc(key)+'</b><small>'+esc(hint)+'</small></span><div class="ai-chat-focus__pick-chips">';
  for(var j=0;j<chips.length;j++){var pressed=Array.isArray(on)?on.indexOf(j)>=0:j===on;h+='<button type="button" class="ai-chat-focus__pick-chip" data-pick-'+which+'="'+j+'" aria-pressed="'+(pressed?'true':'false')+'"><i class="ai-chat-focus__pick-dot" aria-hidden="true">'+WI.check+'</i><span>'+esc(chips[j][0])+'</span></button>'}
  return h+'</div></div>';
}
function focusBrowseHtml(kind){
  var g=focusGender,p=focusPickParts(kind,g),st=focusPick[kind]||{a:-1,b:[]},t=focusPickSentence(kind,g,st.a,st.b);
  /* The one-tap sections (Collections; men's Occasion) first, by the
     helper rows — then Pick & go last, so it never reads as a step after
     them. */
  var h='';
  for(var i=0;i<p.rest.length;i++)h+='<div class="ai-chat-focus__label">'+esc(p.rest[i][0])+'</div><div class="ai-chat-focus__chips">'+focusChipsHtml(p.rest[i][1])+'</div>';
  h+='<div class="ai-chat-focus__label">Pick &amp; go</div><div class="ai-chat-focus__pick">'+focusPickRow(p.keys[0],'choose one',p.a,'a',st.a)+focusPickRow(p.keys[1],'one or more',p.b,'b',st.b);
  /* The Ask box closes the Pick & go card — it belongs to those picks
     only — and stays in view while the card is: the question the picks
     make, as the message it will be (edit it, or type your own; their
     own words let the picks go), and the Ask button. Enter sends too. */
  h+='<div class="ai-chat-focus__ask"><div class="ai-chat-focus__ask-box"><input type="text" class="ai-chat-focus__ask-q" data-pick-q value="'+esc(t)+'" placeholder="'+esc(focusPickHint(kind))+'" autocomplete="off" autocapitalize="sentences" spellcheck="false" enterkeyhint="send" aria-label="Your question"><button type="button" class="ai-chat-focus__ask-cta" data-pick-go'+(t?'':' disabled')+'>'+esc(ASK_WORDS)+WI.arrow+'</button></div></div></div>';
  return h;
}
/* A tap on a chip picks it (a second tap clears it): one in the first row,
   any number in the second. The Ask box follows; then the next thing to do
   comes into view — after a pick in the first row, the second row (scrolled
   to, clear of the bar) — and the Ask button gives a small nudge whenever
   the question changes, so it's seen. */
function focusPickTap(sh,kind,which,j){
  var st=focusPick[kind]||(focusPick[kind]={a:-1,b:[]}),chips=sh.querySelectorAll('[data-pick-'+which+']'),i;
  if(which==='a'){st.a=st.a===j?-1:j;for(i=0;i<chips.length;i++)chips[i].setAttribute('aria-pressed',i===st.a?'true':'false')}
  else{var at=st.b.indexOf(j);if(at>=0)st.b.splice(at,1);else{st.b.push(j);st.b.sort(function(x,y){return x-y})}for(i=0;i<chips.length;i++)chips[i].setAttribute('aria-pressed',st.b.indexOf(i)>=0?'true':'false')}
  focusPickSay(sh,kind);
  if(which==='a'&&st.a>=0&&chips[0]){var row=chips[0].closest('.ai-chat-focus__pick-row'),next=row&&row.nextElementSibling;if(next&&next.scrollIntoView)next.scrollIntoView({block:'nearest',behavior:focusMotionOk()?'smooth':'auto'})}
}
/* Writes the picks' sentence into the Ask box and sets its button by it. */
function focusPickSay(sh,kind){
  var st=focusPick[kind]||{a:-1,b:[]},t=focusPickSentence(kind,focusGender,st.a,st.b),q=$('[data-pick-q]',sh),go=$('[data-pick-go]',sh);
  if(q)q.value=t;
  if(go)go.disabled=!t;
  if(t)focusPickNudge(sh);
}
function focusPickNudge(sh){var bar=$('.ai-chat-focus__ask',sh);if(!bar||!focusMotionOk())return;bar.classList.remove('is-nudge');void bar.offsetWidth;bar.classList.add('is-nudge')}
/* The shopper's own words in the box: the picks let go, since the box no
   longer says what they say. The button follows the box. */
function focusPickTyped(sh,q){
  var kind=sh.getAttribute('data-kind')||'footwear',st=focusPick[kind]||{a:-1,b:[]};
  if((st.a>=0||st.b.length)&&q.value!==focusPickSentence(kind,focusGender,st.a,st.b)){
    focusPickClear(kind);
    var ch=sh.querySelectorAll('[data-pick-a],[data-pick-b]');for(var i=0;i<ch.length;i++)ch[i].setAttribute('aria-pressed','false');
  }
  var go=$('[data-pick-go]',sh);if(go)go.disabled=!q.value.trim();
}
/* Sends what the box says. */
function focusPickGo(sh){
  var q=$('[data-pick-q]',sh),t=q?q.value.trim():'';if(!t)return;
  SEA_TAP='';closeFocusSheet(true);focusSend(t);
}
/* Moves a tab strip's thumb and its pressed tab. */
function focusSegPick(seg,i){
  if(!seg)return;seg.style.setProperty('--seg-i',i);
  var tabs=seg.querySelectorAll('[role="tab"]');
  for(var k=0;k<tabs.length;k++){tabs[k].classList.toggle('is-on',k===i);tabs[k].setAttribute('aria-selected',k===i?'true':'false')}
}
/* Swaps what a box shows with a short fade — out, new content, in. */
function focusSwap(box,fill){
  if(!box)return;
  if(!focusMotionOk()){fill();return}
  box.classList.add('is-swapping');
  setTimeout(function(){fill();void box.offsetWidth;box.classList.remove('is-swapping')},140);
}
/* Women's or men's: the choice is kept for both sheets and across visits;
   the all-button and Browse by follow it. */
function focusSetGender(sh,g){
  if(g!==focusGender){focusGender=g;try{localStorage.setItem(FOCUS_GENDER_KEY,g)}catch(e){}}
  var kind=sh.getAttribute('data-kind')||'footwear';
  focusSegPick($('.ai-chat-focus__gender',sh),g==='men'?1:0);
  if(kind==='pain'){focusPainGenderChanged();focusPainRender(sh,0);return}
  var box=$('.ai-chat-focus__browse',sh);
  focusPickClear(kind);
  focusSwap(box,function(){box.innerHTML=focusBrowseHtml(kind)});
}
/* ── The Foot pain flow ──
   One question a step, each answer a tile: where it hurts (several), then
   footwear or orthotics, then what that needs — footwear: the kind of shoe
   and the width; orthotics: the shoes it goes in, the arch, pain under the
   ball of the foot (the four things the orthotic finder asks for; a saved
   FIT answers the last two). A summary lets any line be changed, and one
   button sends it all to Ava as the shopper's own words. Answers are kept
   while the page is open, so the sheet reopens where they left it. */
var focusPain={where:[],what:'',kind:'',width:'',shoes:'',arch:'',ball:''},focusPainStep=0,focusPainBusy=false,focusPainTrail=[];
function focusPainSteps(){
  var s=['where','what'];
  if(focusPain.what==='footwear')s.push('kind','width');
  else if(focusPain.what==='orthotics'){s.push('shoes');if(!savedFit()){s.push('arch');if(focusPain.where.indexOf('ball')<0)s.push('ball')}}
  s.push('done');return s;
}
function focusPainOpts(step){
  if(step==='where')return FOCUS_WHERE;if(step==='what')return FOCUS_WHAT;if(step==='kind')return focusKinds(focusGender);
  if(step==='width')return FOCUS_WIDTH;if(step==='shoes')return FOCUS_SHOES;if(step==='arch')return FOCUS_ARCH;if(step==='ball')return FOCUS_BALL;return [];
}
function focusPainAsk(step){
  if(step==='where')return [FOCUS_TITLE,FOCUS_HINT];
  if(step==='what')return ['What should I look for?',''];
  if(step==='kind')return ['What kind of shoes?',''];
  if(step==='width')return ['How should they fit?','Aetrex makes many styles in wide widths.'];
  if(step==='shoes')return ['Which shoes will they go in?','Each line is shaped for certain shoes.'];
  if(step==='arch')return ['What’s your arch like?','Not sure? A wet footprint that shows the whole sole means flat or low.'];
  if(step==='ball')return ['Any pain under the ball of your foot?','Just behind the toes — it decides whether you need a metatarsal pad.'];
  return ['Here’s what I’ll tell Ava','Tap a line to change it.'];
}
function focusPainLabel(step,id){var o=focusPainOpts(step);for(var i=0;i<o.length;i++)if(o[i][0]===id)return o[i][1];return ''}
function focusPainWord(step,id){var o=focusPainOpts(step);for(var i=0;i<o.length;i++)if(o[i][0]===id)return o[i][o[i].length-1];return ''}
function focusPainWhereLabels(){var l=[];for(var i=0;i<FOCUS_WHERE.length;i++)if(focusPain.where.indexOf(FOCUS_WHERE[i][0])>=0)l.push(FOCUS_WHERE[i][1]);return l}
/* "heel pain (plantar fasciitis) and arch pain" */
function focusPainWords(){
  var w=[];for(var i=0;i<FOCUS_WHERE.length;i++){var o=FOCUS_WHERE[i];if(o[3]&&focusPain.where.indexOf(o[0])>=0)w.push(o[3])}
  return w.length<=1?w.join(''):w.slice(0,-1).join(', ')+' and '+w[w.length-1];
}
/* The message, in the shopper's own voice, with everything Ava needs. */
function focusPainMessage(){
  var G=focusGenderWord(focusGender),pains=focusPainWords(),fit=savedFit();
  if(focusPain.what==='footwear'){
    var wd=focusPain.width==='wide'?', in a wide width':focusPain.width==='narrow'?', in a narrow width':'';
    return 'I’m looking for '+G+' '+(focusPainWord('kind',focusPain.kind)||'shoes')+(pains?' for '+pains:' for everyday comfort and support')+wd+'. What would you recommend?';
  }
  if(focusPain.what==='orthotics'){
    var s=['I’m looking for '+G+' orthotics for '+(focusPainWord('shoes',focusPain.shoes)||'my everyday shoes')+'.'];
    s.push(pains?'I have '+pains+'.':'No particular pain — I want comfort and support.');
    if(fit)s.push('My FIT is '+fitLetter(fit)+'.');
    else{
      s.push(focusPain.arch==='flat_low'?'My arches are flat or low and my feet roll inward.':focusPain.arch==='medium_high'?'I have medium to high arches.':'I’m not sure of my arch type.');
      if(focusPain.where.indexOf('ball')<0)s.push(focusPain.ball==='yes'?'I also have pain under the ball of my foot.':'No pain in the front of my foot.');
    }
    s.push('Which one would you recommend?');
    return s.join(' ');
  }
  return pains?'I have '+pains+'. I’m open to '+G+' footwear or orthotics — what would help most?':'I’m after everyday comfort and support. Would '+G+' footwear or orthotics help most?';
}
/* The picks so far, for the line under the tiles: "Heel, Arch · Orthotics · Running shoes". */
function focusPainPicks(upto){
  var steps=focusPainSteps(),out=[];
  for(var i=0;i<steps.length&&i<upto;i++){
    var st=steps[i];
    if(st==='where'){var w=focusPainWhereLabels();if(w.length)out.push(w.join(', '))}
    else if(st!=='done'&&focusPain[st])out.push(focusPainLabel(st,focusPain[st]));
  }
  return out.join(' · ');
}
function focusPainOptHtml(step,o,multi){
  var on=step==='where'?focusPain.where.indexOf(o[0])>=0:focusPain[step]===o[0];
  var pic=step==='where'?focusZone(o[0]):'',ico=step==='what'?'<span class="ai-chat-focus__opt-ico">'+(o[0]==='footwear'?WI.shoe:o[0]==='orthotics'?WI.insole:WI.spark)+'</span>':'';
  return '<button type="button" class="ai-chat-focus__opt'+(on?' is-on':'')+(pic||ico?'':' is-plain')+'" data-pain-opt="'+esc(o[0])+'" role="'+(multi?'checkbox':'radio')+'" aria-checked="'+(on?'true':'false')+'">'+pic+ico+'<span class="ai-chat-focus__opt-text"><span class="ai-chat-focus__opt-title">'+esc(o[1])+'</span>'+(o[2]?'<span class="ai-chat-focus__opt-sub">'+esc(o[2])+'</span>':'')+'</span><span class="ai-chat-focus__opt-check" aria-hidden="true">'+WI.check+'</span></button>';
}
function focusPainRow(step,k,v,edit){return '<button type="button" class="ai-chat-focus__sum-row" '+(edit?'data-pain-edit="'+step+'"':'disabled')+'><span class="ai-chat-focus__sum-k">'+esc(k)+'</span><span class="ai-chat-focus__sum-v">'+esc(v)+'</span>'+(edit?'<span class="ai-chat-focus__sum-go">'+WI.arrow+'</span>':'')+'</button>'}
function focusPainStepHtml(){
  var steps=focusPainSteps(),i=Math.min(focusPainStep,steps.length-1),step=steps[i],ask=focusPainAsk(step),multi=step==='where';
  /* Four stages whatever the path — where, what, the details, the summary —
     so the bar never grows; the details stage fills a question at a time. */
  var det=steps.filter(function(x){return x!=='where'&&x!=='what'&&x!=='done'}),di=det.indexOf(step),stage=step==='where'?0:step==='what'?1:step==='done'?3:2;
  var fill=stage>2?1:stage<2?0:det.length?(di+1)/det.length:1;
  var h='<div class="ai-chat-focus__dots" aria-hidden="true">';
  for(var d=0;d<4;d++){var cls=d<stage||(d===stage&&d!==2)||(d===2&&fill>=1&&stage>=2)?' class="is-done"':d===2&&stage===2?' class="is-part" style="--fill:'+fill.toFixed(2)+'"':'';h+='<i'+cls+'></i>'}
  h+='</div>';
  h+='<div class="ai-chat-focus__q-head"><h3 class="ai-chat-focus__q-title" tabindex="-1">'+esc(ask[0])+'</h3>'+(ask[1]?'<p class="ai-chat-focus__q-hint">'+esc(ask[1])+'</p>':'')+'</div>';
  if(step==='done'){
    var fit=savedFit(),what=focusPain.what;
    h+='<div class="ai-chat-focus__sum">';
    h+=focusPainRow('where','Where it hurts',focusPainWhereLabels().join(', ')||'—',true);
    h+=focusPainRow('what','Looking for',what==='both'?'Footwear or orthotics':focusPainLabel('what',what),true);
    if(what==='footwear'){h+=focusPainRow('kind','Kind',focusPainLabel('kind',focusPain.kind)||'Any kind',true);h+=focusPainRow('width','Fit',focusPainLabel('width',focusPain.width)||'Not sure',true)}
    if(what==='orthotics'){
      h+=focusPainRow('shoes','Shoes',focusPainLabel('shoes',focusPain.shoes),true);
      if(fit)h+=focusPainRow('arch','Arch & ball of foot','Your '+fitTitle(fit)+' · from FITFinder',false);
      else{h+=focusPainRow('arch','Arch',focusPainLabel('arch',focusPain.arch),true);if(focusPain.where.indexOf('ball')<0)h+=focusPainRow('ball','Ball of foot',focusPainLabel('ball',focusPain.ball),true)}
    }
    h+='</div>';
    h+='<button type="button" class="ai-chat-focus__ask-btn" data-pain-nav="ask">'+WI.spark+'<span>Ask Ava for my match</span></button>';
    h+='<div class="ai-chat-focus__bar"><button type="button" class="ai-chat-focus__back" data-pain-nav="back" aria-label="Back">'+WI.arrow+'</button><span class="ai-chat-focus__picks">'+esc(focusGenderWord(focusGender).charAt(0).toUpperCase()+focusGenderWord(focusGender).slice(1))+' · switch above</span></div>';
    return h;
  }
  var opts=focusPainOpts(step);
  h+='<div class="ai-chat-focus__opts" role="'+(multi?'group':'radiogroup')+'" aria-label="'+esc(ask[0])+'">';for(var k=0;k<opts.length;k++)h+=focusPainOptHtml(step,opts[k],multi);h+='</div>';
  if(multi)h+='<button type="button" class="ai-chat-focus__else" data-pain-else>Something else…</button>';
  h+='<div class="ai-chat-focus__bar">'+(i>0?'<button type="button" class="ai-chat-focus__back" data-pain-nav="back" aria-label="Back">'+WI.arrow+'</button>':'')+'<span class="ai-chat-focus__picks">'+esc(focusPainPicks(i))+'</span>'+(multi?'<button type="button" class="ai-chat-focus__next" data-pain-nav="next"'+(focusPain.where.length?'':' disabled')+'>Continue</button>':'')+'</div>';
  return h;
}
/* The bar is a footer: while tiles go on beneath it, it shows a hairline
   and a fade over them (is-more); at the end of the list, nothing. */
function focusPainMore(sh){
  var body=$('.ai-chat-focus-sheet__body',sh),bar=$('.ai-chat-focus__bar',sh);if(!body||!bar)return;
  bar.classList.toggle('is-more',body.scrollHeight-body.clientHeight-body.scrollTop>4);
}
/* Draws the current step: forward, the old one slips left and the new one
   comes in from the right; back, the other way; no direction, a plain fade. */
function focusPainRender(sh,dir){
  var box=$('.ai-chat-focus__quiz',sh),body=$('.ai-chat-focus-sheet__body',sh);if(!box)return;
  var fill=function(){box.innerHTML=focusPainStepHtml();if(body)body.scrollTop=0;if(dir){var t=$('.ai-chat-focus__q-title',box);if(t)t.focus({preventScroll:true})}focusPainMore(sh);requestAnimationFrame(function(){focusPainMore(sh)})};
  /* The first question is there the moment the sheet opens: nothing to
     leave yet, so no beat before it. */
  if(!focusMotionOk()||!box.innerHTML){fill();focusPainBusy=false;return}
  focusPainBusy=true;
  box.style.setProperty('--q-dir',(dir>0?-10:dir<0?10:0)+'px');box.classList.add('is-leaving');
  setTimeout(function(){
    fill();box.classList.remove('is-leaving');
    box.style.setProperty('--q-dir',(dir>0?16:dir<0?-16:0)+'px');box.classList.add('is-entering');void box.offsetWidth;box.classList.remove('is-entering');
    focusPainBusy=false;
  },dir?130:100);
}
function focusPainGo(sh,to){
  var steps=focusPainSteps(),i=typeof to==='number'?focusPainStep+to:steps.indexOf(to);
  if(i<0||i>=steps.length)return;
  var dir=i>focusPainStep?1:i<focusPainStep?-1:0;focusPainStep=i;focusPainRender(sh,dir);
}
/* A tap on a tile: where it hurts toggles (No pain stands alone); any other
   step takes the answer and moves on after a beat. */
function focusPainPick(sh,id){
  if(focusPainBusy)return;
  var step=focusPainSteps()[focusPainStep];
  if(step==='where'){
    var w=focusPain.where,at=w.indexOf(id);
    if(at>=0)w.splice(at,1);else if(id==='none')focusPain.where=w=['none'];else{var n=w.indexOf('none');if(n>=0)w.splice(n,1);w.push(id)}
    var tiles=sh.querySelectorAll('[data-pain-opt]');
    for(var i=0;i<tiles.length;i++){var on=focusPain.where.indexOf(tiles[i].getAttribute('data-pain-opt'))>=0;tiles[i].classList.toggle('is-on',on);tiles[i].setAttribute('aria-checked',on?'true':'false')}
    var next=$('.ai-chat-focus__next',sh);if(next)next.disabled=!focusPain.where.length;
    return;
  }
  if(step==='done')return;
  /* A different path (footwear ↔ orthotics ↔ both) asks its own questions afresh. */
  if(step==='what'&&focusPain.what!==id){focusPain.kind='';focusPain.width='';focusPain.shoes='';focusPain.arch='';focusPain.ball=''}
  focusPain[step]=id;
  var all=sh.querySelectorAll('[data-pain-opt]');
  for(var k=0;k<all.length;k++){var hit=all[k].getAttribute('data-pain-opt')===id;all[k].classList.toggle('is-on',hit);all[k].setAttribute('aria-checked',hit?'true':'false')}
  focusPainBusy=true;
  setTimeout(function(){focusPainBusy=false;if(focusSheetEl===sh)focusPainNext(sh)},focusMotionOk()?170:0);
}
/* Answered? (where it hurts: at least one place.) */
function focusPainAnswered(step){return step==='where'?focusPain.where.length>0:!!focusPain[step]}
/* Forward: the first step after this one still waiting for an answer — so a
   change from the summary goes straight back to it — else the summary. */
function focusPainNext(sh){
  var steps=focusPainSteps(),i=focusPainStep+1;
  while(i<steps.length-1&&focusPainAnswered(steps[i]))i++;
  focusPainTrail.push(steps[focusPainStep]);
  focusPainGo(sh,steps[Math.min(i,steps.length-1)]);
}
/* A summary row: back to that step (Back returns to the summary). */
function focusPainEdit(sh,name){focusPainTrail.push(focusPainSteps()[focusPainStep]);focusPainGo(sh,name)}
/* Back walks the path the shopper came by, skipped steps and all. */
function focusPainBack(sh){
  var steps=focusPainSteps(),prev=focusPainTrail.pop();
  while(prev&&(steps.indexOf(prev)<0||prev===steps[focusPainStep]))prev=focusPainTrail.pop();
  if(prev)focusPainGo(sh,prev);else focusPainGo(sh,-1);
}
function focusPainNav(sh,a){
  if(a==='back'){focusPainBack(sh);return}
  if(a==='next'){if(focusPain.where.length)focusPainNext(sh);return}
  if(a==='ask'){var t=focusPainMessage();closeFocusSheet(true);focusSend(t)}
}
/* Women's ↔ Men's: a kind of shoe the other line doesn't list is dropped. */
function focusPainGenderChanged(){
  if(focusPain.kind&&!focusPainLabel('kind',focusPain.kind))focusPain.kind='';
}
function openFocusSheet(kind,opener){
  closeFocusSheet(true);
  focusSheetOpener=opener||null;
  var pain=kind==='pain',w=focusCardWords(kind);
  if(!pain)focusPickClear(kind);
  var sh=el('div','ai-chat-focus-sheet');sh.setAttribute('data-kind',kind);
  sh.innerHTML='<div class="ai-chat-focus-sheet__back" data-focus-close></div><div class="ai-chat-focus-sheet__panel" role="dialog" aria-modal="true" aria-label="'+w[1]+'"><div class="ai-chat-focus-sheet__top"><span class="ai-chat-focus-sheet__grip" aria-hidden="true"></span><div class="ai-chat-focus-sheet__head"><div class="ai-chat-focus-sheet__titles"><div class="ai-chat-focus-sheet__eyebrow">'+w[0]+'</div><div class="ai-chat-focus-sheet__title">'+w[1]+'</div></div>'+focusSegHtml('ai-chat-focus__gender',['Women\u2019s','Men\u2019s'],focusGender==='men'?1:0,function(i){return 'data-gender="'+(i?'men':'women')+'"'})+'<button type="button" class="ai-chat-focus-sheet__close" data-focus-close aria-label="Close">'+CMP_X+'</button></div></div><div class="ai-chat-focus-sheet__body">'+(pain?'<div class="ai-chat-focus__quiz"></div>':focusHelpersHtml(kind)+'<div class="ai-chat-focus__browse ai-chat-focus__swap">'+focusBrowseHtml(kind)+'</div>')+'</div></div>';
  panel.appendChild(sh);focusSheetEl=sh;
  sh.addEventListener('animationend',function(e){var bar=e.target&&e.target.closest&&e.target.closest('.ai-chat-focus__ask');if(bar)bar.classList.remove('is-nudge')});
  if(pain){focusPainStep=0;focusPainTrail=[];focusPainRender(sh,0);var pb=$('.ai-chat-focus-sheet__body',sh);if(pb){pb.addEventListener('scroll',function(){focusPainMore(sh)},{passive:true});window.addEventListener('resize',function(){if(focusSheetEl===sh)focusPainMore(sh)})}}
  var back=$('.ai-chat-focus-sheet__back',sh);if(back)back.addEventListener('click',function(){closeFocusSheet()});
  sh.addEventListener('click',function(e){if(e.target===sh&&focusSheetEl===sh)closeFocusSheet()});
  focusSheetSwipe(sh);
  requestAnimationFrame(function(){requestAnimationFrame(function(){sh.classList.add('is-open')})});
  var c=$('.ai-chat-focus-sheet__close',sh);if(c)c.focus({preventScroll:true});
}
/* A finger on the sheet pulls it down with it — from its head always, from
   its body only once that is scrolled to the top — and lets go: far or
   fast enough, it closes; otherwise it springs back. */
function focusSheetSwipe(sh){
  var p=$('.ai-chat-focus-sheet__panel',sh),body=$('.ai-chat-focus-sheet__body',sh);if(!p)return;
  var y0=null,dy=0,t0=0,drag=false;
  p.addEventListener('touchstart',function(e){if(e.touches.length!==1){y0=null;return}y0=e.touches[0].clientY;dy=0;t0=Date.now();drag=false},{passive:true});
  p.addEventListener('touchmove',function(e){
    if(y0===null||e.touches.length!==1)return;
    var d=e.touches[0].clientY-y0;
    if(!drag){
      var inBody=body&&body.contains(e.target);
      if(d>6&&(!inBody||body.scrollTop<=0))drag=true;
      else if(d<-6||(inBody&&body.scrollTop>0)){y0=null;return}
      else return;
    }
    dy=Math.max(0,d);
    p.style.transition='none';p.style.transform='translateY('+dy+'px)';
    e.preventDefault();
  },{passive:false});
  var end=function(){
    if(y0===null)return;
    var far=dy>90||(dy>28&&Date.now()-t0<280);y0=null;
    p.style.transition='';p.style.transform='';
    if(drag&&far&&focusSheetEl===sh)closeFocusSheet();
    drag=false;
  };
  p.addEventListener('touchend',end);p.addEventListener('touchcancel',end);
}
function closeFocusSheet(now){
  var sh=focusSheetEl;if(!sh)return;focusSheetEl=null;
  var op=focusSheetOpener;focusSheetOpener=null;
  if(now){sh.remove();return}
  sh.classList.remove('is-open');setTimeout(function(){sh.remove()},280);
  if(op&&op.isConnected)op.focus({preventScroll:true});
}
function focusSend(t){
  if(!t)return;
  inputEl.disabled=false;inputEl.placeholder=IPLACE;sendBtn.disabled=false;inputEl.value=t;BTN_SEND=true;sendMessage();
}
if(FOCUS){
  panel.addEventListener('click',function(e){
    var card=e.target.closest('[data-focus-sheet]');
    if(card){e.preventDefault();openFocusSheet(card.getAttribute('data-focus-sheet'),card);return}
    var ty=e.target.closest('[data-focus="type"]');
    if(ty){e.preventDefault();inputEl.disabled=false;inputEl.placeholder=IPLACE;inputEl.focus();return}
    var sh=focusSheetEl;if(!sh||!sh.contains(e.target))return;
    if(e.target.closest('[data-focus-close]')){e.preventDefault();closeFocusSheet();return}
    var gb=e.target.closest('[data-gender]');
    if(gb){e.preventDefault();focusSetGender(sh,gb.getAttribute('data-gender')==='men'?'men':'women');return}
    var pk=e.target.closest('[data-pick-a],[data-pick-b]');
    if(pk){e.preventDefault();var pw=pk.hasAttribute('data-pick-a')?'a':'b';focusPickTap(sh,sh.getAttribute('data-kind')||'footwear',pw,parseInt(pk.getAttribute('data-pick-'+pw),10)||0);return}
    var go=e.target.closest('[data-pick-go]');
    if(go){e.preventDefault();if(go.disabled)return;focusPickGo(sh);return}
    var hp=e.target.closest('[data-helper]');
    if(hp){e.preventDefault();closeFocusSheet(true);if(!isStreaming)startHelper(hp.getAttribute('data-helper'));return}
    var fb=e.target.closest('[data-form]');
    if(fb){e.preventDefault();var op=focusSheetOpener;closeFocusSheet(true);openForm(op,fb.getAttribute('data-form'),fb.getAttribute('data-form-label'),'quiz');return}
    var sv=e.target.closest('[data-survey]');
    if(sv){e.preventDefault();var op2=focusSheetOpener;closeFocusSheet(true);openFeedback(op2);return}
    var pe=e.target.closest('[data-pain-else]');
    if(pe){e.preventDefault();closeFocusSheet(true);inputEl.disabled=false;inputEl.placeholder=IPLACE;inputEl.focus();return}
    var po=e.target.closest('[data-pain-opt]');
    if(po){e.preventDefault();focusPainPick(sh,po.getAttribute('data-pain-opt'));return}
    var pv=e.target.closest('[data-pain-nav]');
    if(pv){e.preventDefault();focusPainNav(sh,pv.getAttribute('data-pain-nav'));return}
    var pd=e.target.closest('[data-pain-edit]');
    if(pd){e.preventDefault();focusPainEdit(sh,pd.getAttribute('data-pain-edit'));return}
    var m=e.target.closest('[data-message]');
    if(m){e.preventDefault();var t=m.getAttribute('data-message');SEA_TAP=m.hasAttribute('data-seasonal')?t:'';closeFocusSheet(true);focusSend(t)}
  });
  panel.addEventListener('keydown',function(e){
    if(!focusSheetEl)return;
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeFocusSheet();return}
    /* Enter in the Ask box sends, as in the chat's own. */
    if(e.key==='Enter'&&e.target&&e.target.hasAttribute&&e.target.hasAttribute('data-pick-q')){e.preventDefault();e.stopPropagation();focusPickGo(focusSheetEl)}
  },true);
  panel.addEventListener('input',function(e){var q=e.target;if(!focusSheetEl||!q||!q.hasAttribute||!q.hasAttribute('data-pick-q')||!focusSheetEl.contains(q))return;focusPickTyped(focusSheetEl,q)});
  /* Anywhere outside the sheet — the dimmed chat or the page itself — closes
     it, and only it: that press does not go on to close the chat as well. */
  document.addEventListener('pointerdown',function(e){var sh=focusSheetEl;if(!sh)return;var p=$('.ai-chat-focus-sheet__panel',sh);if(p&&!p.contains(e.target)){focusSheetShut=Date.now();closeFocusSheet()}},true);
}
function buildWelcome(){
if(FOCUS){buildFocusHome();return}
var pkc=peakBlocks(),hasBanner=!pkc.length&&!!(SHOWBAN&&BANNER&&safeUrl(BANNER));
var h='<div class="ai-chat-welcome'+(hasBanner?' has-banner':'')+(pkc.length?' has-peak':'')+'">';
if(pkc.length)h+=peakTilesHtml(pkc);
else if(SHOWBAN&&BANNER){
  h+='<div class="ai-chat-welcome__banner"><img src="'+safeUrl(BANNER)+'" alt=""></div>';
}
var welcomeGreeting=welcomeGreetingText();
/* The assistant's face greets the shopper here; the header shows it only
   once the chat starts (it flies up there — see flyAvatarToHeader). */
var welcomeAv=safeUrl(AVATAR)?'<img src="'+safeUrl(AVATAR)+'" alt="">':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
h+='<div class="ai-chat-welcome__intro"><div class="ai-chat-welcome__avatar-wrap" aria-hidden="true"><i class="ai-chat-avatar-glow"></i><div class="ai-chat-welcome__avatar'+(safeUrl(AVATAR)?'':' is-placeholder')+'">'+welcomeAv+'</div></div><div class="ai-chat-welcome__intro-text"><h2 class="ai-chat-welcome__title">'+esc(welcomeGreeting||('Hi, I\'m '+NAME))+'</h2>'+
   (GREETCTA?'<p class="ai-chat-welcome__greeting-cta">'+esc(GREETCTA)+'</p>':'')+'</div></div>';
h+='<div class="ai-chat-welcome__helpers" hidden></div>';
var ctas=welcomeCtas();
if(ctas.length){
  h+='<div class="ai-chat-welcome__section"><div class="ai-chat-welcome__label" data-wl="start">'+esc(START_LBL)+'</div><div class="ai-chat-welcome__ctas">'+welcomeCtasHtml(ctas);
  h+='</div></div>';
}
var qps=[];
if(QP1L&&QP1M)qps.push({l:QP1L,m:QP1M});
if(QP2L&&QP2M)qps.push({l:QP2L,m:QP2M});
if(QP3L&&QP3M)qps.push({l:QP3L,m:QP3M});
if(QP4L&&QP4M)qps.push({l:QP4L,m:QP4M});
if(qps.length){
  h+='<div class="ai-chat-welcome__section"><div class="ai-chat-welcome__label" data-wl="popular">'+esc(POP_LBL)+'</div><div class="ai-chat-welcome__quickpicks">';
  for(var j=0;j<qps.length;j++)h+=qpHtml(qps[j]);
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
peakVideosWatch();
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
    else items+=helperHtml('truefit','Find my shoe size','True Fit \u00b7 pick a shoe, get its size',tfLogo(24));
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
  /* FITFinder: the app's own flow in the chat's sheet — no turn with the
     assistant to find a FIT. (The assistant still answers a typed question.) */
  if((kind==='fitfinder'||kind==='fitfinder-retake'||kind==='refit')&&ffNative()){openFitFinder(null,kind==='fitfinder'?'':'retake');return}
  inputEl.disabled=false;inputEl.placeholder=IPLACE;sendBtn.disabled=false;
  var mine=savedFit(),size=tfHere()&&pageHandle()?tfSizeHere():'';
  if(kind==='truefit-update'){runTrueFit(pageTitle());return}
  if(kind==='truefit'){
    if(size){var shoe=pageTitle();inputEl.value='True Fit recommends size '+size+' for me'+(shoe?' in the '+shoe:'')+'.'}
    else if(tfHere()&&pageHandle()){runTrueFit(pageTitle());return}
    else{inputEl.value='Help me find my shoe size with True Fit.';TF_INTRO=inputEl.value}
  }else if(kind==='fitfinder-retake'||(kind==='refit')){
    ffRetake=true;
    inputEl.value='I\'d like to retake my orthotic FIT.';
  }else{
    inputEl.value=mine?'Show me orthotics in my '+fitTitle(mine)+'.':'Help me find my orthotic FIT.';
  }
  BTN_SEND=true;sendMessage();
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
/* Cookie-consent banners are never hidden: the shopper may need to answer
   them, and they stay on top of the chat. */
function isConsentUi(el){
  var id=(el.id||'')+' '+(typeof el.className==='string'?el.className:'');
  return /onetrust|optanon|cookiebot|CybotCookiebot|cookie|consent|shopify-pc__|cc-window|truste|didomi|usercentrics|osano|termly|iubenda/i.test(id);
}
function hideFloaters(){
  var ours=parseInt(getComputedStyle(overlay).zIndex,10)||0;
  var kids=document.body.children;
  for(var i=0;i<kids.length;i++){
    var el=kids[i];
    if(el===panel||el===overlay||el===launcher||el.contains(panel)||isConsentUi(el))continue;
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
    if(el===panel||el===overlay||el===launcher||el.contains(panel)||el.inert||isConsentUi(el)||/^(SCRIPT|STYLE|LINK|TEMPLATE|NOSCRIPT)$/.test(el.tagName))continue;
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
/* The keyboard is measured against the tallest visible height seen while
   no field was being typed in (iOS sometimes shrinks the page's own height
   too, so comparing with that alone missed the keyboard until a scroll). */
var vvFull=0,vvWidth=0;
function typingInChat(){var a=document.activeElement;return !!(a&&panel.contains(a)&&(a.tagName==='TEXTAREA'||a.tagName==='INPUT'))}
function fitToKeyboard(){
  var vv=window.visualViewport;
  if(vv&&vv.width!==vvWidth){vvWidth=vv.width;vvFull=0}/* turned the phone */
  if(vv&&!typingInChat())vvFull=Math.max(vvFull,vv.height);
  var full=Math.max(vvFull,window.innerHeight);
  var kb=!!(vv&&isOpen&&KB_MQ&&KB_MQ.matches&&full-vv.height>120);
  var was=panel.classList.contains('is-kb');
  panel.classList.toggle('is-kb',kb);
  if(kb){
    panel.style.setProperty('height',vv.height+'px','important');
    panel.style.setProperty('max-height',vv.height+'px','important');
    panel.style.setProperty('top',vv.offsetTop+'px','important');
    /* The home screen starts at its top; a conversation shows its latest. */
    if(!was){if(msgsEl&&msgsEl.classList.contains('is-welcome'))msgsEl.scrollTop=0;else scrollBottom()}
  }else{
    /* The wide View all view keeps the height it set. */
    if(!vaWide)panel.style.removeProperty('height');
    panel.style.removeProperty('max-height');panel.style.removeProperty('top');
  }
}
if(window.visualViewport){
  window.visualViewport.addEventListener('resize',fitToKeyboard);
  window.visualViewport.addEventListener('scroll',fitToKeyboard);
}
/* iOS reports the keyboard's height while it slides in, and not always once
   it has settled: look again a few times after the field gains or loses
   focus. */
function settleKeyboard(){[0,80,200,350,550,800,1100].forEach(function(ms){setTimeout(fitToKeyboard,ms)})}
panel.addEventListener('focusin',settleKeyboard);
panel.addEventListener('focusout',settleKeyboard);
/* Phones: the chat's frame (header, message bar) stays put under the
   finger. Only parts that can actually scroll — the conversation, the home
   screen on a short phone, a row of cards — move; at their ends the swipe
   stops instead of dragging the whole chat (and, with the keyboard up,
   Safari's view of the page) along. */
var touchX=0,touchY=0;
panel.addEventListener('touchstart',function(e){var t=e.touches&&e.touches[0];if(t){touchX=t.clientX;touchY=t.clientY}},{passive:true});
panel.addEventListener('touchmove',function(e){
  if(!isOpen||!KB_MQ||!KB_MQ.matches||!e.cancelable)return;
  var t=e.touches&&e.touches[0];if(!t||e.touches.length>1)return;
  var dx=t.clientX-touchX,dy=t.clientY-touchY,sideways=Math.abs(dx)>Math.abs(dy);
  for(var el=e.target;el&&el!==panel;el=el.parentElement){
    if(el.nodeType!==1)continue;
    var cs=getComputedStyle(el);
    if(sideways&&/(auto|scroll)/.test(cs.overflowX)&&el.scrollWidth>el.clientWidth+1)return;
    if(!sideways&&/(auto|scroll)/.test(cs.overflowY)&&el.scrollHeight>el.clientHeight+1){
      var atTop=el.scrollTop<=0,atEnd=el.scrollTop+el.clientHeight>=el.scrollHeight-1;
      if(!((dy>0&&atTop)||(dy<0&&atEnd)))return;
      break;
    }
  }
  e.preventDefault();
},{passive:false});
/* Phones: the open chat covers the screen, so the page behind it must not
   move. Swipes on parts of the chat that don't scroll (the home screen, the
   header) used to scroll the store page underneath. The page is pinned where
   it was and put back exactly there on close. */
var pageLock=null;
function lockPage(on){
  var html=document.documentElement,b=document.body.style;
  if(on){
    if(pageLock||!KB_MQ||!KB_MQ.matches)return;
    var y=window.pageYOffset||html.scrollTop||0;
    pageLock={y:y,pos:b.position,top:b.top,left:b.left,right:b.right,width:b.width,ov:html.style.overflow,
      bg:[html,document.body].map(function(el){return [el.style.getPropertyValue('background-color'),el.style.getPropertyPriority('background-color')]}),
      metas:Array.prototype.map.call(document.querySelectorAll('meta[name="theme-color"]'),function(m){return [m,m.getAttribute('content')]}),ownMeta:null};
    b.position='fixed';b.top=(-y)+'px';b.left='0';b.right='0';b.width='100%';html.style.overflow='hidden';
    paintPageBg();
  }else if(pageLock){
    var l=pageLock;pageLock=null;
    b.position=l.pos;b.top=l.top;b.left=l.left;b.right=l.right;b.width=l.width;html.style.overflow=l.ov;
    [html,document.body].forEach(function(el,i){var v=l.bg[i];if(v[0])el.style.setProperty('background-color',v[0],v[1]);else el.style.removeProperty('background-color')});
    l.metas.forEach(function(m){if(m[1]==null)m[0].removeAttribute('content');else m[0].setAttribute('content',m[1])});
    if(l.ownMeta&&l.ownMeta.parentNode)l.ownMeta.parentNode.removeChild(l.ownMeta);
    var sb=html.style.scrollBehavior;html.style.scrollBehavior='auto';
    window.scrollTo(0,l.y);
    html.style.scrollBehavior=sb;
  }
}
/* Phones: Safari's bar above the keyboard (address pill, form arrows) and
   its toolbars are see-through, and show the page's own background, not the
   chat. While the chat covers the screen, the page takes the chat's color
   (and Safari's theme color); both go back exactly as they were on close. */
function paintPageBg(){
  if(!pageLock)return;
  var bg=getComputedStyle(panel).backgroundColor;
  if(!bg||/rgba\(0, 0, 0, 0\)|transparent/.test(bg))return;
  document.documentElement.style.setProperty('background-color',bg,'important');
  document.body.style.setProperty('background-color',bg,'important');
  if(pageLock.metas.length)pageLock.metas.forEach(function(m){m[0].setAttribute('content',bg)});
  else{if(!pageLock.ownMeta){pageLock.ownMeta=document.createElement('meta');pageLock.ownMeta.name='theme-color';(document.head||document.documentElement).appendChild(pageLock.ownMeta)}pageLock.ownMeta.setAttribute('content',bg)}
}
function toggle(force){
var want=typeof force==='boolean'?force:!isOpen;
if(want&&HIDDEN_BY_URL)return;
isOpen=want;
if(isOpen){
  /* Left open in a tab for a day: open on the home screen too. */
  if(messages.length&&!isStreaming&&chatStale())clearChat();
  revealLauncher();
  if(FOCUS)focusGreetReset();
  focusBeforeOpen=document.activeElement;
  loadFitfinder().then(renderHelpers);
  launcher.classList.add('hidden');
  launcher.inert=true;launcher.setAttribute('aria-hidden','true');
  panel.classList.add('open');
  overlay.classList.add('visible');
  document.body.classList.add('ai-chat-blurred');
  hideFloaters();
  inertPage(true);
  lockPage(true);
  /* A chat the guard ended stays paused until its time, whatever reset the box. */
  var pz=chatPausedUntil();if(pz)pauseChat(pz);
  setTimeout(function(){inputEl.focus()},400);
  setTimeout(function(){inputEl.focus()},800);
  playWelcomeIntro();
  if(GREETCTA)startGreetCtaRotator();
  /* Back from checkout (Buy now): how did it go? */
  if(messages.length&&ratePending())maybeAskRating();
}else{
  stopGreetCtaRotator();
  fitxClose(true);
  panel.classList.remove('open');
  overlay.classList.remove('visible');
  launcher.classList.remove('hidden');placeLauncher();
  launcher.inert=false;launcher.removeAttribute('aria-hidden');
  document.body.classList.remove('ai-chat-blurred');
  restoreFloaters();
  inertPage(false);
  lockPage(false);
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
  /* Anchor on the middle of the product photo, so the arrow sits over the
     peeking card's picture — never over its name or price. Falls back to
     the card's middle until the photo has a size. */
  var firstCard=row.querySelector('.ai-chat-product-card');
  if(firstCard&&firstCard.offsetHeight){
    var photo=firstCard.querySelector('.ai-chat-product-img');
    var anchorR=photo&&photo.offsetHeight?photo.getBoundingClientRect():firstCard.getBoundingClientRect();
    var wrapR=wrap.getBoundingClientRect();
    wrap.style.setProperty('--arrow-top',((anchorR.top-wrapR.top)+anchorR.height/2)+'px');
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

/* "See It Styled": a photo frame with a spark of light at its corner (the
   frame opens where the spark sits), the spark in the mark's colors. */
function vizIcon(){return '<svg class="ai-chat-viz-icon" width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">'+
  '<defs><linearGradient id="aiVizSpark" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style="stop-color:var(--orb-c2,#33dbff)"/><stop offset=".55" style="stop-color:var(--orb-c1,#1a4dff)"/><stop offset="1" style="stop-color:var(--orb-c4,#ff4780)"/></linearGradient></defs>'+
  '<path d="M12.2 6H6.4A3.4 3.4 0 0 0 3 9.4v7.2A3.4 3.4 0 0 0 6.4 20h7.2a3.4 3.4 0 0 0 3.4-3.4v-5.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'+
  '<path d="M3.6 17.6l3.7-3.7a1.6 1.6 0 0 1 2.2 0l4.8 4.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'+
  '<circle cx="12.4" cy="11" r="1.35" fill="currentColor"/>'+
  '<path d="M18.6 1.6Q19.1 5 22.4 5.5 19.1 6 18.6 9.4 18.1 6 14.8 5.5 18.1 5 18.6 1.6Z" fill="url(#aiVizSpark)"/>'+
'</svg>';}
function vizLoadingHtml(){
  // Reuses the `.ai-chat-viz-result` shell so the loading state occupies the
  // SAME footprint as the finished image (no collapse, no layout jump). Inside:
  // the mark's colors drifting as soft light, the live orb, and one line of
  // text. Everything that moves is transform/opacity only (composited, no
  // repaint loop), and it all stops for reduced motion.
  return '<div class="ai-chat-viz-result ai-chat-viz-loading">'+
    '<div class="ai-chat-viz-loading-fill ai-chat-viz-gen">'+
      '<span class="ai-chat-viz-aura" aria-hidden="true"><i></i><i></i><i></i><i></i></span>'+
      '<span class="ai-chat-viz-gen-center"><span class="ai-chat-viz-gen-orb" aria-hidden="true"></span><span class="ai-chat-viz-step">Creating your look\u2026</span></span>'+
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
  return '<div class="ai-chat-viz-error">'+
    '<div class="ai-chat-viz-error-msg">'+esc(msg||'Could not create the preview.')+'</div>'+
    '<button class="ai-chat-viz-retry" type="button">Try again</button>'+
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
    if(card._aiVizHost)keepInView(card._aiVizHost);
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
  var head=document.createElement('div');
  head.className='ai-chat-viz-options-title';
  head.textContent='Style the look';
  var help=document.createElement('div');
  help.className='ai-chat-viz-options-help';
  help.textContent='Choose a setting';
  wrap.appendChild(head);
  wrap.appendChild(help);
  var seg=document.createElement('div');
  seg.className='ai-chat-viz-seg';
  scenes.forEach(function(s){
    var chip=document.createElement('button');
    chip.type='button';
    chip.className='ai-chat-viz-opt';
    chip.setAttribute('data-scene',s.label);
    chip.setAttribute('aria-pressed','false');
    chip.textContent=s.label;
    // Quiet, Apple-style pill — small (~32px) and fully rounded, not a CTA block.
    // Wraps cleanly. (The .ai-chat-viz-opt rule also enforces this with !important.)
    // Quiet pill, styled (and themed) by the stylesheet; selected = aria-pressed.
    chip.addEventListener('click',function(e){
      if(e){e.preventDefault();e.stopPropagation();}
      var kids=seg.children;
      for(var i=0;i<kids.length;i++)kids[i].setAttribute('aria-pressed','false');
      chip.setAttribute('aria-pressed','true');
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
  imgHost.innerHTML=vizLoadingHtml();
  var orbSpot=imgHost.querySelector('.ai-chat-viz-gen-orb');
  if(orbSpot){orbSpot.appendChild(makeGlow(56,true));if(GLOW_STILL)paintGlows(GLOW_SEED)}
  scrollBottom();
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
/* Feedback: the store's Typeform survey, inside the chat. It slides up over
   the conversation (which stays as it was underneath) and is embedded with
   Typeform's own SDK, so answers land in the same form, with the same
   settings, as the site's Feedback button. Once sent, the button gives its
   place back to Start here button 4 (and the site's button stays hidden
   for this shopper, as it does after sending it there). If the survey
   can't load here, it opens in a new tab instead.
   The same sheet opens the store's other Typeforms: a Popular button whose
   message is a Typeform link, and the assistant's quiz button ("which
   orthotic do I have?"). The sheet holds one form at a time. */
function fbDoneKey(){return 'hajirai_fb_done_'+FB_FORM}
var fbSheet=null,fbSdk=null,fbOpener=null,fbSent=false;
var sheetForm='',sheetTitle='',sheetKind='fb',sheetSubmitted=false;
/* A Typeform link in a button's message: the form's ID, else ''. Plain
   words are never taken for a form. */
function formIdOf(v){var m=String(v||'').match(/typeform\.com\/to\/([A-Za-z0-9]{4,32})(?![A-Za-z0-9])/);return m?m[1]:''}
function fbShown(){
  if(!FB_ON)return false;
  if(!FB_HIDE_AFTER)return true;
  if(fbSent)return false;
  try{return !((parseInt(localStorage.getItem(fbDoneKey()),10)||0)>Date.now())}catch(e){return true}
}
function fbUrl(){return 'https://form.typeform.com/to/'+(sheetForm||FB_FORM)+location.search}
function fbTrack(action){if(window.dataLayer)try{window.dataLayer.push({event:'typeform_cta_'+action,typeform_form_id:sheetForm||FB_FORM,typeform_source:'chat'})}catch(e){}}
function fbLoadSdk(){
  if(fbSdk)return fbSdk;
  fbSdk=new Promise(function(res,rej){
    var ready=function(){return window.tf&&typeof window.tf.createWidget==='function'};
    if(!document.querySelector('link[href*="embed.typeform.com/next/css/widget.css"]')){
      var l=document.createElement('link');l.rel='stylesheet';l.href='https://embed.typeform.com/next/css/widget.css';document.head.appendChild(l);
    }
    if(ready())return res(window.tf);
    if(!document.querySelector('script[src*="embed.typeform.com/next/embed.js"]')){
      var sc=document.createElement('script');sc.src='https://embed.typeform.com/next/embed.js';sc.async=true;document.head.appendChild(sc);
    }
    var t0=Date.now();
    (function wait(){if(ready())return res(window.tf);if(Date.now()-t0>10000)return rej(new Error('Typeform did not load'));setTimeout(wait,120)})();
  });
  fbSdk.catch(function(){fbSdk=null});
  return fbSdk;
}
function fbSheetEl(){
  if(fbSheet)return fbSheet;
  fbSheet=el('div','ai-chat-fbsheet');
  fbSheet.setAttribute('role','dialog');fbSheet.setAttribute('aria-label',FB_LABEL);fbSheet.hidden=true;
  fbSheet.innerHTML='<div class="ai-chat-fbsheet__bar"><button type="button" class="ai-chat-fbsheet__back" data-fb-close="1" aria-label="Back to the chat"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M15 5l-7 7 7 7"/></svg><span>Chat</span></button><div class="ai-chat-fbsheet__title"></div><span class="ai-chat-fbsheet__end"><button type="button" class="ai-chat-fbsheet__x" data-sheet-x="1" aria-label="Close the chat" title="Close"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg></button></span></div>'+
    '<div class="ai-chat-fbsheet__body"><div class="ai-chat-fbsheet__state" role="status"><span class="ai-chat-fbsheet__spin" aria-hidden="true"></span><span class="ai-chat-fbsheet__msg">Loading the survey…</span></div><div class="ai-chat-fbsheet__form"></div><div class="ai-chat-fbsheet__map"></div><div class="ai-chat-fbsheet__list ai-chat-msg-bubble"></div><div class="ai-chat-fbsheet__ff"></div></div>';
  fbSheet.addEventListener('click',function(e){
    if(e.target.closest('[data-fb-close]')){e.preventDefault();closeFeedback();return}
    /* × closes the whole chat. */
    if(e.target.closest('[data-sheet-x]')){e.preventDefault();sheetCloseAll();return}
    /* The filters' panel and anything in it. */
    if(vfClick(e))return;
    /* FITFinder's own buttons. */
    var ffb=e.target.closest('[data-ffs]');
    if(ffb&&sheetKind==='fitfinder'){e.preventDefault();ffsAct(ffb);return}
    /* The "View all" list: its cards work like the ones in the chat. */
    var vaBox=e.target.closest('.ai-chat-fbsheet__list');
    if(!vaBox)return;
    /* Page buttons, and Try again on a page that didn't load. */
    var step=e.target.closest('[data-va-step]');
    if(step){e.preventDefault();vaStep(vaBox,parseInt(step.getAttribute('data-va-step'),10)||0,step);return}
    var retry=e.target.closest('[data-va-retry]');
    if(retry){e.preventDefault();var nb=$('[data-va-step="1"]',vaBox);var rc=viewAllStore[vaBox.getAttribute('data-va')];if(rc&&vaFiltered(rc)){vaShowF(rc,vaBox,rc.fpage||1);return}vaGo(vaBox,parseInt(retry.getAttribute('data-va-retry'),10)||1,nb);return}
    var atc=e.target.closest('[data-atc]');
    if(atc){e.preventDefault();e.stopPropagation();startAddToCart(atc.closest('.ai-chat-product-card'),atc);return}
    var bn=e.target.closest('[data-buynow]');
    if(bn){e.preventDefault();e.stopPropagation();startBuyNow(bn.closest('.ai-chat-product-card'),bn);return}
    /* A card's fit & size tiles open and fold in place. */
    var fq=e.target.closest('[data-fitq]');
    if(fq){e.preventDefault();e.stopPropagation();fitqToggle(fq);return}
    /* Where a card's fit number comes from: over the list. */
    var fx=e.target.closest('[data-fitx]');
    if(fx){e.preventDefault();e.stopPropagation();fitxOpen(fx);return}
    /* True Fit / FITFinder carry on in the chat: close the list first. */
    var tf=e.target.closest('[data-truefit]');
    if(tf){e.preventDefault();e.stopPropagation();closeFeedback();trueFitFor(tf.getAttribute('data-truefit'),tf.getAttribute('data-title')||'');return}
    var hp=e.target.closest('[data-helper]');
    if(hp){e.preventDefault();e.stopPropagation();if(isStreaming)return;closeFeedback();startHelper(hp.getAttribute('data-helper'));return}
    if(e.target.closest('.ai-chat-product-card a[href]'))markChatAttributed();
  });
  /* The price slider, live. */
  fbSheet.addEventListener('input',function(e){var r=e.target&&e.target.closest&&e.target.closest('[data-vf-range]');if(r)vfRange(r)});
  /* A tap anywhere else closes a filter panel (a sheet has its own backdrop). */
  fbSheet.addEventListener('pointerdown',function(e){
    if(!vfOpen||vfOpen.pop.classList.contains('is-sheet')||!e.target||!e.target.closest)return;
    if(!e.target.closest('.ai-vf-pop')&&!e.target.closest('[data-vf-open]'))vfClose(false);
  },true);
  panel.appendChild(fbSheet);
  return fbSheet;
}
function fbBehind(on){
  /* The conversation under the sheet: out of reach while it's up. A card's
     fit details open over the sheet, so they never are. */
  for(var c=panel.firstElementChild;c;c=c.nextElementSibling)if(c!==fbSheet&&c!==menu&&c!==fitx){if(on){c.inert=true;c.setAttribute('data-fb-inert','')}else if(c.hasAttribute('data-fb-inert')){c.inert=false;c.removeAttribute('data-fb-inert')}}
}
function openFeedback(opener){
  if(!FB_ON)return;
  openForm(opener,FB_FORM,FB_LABEL,'fb');
}
/* Any of the store's Typeforms, in the sheet. kind 'fb' is the feedback
   survey (sending it retires its button); 'quiz' is any other form. */
function openForm(opener,form,title,kind){
  if(!/^[A-Za-z0-9]{4,32}$/.test(String(form||'')))return;
  fbOpener=opener||null;
  var sh=fbSheetEl(),box=$('.ai-chat-fbsheet__form',sh);
  var same=sheetForm===form&&!!box.firstChild;
  sheetForm=form;sheetKind=kind==='fb'?'fb':'quiz';
  sheetTitle=String(title||'').trim().slice(0,40)||(sheetKind==='fb'?'Share feedback':'Quiz');
  $('.ai-chat-fbsheet__title',sh).textContent=sheetTitle;
  sh.setAttribute('aria-label',sheetTitle);
  sh.setAttribute('data-kind','form');
  menu.style.display='none';
  sh.hidden=false;void sh.offsetWidth;sh.classList.add('is-open');
  fbBehind(true);
  setTimeout(function(){var b=$('.ai-chat-fbsheet__back',sh);if(b)try{b.focus({preventScroll:true})}catch(e){}},60);
  fbTrack('open');
  /* already loaded: pick up where they left off (the store map may have
     been showing, so it's shown as ready again) */
  if(same){sh.classList.remove('is-failed');sh.classList.add('is-ready');return}
  /* Another form was here: start this one fresh. */
  box.innerHTML='';
  var st=$('.ai-chat-fbsheet__state',sh);
  st.innerHTML='<span class="ai-chat-fbsheet__spin" aria-hidden="true"></span><span class="ai-chat-fbsheet__msg">'+(sheetKind==='fb'?'Loading the survey…':'Loading…')+'</span>';
  sh.classList.remove('is-ready','is-failed');
  var mine=form,thisKind=sheetKind;
  fbLoadSdk().then(function(tf){
    /* They moved on to another form while this one loaded. */
    if(sheetForm!==mine||box.firstChild)return;
    tf.createWidget(mine,{
      container:box,
      inlineOnMobile:true,
      transitiveSearchParams:true,
      opacity:100,
      iframeProps:{title:sheetTitle},
      onReady:function(){if(sheetForm===mine&&sh.getAttribute('data-kind')==='form')sh.classList.add('is-ready')},
      onSubmit:function(){
        /* Sent: the next open starts the form afresh. */
        if(sheetForm===mine)sheetSubmitted=true;
        if(thisKind!=='fb'||!FB_HIDE_AFTER){fbTrack('submit');return}
        fbSent=true;
        var year=Date.now()+365*864e5;
        try{localStorage.setItem(fbDoneKey(),String(year));
          /* The site's own button reads this, so it stays away too. */
          var k='tf_cta_hidden_until_'+FB_FORM;if((parseInt(localStorage.getItem(k),10)||0)<year)localStorage.setItem(k,String(year))}catch(e){}
        fbTrack('submit');
      }
    });
    /* Ready even if Typeform's own signal never comes. */
    setTimeout(function(){if(sheetForm===mine&&sh.getAttribute('data-kind')==='form')sh.classList.add('is-ready')},4000);
  },function(){
    if(sheetForm!==mine||sh.getAttribute('data-kind')!=='form')return;
    sh.classList.add('is-failed');
    $('.ai-chat-fbsheet__state',sh).innerHTML='<span class="ai-chat-fbsheet__msg">'+(thisKind==='fb'?'The survey couldn’t open here.':'This couldn’t open here.')+'</span><a class="ai-chat-fbsheet__alt" href="'+esc(fbUrl())+'" target="_blank" rel="noopener">Open it in a new tab</a>';
  });
}
/* The store locator (Storepoint), in the same sheet. It's put on the page
   exactly as on the store's own locator page — Storepoint's container and
   script — inside a part of the sheet that's kept once built, so going
   back and forth never reloads the map. On the locator page itself (its
   own map already there) the button takes the shopper to that map. */
var LOC_URL='',mapBuilt='',mapState='',mapTimer=null;
function locatorTrack(){if(window.dataLayer)try{window.dataLayer.push({event:'store_locator_open',store_locator_source:'chat'})}catch(e){}}
function openLocator(opener,mapId,title,url){
  if(!/^[A-Za-z0-9]{6,32}$/.test(String(mapId||'')))return;
  if(url)LOC_URL=url;
  var onPage=document.getElementById('storepoint-container');
  if(onPage&&!panel.contains(onPage)){
    toggle(false);
    try{onPage.scrollIntoView({behavior:'smooth',block:'start'})}catch(e){}
    return;
  }
  fbOpener=opener||null;
  var sh=fbSheetEl(),box=$('.ai-chat-fbsheet__map',sh);
  sheetKind='map';
  sheetTitle=String(title||'').trim().slice(0,40)||'Find a store near you';
  $('.ai-chat-fbsheet__title',sh).textContent=sheetTitle;
  sh.setAttribute('aria-label',sheetTitle);
  sh.setAttribute('data-kind','map');
  menu.style.display='none';
  sh.hidden=false;void sh.offsetWidth;sh.classList.add('is-open');
  fbBehind(true);
  setTimeout(function(){var b=$('.ai-chat-fbsheet__back',sh);if(b)try{b.focus({preventScroll:true})}catch(e){}},60);
  locatorTrack();
  var st=$('.ai-chat-fbsheet__state',sh);
  var loading='<span class="ai-chat-fbsheet__spin" aria-hidden="true"></span><span class="ai-chat-fbsheet__msg">Loading the store map…</span>';
  var showFail=function(){
    mapState='failed';
    if(sh.getAttribute('data-kind')!=='map')return;
    sh.classList.remove('is-ready');sh.classList.add('is-failed');
    st.innerHTML='<span class="ai-chat-fbsheet__msg">The store map couldn’t open here.</span>'+(LOC_URL&&safeUrl(LOC_URL)?'<a class="ai-chat-fbsheet__alt" href="'+esc(safeUrl(LOC_URL))+'">Go to the store locator</a>':'');
  };
  if(mapBuilt===mapId){
    sh.classList.remove('is-failed','is-ready');
    if(mapState==='ready'){sh.classList.add('is-ready');return}
    if(mapState==='failed'){showFail();return}
    st.innerHTML=loading;return;
  }
  mapBuilt=mapId;mapState='loading';
  sh.classList.remove('is-ready','is-failed');
  st.innerHTML=loading;
  box.innerHTML='<div class="ai-chat-locator"><div id="storepoint-container" data-map-id="'+esc(mapId)+'"></div></div>';
  var sc=document.createElement('script');sc.src='https://cdn.storepoint.co/api/v1/js/'+mapId+'.js';sc.async=true;
  sc.onerror=function(){if(mapBuilt===mapId&&mapState==='loading'){clearInterval(mapTimer);showFail()}};
  document.head.appendChild(sc);
  /* Ready once Storepoint has drawn something in its container. */
  var t0=Date.now();clearInterval(mapTimer);
  mapTimer=setInterval(function(){
    if(mapBuilt!==mapId||mapState!=='loading'){clearInterval(mapTimer);return}
    var c=$('#storepoint-container',box);
    if(c&&c.children.length){
      clearInterval(mapTimer);mapState='ready';
      setTimeout(function(){if(sh.getAttribute('data-kind')==='map'&&mapState==='ready')sh.classList.add('is-ready')},300);
    }else if(Date.now()-t0>15000){clearInterval(mapTimer);showFail()}
  },200);
}
function closeFeedback(){
  if(!fbSheet||fbSheet.hidden)return;
  vfClose(false);
  /* The wide View all view shrinks back to the chat first. */
  if(vaWide){vaNarrow(function(){closeSheetNow(false)});return}
  closeSheetNow(false);
}
/* × on a sheet: the chat closes; the sheet (and the wide view) are put
   away once it has faded, so the chat opens on the conversation next time. */
function sheetCloseAll(){
  vfClose(false);
  toggle(false);
  setTimeout(function(){if(isOpen)return;vaNarrowNow();if(fbSheet&&!fbSheet.hidden){closeSheetNow(true);fbSheet.hidden=true}},480);
}
function closeSheetNow(quiet){
  if(!fbSheet||fbSheet.hidden)return;
  var sh=fbSheet;
  clearTimeout(sh.__ffsT);sh.style.height='';
  sh.classList.remove('is-open');fbBehind(false);
  /* Added to the cart from View all: asked once the sheet's away. */
  if(isOpen&&ratePending())maybeAskRating();
  var gone=function(){if(!sh.classList.contains('is-open'))sh.hidden=true};
  if(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches)gone();else setTimeout(gone,420);
  /* Sent and kept: the form starts afresh next time. */
  if(sheetSubmitted&&!(fbSent&&sheetKind==='fb')){var sf=$('.ai-chat-fbsheet__form',sh);if(sf)sf.innerHTML='';sheetForm='';sheetSubmitted=false}
  /* Sent: the button makes way for Start here button 4. */
  if(fbSent&&sheetKind==='fb'){
    sheetSubmitted=false;
    /* (The Focus sheets and menu read fbShown() each time they open.) */
    if(!FOCUS){var t=$('[data-feedback]',panel);if(t){if(CTA4L&&CTA4M)t.outerHTML=ctaTileHtml({l:CTA4L,m:CTA4M,i:CTA4I});else t.remove()}}
    if(fbSheet){var f=$('.ai-chat-fbsheet__form',fbSheet);if(f)f.innerHTML='';sheetForm=''}
    fbOpener=null;
  }
  if(quiet)return;
  var back=fbOpener&&document.body.contains(fbOpener)?fbOpener:inputEl;
  try{back.focus({preventScroll:true})}catch(e){}
}
/* Escape steps back out of a filter panel, then the sheet, then closes the chat. */
panel.addEventListener('keydown',function(e){
  if(e.key==='Escape'&&fitx&&!fitx.hidden){e.preventDefault();e.stopPropagation();fitxClose();return}
  if(e.key!=='Escape'||!fbSheet||fbSheet.hidden)return;
  e.preventDefault();e.stopPropagation();
  if(vfOpen){vfClose(true);return}
  closeFeedback();
},true);
/* Start fetching Typeform the moment the button is pointed at. */
function wantsForm(t){return t&&t.closest&&(FB_ON&&t.closest('[data-feedback]')||t.closest('[data-form]'))}
panel.addEventListener('pointerover',function(e){if(wantsForm(e.target))fbLoadSdk().catch(function(){})});
panel.addEventListener('focusin',function(e){if(wantsForm(e.target))fbLoadSdk().catch(function(){})});
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
   finder is visible). For another shoe, the button opens that shoe's page
   and the finder starts there. Once True Fit has a size, the shopper stays
   on the page where True Fit marked it: the chat never opens or sends
   anything by itself. A conversation already under way just gets the size
   added (quietly), so the assistant knows it if they come back.
   The page's own tile is the theme's alone: a shopper who taps it ends any
   finder the chat started, so the chat can't pick up that result. */
var TF_PENDING='hajirai_tf_pending',TF_SITE='hajirai_tf_site',tfRun=null,tfTimer=null;
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
/* "Find my shoe size" before a shoe is picked: how True Fit works (it sizes
   one shoe at a time), then the store's kinds of shoes to start from — per
   line, each with how many styles and a photo of its best seller. A tile asks
   for those shoes; every shoe card has its own True Fit button. */
var TF_INTRO='',TF_PICK='',pendingSizeIntro=null;
function cleanSizeIntro(p){
  if(!p||!Array.isArray(p.lines))return null;
  var lines=[];
  p.lines.slice(0,3).forEach(function(l){
    if(!l||!/^[a-z]{1,10}$/.test(String(l.k||''))||!Array.isArray(l.tiles))return;
    var tiles=[];
    l.tiles.slice(0,6).forEach(function(t){
      var name=String(t&&t.l||'').replace(/\s+/g,' ').trim().slice(0,40);if(!name)return;
      var img=String(t.img||'');
      tiles.push({l:name,n:Math.max(0,parseInt(t.n,10)||0),img:/^https:\/\/[^\s"'<>]+$/.test(img)?img:''});
    });
    if(tiles.length>=2)lines.push({k:String(l.k),l:String(l.l||'').slice(0,20),tiles:tiles});
  });
  if(!lines.length)return null;
  return {line:lines.some(function(l){return l.k===p.line})?String(p.line):lines[0].k,lines:lines};
}
/* Three steps anyone can follow: a dot, then the True Fit button itself —
   the same round logo the shoe cards carry, so they know what to look
   for — then a dot. */
var TFI_STEPS=[['Pick a shoe','Every style fits a little differently.'],['Tap this button on the shoe','The round button on each shoe’s card. Tell it about a pair you already wear.'],['Get your size for that shoe','Matched with real fit data from shoppers who bought it.']];
function sizeIntroHtml(d){
  var known=tfKnown()||tfLast(),steps='';
  TFI_STEPS.forEach(function(s,i){
    var mark=i===1?'<span class="ai-tfi__fit">'+tfLogo(20)+'</span>':'<span class="ai-tfi__dot"></span>';
    steps+='<li class="ai-tfi__step'+(i===0?' is-now':'')+(i===1?' is-tap':'')+'"><span class="ai-tfi__n" aria-hidden="true">'+mark+'</span><span class="ai-tfi__txt"><b>'+esc(s[0])+'</b><span>'+esc(i===1&&known?'The round button on each shoe’s card. True Fit already knows your fit, so it’s quick.':s[1])+'</span></span></li>';
  });
  var seg=d.lines.length>1?'<div class="ai-tfi__seg" role="radiogroup" aria-label="Shoes for">'+d.lines.map(function(l){return '<button type="button" role="radio" class="ai-tfi__segbtn" data-tfi-show="'+esc(l.k)+'" aria-checked="'+(l.k===d.line)+'">'+esc(l.l)+'</button>'}).join('')+'</div>':'';
  var grids=d.lines.map(function(l){
    var word=l.l?l.l.toLowerCase()+' ':'';
    return '<div class="ai-tfi__grid" data-tfi-grid="'+esc(l.k)+'"'+(l.k===d.line?'':' hidden')+'>'+l.tiles.map(function(t){
      var count=t.n?t.n+' style'+(t.n===1?'':'s'):'';
      return '<button type="button" class="ai-tfi__tile" data-tfi-ask="'+esc('Show me '+word+t.l.toLowerCase())+'" aria-label="'+esc((l.l?l.l+' ':'')+t.l+(count?', '+count:''))+'">'+
        '<span class="ai-tfi__img">'+(t.img?'<img src="'+esc(t.img)+'" alt="" loading="lazy">':'')+'</span>'+
        '<span class="ai-tfi__name">'+esc(t.l)+'</span>'+(count?'<span class="ai-tfi__count">'+count+'</span>':'')+'</button>';
    }).join('')+'</div>';
  }).join('');
  return '<div class="ai-tfi" role="group" aria-label="Find your size with True Fit">'+
    '<div class="ai-tfi__how"><div class="ai-tfi__head"><span class="ai-tfi__logo">'+tfLogo(22)+'</span><span class="ai-tfi__htxt"><span class="ai-tfi__title">How True Fit works</span><span class="ai-tfi__sub">Your size for the exact shoe, not a guess</span></span></div>'+
    '<ol class="ai-tfi__steps">'+steps+'</ol></div>'+
    '<div class="ai-tfi__pick"><div class="ai-tfi__pickhead"><span class="ai-tfi__picktitle">Start with a style</span>'+seg+'</div>'+grids+
    '<p class="ai-tfi__note">Have a shoe in mind? Just type its name.</p></div></div>';
}
function tfiShow(btn){
  var root=btn.closest('.ai-tfi'),k=btn.getAttribute('data-tfi-show');if(!root)return;
  Array.prototype.forEach.call(root.querySelectorAll('[data-tfi-show]'),function(b){b.setAttribute('aria-checked',String(b===btn))});
  Array.prototype.forEach.call(root.querySelectorAll('[data-tfi-grid]'),function(g){g.hidden=g.getAttribute('data-tfi-grid')!==k});
}
/* The store's app, once a visit, as its own small message under the
   conversation (like "How's the chat going?") — never after the first
   reply, never beside an order, a comparison or a form, never in the same
   turn as the rating question. Its button opens a QR code to scan on
   computers (iPhone or Android, like the footer) and the App Store /
   Google Play buttons on phones. Text and button from Settings; links from
   Settings, else from the store's own footer — with its QR codes and badges. */
var APP_PROMO={on:true,ios:'',android:'',text:'',button:'',image:''},APPN_KEY='hajirai_app_note',APPN_COUNT='hajirai_app_replies',APP_QR_URL='/apps/hajirai/app-qr',APPN_DELAY=900;
function appText(){
  if(APP_PROMO.text)return APP_PROMO.text;
  var name=String(C.shopName||'').replace(/\s+/g,' ').trim().slice(0,30);
  return name?'Love '+name+'? You\u2019ll love our app':'You\u2019ll love our app';
}
function appButton(){return APP_PROMO.button||'Get it'}
var APP_RE={ios:/^https:\/\/apps\.apple\.com\/[^\s"'<>]+$/i,android:/^https:\/\/play\.google\.com\/store\/apps\/details\?[^\s"'<>]+$/i};
var APP_ICON='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6.5" y="2.5" width="11" height="19" rx="2.8"/><path d="M10.5 18.5h3"/></svg>';
var APP_LOGO={ios:'<svg viewBox="8 8 18 22" width="18" height="22" aria-hidden="true"><path fill="currentColor" d="M24.77 20.3a4.95 4.95 0 0 1 2.36-4.15 5.07 5.07 0 0 0-3.99-2.16c-1.68-.18-3.31 1-4.16 1-.87 0-2.19-.98-3.61-.96a5.32 5.32 0 0 0-4.47 2.73c-1.93 3.35-.49 8.27 1.36 10.98.93 1.33 2.01 2.81 3.43 2.75 1.39-.06 1.9-.88 3.58-.88 1.66 0 2.14.88 3.59.85 1.49-.02 2.43-1.33 3.32-2.67a10.96 10.96 0 0 0 1.52-3.09 4.78 4.78 0 0 1-2.92-4.4zM22.04 12.21a4.87 4.87 0 0 0 1.11-3.49 4.96 4.96 0 0 0-3.2 1.66 4.64 4.64 0 0 0-1.15 3.36 4.1 4.1 0 0 0 3.24-1.53z"/></svg>',
  android:'<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="#00d7fe" d="M4 2.6 13.2 12 4 21.4c-.3-.2-.5-.6-.5-1.1V3.7c0-.5.2-.9.5-1.1z"/><path fill="#ffce00" d="m16.3 15.1-3.1-3.1 3.1-3.1 3.6 2.1c1 .6 1 1.5 0 2l-3.6 2.1z"/><path fill="#ff3a44" d="M16.3 15.1 13.2 12 4 21.4c.4.4 1 .4 1.7 0l10.6-6.3z"/><path fill="#00f076" d="M16.3 8.9 5.7 2.6c-.7-.4-1.3-.4-1.7 0l9.2 9.4 3.1-3.1z"/></svg>'};
function appFooter(sel,attr){try{var el=document.querySelector(sel);return el?String(el.getAttribute(attr)||''):''}catch(e){return ''}}
/* Theme files: //host/cdn/… or https://… only. */
function appImg(u){u=String(u||'');return /^(https:)?\/\/[^\s"'<>]+$/i.test(u)?u:''}
function appInfo(){
  if(!APP_PROMO.on)return null;
  var out={},any=false;
  ['ios','android'].forEach(function(pf){
    var link=APP_PROMO[pf]||appFooter('a[data-app-dl-link][data-platform="'+pf+'"]','href');
    if(!APP_RE[pf].test(link))return;
    out[pf]={link:link,qr:APP_PROMO[pf]?APP_QR_URL+'?p='+pf:appImg(appFooter('.app-dl__qr[data-platform="'+pf+'"] img','src')),badge:appImg(appFooter('.app-dl-badge[data-platform="'+pf+'"] img','src'))};
    any=true;
  });
  return any?out:null;
}
var appInfoNow=null;
function appNoteHtml(){
  var id='ai-appn-'+(++ordlSeq);
  /* The store's picture of its app (Settings → Your app), bigger than the
     card so it stands out above and below it; else the phone icon. */
  var lead=APP_PROMO.image?'<span class="ai-appn__shot"><img src="'+esc(APP_PROMO.image)+'" alt="" width="64" height="80" decoding="async"></span>':'<span class="ai-appn__icon">'+APP_ICON+'</span>';
  return '<div class="ai-appn'+(APP_PROMO.image?' has-shot':'')+'"><div class="ai-appn__row">'+lead+'<span class="ai-appn__txt">'+esc(appText())+'</span>'+
    '<button type="button" class="ai-appn__go" data-appn aria-expanded="false" aria-controls="'+id+'">'+esc(appButton())+'</button>'+
    '<button type="button" class="ai-appn__x" data-appn-x aria-label="Not now" title="Not now">'+RATE_ICON.x+'</button></div>'+
    '<div class="ai-appn__panel" id="'+id+'" hidden></div></div>';
}
var APPN_CAP={ios:'Scan with your iPhone camera',android:'Scan with your phone\u2019s camera'},APPN_STORE={ios:'App Store',android:'Google Play'};
function appPanelHtml(info){
  var pfs=['ios','android'].filter(function(pf){return info[pf]});
  var desk=false;try{desk=window.matchMedia('(hover: hover) and (pointer: fine)').matches}catch(e){}
  var qrs=pfs.filter(function(pf){return info[pf].qr});
  if(desk&&qrs.length){
    var pf=qrs[0];
    return '<div class="ai-appn__qrbox" data-appn-on="'+pf+'"><a class="ai-appn__qr" href="'+esc(info[pf].link)+'" target="_blank" rel="noopener"><img src="'+esc(info[pf].qr)+'" alt="'+esc('QR code: the app on '+APPN_STORE[pf]+' (opens in a new tab)')+'" width="96" height="96"></a>'+
      '<div class="ai-appn__side">'+(qrs.length>1?'<div class="ai-appn__seg" role="group" aria-label="Choose your phone">'+qrs.map(function(p){return '<button type="button" data-appn-pf="'+p+'" aria-pressed="'+(p===pf)+'">'+(p==='ios'?'iPhone':'Android')+'</button>'}).join('')+'</div>':'')+
      '<p class="ai-appn__cap">'+esc(APPN_CAP[pf])+'</p><a class="ai-appn__store" href="'+esc(info[pf].link)+'" target="_blank" rel="noopener">Or open '+APPN_STORE[pf]+ORD_ICON.ext+'</a></div></div>';
  }
  /* Phones: the badge for their own store, the other as a small link;
     both badges when we can't tell which phone it is. */
  var ua=navigator.userAgent||'',mine=/android/i.test(ua)?'android':(/iphone|ipad|ipod/i.test(ua)||(/macintosh/i.test(ua)&&navigator.maxTouchPoints>1))?'ios':'';
  var badge=function(p){
    var i=info[p],label=p==='ios'?'Download on the App Store':'Get it on Google Play';
    return '<a class="ai-appn__badge is-'+p+'" href="'+esc(i.link)+'" target="_blank" rel="noopener" aria-label="'+label+'">'+(i.badge?'<img src="'+esc(i.badge)+'" alt="">':'<span class="ai-appn__pill">'+APP_LOGO[p]+'<span><small>'+(p==='ios'?'Download on the':'GET IT ON')+'</small>'+APPN_STORE[p]+'</span></span>')+'</a>';
  };
  if(mine&&info[mine]){
    var other=mine==='ios'?'android':'ios';
    return '<div class="ai-appn__badges">'+badge(mine)+'</div>'+(info[other]?'<a class="ai-appn__store ai-appn__other" href="'+esc(info[other].link)+'" target="_blank" rel="noopener">'+(other==='ios'?'On an iPhone? App Store':'On Android? Google Play')+ORD_ICON.ext+'</a>':'');
  }
  return '<div class="ai-appn__badges">'+pfs.map(badge).join('')+'</div>';
}
function appNoteToggle(btn){
  var panel=document.getElementById(btn.getAttribute('aria-controls'));if(!panel)return;
  var open=panel.hidden;
  if(open&&!panel.innerHTML){var info=appInfoNow||appInfo();if(!info)return;panel.__info=info;panel.innerHTML=appPanelHtml(info)}
  panel.hidden=!open;btn.setAttribute('aria-expanded',String(open));
  /* Opened below the fold: bring all of it into view (again once it has
     slid in and its pictures have loaded). */
  if(open){
    var row=btn.closest('.ai-chat-app')||panel;
    keepInView(row);setTimeout(function(){keepInView(row)},340);
    Array.prototype.forEach.call(panel.querySelectorAll('img'),function(im){if(!im.complete)im.addEventListener('load',function(){keepInView(row)},{once:true})});
  }
}
function appNoteSwitch(btn){
  var box=btn.closest('.ai-appn__qrbox'),panel=btn.closest('.ai-appn__panel');if(!box||!panel||!panel.__info)return;
  var pf=btn.getAttribute('data-appn-pf'),i=panel.__info[pf];if(!i)return;
  box.setAttribute('data-appn-on',pf);
  var a=box.querySelector('.ai-appn__qr'),img=a.querySelector('img');a.href=i.link;img.src=i.qr;img.alt='QR code: the app on '+APPN_STORE[pf]+' (opens in a new tab)';
  box.querySelector('.ai-appn__cap').textContent=APPN_CAP[pf];
  var st=box.querySelector('.ai-appn__store');st.href=i.link;st.firstChild.textContent='Or open '+APPN_STORE[pf];
  Array.prototype.forEach.call(box.querySelectorAll('[data-appn-pf]'),function(b){b.setAttribute('aria-pressed',String(b===btn))});
}
/* After a reply: the second one this visit (or later), once — a moment
   after it, as long as the shopper hasn't moved on. True when it's coming
   (the rating question then waits for a later reply). */
function maybeAppNote(bubble){
  if(!bubble||!APP_PROMO.on)return false;
  try{if(sessionStorage.getItem(APPN_KEY))return false;var n=(parseInt(sessionStorage.getItem(APPN_COUNT),10)||0)+1;sessionStorage.setItem(APPN_COUNT,String(n));if(n<2)return false}catch(e){return false}
  if(bubble.querySelector('.ai-ordl,.ai-ord,.ai-cmp,.ai-cmp-bar:not([hidden]),.ai-tfi,.ai-chat-klaviyo-form,.ai-chat-atc-panel,.ai-chat-choices'))return false;
  if($('.ai-chat-rate',msgsEl))return false;
  var info=appInfo();if(!info)return false;
  var turn=messages.length;
  later(function(){
    if(!APP_PROMO.on||isStreaming||messages.length!==turn||$('.ai-chat-app',msgsEl)||$('.ai-chat-rate',msgsEl))return;
    if(inputEl.value.trim()||(fbSheet&&!fbSheet.hidden))return;
    try{if(sessionStorage.getItem(APPN_KEY))return;sessionStorage.setItem(APPN_KEY,'1')}catch(e){return}
    appInfoNow=info;
    var near=rateNearBottom();
    var row=el('div','ai-chat-app',appNoteHtml());
    row.setAttribute('role','group');row.setAttribute('aria-label',appText());
    /* A picture that doesn't load: the phone icon in its place. */
    var shot=row.querySelector('.ai-appn__shot img');
    if(shot)shot.addEventListener('error',function(){var s=shot.parentNode,card=row.querySelector('.ai-appn');if(!s)return;s.outerHTML='<span class="ai-appn__icon">'+APP_ICON+'</span>';if(card)card.classList.remove('has-shot');row.classList.remove('has-shot')});
    if(shot)row.classList.add('has-shot');
    msgsEl.appendChild(row);
    void row.offsetWidth;row.classList.add('is-in');
    if(near)keepInView(row);
  },APPN_DELAY);
  return true;
}
function appNoteClose(btn){
  var row=btn.closest('.ai-chat-app');if(!row)return;
  foldAway(row);try{inputEl.focus({preventScroll:true})}catch(e){}
}
function tfNote(text){messages.push({role:'assistant',content:text});saveH(messages);appendMsg('assistant',text);scrollBottom()}
function trueFitFor(handle,title){
  if(!handle||tfRun)return;
  if(handle===pageHandle()&&tfHere()){runTrueFit(title);return}
  try{sessionStorage.setItem(TF_PENDING,JSON.stringify({handle:handle,title:title,at:Date.now()}))}catch(e){}
  location.href=SHOP_ROOT+'products/'+encodeURIComponent(handle);
}
function tfStop(){if(tfTimer){clearInterval(tfTimer);tfTimer=null}tfRun=null}
function runTrueFit(title){
  var api=window.AetrexTrueFitTile,tile=tfTile();
  if(!api||!tile||tfRun)return;
  var run=tfRun={title:title,started:Date.now()};
  toggle(false);
  Promise.resolve().then(function(){return api.open(tile)}).catch(function(){}).then(function(){
    if(tfRun!==run)return;
    var st=api.state,seen=false,closedAt=0,id=0;
    id=tfTimer=setInterval(function(){
      if(tfRun!==run){clearInterval(id);return}
      var age=Date.now()-run.started;
      /* Only True Fit's finder on screen counts — not the tile loading. */
      var open=document.body.classList.contains('tfc-show-modal')||st.finderOpen;
      if(open&&age<30*60*1000){seen=true;closedAt=0;return}
      /* Still loading: wait, but not for ever. */
      if(!seen&&st.busy&&age<45000)return;
      if(!closedAt)closedAt=Date.now();
      /* True Fit redraws its answer a moment after the finder closes. */
      if(!st.recommendation&&seen&&Date.now()-closedAt<4000)return;
      tfStop();
      /* The finder never opened (no data for this style: the theme showed
         its size chart), or closed without a size: nothing to add. */
      var size=seen&&typeof st.recommendation==='string'?st.recommendation.trim().slice(0,40):'';
      if(!size)return;
      tfRemember(size,run.title);
      if(messages.length)tfNote('True Fit recommends size '+size+(run.title?' in the '+run.title:'')+'. It’s marked in the size list on this page.');
    },400);
  });
}
/* The shopper used the page's own "Find my size" tile: that's the theme's
   finder, not the chat's — any run the chat started ends here. */
document.addEventListener('click',function(e){if(tfRun&&e.isTrusted&&e.target&&e.target.closest&&e.target.closest('[data-tf-size-tile]'))tfStop()},true);
/* Back to a page kept in the browser's memory: whatever was waiting is over. */
window.addEventListener('pageshow',function(e){if(e.persisted)tfStop()});
/* Arrived from the chat's True Fit button on another page: start the finder here. */
function tfResume(){
  var p=null;
  try{p=JSON.parse(sessionStorage.getItem(TF_PENDING)||'null');sessionStorage.removeItem(TF_PENDING)}catch(e){}
  /* Only straight after the chat's button sent the shopper here. */
  if(!p||!p.handle||Date.now()-p.at>2*60*1000||p.handle!==pageHandle())return;
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
  var useTiles=fitcAny(products);
  for(var i=0;i<products.length;i++)ph+=prodCard(products[i],useTiles);
  ph+='</div>';
  b.insertAdjacentHTML('beforeend',isShowcase?showcaseWrap(ph):ph);
  if(isShowcase){var w=b.querySelector('.ai-chat-products-wrap');if(w)initShowcaseArrows(w)}
  b.insertAdjacentHTML('beforeend',compareCtaHtml(products));
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
/* With Fit confidence on — in "Check fit & size", two rows: the style's Fit
   and the size tool that belongs to the product — True Fit on shoes,
   FITFinder on orthotics (until the shopper has a FIT), never the other
   way. Either may be missing; one alone is the only row. Fit is a word,
   never a number: a band tinted in its level's color (High green, Mid
   blue, Fair orange) with ⓘ in a ring of that color, how the style runs
   ("Runs small") in it — that always shows — and "Mid confidence" under
   it where there's room; tapping it says where it comes from. The size tool is a
   quiet row with its logo and a chevron. The rows size themselves to the
   card, so no card breaks at any width. */
var FITC_WORDS={'true':'True to size',small:'Runs small',large:'Runs large',narrow:'Runs narrow',wide:'Runs wide'};
var FITC_LONG={'true':'Runs true to size',small:'Runs small',large:'Runs large',narrow:'Runs narrow',wide:'Runs wide'};
var FITC_LEVEL={high:'High',mid:'Mid',fair:'Fair'};
function fitcInt(v,max){var n=Math.round(Number(v));return isFinite(n)&&n>=0?Math.min(n,max):null}
function fitcTriple(v){
  if(!Array.isArray(v)||v.length!==3)return null;
  var o=[fitcInt(v[0],1e7),fitcInt(v[1],1e7),fitcInt(v[2],1e7)];
  return o[0]===null||o[1]===null||o[2]===null||o[0]+o[1]+o[2]===0?null:o;
}
function fitcClean(f){
  if(!f||typeof f!=='object')return null;
  var s=Math.round(Number(f.s));if(!(s>=1&&s<=99))return null;
  /* The level the server sent; a card saved before it did gets it from the
     score (the same cutoffs as app/lib/fit-confidence.js). */
  var v=Object.prototype.hasOwnProperty.call(FITC_LEVEL,f.v)?f.v:(s>=85?'high':s>=70?'mid':'fair');
  if(!FITC_LEVELS[v])return null;
  var o={s:s,v:v,r:Math.max(0,parseInt(f.r,10)||0),n:Math.max(0,parseInt(f.n,10)||0)};
  if(typeof f.l==='string'&&Object.prototype.hasOwnProperty.call(FITC_WORDS,f.l))o.l=f.l;
  var a=fitcTriple(f.a),w=fitcTriple(f.w),k=fitcInt(f.k,100);
  if(a)o.a=a;if(w)o.w=w;
  if(k!==null&&o.n){o.k=k;if(f.kf===1)o.kf=1}
  if(typeof f.z==='string'&&/^\d{1,2}(\.5)?$/.test(f.z)){
    o.z=f.z;
    var zn=fitcInt(f.zn,1e7),zk=fitcInt(f.zk,100);
    if(zn){o.zn=zn;if(zk!==null)o.zk=zk}
  }
  return o;
}
function fitcSay(f){
  var basis=[f.r?'reviews':'',f.n?'sales and return history':''].filter(Boolean).join(', ');
  return 'Fit confidence'+(f.z?' in size '+f.z+', the size you’ve kept before':'')+': '+FITC_LEVEL[f.v]+'.'+(f.l?' '+FITC_LONG[f.l]+'.':'')+(basis?' From '+basis+'.':'');
}
/* A full ring in the level's color, its word inside (the details sheet). */
function fitRing(v){
  return '<svg class="ai-ring" viewBox="0 0 36 36" aria-hidden="true" focusable="false"><circle class="ai-ring__arc" cx="18" cy="18" r="15.5"/></svg><b class="ai-tool__lvl">'+FITC_LEVEL[v]+'</b>';
}
/* ⓘ in a ring of the level's color: there's more to read behind it. */
var TOOL_INFO='<svg class="ai-tool__info" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10"/><path d="M12 11v6"/><circle cx="12" cy="7.4" r="1.15" fill="currentColor" stroke="none"/></svg>';
var TOOL_GO='<svg class="ai-tool__go" viewBox="0 0 8 14" width="8" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M1.5 1.5L6.5 7l-5 5.5"/></svg>';
/* One row: icon, a title and a line under it, each in two lengths (the
   card's width picks), and a chevron where it leads somewhere. */
function toolTile(attrs,icon,title,titleShort,sub,subShort,go){
  var two=function(cls,a,b){return '<span class="'+cls+'"><span class="ai-tool__long">'+esc(a)+'</span><span class="ai-tool__short">'+esc(b)+'</span></span>'};
  return '<button type="button" '+attrs+'><span class="ai-tool__icon" aria-hidden="true">'+icon+'</span><span class="ai-tool__text" aria-hidden="true">'+two('ai-tool__title',title,titleShort)+two('ai-tool__sub',sub,subShort)+'</span>'+(go?TOOL_GO:'')+'</button>';
}
function fitTile(raw){
  var f=fitcClean(raw);if(!f)return '';
  var L=FITC_LEVEL[f.v];
  return toolTile('class="ai-tool ai-tool--fit is-'+f.v+'" data-fitx="'+esc(JSON.stringify(f))+'" aria-haspopup="dialog" aria-label="'+esc(fitcSay(f)+' Shows where this comes from.')+'"',
    TOOL_INFO,f.l?FITC_LONG[f.l]:'See how it fits',f.l?FITC_WORDS[f.l]:'How it fits',
    L+' confidence',L+' confidence');
}
/* Fit confidence off: the size tool is a round icon button beside the buy
   button, so the card doesn't grow (as it always was). */
function cardHelper(p,t){
  if(!p||!p.handle)return '';
  if(p.kind==='footwear'&&tfPayload())return '<button type="button" class="ai-chat-card-fit" data-truefit="'+esc(p.handle)+'" data-title="'+t+'" aria-label="Find my size with True Fit" title="Find my size \u00b7 True Fit">'+tfLogo(20)+'</button>';
  if(p.kind==='orthotic'&&ff&&!savedFit())return '<button type="button" class="ai-chat-card-fit ai-chat-card-fit--fit" data-helper="fitfinder" aria-label="Find my orthotic FIT with FITFinder" title="Find my FIT \u00b7 FITFinder"><span aria-hidden="true">FIT</span></button>';
  return '';
}
/* Fit confidence on: the size tool as a row under the Fit row. */
function sizeTile(p,t){
  if(!p||!p.handle)return '';
  if(p.kind==='footwear'&&tfPayload())return toolTile('class="ai-tool ai-tool--size" data-truefit="'+esc(p.handle)+'" data-title="'+t+'" aria-label="Find my size with True Fit"','<span class="ai-tool__badge">'+tfLogo(20)+'</span>','Find your size','Your size','with True Fit','True Fit',true);
  if(p.kind==='orthotic'&&ff&&!savedFit())return toolTile('class="ai-tool ai-tool--ff" data-helper="fitfinder" aria-label="Find my orthotic FIT with FITFinder"','<span class="ai-tool__badge ai-tool__badge--fit">FIT</span>','Find your FIT','Your FIT','with FITFinder','FITFinder',true);
  return '';
}
function cardTools(p,t){
  var tiles=[fitTile(p.fit),sizeTile(p,t)].filter(Boolean);
  return tiles.length?'<div class="ai-tools" data-n="'+tiles.length+'">'+tiles.join('')+'</div>':'';
}
/* The tiles stay folded under one quiet button where "View product" was
   (the image and the title still open the product): "Check fit & size"
   (Settings → Chat text) opens them in place, for that card only. A card
   with nothing to open keeps "View product". */
var fitqN=0;
var FITQ_CHEV='<svg class="ai-fitq__chev" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false"><path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function fitqName(title){return FIT_LBL+(title?', '+title:'')}
/* The chevron stays with the last word when a narrow card wraps the words. */
function fitqLabel(){
  var i=FIT_LBL.lastIndexOf(' ');
  return '<span class="ai-fitq__label">'+(i>0?esc(FIT_LBL.slice(0,i))+' ':'')+'<span class="ai-fitq__end">'+esc(i>0?FIT_LBL.slice(i+1):FIT_LBL)+FITQ_CHEV+'</span></span>';
}
function viewLink(u){return '<a class="ai-chat-view-link" href="'+esc(u)+'">View product</a>'}
function fitFold(p,t,u){
  var tools=cardTools(p,t);
  if(!tools)return viewLink(u);
  var id='ai-fitp-'+(++fitqN);
  return '<button type="button" class="ai-fitq" data-fitq aria-expanded="false" aria-controls="'+id+'" aria-label="'+esc(fitqName(p.title||''))+'">'+fitqLabel()+'</button>'+
    '<div class="ai-fitp" id="'+id+'"><div class="ai-fitp__in">'+tools+'</div></div>';
}
/* Open or fold one card's tiles. The other cards in its row keep their
   height while any is open, so only this one grows. */
function fitqToggle(btn){
  var fp=document.getElementById(btn.getAttribute('aria-controls')||'');
  var card=btn.closest('.ai-chat-product-card');
  if(!fp||!card)return;
  var open=btn.getAttribute('aria-expanded')!=='true',row=card.parentNode;
  if(open)fitqPin(row);
  btn.setAttribute('aria-expanded',open?'true':'false');
  fp.classList.toggle('is-open',open);
  clearTimeout(fp._t);
  fp._t=setTimeout(function(){if(open)keepInView(fp);else fitqUnpin(row)},320);
}
function fitqCards(row){
  var out=[];
  for(var c=row&&row.firstElementChild;c;c=c.nextElementSibling)if(c.classList.contains('ai-chat-product-card'))out.push(c);
  return out;
}
function fitqPin(row){
  if(!row||row.classList.contains('is-fitq-open'))return;
  /* Only where cards sit side by side (a row of cards, or View all's grid). */
  if(!row.classList.contains('ai-chat-products--showcase')&&!row.classList.contains('ai-chat-products--grid'))return;
  var cs=fitqCards(row);
  if(cs.length<2)return;
  var hs=cs.map(function(c){
    var st=getComputedStyle(c),h=c.getBoundingClientRect().height;
    if(st.boxSizing!=='border-box')h-=parseFloat(st.paddingTop)+parseFloat(st.paddingBottom)+parseFloat(st.borderTopWidth)+parseFloat(st.borderBottomWidth);
    return h;
  });
  for(var i=0;i<cs.length;i++)cs[i].style.minHeight=hs[i]+'px';
  row.classList.add('is-fitq-open');
}
function fitqUnpin(row){
  if(!row||!row.classList.contains('is-fitq-open')||row.querySelector('.ai-fitp.is-open'))return;
  var cs=fitqCards(row);
  for(var i=0;i<cs.length;i++)cs[i].style.minHeight='';
  row.classList.remove('is-fitq-open');
}
/* A FITFinder tile gone (the shopper has a FIT now): the other takes the
   row; with none left, the card's "View product" comes back. */
function toolsRelayout(row){
  if(!row)return;
  var n=row.querySelectorAll('.ai-tool').length;
  if(n){row.setAttribute('data-n',String(n));return}
  var fp=row.closest('.ai-fitp'),card=row.closest('.ai-chat-product-card');
  row.parentNode.removeChild(row);
  if(!fp||!card)return;
  var q=card.querySelector('[data-fitq]');
  if(q){q.insertAdjacentHTML('beforebegin',viewLink(card.getAttribute('data-url')||'#'));q.parentNode.removeChild(q)}
  fp.classList.remove('is-open');
  if(fp.parentNode)fp.parentNode.removeChild(fp);
  fitqUnpin(card.parentNode);
}

/* Where the fit number comes from: a small sheet over the chat, opened from
   the Fit tile — the score, how it runs, what reviewers said, how many pairs
   were kept, and the shopper's own size when it's theirs. × or a tap outside
   or Escape closes it, back to the tile. */
var fitx=null,fitxFrom=null;
var FX_ICON={
  star:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 3.6l2.5 5.3 5.8.7-4.3 4 1.1 5.7L12 16.5l-5.1 2.8 1.1-5.7-4.3-4 5.8-.7z"/></svg>',
  box:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3.5 7.5L12 3.5l8.5 4v9L12 20.5l-8.5-4z"/><path d="M3.5 7.5L12 11.5l8.5-4M12 11.5v9"/></svg>',
  you:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true" focusable="false"><circle cx="12" cy="8.5" r="3.5"/><path d="M5 19.5c1.3-3.4 4-5 7-5s5.7 1.6 7 5"/></svg>',
  x:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18"/></svg>'
};
function fxRow(icon,title,text,extra){
  return '<li class="ai-fitx__row"><span class="ai-fitx__ico" aria-hidden="true">'+FX_ICON[icon]+'</span><div class="ai-fitx__rt"><div class="ai-fitx__rh">'+esc(title)+'</div><p class="ai-fitx__rp">'+esc(text)+'</p>'+(extra||'')+'</div></li>';
}
/* The sheet says where the fit comes from in words, never counts or shares:
   what most reviewers said, and how sales and returns went. */
/* Reviewers' size answers as one bar — runs small · true · runs large — and
   its key. */
function fxSplit(a){
  var t=a[0]+a[1]+a[2],pc=function(x){return (100*x/t).toFixed(2)+'%'};
  return '<div class="ai-fitx__split" aria-hidden="true"><i class="is-low" style="width:'+pc(a[0])+'"></i><i class="is-true" style="width:'+pc(a[1])+'"></i><i class="is-high" style="width:'+pc(a[2])+'"></i></div>'+
    '<ul class="ai-fitx__key"><li class="is-low">Runs small</li><li class="is-true">True to size</li><li class="is-high">Runs large</li></ul>';
}
var FX_SIZE={say:['it runs small','it’s true to size','it runs large'],lean:['small','true to size','large']};
var FX_WIDTH={say:['it runs narrow','it’s true to width','it runs wide'],lean:['narrow','true to width','wide']};
/* What reviewers said, [low, true, high]: most of them (more than half), the
   way they lean, or split between two. */
function fxSays(a,w,width){
  var t=a[0]+a[1]+a[2],m=Math.max(a[0],a[1],a[2]),i=a.indexOf(m),p=width?'Width: ':'';
  var cap=function(x){return width?x:x.charAt(0).toUpperCase()+x.slice(1)};
  if(a.indexOf(m,i+1)>-1)return p+cap('reviewers are split.');
  return p+(2*m>t?cap('most say ')+w.say[i]:cap('reviewers are mixed, leaning ')+w.lean[i])+'.';
}
/* How sales and returns went, from the share of pairs kept. */
function fxKept(k,fit){
  return (k>=90?'very few pairs are sent back':k>=70?'most pairs aren’t sent back':k>=50?'more pairs are kept than sent back':'many pairs are sent back')+(fit?' for fit':'')+'.';
}
function fitxBody(f,title,tf){
  var h='<div class="ai-fitx__head is-'+f.v+'"><span class="ai-fitx__ring">'+fitRing(f.v)+'</span><div class="ai-fitx__hd">'+
    '<h2 class="ai-fitx__title" id="ai-fitx-title">'+FITC_LEVEL[f.v]+' confidence</h2>'+(title?'<p class="ai-fitx__prod">'+esc(title)+'</p>':'')+
    (f.l?'<span class="ai-fitx__pill">'+esc(FITC_LONG[f.l])+'</span>':'')+'</div></div><ul class="ai-fitx__list">';
  if(f.z)h+=fxRow('you','For your size '+f.z,'The size you’ve kept before, from your orders.'+(f.zn&&f.zk!=null?' In size '+f.z+', '+fxKept(f.zk,f.kf):''));
  if(f.a||f.w){
    var txt=f.a?fxSays(f.a,FX_SIZE):'';
    var wtxt=f.w?fxSays(f.w,FX_WIDTH,true):'';
    h+=fxRow('star','What reviewers said',txt||wtxt,(f.a?fxSplit(f.a):'')+(txt&&wtxt?'<p class="ai-fitx__rp ai-fitx__rp--more">'+esc(wtxt)+'</p>':''));
  }else h+=fxRow('star','What reviewers said','No reviewer has rated the fit yet.');
  if(f.n&&f.k!=null)h+=fxRow('box','What buyers kept','From sales and return history, '+fxKept(f.k,f.kf));
  else h+=fxRow('box','What buyers kept','Not enough sales in the last year to go by yet.');
  h+='</ul><p class="ai-fitx__note">High, Mid or Fair says how sure we can be that this style fits as expected. It blends what reviewers said with what buyers kept, across every color — the more there is to go on, the more it counts. It tells you how the style fits; True Fit finds your size.</p>';
  if(tf)h+='<button type="button" class="ai-fitx__tf" data-truefit="'+esc(tf.handle)+'" data-title="'+esc(tf.title)+'"><span class="ai-tool__badge" aria-hidden="true">'+tfLogo(18)+'</span><span>Find my size with True Fit</span></button>';
  return h;
}
function fitxEl(){
  if(fitx)return fitx;
  fitx=el('div','ai-fitx');fitx.hidden=true;
  fitx.innerHTML='<div class="ai-fitx__scrim" data-fitx-close="1"></div><div class="ai-fitx__sheet" role="dialog" aria-modal="true" aria-labelledby="ai-fitx-title"><div class="ai-fitx__grip" aria-hidden="true"></div><button type="button" class="ai-fitx__x" data-fitx-close="1" aria-label="Close">'+FX_ICON.x+'</button><div class="ai-fitx__body"></div></div>';
  fitx.addEventListener('click',function(e){
    e.stopPropagation();
    if(e.target.closest('[data-fitx-close]')){e.preventDefault();fitxClose();return}
    var tf=e.target.closest('[data-truefit]');
    if(tf){e.preventDefault();var h=tf.getAttribute('data-truefit'),tt=tf.getAttribute('data-title')||'';fitxClose(true);if(fbSheet&&!fbSheet.hidden)closeFeedback();trueFitFor(h,tt)}
  });
  fitx.addEventListener('keydown',function(e){
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();fitxClose();return}
    /* Focus stays in the sheet while it's open. */
    if(e.key!=='Tab')return;
    var f=fitx.querySelectorAll('button');if(!f.length)return;
    var first=f[0],last=f[f.length-1];
    if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}
    else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}
  });
  panel.appendChild(fitx);
  return fitx;
}
function fitxBehind(on){
  for(var c=panel.firstElementChild;c;c=c.nextElementSibling)if(c!==fitx){if(on){if(!c.inert){c.inert=true;c.setAttribute('data-fx-inert','')}}else if(c.hasAttribute('data-fx-inert')){c.inert=false;c.removeAttribute('data-fx-inert')}}
}
function fitxOpen(btn){
  var f=null;try{f=fitcClean(JSON.parse(btn.getAttribute('data-fitx')||'null'))}catch(e){f=null}
  if(!f)return;
  var card=btn.closest('.ai-chat-product-card');
  var title=card?card.getAttribute('data-title')||'':'';
  var tfb=card&&card.querySelector('[data-truefit]');
  var sh=fitxEl();
  $('.ai-fitx__body',sh).innerHTML=fitxBody(f,title,tfb?{handle:tfb.getAttribute('data-truefit'),title:title}:null);
  $('.ai-fitx__sheet',sh).scrollTop=0;
  fitxFrom=btn;
  sh.hidden=false;void sh.offsetWidth;sh.classList.add('is-open');
  fitxBehind(true);
  setTimeout(function(){var x=$('.ai-fitx__x',sh);if(x)try{x.focus({preventScroll:true})}catch(e){}},40);
}
function fitxClose(quiet){
  if(!fitx||fitx.hidden)return;
  var sh=fitx;
  sh.classList.remove('is-open');fitxBehind(false);
  var gone=function(){if(!sh.classList.contains('is-open'))sh.hidden=true};
  if(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches)gone();else setTimeout(gone,300);
  var back=fitxFrom;fitxFrom=null;
  if(!quiet&&back&&document.body.contains(back))try{back.focus({preventScroll:true})}catch(e){}
}

/* Product card: image + title link to the product; "Add to cart" is the
   primary action (.ai-chat-product-cta keeps every layout's CTA placement),
   then "View product", a quiet underlined link — or, with Fit confidence
   on, "Check fit & size" in its place, opening the Fit and size tiles.
   When the chat already knows the customer's size/width, the card carries it
   (data-preselect) and shows it under the price — one tap adds that exact
   variant. */
/* The tiles, for every card of a reply (or a View all list) when the store
   has Fit confidence on or any of its cards carries a score — never a mix. */
function fitcAny(list){
  if(FITC_ON)return true;
  for(var i=0;list&&i<list.length;i++)if(list[i]&&fitcClean(list[i].fit))return true;
  return false;
}
function prodCard(p,useTiles){
var img=p.image||p.featured_image||'';
var t=esc(p.title||'');
var u=safeUrl(p.url)||(p.handle?(SHOP_ROOT+'products/'+encodeURIComponent(p.handle)):'#');
var pr=esc(p.price_formatted||(p.price?fmt(p.price):''));
var cp=p.compare_at_price?esc(fmt(p.compare_at_price)):'';
var pre=(p.preselect&&typeof p.preselect==='object')?p.preselect:null;
var preKeys=pre?Object.keys(pre):[];
var preLabel=preKeys.map(function(k){return esc(String(pre[k]))}).join(' · ');
/* "Select size" until every option the product has (size, width…) is known. */
var toPick=(Array.isArray(p.choose)?p.choose:[]).filter(function(n){return !preKeys.some(function(k){return k.toLowerCase()===String(n).toLowerCase()})});
/* One short label for every card ("Select size"); the picker asks for the rest. */
var firstPick=toPick.filter(function(n){return /size/i.test(n)})[0]||toPick[0];
var ctaText=toPick.length?'Select '+String(firstPick).toLowerCase():'Add to cart';
var buyBtn='<button type="button" class="ai-chat-product-cta ai-chat-atc" data-atc aria-label="'+(toPick.length?esc(ctaText)+' for '+t:'Add '+t+(preLabel?', '+preLabel+',':'')+' to cart')+'">'+esc(ctaText)+'</button>';
/* Buy now only once nothing is left to choose (size, width, the rest). */
var nowBtn=BUY_ON&&!toPick.length&&p.handle?'<button type="button" class="ai-buynow" data-buynow aria-label="Buy now, '+t+(preLabel?', '+preLabel:'')+': straight to checkout">Buy now</button>':'';
var tiles=useTiles===true||FITC_ON||!!fitcClean(p.fit);
var fitBtn=tiles?'':cardHelper(p,t);
/* Off: with a fit tool, the buy button and the tool share one row; Buy now
   joins them (beside the buy button where there's room, under it where not). */
var buyHtml=fitBtn||nowBtn?'<div class="ai-chat-viz-actions ai-chat-buy-row'+(nowBtn?' has-buynow':'')+(fitBtn?' has-tool':'')+'">'+buyBtn+nowBtn+fitBtn+'</div>':buyBtn;
var imgHtml=img?'<a class="ai-chat-product-img" href="'+esc(u)+'" tabindex="-1" aria-hidden="true"><img src="'+esc(img)+'" alt="" loading="lazy"></a>':'';
var infoHtml='<div class="ai-chat-product-info">'+
  '<a class="ai-chat-product-title" href="'+esc(u)+'">'+t+'</a>'+
  '<div class="ai-chat-product-price">'+pr+(cp?'<span class="compare-at">'+cp+'</span>':'')+(preLabel?'<span class="ai-chat-product-variant">'+preLabel+'</span>':'')+'</div>'+
  buyHtml+
  (tiles?fitFold(p,t,u):viewLink(u))+
'</div>';
return '<div class="ai-chat-product-card" data-handle="'+esc(p.handle||'')+'" data-title="'+t+'" data-url="'+esc(u)+'" data-image="'+esc(img)+'"'+(pre?' data-preselect="'+esc(JSON.stringify(pre))+'"':'')+'>'+imgHtml+infoHtml+'</div>';
}

/* ── Compare ──────────────────────────────────────────────────────────────
   Side by side, from the store's own data. Two ways in: the shopper asks
   (the assistant's compare_products tool sends the table with its reply), or
   taps Compare under a row of product cards — straight away for 2 or 3
   cards, picking 2 or 3 when there are more. That path asks the server for
   the table directly (/apps/hajirai/compare), no model in between.
   Price and rating head each column, with the lower price and the higher
   rating marked; the rows lead with what differs ("Differences"), and "All
   details" shows everything. Values the store doesn't list say so — nothing
   is filled in. Each column has its own Add to cart (live sizes and stock). */
var COMPARE_URL='/apps/hajirai/compare';
/* Which widget build the store is serving (console: window.__hajiraiWidget). */
try{window.__hajiraiWidget='2026-10-29 feedback'}catch(e){}
var CMP_MAX=3;
/* On a phone you pick two; a three-way comparison (when the shopper names
   three) scrolls sideways there. */
function cmpIsPhone(){return !!(PHONE_BAR&&PHONE_BAR.matches)}
function cmpMax(){return cmpIsPhone()?2:CMP_MAX}
function cmpPickHint(){return cmpMax()===2?'Pick 2':'Pick 2 or 3'}
var pendingCompare=null;
/* A button under the reply that opens one of the store's Typeforms. */
var pendingForm=null,pendingMap=null;
/* The back-in-stock card under a reply (the server's restock_cta): the
   shopper's email goes from here straight to the store's Klaviyo, for that
   one variant — never through the assistant. */
var pendingRestock=null;
/* "View all 16 women's sale boots": when the search behind the cards matched
   more than they show, every match opens in the sheet — the chat's own
   search, so exactly what the assistant found, each with Add to cart. A page
   at a time: the first comes with the reply, the others from
   /apps/hajirai/view-all (the same search, sent back), kept once loaded, and
   the next one fetched ahead so stepping forward is instant. */
var pendingViewAll=null,viewAllStore={},viewAllSeq=0,VA_MAX=48;
var VIEW_ALL_URL='/apps/hajirai/view-all';
var VA_PREV='<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M15 5l-7 7 7 7"/></svg>';
var VA_NEXT='<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9 5l7 7-7 7"/></svg>';
function vaCard(c){
  if(!c||typeof c!=='object'||!c.handle||!c.title)return null;
  return {handle:String(c.handle),title:String(c.title),url:String(c.url||''),image:String(c.image||''),price:c.price||'',price_formatted:String(c.price_formatted||''),compare_at_price:c.compare_at_price||undefined,kind:c.kind||'',choose:Array.isArray(c.choose)?c.choose.slice(0,4):undefined,fit:fitcClean(c.fit)||undefined};
}
var VA_ICON='<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6"/></svg>';
function cleanViewAll(p){
  if(!p||!Array.isArray(p.products))return null;
  var list=[];
  for(var i=0;i<p.products.length&&list.length<VA_MAX;i++){var c=vaCard(p.products[i]);if(c)list.push(c)}
  if(list.length<2)return null;
  var total=Math.max(parseInt(p.total,10)||0,list.length);
  /* The search behind the list, sent back as-is for the other pages. */
  var search=null;
  if(p.search&&typeof p.search==='object'&&!Array.isArray(p.search)){try{var js=JSON.stringify(p.search);if(js.length<=1500)search=JSON.parse(js)}catch(e){}}
  return {label:String(p.label||'').trim().slice(0,80)||('View all '+total),title:String(p.title||'').trim().slice(0,48)||'All matches',total:total,products:list,search:search,pageSize:Math.min(Math.max(parseInt(p.pageSize,10)||list.length,1),VA_MAX)};
}
/* Pages: only when the server can send the rest (older saved chats can't). */
function vaPaged(va){return !!(va.search&&va.total>va.products.length)}
function vaPages(va){return vaPaged(va)?Math.max(1,Math.ceil(va.total/va.pageSize)):1}
function vaCountText(va){
  if(!vaPaged(va))return va.total>va.products.length?'Showing '+va.products.length+' of '+va.total:va.total+' results';
  var a=(va.page-1)*va.pageSize+1,b=Math.min(va.page*va.pageSize,va.total);
  return a+'\u2013'+b+' of '+va.total;
}
function vaPagerHtml(){
  return '<div class="ai-va-dock"><div class="ai-va-error" role="alert" hidden></div>'+
    '<nav class="ai-va-pager" aria-label="Pages"><button type="button" class="ai-va-pager__btn" data-va-step="-1" aria-label="Previous page">'+VA_PREV+'</button>'+
    '<span class="ai-va-pager__label" aria-hidden="true"></span>'+
    '<button type="button" class="ai-va-pager__btn" data-va-step="1" aria-label="Next page">'+VA_NEXT+'</button></nav></div>';
}
/* Show page n (already loaded) in the list. */
function vaShow(va,box,n){
  va.page=n;
  var items=va.cache[n]||[],h='';
  va.cards=va.cards||{};
  for(var i=0;i<items.length;i++){h+=prodCard(items[i],fitcAny(va.products));va.cards[items[i].handle]=items[i]}
  var grid=$('.ai-chat-products--grid',box);if(grid)grid.innerHTML=h;
  var empty=$('.ai-va-empty',box);if(empty)empty.hidden=true;
  var cnt=$('.ai-chat-viewall__count',box);if(cnt)cnt.textContent=vaCountText(va);
  vaPagerShow(box,n,vaPages(va));
}
function vaPagerShow(box,n,last){
  var pager=$('.ai-va-pager',box);
  if(pager){
    pager.hidden=last<=1;
    var lab=$('.ai-va-pager__label',pager),prev=$('[data-va-step="-1"]',pager),next=$('[data-va-step="1"]',pager);
    if(lab)lab.textContent='Page '+n+' of '+last;
    /* A page button that's just been switched off hands focus to the other. */
    var had=document.activeElement;
    if(prev)prev.disabled=n<=1;
    if(next)next.disabled=n>=last;
    if(had&&had.disabled&&(had===prev||had===next)){var other=had===next?prev:next;try{(other&&!other.disabled?other:box).focus({preventScroll:true})}catch(e){}}
    if(next)next.setAttribute('aria-label',n<last?'Next page, '+(n+1)+' of '+last:'Next page');
    if(prev)prev.setAttribute('aria-label',n>1?'Previous page, '+(n-1)+' of '+last:'Previous page');
  }
}
function vaFetch(va,n){
  va.inflight=va.inflight||{};
  if(va.inflight[n])return va.inflight[n];
  var req=retFetch(VIEW_ALL_URL+'?search='+encodeURIComponent(JSON.stringify(va.search))+'&page='+n,{},12000).then(function(r){
    var d=r.d||{},list=[];
    if(r.status!==200||!d.ok||!Array.isArray(d.products))throw new Error('page');
    d.products.forEach(function(c){var x=vaCard(c);if(x)list.push(x)});
    if(!list.length)throw new Error('empty');
    var got=parseInt(d.page,10)||n;
    va.cache[got]=list;
    if(parseInt(d.total,10)>0)va.total=parseInt(d.total,10);
    return got;
  });
  va.inflight[n]=req;
  req.then(function(){delete va.inflight[n]},function(){delete va.inflight[n]});
  return req;
}
/* The page after this one, quietly, so Next is instant. */
function vaPrefetch(va,n){if(vaPaged(va)&&n<=vaPages(va)&&!va.cache[n])vaFetch(va,n).catch(function(){})}
function vaGo(box,n,btn){
  var va=viewAllStore[box.getAttribute('data-va')];
  if(!va||!vaPaged(va)||va.loading||n<1||n>vaPages(va))return;
  var err=$('.ai-va-error',box);if(err){err.hidden=true;err.innerHTML=''}
  var done=function(page){vaShow(va,box,page);box.scrollTop=0;vaPrefetch(va,page+1)};
  if(window.dataLayer)try{window.dataLayer.push({event:'chat_view_all_page',chat_view_all_page:n})}catch(e){}
  if(va.cache[n]){done(n);return}
  va.loading=true;box.classList.add('is-loading');box.setAttribute('aria-busy','true');if(btn)btn.classList.add('is-busy');
  var finish=function(){va.loading=false;box.classList.remove('is-loading');box.removeAttribute('aria-busy');if(btn)btn.classList.remove('is-busy')};
  vaFetch(va,n).then(function(page){finish();if(box.getAttribute('data-va')===va.id&&!vaFiltered(va))done(page)},function(){
    finish();
    if(err&&box.getAttribute('data-va')===va.id){err.innerHTML='<span>Page '+n+' couldn\u2019t load.</span><button type="button" data-va-retry="'+n+'">Try again</button>';err.hidden=false}
  });
}
function viewAllHtml(va,shown){
  /* A copy for the sheet: its loaded pages never go into the saved chat. */
  var id='va'+(++viewAllSeq);viewAllStore[id]=Object.assign({},va,{id:id,page:1,cache:{1:va.products}});
  var seen={};(shown||[]).forEach(function(x){if(x&&x.handle)seen[x.handle]=1});
  var more=va.products.filter(function(x){return !seen[x.handle]});
  var rest=va.total-(va.products.length-more.length);
  var hint=rest+' more to browse';
  return '<div class="ai-va-cta"><button type="button" class="ai-cmp-cta__btn" data-viewall="'+id+'" aria-haspopup="dialog" aria-label="'+esc(va.label+' — '+hint)+'"><span class="ai-cmp-cta__icon">'+VA_ICON+'</span><span class="ai-cmp-cta__text"><span class="ai-cmp-cta__label">'+esc(va.label)+'</span><span class="ai-cmp-cta__hint">'+esc(hint)+'</span></span></button></div>';
}
/* Right under the cards, above Compare. */
function placeViewAll(bubble,va,shown){
  if(!bubble||!va)return;
  var html=viewAllHtml(va,shown);
  /* With Compare: the two side by side (View all the wider), on phones one above the other. */
  var cmp=bubble.querySelector('.ai-cmp-cta');
  if(cmp){var pair=document.createElement('div');pair.className='ai-cta-pair';pair.innerHTML='<div class="ai-cta-pair__in"></div>';cmp.parentNode.insertBefore(pair,cmp);var pin=pair.firstChild;pin.insertAdjacentHTML('beforeend',html);pin.appendChild(cmp);return}
  var row=bubble.querySelector('.ai-chat-products-wrap')||bubble.querySelector('.ai-chat-products');
  if(row)row.insertAdjacentHTML('afterend',html);else bubble.insertAdjacentHTML('beforeend',html);
}
function openViewAll(opener,id){
  var va=viewAllStore[id];if(!va)return;
  fbOpener=opener||null;
  var sh=fbSheetEl(),box=$('.ai-chat-fbsheet__list',sh);
  sheetKind='list';
  sheetTitle=va.title;
  $('.ai-chat-fbsheet__title',sh).textContent=sheetTitle;
  sh.setAttribute('aria-label',sheetTitle);
  sh.setAttribute('data-kind','list');
  $('.ai-chat-fbsheet__state',sh).innerHTML='';
  sh.classList.remove('is-failed');sh.classList.add('is-ready');
  if(box.getAttribute('data-va')!==id){
    /* The chat's own card style, as a grid (no sideways scrolling), a page
       at a time with the page buttons floating at the bottom. The filters
       go on top once their index is in (a placeholder holds their place). */
    var h=(va.search?'<div class="ai-vf is-loading" aria-hidden="true"><div class="ai-vf__row"><span class="ai-vf__ph"></span><span class="ai-vf__ph"></span><span class="ai-vf__ph"></span><span class="ai-vf__ph is-short"></span></div></div>':'')+
      '<p class="ai-chat-viewall__count" aria-live="polite"></p><div class="ai-chat-products ai-chat-products--grid'+(PRODUCT_CARD_STYLE==='showcase'?' ai-chat-products--showcase':'')+'"></div>'+
      '<div class="ai-va-empty" hidden><p>No styles match these filters.</p><button type="button" data-vf-clear="1">Clear filters</button></div>';
    if(va.total>va.products.length)h+='<p class="ai-chat-viewall__more">Tell the chat a size, color or style to narrow these down.</p>';
    if(vaPaged(va)||va.search)h+=vaPagerHtml();
    box.innerHTML=h;box.setAttribute('data-va',id);box.classList.toggle('is-paged',vaPaged(va));
    vaShow(va,box,va.page||1);box.scrollTop=0;
    vaPrefetch(va,(va.page||1)+1);
    if(va.search)vaLoadIndex(va,box);
  }else if(va.ix){vfRenderBar(va,box)}
  menu.style.display='none';
  /* On a computer the chat grows into a wide view for browsing. */
  vaWiden();
  sh.hidden=false;void sh.offsetWidth;sh.classList.add('is-open');
  fbBehind(true);
  setTimeout(function(){var b=$('.ai-chat-fbsheet__back',sh);if(b)try{b.focus({preventScroll:true})}catch(e){}},60);
  if(window.dataLayer)try{window.dataLayer.push({event:'chat_view_all_open',chat_view_all_count:va.total})}catch(e){}
}
/* ── View all: the wide view ───────────────────────────────────────────────
   On a computer, View all grows the chat into a wide browsing view (four or
   five cards a row) in one smooth resize, and shrinks it back the same way
   on the way out; on a phone the sheet is already full screen. Nothing
   reflows while the window moves: the list is laid out at its final size
   from the start (and fades in as the window settles), and the conversation
   steps out of the layout once the list covers it. */
var vaWide=false,vaFrom=null,vaKeepScroll=0,vaTimers=[],VA_MORPH_MS=560;
function vaReduce(){return !!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches)}
function vaCanWiden(){return window.innerWidth>=900&&window.innerHeight>=520&&!(window.matchMedia&&window.matchMedia('(max-width: 767px)').matches)}
function vaTarget(){return{w:Math.round(Math.max(Math.min(panelW,window.innerWidth-16),Math.min(1440,window.innerWidth-48))),h:Math.round(Math.max(360,window.innerHeight-40))}}
function vaNarrowSize(){return{w:Math.round(Math.min(panelW,window.innerWidth-16)),h:Math.round(Math.min(window.innerHeight*0.85,window.innerHeight-40))}}
function vaLater(ms,fn){vaTimers.push(setTimeout(fn,ms))}
function vaClearTimers(){while(vaTimers.length)clearTimeout(vaTimers.pop())}
function vaSetSize(w,h){panel.style.width=w+'px';panel.style.height=h+'px'}
function vaWiden(){
  if(vaWide||!vaCanWiden())return false;
  vaClearTimers();
  var r=panel.getBoundingClientRect(),t=vaTarget();
  vaWide=true;vaFrom={w:Math.round(r.width),h:Math.round(r.height)};
  vaKeepScroll=msgsEl.scrollTop;
  panel.style.setProperty('--va-w',t.w+'px');panel.style.setProperty('--va-h',t.h+'px');
  panel.classList.remove('is-va-out');
  vaSetSize(vaFrom.w,vaFrom.h);
  panel.classList.add('is-wide','is-va-morph');
  if(vaReduce()||!isOpen){vaSetSize(t.w,t.h);panel.classList.add('is-va-full','is-va-in');panel.classList.remove('is-va-morph');return true}
  void panel.offsetWidth;
  panel.classList.add('is-va-anim');
  vaSetSize(t.w,t.h);
  vaLater(170,function(){panel.classList.add('is-va-full')});
  vaLater(Math.round(VA_MORPH_MS*0.42),function(){panel.classList.add('is-va-in')});
  vaLater(VA_MORPH_MS+40,function(){panel.classList.remove('is-va-morph','is-va-anim')});
  return true;
}
/* Back to the chat's size: the list fades out, the window shrinks, the
   conversation is back underneath, then after() lets the sheet fade away. */
function vaNarrow(after){
  if(!vaWide){if(after)after();return}
  vaClearTimers();
  var r=panel.getBoundingClientRect(),t=vaFrom||vaNarrowSize();
  if(vaReduce()||!isOpen){vaNarrowNow();if(after)after();return}
  panel.style.setProperty('--va-w',Math.round(r.width)+'px');panel.style.setProperty('--va-h',Math.round(r.height)+'px');
  panel.classList.remove('is-va-in');
  panel.classList.add('is-va-morph','is-va-out');
  vaLater(130,function(){panel.classList.add('is-va-anim');vaSetSize(t.w,t.h)});
  vaLater(130+VA_MORPH_MS,function(){
    vaWide=false;
    panel.classList.remove('is-va-full','is-va-morph','is-va-anim');
    panel.style.width=panelW+'px';panel.style.height='';
    try{msgsEl.scrollTop=vaKeepScroll}catch(e){}
    /* The conversation is laid out again in this frame; the sheet starts
       to fade in the next one, so the fade gets every frame. */
    requestAnimationFrame(function(){requestAnimationFrame(function(){
      if(vaWide)return;
      if(after)after();
      /* The sheet fades out in the wide style; once it's gone, it's an
         ordinary sheet again. */
      vaLater(480,function(){if(vaWide)return;panel.classList.remove('is-wide','is-va-out');panel.style.removeProperty('--va-w');panel.style.removeProperty('--va-h')});
    })});
  });
}
function vaNarrowNow(){
  vaClearTimers();
  if(!vaWide&&!panel.classList.contains('is-wide'))return;
  vaWide=false;
  panel.classList.remove('is-wide','is-va-morph','is-va-anim','is-va-full','is-va-in','is-va-out');
  panel.style.width=panelW+'px';panel.style.height='';
  panel.style.removeProperty('--va-w');panel.style.removeProperty('--va-h');
  try{msgsEl.scrollTop=vaKeepScroll}catch(e){}
}
window.addEventListener('resize',function(){
  if(!vaWide)return;
  if(!vaCanWiden()){vaNarrowNow();return}
  if(panel.classList.contains('is-va-anim'))return;
  var t=vaTarget();vaSetSize(t.w,t.h);
  panel.style.setProperty('--va-w',t.w+'px');panel.style.setProperty('--va-h',t.h+'px');
  vaFrom=vaNarrowSize();
  vfPlace();
});

/* ── View all: filters ─────────────────────────────────────────────────────
   Sticky on top of the list, built from an index of every match
   (/apps/hajirai/view-all?index=1: sizes and widths in stock — paired, so
   "8, Wide" means a pair that's both — colors, type, gender, foot needs,
   price, sale, rating; the same catalog facts the assistant searches). The
   browser filters, counts and sorts with it, so results change the moment
   a filter is tapped. Cards a filter brings up that haven't been seen yet
   come from the server by handle, and are kept. With no filter (and the
   best-match order) the pages come from the server exactly as before.
   On a wide list each filter opens as a panel under its button; on a
   narrow one, as a sheet from the bottom. */
var VF_KEYS=['size','width','color','price','type','line','needs'];
var VF_NAME={size:'Size',width:'Width',color:'Color',price:'Price',type:'Type',line:'Gender',needs:'Helps with',sale:'On sale',sort:'Sort',all:'Filters'};
var VF_SORTS=[['best','Best match'],['price_low','Price: Low to High'],['price_high','Price: High to Low'],['rating','Top rated']];
/* Swatches for the color groups (the server names the groups). */
var VF_SW={black:'#1d1d1f',white:'#ffffff',grey:'#a1a1a6',navy:'#26365c',blue:'#3b7ddd',red:'#cf3a3f',pink:'#f0a3c2',purple:'#8d5fd0',green:'#4f8f61',yellow:'#f4cc3f',orange:'#ee8a35',brown:'#7d5134',tan:'#d9c29e',
  metallic:'linear-gradient(135deg,#f7e9bd 0%,#caa74c 45%,#f4e8c8 62%,#b48f33 100%)',multi:'conic-gradient(#e2574c,#f2c53d,#4fb06c,#3d7bd9,#9c5fcb,#e2574c)',other:'repeating-linear-gradient(135deg,#cfcfd4 0 3px,#f2f2f5 3px 6px)'};
var VF_CHEV='<svg class="ai-vf__chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6.5 9.5l5.5 5.5 5.5-5.5"/></svg>';
var VF_TUNE='<svg class="ai-vf__ic" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M4 7.5h9.5M17.5 7.5H20M4 16.5h3M11 16.5h9"/><circle cx="15.5" cy="7.5" r="2"/><circle cx="9" cy="16.5" r="2"/></svg>';
var VF_SORTI='<svg class="ai-vf__ic" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M8 5v14M4.5 8.5L8 5l3.5 3.5M16 19V5M12.5 15.5L16 19l3.5-3.5"/></svg>';
var VF_TAG='<svg class="ai-vf__ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3.5 12.6V5a1.5 1.5 0 011.5-1.5h7.6a1.5 1.5 0 011.06.44l6.9 6.9a1.5 1.5 0 010 2.12l-7.6 7.6a1.5 1.5 0 01-2.12 0l-6.9-6.9a1.5 1.5 0 01-.44-1.06z"/><circle cx="8.2" cy="8.2" r="1.4"/></svg>';
var VF_XS='<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M7 7l10 10M17 7L7 17"/></svg>';
var VF_XL='<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>';
var VF_SKEL='<div class="ai-va-skel__img"></div><div class="ai-va-skel__line"></div><div class="ai-va-skel__line is-short"></div><div class="ai-va-skel__btn"></div>';
var vfOpen=null,vfRaf=0;

function vfEmpty(){return{sel:{size:{},width:{},color:{},type:{},line:{},needs:{}},sale:false,pmin:null,pmax:null}}
/* The index as the server sent it, checked and bounded. */
function vfClean(d){
  var f=d.facets||{};
  var vals=function(x){return x&&Array.isArray(x.values)?x.values.slice(0,300).map(function(v){return{k:String(v&&v.k||'').slice(0,40),l:String(v&&v.l||'').slice(0,40),n:parseInt(v&&v.n,10)||0}}):[]};
  var ord=function(x,n){var o=x&&Array.isArray(x.order)?x.order.filter(function(i){return typeof i==='number'&&i>=0&&i<n}):[];if(o.length!==n){o=[];for(var i=0;i<n;i++)o.push(i)}return o};
  var F={size:{unit:String(f.size&&f.size.unit||'').slice(0,6),values:vals(f.size)},width:{values:vals(f.width)},color:{values:vals(f.color)},type:{values:vals(f.type)},line:{values:vals(f.line)},needs:{values:vals(f.needs)},
    price:f.price&&isFinite(f.price.min)&&isFinite(f.price.max)&&+f.price.max>=+f.price.min?{min:Math.floor(+f.price.min),max:Math.ceil(+f.price.max)}:null,sale:parseInt(f.sale,10)||0,rated:parseInt(f.rated,10)||0};
  ['size','width'].forEach(function(k){F[k].order=ord(null,F[k].values.length)});
  ['color','type','line','needs'].forEach(function(k){F[k].order=ord(f[k],F[k].values.length)});
  var nums=function(a){return Array.isArray(a)?a.filter(function(x){return typeof x==='number'}):[]};
  var items=[];
  for(var i=0;i<d.items.length&&items.length<2000;i++){
    var it=d.items[i];if(!it||typeof it.h!=='string'||!it.h)continue;
    items.push({h:it.h,sw:Array.isArray(it.sw)?it.sw.filter(function(p){return Array.isArray(p)&&p.length===2}):[],c:nums(it.c),t:typeof it.t==='number'?it.t:null,l:nums(it.l),n:nums(it.n),
      p:typeof it.p==='number'?it.p:null,s:it.s===1,r:typeof it.r==='number'?it.r:null,rc:typeof it.rc==='number'?it.rc:0,i:items.length});
  }
  return items.length>1?{facets:F,items:items}:null;
}
function vaLoadIndex(va,box){
  if(va.ix||va.ixLoading)return;
  va.ixLoading=true;
  retFetch(VIEW_ALL_URL+'?search='+encodeURIComponent(JSON.stringify(va.search))+'&index=1',{},12000).then(function(r){
    var d=r.d||{};
    if(r.status!==200||!d.ok||!Array.isArray(d.items)||!d.facets)throw new Error('index');
    var ix=vfClean(d);if(!ix)throw new Error('index');
    va.ix=ix;va.f=va.f||vfEmpty();va.sort=va.sort||'best';
    if(box.getAttribute('data-va')===va.id)vfRenderBar(va,box);
  }).catch(function(){
    /* No filters this time: the list works as before. */
    if(box.getAttribute('data-va')===va.id){var ph=$('.ai-vf.is-loading',box);if(ph)ph.remove()}
  }).then(function(){va.ixLoading=false});
}

function vfAny(o){for(var k in o)if(o[k])return true;return false}
function vfHasAny(arr,o){for(var i=0;i<arr.length;i++)if(o[arr[i]])return true;return false}
function vfOn(va){if(!va.f)return false;var s=va.f.sel;for(var k in s)if(vfAny(s[k]))return true;return va.f.sale||va.f.pmin!=null||va.f.pmax!=null}
function vaFiltered(va){return !!(va&&va.ix&&(vfOn(va)||(va.sort&&va.sort!=='best')))}
function vfActiveCount(va){var n=0,s=va.f.sel;for(var k in s)for(var v in s[k])if(s[k][v])n++;if(va.f.sale)n++;if(va.f.pmin!=null||va.f.pmax!=null)n++;return n}
function vfHas(va,k){
  var F=va.ix.facets,total=va.ix.items.length;
  if(k==='price')return !!(F.price&&F.price.max-F.price.min>=10);
  if(k==='sale')return F.sale>0&&F.sale<total;
  if(k==='needs')return F.needs.values.length>1||(F.needs.values.length===1&&F.needs.values[0].n<total);
  return !!(F[k]&&F[k].values.length>1);
}
/* Does a product pass every filter (but `skip`)? Size and width are
   checked on the same pair. */
function vfPass(va,it,skip){
  var f=va.f,s=f.sel;
  var sz=skip!=='size'&&vfAny(s.size),wd=skip!=='width'&&vfAny(s.width);
  if(sz||wd){
    var ok=false;
    for(var i=0;i<it.sw.length&&!ok;i++){var p=it.sw[i];if((!sz||s.size[p[0]])&&(!wd||s.width[p[1]]))ok=true}
    if(!ok)return false;
  }
  if(skip!=='color'&&vfAny(s.color)&&!vfHasAny(it.c,s.color))return false;
  if(skip!=='type'&&vfAny(s.type)&&!(it.t!=null&&s.type[it.t]))return false;
  if(skip!=='line'&&vfAny(s.line)&&!vfHasAny(it.l,s.line))return false;
  if(skip!=='needs'&&vfAny(s.needs)&&!vfHasAny(it.n,s.needs))return false;
  if(skip!=='sale'&&f.sale&&!it.s)return false;
  if(skip!=='price'&&(f.pmin!=null||f.pmax!=null)){
    if(it.p==null)return false;
    if(f.pmin!=null&&it.p<Math.round(f.pmin*100))return false;
    if(f.pmax!=null&&it.p>Math.round(f.pmax*100))return false;
  }
  return true;
}
/* How many products each value of a filter would show, with the others as set. */
function vfCounts(va,key){
  var out={},items=va.ix.items,s=va.f.sel,pick={color:'c',line:'l',needs:'n'}[key];
  for(var i=0;i<items.length;i++){
    var it=items[i];if(!vfPass(va,it,key))continue;
    if(key==='size'||key==='width'){
      var other=key==='size'?s.width:s.size,oa=vfAny(other),seen={};
      for(var j=0;j<it.sw.length;j++){var p=it.sw[j],v=key==='size'?p[0]:p[1],o=key==='size'?p[1]:p[0];if(v<0||seen[v]||(oa&&!other[o]))continue;seen[v]=1;out[v]=(out[v]||0)+1}
    }else{
      var vals=key==='type'?(it.t!=null?[it.t]:[]):(it[pick]||[]);
      for(var q=0;q<vals.length;q++)out[vals[q]]=(out[vals[q]]||0)+1;
    }
  }
  return out;
}
function vfList(va){
  var items=va.ix.items,out=[];
  for(var i=0;i<items.length;i++)if(vfPass(va,items[i],''))out.push(items[i]);
  var sort=va.sort||'best',big=1e12;
  if(sort==='price_low')out.sort(function(a,b){return (a.p==null?big:a.p)-(b.p==null?big:b.p)||a.i-b.i});
  else if(sort==='price_high')out.sort(function(a,b){return (b.p==null?-1:b.p)-(a.p==null?-1:a.p)||a.i-b.i});
  else if(sort==='rating')out.sort(function(a,b){return (b.r==null?-1:b.r)-(a.r==null?-1:a.r)||b.rc-a.rc||a.i-b.i});
  return out;
}
function vfSig(va){return JSON.stringify([va.f,va.sort])}

/* Cards by handle, a request per 48, each handle asked for once. */
function vaCardsFor(va,handles){
  va.cards=va.cards||{};va.cardReq=va.cardReq||{};va.gone=va.gone||{};
  var need=[],wait=[];
  handles.forEach(function(h){if(va.cards[h]||va.gone[h])return;if(va.cardReq[h])wait.push(va.cardReq[h]);else need.push(h)});
  for(var i=0;i<need.length;i+=48)(function(chunk){
    var req=retFetch(VIEW_ALL_URL+'?handles='+chunk.map(encodeURIComponent).join(','),{},12000).then(function(r){
      var d=r.d||{};
      if(r.status!==200||!d.ok||!Array.isArray(d.products))throw new Error('cards');
      var got={};
      d.products.forEach(function(c){var x=vaCard(c);if(x){va.cards[x.handle]=x;got[x.handle]=1}});
      chunk.forEach(function(h){if(!got[h])va.gone[h]=1});
    });
    chunk.forEach(function(h){va.cardReq[h]=req});
    var drop=function(){chunk.forEach(function(h){if(va.cardReq[h]===req)delete va.cardReq[h]})};
    req.then(drop,drop);
    wait.push(req);
  })(need.slice(i,i+48));
  return Promise.all(wait);
}
/* A filtered page: the cards already here at once, the rest as soft
   placeholders until they arrive. */
function vaShowF(va,box,n){
  var list=vfList(va),total=list.length,size=va.pageSize||24,last=Math.max(1,Math.ceil(total/size));
  n=Math.min(Math.max(n||1,1),last);va.fpage=n;
  var slice=list.slice((n-1)*size,n*size),h='',miss=[];
  va.cards=va.cards||{};va.gone=va.gone||{};
  for(var i=0;i<slice.length;i++){
    var hd=slice[i].h,c=va.cards[hd];
    if(c)h+=prodCard(c,fitcAny(va.products));
    else if(!va.gone[hd]){h+='<div class="ai-chat-product-card is-skel" data-skel="'+esc(hd)+'" aria-hidden="true">'+VF_SKEL+'</div>';miss.push(hd)}
  }
  var grid=$('.ai-chat-products--grid',box);if(grid)grid.innerHTML=h;
  var empty=$('.ai-va-empty',box);if(empty)empty.hidden=total>0;
  var cnt=$('.ai-chat-viewall__count',box);
  if(cnt)cnt.textContent=!total?'No matches':total>size?((n-1)*size+1)+'–'+Math.min(n*size,total)+' of '+total:total+(total===1?' result':' results');
  var err=$('.ai-va-error',box);if(err){err.hidden=true;err.innerHTML=''}
  vaPagerShow(box,n,last);
  var sig=vfSig(va)+'|'+n;va.fsig=sig;
  var still=function(){return va.fsig===sig&&box.getAttribute('data-va')===va.id};
  if(miss.length){
    box.setAttribute('aria-busy','true');
    vaCardsFor(va,miss).then(function(){if(still()){box.removeAttribute('aria-busy');vfFill(va,box)}},function(){
      if(!still())return;
      box.removeAttribute('aria-busy');vfFill(va,box);
      if(err&&$('[data-skel]',box)){err.innerHTML='<span>Some styles couldn’t load.</span><button type="button" data-va-retry="'+n+'">Try again</button>';err.hidden=false}
    });
  }else box.removeAttribute('aria-busy');
  /* The next page's cards, quietly, so Next is instant. */
  if(n<last){var nx=list.slice(n*size,(n+1)*size).map(function(x){return x.h}).filter(function(x){return !va.cards[x]&&!va.gone[x]});if(nx.length)vaCardsFor(va,nx).catch(function(){})}
}
function vfFill(va,box){
  var sk=box.querySelectorAll('[data-skel]');
  for(var i=0;i<sk.length;i++){
    var h=sk[i].getAttribute('data-skel'),c=va.cards[h];
    if(c){var tmp=document.createElement('div');tmp.innerHTML=prodCard(c,fitcAny(va.products));var card=tmp.firstChild;card.classList.add('is-in');sk[i].replaceWith(card)}
    else if(va.gone[h])sk[i].remove();
  }
}
function vaStep(box,d,btn){
  var va=viewAllStore[box.getAttribute('data-va')];if(!va||!d)return;
  if(vaFiltered(va)){
    var last=Math.max(1,Math.ceil(vfList(va).length/(va.pageSize||24))),n=(va.fpage||1)+d;
    if(n<1||n>last)return;
    vaShowF(va,box,n);box.scrollTop=0;
    if(window.dataLayer)try{window.dataLayer.push({event:'chat_view_all_page',chat_view_all_page:n})}catch(e){}
    return;
  }
  vaGo(box,(va.page||1)+d,btn);
}

/* The filter bar: one button per filter the matches can use, Sort at the
   end, and the chosen values as chips underneath. */
function vfRenderBar(va,box){
  /* "Filters" (all of them at once) only when there's something to filter by. */
  var any=VF_KEYS.some(function(k){return vfHas(va,k)})||vfHas(va,'sale');
  var pills=any?'<button type="button" class="ai-vf__pill ai-vf__all" data-vf-open="all" aria-haspopup="dialog" aria-expanded="false">'+VF_TUNE+'<span class="ai-vf__pill-t">Filters</span><span class="ai-vf__badge" hidden></span></button>':'';
  VF_KEYS.forEach(function(k){
    if(vfHas(va,k))pills+='<button type="button" class="ai-vf__pill" data-vf-open="'+k+'" aria-haspopup="dialog" aria-expanded="false"><span class="ai-vf__pill-t">'+VF_NAME[k]+'</span><span class="ai-vf__pill-v" hidden></span>'+VF_CHEV+'</button>';
  });
  if(vfHas(va,'sale'))pills+='<button type="button" class="ai-vf__pill ai-vf__toggle" data-vf-toggle="sale" aria-pressed="false">'+VF_TAG+'<span class="ai-vf__pill-t">On sale</span></button>';
  var html='<div class="ai-vf" role="group" aria-label="Filter and sort"><div class="ai-vf__row"><div class="ai-vf__pills">'+pills+'</div>'+
    '<button type="button" class="ai-vf__sort" data-vf-open="sort" aria-haspopup="dialog" aria-expanded="false">'+VF_SORTI+'<span class="ai-vf__sort-t">Sort:</span><span class="ai-vf__sort-v"></span>'+VF_CHEV+'</button></div>'+
    '<div class="ai-vf__chips" hidden></div></div>';
  var old=$('.ai-vf',box);
  if(old)old.outerHTML=html;else box.insertAdjacentHTML('afterbegin',html);
  vfSync(va,box);
}
function vfMoney(n){return '$'+Math.round(n)}
function vfPriceText(va){
  var f=va.f;if(f.pmin==null&&f.pmax==null)return '';
  if(f.pmin!=null&&f.pmax!=null)return vfMoney(f.pmin)+'–'+vfMoney(f.pmax);
  return f.pmax!=null?'Under '+vfMoney(f.pmax):vfMoney(f.pmin)+'+';
}
/* "10.5 - 11" → "10.5–11": a size range reads as one size. */
function vfSizeLabel(l){return String(l).replace(/(\d)\s*[-\u2013]\s*(\d)/g,'$1\u2013$2')}
function vfValueLabel(va,k,v){var x=va.ix.facets[k].values[v];return x?(k==='size'?vfSizeLabel(x.l):x.l):''}
/* Size keys as wide as the longest size needs, on one line. */
function vfKeyWidth(va){var n=0;va.ix.facets.size.values.forEach(function(v){n=Math.max(n,vfSizeLabel(v.l).length)});return Math.max(54,Math.round(n*8.6+24))}
function vfPillText(va,k){
  if(k==='price')return vfPriceText(va);
  var sel=va.f.sel[k],on=[];for(var v in sel)if(sel[v])on.push(+v);
  if(!on.length)return '';
  return on.length>1?String(on.length):vfValueLabel(va,k,on[0]);
}
function vfSortName(s){for(var i=0;i<VF_SORTS.length;i++)if(VF_SORTS[i][0]===s)return VF_SORTS[i][1];return VF_SORTS[0][1]}
function vfChipsHtml(va){
  var h='',F=va.ix.facets,unit=F.size.unit;
  VF_KEYS.forEach(function(k){
    if(k==='price'){var pt=vfPriceText(va);if(pt)h+='<button type="button" class="ai-vf__chip" data-vf-rm="price" aria-label="Remove price '+esc(pt)+'">'+esc(pt)+VF_XS+'</button>';return}
    var sel=va.f.sel[k];
    F[k].order.forEach(function(i){
      if(!sel[i])return;
      var l=vfValueLabel(va,k,i),shown=k==='size'?'Size '+l+(unit?' '+unit:''):l;
      h+='<button type="button" class="ai-vf__chip" data-vf-rm="'+k+':'+i+'" aria-label="Remove '+esc(shown)+'">'+esc(shown)+VF_XS+'</button>';
    });
  });
  if(va.f.sale)h+='<button type="button" class="ai-vf__chip" data-vf-rm="sale" aria-label="Remove On sale">On sale'+VF_XS+'</button>';
  return h?h+'<button type="button" class="ai-vf__clear" data-vf-clear="1">Clear all</button>':'';
}
/* The bar shows what's chosen. */
function vfSync(va,box){
  var bar=$('.ai-vf',box);if(!bar||!va.ix)return;
  var pills=bar.querySelectorAll('[data-vf-open]');
  for(var i=0;i<pills.length;i++){
    var p=pills[i],k=p.getAttribute('data-vf-open');
    if(k==='sort'){$('.ai-vf__sort-v',p).textContent=vfSortName(va.sort);p.classList.toggle('is-on',va.sort!=='best');p.setAttribute('aria-label','Sort: '+vfSortName(va.sort));continue}
    if(k==='all'){var n=vfActiveCount(va),b=$('.ai-vf__badge',p);b.textContent=n;b.hidden=!n;p.classList.toggle('is-on',n>0);p.setAttribute('aria-label',n?'Filters, '+n+' on':'Filters');continue}
    var v=vfPillText(va,k),ve=$('.ai-vf__pill-v',p);
    ve.textContent=v;ve.hidden=!v;p.classList.toggle('is-on',!!v);
    p.setAttribute('aria-label',VF_NAME[k]+(v?', '+(/^\d+$/.test(v)&&k!=='size'?v+' chosen':v):''));
  }
  var sale=$('[data-vf-toggle="sale"]',bar);
  if(sale){sale.setAttribute('aria-pressed',va.f.sale?'true':'false');sale.classList.toggle('is-on',va.f.sale)}
  var chips=$('.ai-vf__chips',bar),ch=vfChipsHtml(va);
  if(chips){chips.innerHTML=ch;chips.hidden=!ch}
}
/* A filter changed: back to page 1 of what now matches. */
function vfApply(va,box,src){
  vfSync(va,box);
  if(vaFiltered(va))vaShowF(va,box,1);
  else{va.fsig='';vaShow(va,box,1);vaPrefetch(va,2)}
  box.scrollTop=0;
  vfPopSync(src);
}
function vfReset(va,k){
  if(k==='all'){var keep=va.sort;va.f=vfEmpty();va.sort=keep;return}
  if(k==='price'){va.f.pmin=null;va.f.pmax=null;return}
  if(k==='sale'){va.f.sale=false;return}
  if(va.f.sel[k])va.f.sel[k]={};
}

/* The panel for one filter (or all of them, or Sort). */
function vfShowText(va){var n=vfList(va).length;return n?'Show '+n+(n===1?' result':' results'):'No matches'}
function vfTitle(va,k){var u=va.ix.facets.size.unit;return k==='size'&&u?'Size ('+u+')':VF_NAME[k]}
function vfPriceStep(P){var span=P.max-P.min;return span<=100?5:span<=400?10:25}
function vfPresets(P){
  var cuts=[],i,c;
  for(c=50;c<P.max;c+=50)if(c>P.min+5&&c<P.max-5)cuts.push(c);
  if(!cuts.length)for(c=25;c<P.max;c+=25)if(c>P.min+5&&c<P.max-5)cuts.push(c);
  cuts=cuts.slice(0,3);
  if(!cuts.length)return [];
  var out=[[null,cuts[0]-0.01,'Under '+vfMoney(cuts[0])]];
  for(i=1;i<cuts.length;i++)out.push([cuts[i-1],cuts[i]-0.01,vfMoney(cuts[i-1])+'–'+vfMoney(cuts[i])]);
  out.push([cuts[cuts.length-1],null,vfMoney(cuts[cuts.length-1])+'+']);
  return out;
}
function vfPct(P,v){return P.max>P.min?Math.round((v-P.min)/(P.max-P.min)*1000)/10:0}
function vfPriceHtml(va){
  var P=va.ix.facets.price,step=vfPriceStep(P);
  var lo=va.f.pmin!=null?Math.max(P.min,Math.round(va.f.pmin)):P.min,hi=va.f.pmax!=null?Math.min(P.max,Math.round(va.f.pmax)):P.max;
  var pre=vfPresets(P).map(function(p){
    var on=va.f.pmin===p[0]&&va.f.pmax===p[1];
    return '<button type="button" class="ai-vf-preset" data-vf-preset="'+(p[0]==null?'':p[0])+'_'+(p[1]==null?'':p[1])+'" aria-pressed="'+on+'">'+esc(p[2])+'</button>';
  }).join('');
  return '<div class="ai-vf-price"><div class="ai-vf-price__vals" aria-hidden="true"><span class="ai-vf-price__v" data-vf-plo>'+vfMoney(lo)+'</span><span class="ai-vf-price__to">to</span><span class="ai-vf-price__v" data-vf-phi>'+vfMoney(hi)+'</span></div>'+
    '<div class="ai-vf-range" style="--lo:'+vfPct(P,lo)+'%;--hi:'+vfPct(P,hi)+'%"><div class="ai-vf-range__track"><div class="ai-vf-range__fill"></div></div>'+
    '<input type="range" min="'+P.min+'" max="'+P.max+'" step="'+step+'" value="'+lo+'" data-vf-range="lo" aria-label="Lowest price" aria-valuetext="'+vfMoney(lo)+'">'+
    '<input type="range" min="'+P.min+'" max="'+P.max+'" step="'+step+'" value="'+hi+'" data-vf-range="hi" aria-label="Highest price" aria-valuetext="'+vfMoney(hi)+'"></div>'+
    (pre?'<div class="ai-vf-presets" role="group" aria-label="Price ranges">'+pre+'</div>':'')+'</div>';
}
function vfBody(va,kind){
  var F=va.ix.facets,h='';
  if(kind==='all'){
    VF_KEYS.forEach(function(k){if(vfHas(va,k))h+='<section class="ai-vf-sec"><h3 class="ai-vf-sec__h">'+esc(vfTitle(va,k))+'</h3>'+vfBody(va,k)+'</section>'});
    if(vfHas(va,'sale'))h+='<section class="ai-vf-sec"><button type="button" class="ai-vf-switchrow" role="switch" data-vf-toggle="sale" aria-checked="'+(va.f.sale?'true':'false')+'"><span>On sale only</span><span class="ai-vf-switch" aria-hidden="true"></span></button></section>';
    return h;
  }
  if(kind==='sort'){
    h='<div class="ai-vf-list" role="radiogroup" aria-label="Sort by">';
    VF_SORTS.forEach(function(s){
      if(s[0]==='rating'&&F.rated<3)return;
      var on=(va.sort||'best')===s[0];
      h+='<button type="button" class="ai-vf-opt is-radio" role="radio" aria-checked="'+on+'" data-vf-sort="'+s[0]+'"><span class="ai-vf-mark" aria-hidden="true"></span><span class="ai-vf-opt__l">'+s[1]+'</span></button>';
    });
    return h+'</div>';
  }
  if(kind==='price')return vfPriceHtml(va);
  var X=F[kind],counts=vfCounts(va,kind),sel=va.f.sel[kind];
  if(kind==='size'){
    h='<div class="ai-vf-sizes" role="group" aria-label="'+esc(vfTitle(va,'size'))+'" style="--vf-key:'+vfKeyWidth(va)+'px">';
    X.order.forEach(function(i){var v=X.values[i],n=counts[i]||0,on=!!sel[i];h+='<button type="button" class="ai-vf-size" data-vf="size" data-v="'+i+'" aria-pressed="'+on+'"'+(!n&&!on?' disabled':'')+'>'+esc(vfSizeLabel(v.l))+'</button>'});
    return h+'</div>';
  }
  if(kind==='color'){
    h='<div class="ai-vf-colors" role="group" aria-label="Colors">';
    X.order.forEach(function(i){var v=X.values[i],n=counts[i]||0,on=!!sel[i];h+='<button type="button" class="ai-vf-sw" data-vf="color" data-v="'+i+'" data-k="'+esc(v.k)+'" aria-pressed="'+on+'"'+(!n&&!on?' disabled':'')+'><span class="ai-vf-sw__dot" style="background:'+(VF_SW[v.k]||VF_SW.other)+'"></span><span class="ai-vf-sw__l">'+esc(v.l)+'</span><span class="ai-vf-n">'+n+'</span></button>'});
    return h+'</div>';
  }
  h='<div class="ai-vf-list" role="group" aria-label="'+esc(VF_NAME[kind])+'">';
  X.order.forEach(function(i){var v=X.values[i],n=counts[i]||0,on=!!sel[i];h+='<button type="button" class="ai-vf-opt" role="checkbox" aria-checked="'+on+'" data-vf="'+kind+'" data-v="'+i+'"'+(!n&&!on?' disabled':'')+'><span class="ai-vf-mark" aria-hidden="true"></span><span class="ai-vf-opt__l">'+esc(v.l)+'</span><span class="ai-vf-n">'+n+'</span></button>'});
  return h+'</div>';
}
function vfCompact(box){return (box.clientWidth||0)<640}
function vfOpenPanel(va,box,kind,pill){
  vfClose(false);
  var sh=fbSheetEl(),compact=vfCompact(box);
  var pop=el('div','ai-vf-pop ai-vf-pop--'+kind+(compact?' is-sheet':''));
  pop.setAttribute('role','dialog');pop.setAttribute('aria-label',kind==='all'?'Filters':vfTitle(va,kind));pop.tabIndex=-1;
  /* Room for five size keys a row, however long the sizes are. */
  if(kind==='size'&&!compact)pop.style.width=Math.min(480,Math.max(352,vfKeyWidth(va)*5+32+36))+'px';
  var foot=kind==='sort'?'':'<div class="ai-vf-pop__foot"><button type="button" class="ai-vf-pop__reset" data-vf-reset="'+kind+'">'+(kind==='all'?'Clear all':'Clear')+'</button><button type="button" class="ai-vf-pop__done" data-vf-close="1">'+vfShowText(va)+'</button></div>';
  pop.innerHTML=(compact?'<div class="ai-vf-pop__grab" aria-hidden="true"></div>':'')+
    '<div class="ai-vf-pop__head"><span class="ai-vf-pop__title">'+esc(kind==='all'?'Filters':vfTitle(va,kind))+'</span><button type="button" class="ai-vf-pop__x" data-vf-close="1" aria-label="Close">'+VF_XL+'</button></div>'+
    '<div class="ai-vf-pop__body">'+vfBody(va,kind)+'</div>'+foot;
  var scrim=el('div','ai-vf-scrim'+(compact?' is-dim':''));scrim.setAttribute('data-vf-close','1');
  sh.appendChild(scrim);sh.appendChild(pop);
  vfOpen={va:va,box:box,kind:kind,pill:pill,pop:pop,scrim:scrim};
  if(pill)pill.setAttribute('aria-expanded','true');
  vfPlace();
  void pop.offsetWidth;
  pop.classList.add('is-open');scrim.classList.add('is-open');
  var first=pop.querySelector('.ai-vf-pop__body [aria-pressed="true"],.ai-vf-pop__body [aria-checked="true"],.ai-vf-pop__body button:not([disabled]),.ai-vf-pop__body input');
  setTimeout(function(){if(vfOpen&&vfOpen.pop===pop)try{(first||pop).focus({preventScroll:true})}catch(e){}},compact?200:20);
  if(window.dataLayer)try{window.dataLayer.push({event:'chat_view_all_filter_open',chat_view_all_filter:kind})}catch(e){}
}
function vfClose(refocus){
  if(!vfOpen)return;
  var o=vfOpen;vfOpen=null;
  if(o.pill)o.pill.setAttribute('aria-expanded','false');
  o.pop.classList.remove('is-open');o.scrim.classList.remove('is-open');
  var gone=function(){o.pop.remove();o.scrim.remove()};
  if(vaReduce())gone();else setTimeout(gone,260);
  if(refocus&&o.pill&&document.body.contains(o.pill))try{o.pill.focus({preventScroll:true})}catch(e){}
}
/* Under its button (kept inside the sheet), or a sheet from the bottom. */
function vfPlace(){
  if(!vfOpen||!fbSheet)return;
  var o=vfOpen,pop=o.pop;
  if(pop.classList.contains('is-sheet')){pop.style.left='';pop.style.top='';pop.style.maxHeight='';return}
  var sr=fbSheet.getBoundingClientRect(),pr=o.pill&&o.pill.getBoundingClientRect?o.pill.getBoundingClientRect():sr;
  var w=pop.offsetWidth||320,left=o.kind==='sort'?pr.right-sr.left-w:pr.left-sr.left;
  left=Math.max(12,Math.min(left,sr.width-w-12));
  var top=Math.round(pr.bottom-sr.top+8);
  pop.style.left=Math.round(left)+'px';pop.style.top=top+'px';pop.style.maxHeight=Math.max(220,Math.round(sr.height-top-16))+'px';
}
/* The open panel shows what's chosen and the new counts, in place (focus
   and a slider being dragged stay put). */
function vfPopSync(src){
  if(!vfOpen)return;
  var o=vfOpen,va=o.va,pop=o.pop,cache={};
  var btns=pop.querySelectorAll('[data-vf][data-v]');
  for(var i=0;i<btns.length;i++){
    var b=btns[i],k=b.getAttribute('data-vf'),v=+b.getAttribute('data-v');
    var counts=cache[k]||(cache[k]=vfCounts(va,k)),n=counts[v]||0,on=!!va.f.sel[k][v];
    b.setAttribute(b.getAttribute('role')==='checkbox'?'aria-checked':'aria-pressed',on?'true':'false');
    b.disabled=!n&&!on;
    var ne=$('.ai-vf-n',b);if(ne)ne.textContent=n;
  }
  var srt=pop.querySelectorAll('[data-vf-sort]');
  for(var s=0;s<srt.length;s++)srt[s].setAttribute('aria-checked',srt[s].getAttribute('data-vf-sort')===(va.sort||'best')?'true':'false');
  var sw=$('[data-vf-toggle="sale"]',pop);if(sw)sw.setAttribute('aria-checked',va.f.sale?'true':'false');
  var pres=pop.querySelectorAll('[data-vf-preset]');
  for(var q=0;q<pres.length;q++){var pp=vfPresetOf(pres[q]);pres[q].setAttribute('aria-pressed',va.f.pmin===pp[0]&&va.f.pmax===pp[1]?'true':'false')}
  if(src!=='range'){var rg=$('.ai-vf-range',pop);if(rg)vfRangeSet(va,rg)}
  var done=$('.ai-vf-pop__done',pop);if(done)done.textContent=vfShowText(va);
}
function vfPresetOf(b){var p=String(b.getAttribute('data-vf-preset')||'').split('_');return[p[0]===''?null:+p[0],p[1]===''?null:+p[1]]}
/* Put the slider where the price filter is. */
function vfRangeSet(va,wrap){
  var P=va.ix.facets.price,lo=$('[data-vf-range="lo"]',wrap),hi=$('[data-vf-range="hi"]',wrap);
  var a=va.f.pmin!=null?Math.max(P.min,Math.round(va.f.pmin)):P.min,b=va.f.pmax!=null?Math.min(P.max,Math.round(va.f.pmax)):P.max;
  lo.value=a;hi.value=b;vfRangePaint(wrap,P,+lo.value,+hi.value);
}
function vfRangePaint(wrap,P,a,b){
  wrap.style.setProperty('--lo',vfPct(P,a)+'%');wrap.style.setProperty('--hi',vfPct(P,b)+'%');
  var lo=$('[data-vf-range="lo"]',wrap),hi=$('[data-vf-range="hi"]',wrap);
  lo.setAttribute('aria-valuetext',vfMoney(a));hi.setAttribute('aria-valuetext',vfMoney(b));
  /* The thumb nearer the middle stays on top, so neither gets stuck. */
  lo.style.zIndex=a>P.min+(P.max-P.min)/2?4:3;
  var box=wrap.closest('.ai-vf-price');if(box){$('[data-vf-plo]',box).textContent=vfMoney(a);$('[data-vf-phi]',box).textContent=vfMoney(b)}
}
function vfRange(input){
  if(!vfOpen)return;
  var o=vfOpen,va=o.va,P=va.ix.facets.price,wrap=input.closest('.ai-vf-range');
  var lo=$('[data-vf-range="lo"]',wrap),hi=$('[data-vf-range="hi"]',wrap),step=+lo.step||5;
  var a=+lo.value,b=+hi.value;
  if(a>b-step){if(input===lo){a=Math.max(P.min,b-step);lo.value=a}else{b=Math.min(P.max,a+step);hi.value=b}}
  va.f.pmin=a<=P.min?null:a;va.f.pmax=b>=P.max?null:b;
  vfRangePaint(wrap,P,a,b);
  if(vfRaf)return;
  vfRaf=requestAnimationFrame(function(){vfRaf=0;if(vfOpen&&vfOpen.va===va)vfApply(va,o.box,'range')});
}
/* Every tap in the bar, a panel or the empty state. True when handled. */
function vfClick(e){
  var t=e.target;if(!t||!t.closest)return false;
  if(t.closest('[data-vf-close]')){e.preventDefault();vfClose(true);return true}
  var o=vfOpen,box=t.closest('.ai-chat-fbsheet__list')||(o&&t.closest('.ai-vf-pop')?o.box:null);
  var va=box&&viewAllStore[box.getAttribute('data-va')];
  if(!va||!va.ix)return false;
  var track=function(k){if(window.dataLayer)try{window.dataLayer.push({event:'chat_view_all_filter',chat_view_all_filter:k})}catch(x){}};
  var op=t.closest('[data-vf-open]');
  if(op){e.preventDefault();var k=op.getAttribute('data-vf-open');if(o&&o.kind===k&&o.pill===op)vfClose(true);else vfOpenPanel(va,box,k,op);return true}
  if(t.closest('[data-vf-toggle]')){e.preventDefault();va.f.sale=!va.f.sale;track('sale');vfApply(va,box);return true}
  var opt=t.closest('[data-vf][data-v]');
  if(opt){
    e.preventDefault();if(opt.disabled)return true;
    var fk=opt.getAttribute('data-vf'),fv=opt.getAttribute('data-v'),sel=va.f.sel[fk];
    if(sel[fv])delete sel[fv];else sel[fv]=1;
    track(fk);vfApply(va,box);return true;
  }
  var so=t.closest('[data-vf-sort]');
  if(so){e.preventDefault();va.sort=so.getAttribute('data-vf-sort');track('sort');vfApply(va,box);vfClose(true);return true}
  var pre=t.closest('[data-vf-preset]');
  if(pre){
    e.preventDefault();var pp=vfPresetOf(pre);
    if(va.f.pmin===pp[0]&&va.f.pmax===pp[1]){va.f.pmin=null;va.f.pmax=null}else{va.f.pmin=pp[0];va.f.pmax=pp[1]}
    track('price');vfApply(va,box);return true;
  }
  var rm=t.closest('[data-vf-rm]');
  if(rm){
    e.preventDefault();var part=rm.getAttribute('data-vf-rm').split(':');
    if(part[0]==='sale')va.f.sale=false;else if(part[0]==='price'){va.f.pmin=null;va.f.pmax=null}else if(va.f.sel[part[0]])delete va.f.sel[part[0]][part[1]];
    vfApply(va,box);
    var next=$('.ai-vf__chip',box)||$('.ai-vf__pill',box);if(next)try{next.focus({preventScroll:true})}catch(x){}
    return true;
  }
  var rs=t.closest('[data-vf-reset]');
  if(rs){e.preventDefault();vfReset(va,rs.getAttribute('data-vf-reset'));vfApply(va,box);return true}
  if(t.closest('[data-vf-clear]')){
    e.preventDefault();vfReset(va,'all');vfApply(va,box);
    var first=$('.ai-vf__pill',box);if(first)try{first.focus({preventScroll:true})}catch(x){}
    return true;
  }
  return false;
}
function mapCtaHtml(m){
  return '<button type="button" class="ai-chat-cta-btn ai-chat-form-cta" data-map="'+esc(m.mapId)+'" data-map-label="'+esc(m.label)+'" data-map-url="'+esc(m.url||'')+'" aria-haspopup="dialog">'+esc(m.label)+'</button>';
}
function cleanMap(p){
  if(!p||!/^[A-Za-z0-9]{6,32}$/.test(String(p.mapId||'')))return null;
  var u=String(p.url||'');
  return {mapId:String(p.mapId),label:String(p.label||'').trim().slice(0,40)||'Find a store near you',url:/^(\/(?!\/)|https:\/\/)[^\s<>"']*$/i.test(u)?u:''};
}
function formCtaHtml(f){
  return '<button type="button" class="ai-chat-cta-btn ai-chat-form-cta" data-form="'+esc(f.form)+'" data-form-label="'+esc(f.label)+'" aria-haspopup="dialog">'+esc(f.label)+'</button>';
}
/* Two arrows, one each way: the usual sign for compare in a shop. */
var CMP_ICON='<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4.5 8.5h14M15.5 5.5l3 3-3 3M19.5 15.5h-14M8.5 12.5l-3 3 3 3"/></svg>';
var CMP_PLUS='<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M12 6.5v11M6.5 12h11"/></svg>';
var CMP_X='<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M7 7l10 10M17 7L7 17"/></svg>';
var CMP_STAR='<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 3.2l2.7 5.5 6 .9-4.35 4.25 1 6L12 17l-5.35 2.85 1-6L3.3 9.6l6-.9z"/></svg>';
var CMP_CHECK='<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
/* The product handle in this page's URL (/products/<handle>, also under a
   collection or a locale prefix), or ''. */
function pageProductHandle(){
  try{var m=location.pathname.match(/\/products\/([^/?#]+)/);if(!m)return '';var h=decodeURIComponent(m[1]).toLowerCase();return /^[a-z0-9][a-z0-9-]{0,199}$/.test(h)?h:''}catch(e){return ''}
}
function cmpCards(products){return (products||[]).filter(function(p){return p&&p.handle})}
/* Under a row of 2+ product cards: one quiet row, in the chat's own style. */
function compareCtaHtml(products){
  var list=cmpCards(products);
  if(list.length<2)return '';
  var direct=list.length<=cmpMax();
  var label=direct?(list.length===2?'Compare these two':'Compare all three'):'Compare';
  var hint=direct?'Side by side':cmpPickHint();
  return '<div class="ai-cmp-cta"><button type="button" class="ai-cmp-cta__btn" data-cmp-start aria-label="'+esc(label+' — '+hint.toLowerCase())+'"><span class="ai-cmp-cta__icon">'+CMP_ICON+'</span><span class="ai-cmp-cta__text"><span class="ai-cmp-cta__label">'+esc(label)+'</span><span class="ai-cmp-cta__hint">'+esc(hint)+'</span></span><span class="ai-cmp-cta__go" aria-hidden="true"></span></button>'+
    /* Picking: the row turns into a tray — × to stop, a slot per pick (its
       photo; tap it to take it out), and the button, which says what's left
       to do until there are enough to compare. */
    '<div class="ai-cmp-bar" role="group" aria-label="Compare" hidden><button type="button" class="ai-cmp-bar__x" data-cmp-cancel aria-label="Cancel compare">'+CMP_X+'</button><span class="ai-cmp-bar__slots"></span><span class="ai-cmp-bar__msg ai-sr" aria-live="polite">'+cmpPickHint()+'</span><button type="button" class="ai-cmp-bar__go" data-cmp-go disabled>'+cmpPickHint()+'</button></div>'+
    '<div class="ai-cmp-cta__err" role="alert" hidden></div></div>';
}
function cmpBubbleCards(bubble){return Array.prototype.slice.call(bubble.querySelectorAll('.ai-chat-products .ai-chat-product-card[data-handle]'))}
function cmpPicked(bubble){return cmpBubbleCards(bubble).filter(function(c){return c.classList.contains('is-cmp-picked')})}
function cmpPickMode(bubble,on){
  var cta=$('.ai-cmp-cta',bubble);if(!cta)return;
  bubble.classList.toggle('is-cmp-picking',on);
  /* Coming back from picking, the row fades in where the tray was. */
  cta.classList.toggle('is-back',!on);
  $('.ai-cmp-cta__btn',cta).hidden=on;$('.ai-cmp-bar',cta).hidden=!on;
  cmpBubbleCards(bubble).forEach(function(c){
    var b=$('.ai-cmp-pick',c);
    if(on&&!b){b=document.createElement('button');b.type='button';b.className='ai-cmp-pick';b.setAttribute('data-cmp-pick','');b.innerHTML=CMP_PLUS+CMP_CHECK;c.appendChild(b)}
    if(b){b.hidden=!on;b.setAttribute('aria-pressed',c.classList.contains('is-cmp-picked')?'true':'false');b.setAttribute('aria-label','Compare '+(c.getAttribute('data-title')||'this product'))}
    if(!on)c.classList.remove('is-cmp-picked');
  });
  if(on)cmpPickUpdate(bubble);
  else{var s=$('.ai-cmp-bar__slots',cta);s.innerHTML='';s.removeAttribute('data-picked')}
}
function cmpPickUpdate(bubble){
  var cta=$('.ai-cmp-cta',bubble);if(!cta)return;
  var picked=cmpPicked(bubble),n=picked.length,max=cmpMax();
  $('.ai-cmp-bar__msg',cta).textContent=n===0?cmpPickHint():n===1?'Pick 1 more':n+' picked';
  var go=$('.ai-cmp-bar__go',cta);go.disabled=n<2;go.textContent=n>=2?'Compare '+n:n===1?'Pick 1 more':cmpPickHint();
  /* One slot per pick, in the cards' order; only a new one pops in. */
  var slots=$('.ai-cmp-bar__slots',cta),was=','+(slots.getAttribute('data-picked')||'')+',',hs=[],h='';
  for(var i=0;i<max;i++){
    var c=picked[i];
    if(!c){h+='<span class="ai-cmp-slot is-empty" aria-hidden="true">'+CMP_PLUS+'</span>';continue}
    var hd=c.getAttribute('data-handle'),im=c.getAttribute('data-image')||'';hs.push(hd);
    h+='<button type="button" class="ai-cmp-slot'+(was.indexOf(','+hd+',')<0?' is-new':'')+'" data-cmp-unpick="'+esc(hd)+'" aria-label="'+esc('Remove '+(c.getAttribute('data-title')||'this product')+' from compare')+'">'+(im?'<img src="'+esc(im)+'" alt="" loading="lazy">':'')+'<span class="ai-cmp-slot__x" aria-hidden="true">'+CMP_X+'</span></button>';
  }
  slots.innerHTML=h;slots.setAttribute('data-picked',hs.join(','));
  cmpBubbleCards(bubble).forEach(function(c){var b=$('.ai-cmp-pick',c);if(b)b.setAttribute('aria-pressed',c.classList.contains('is-cmp-picked')?'true':'false');c.classList.toggle('is-cmp-full',n>=max&&!c.classList.contains('is-cmp-picked'))});
}
function cmpToggle(card){
  var bubble=card.closest('.ai-chat-msg-bubble');if(!bubble)return;
  if(!card.classList.contains('is-cmp-picked')&&cmpPicked(bubble).length>=cmpMax()){
    /* Full: the slots give a little shake, and it's read out. */
    var m=$('.ai-cmp-bar__msg',bubble),s=$('.ai-cmp-bar__slots',bubble);
    if(m)m.textContent=cmpMax()+' at most';
    if(s){s.classList.remove('is-nudge');void s.offsetWidth;s.classList.add('is-nudge')}
    return;
  }
  card.classList.toggle('is-cmp-picked');cmpPickUpdate(bubble);
}
function cmpCancel(bubble){
  cmpErr(bubble,'');cmpPickMode(bubble,false);
  var sb=$('[data-cmp-start]',bubble);if(sb)try{sb.focus({preventScroll:true})}catch(e){}
}
/* A tap on a slot takes that one out; focus goes to its card's circle. */
function cmpUnpick(bubble,handle){
  var card=cmpBubbleCards(bubble).filter(function(c){return c.getAttribute('data-handle')===handle})[0];
  if(!card||!card.classList.contains('is-cmp-picked'))return;
  cmpToggle(card);
  var b=$('.ai-cmp-pick',card);if(b)try{b.focus({preventScroll:true})}catch(e){}
}
function cmpErr(bubble,msg){
  var e=$('.ai-cmp-cta__err',bubble);if(!e)return;
  e.textContent=msg;e.hidden=!msg;
}
function startCompare(bubble){
  var cards=cmpBubbleCards(bubble);
  if(cards.length<2)return;
  if(cards.length<=cmpMax()){runCompare(bubble,cards);return}
  cmpPickMode(bubble,true);
  var first=$('.ai-cmp-pick',cards[0]);if(first)try{first.focus({preventScroll:true})}catch(e){}
}
function runCompare(bubble,cards){
  if(isStreaming)return;
  var handles=cards.map(function(c){return c.getAttribute('data-handle')}).slice(0,cmpMax());
  var cta=$('.ai-cmp-cta',bubble),btn=cta&&(cta.querySelector('.ai-cmp-bar:not([hidden]) .ai-cmp-bar__go')||$('.ai-cmp-cta__btn',cta));
  cmpErr(bubble,'');
  if(btn){btn.disabled=true;btn.classList.add('is-busy');btn.setAttribute('aria-busy','true')}
  var done=function(){if(btn){btn.disabled=false;btn.classList.remove('is-busy');btn.removeAttribute('aria-busy')}};
  fetch(COMPARE_URL+'?handles='+encodeURIComponent(handles.join(',')),{credentials:'same-origin',headers:{'Accept':'application/json'}})
    .then(function(r){return r.json().catch(function(){return {}}).then(function(d){if(!r.ok||!d.ok||!d.comparison)throw new Error(d.message||'');return d})})
    .then(function(d){
      done();cmpPickMode(bubble,false);
      var cmp=d.comparison,names=cmp.products.map(function(p){return cmp.sameStyle?(p.name+(p.color?' in '+p.color:'')):p.name});
      var ask='Compare the '+(names.length===2?names[0]+' and '+names[1]:names.slice(0,-1).join(', ')+' and '+names[names.length-1]);
      appendMsg('user',ask);
      var intro=String(d.intro||'Here they are side by side.');
      var md2=appendMsg('assistant',intro);
      var b=$('.ai-chat-msg-bubble',md2);if(b)b.insertAdjacentHTML('beforeend',compareHtml(cmp));
      messages.push({role:'user',content:ask});
      messages.push({role:'assistant',content:intro,comparison:cmp,compared:cmpCompared(cmp)});
      saveH(messages);
      /* Show the table from its top, not the bottom of the chat. Scroll the
         message list only: scrollIntoView also scrolls the panel itself and
         pushes its header out of view. */
      scrollMsgTop(md2);
    })
    .catch(function(err){done();cmpErr(bubble,(err&&err.message)||'The comparison couldn’t load. Please try again.')});
}
function cmpCompared(cmp){return (cmp&&cmp.products||[]).map(function(p){return {title:p.title,price:p.priceLabel||''}})}
function cmpListHtml(items){
  if(!items||!items.length)return '';
  var h='<ul class="ai-cmp__list">';for(var i=0;i<items.length;i++)h+='<li>'+esc(items[i])+'</li>';return h+'</ul>';
}
/* A value the store doesn't list: a quiet dash (read out as "Not listed"). */
var CMP_NA='<span class="ai-cmp__na ai-cmp__dash"><span aria-hidden="true">\u2014</span><span class="ai-sr">Not listed</span></span>';
/* Nothing beyond what they all share (that's in the "Both" box above). */
var CMP_SAME='<span class="ai-cmp__na ai-cmp__dash"><span aria-hidden="true">\u2014</span><span class="ai-sr">Only what they share</span></span>';
function compareHtml(cmp){
  var P=cmp.products,n=P.length;
  var byKey={};cmp.rows.forEach(function(r){byKey[r.key]=r});
  var priceRow=byKey.price,ratingRow=byKey.rating;
  var rows=cmp.rows.filter(function(r){return r.key!=='price'&&r.key!=='rating'});
  var diffs=rows.filter(function(r){return r.differ}).length;
  var useToggle=diffs>0&&diffs<rows.length;
  var mode=diffs>0?'diffs':'all';
  var sr=function(i){return '<span class="ai-sr">'+esc(P[i].name)+': </span>'};
  var url=function(p){return safeUrl(p.url)||(SHOP_ROOT+'products/'+encodeURIComponent(p.handle))};
  var allNames=P.map(function(p){return p.name}).join(n===2?' and ':', ');
  var h='<div class="ai-cmp is-'+mode+(n>2?' is-wide':'')+'" style="--n:'+n+'" role="region" aria-label="'+esc('Comparison: '+allNames)+'">';
  /* Three on a phone: the table scrolls sideways (CSS), with this cue. */
  if(n>2)h+='<div class="ai-cmp__swipe" aria-hidden="true"><span>Swipe to see all '+n+'</span><span class="ai-cmp__dots">'+P.map(function(_,i){return '<i'+(i<2?' class="is-on"':'')+'></i>'}).join('')+'</span></div>';
  h+='<div class="ai-cmp__pane"><div class="ai-cmp__scroll">';
  /* Columns: photo, name, color, price, rating. */
  h+='<div class="ai-cmp__grid ai-cmp__heads">';
  P.forEach(function(p,i){
    var pv=priceRow&&priceRow.values[i],rv=ratingRow&&ratingRow.values[i];
    var bestP=priceRow&&priceRow.best===i,bestR=ratingRow&&ratingRow.best===i;
    h+='<div class="ai-cmp__col ai-cmp__head">'+
      '<a class="ai-cmp__img" href="'+esc(url(p))+'" tabindex="-1" aria-hidden="true">'+(p.image?'<img src="'+esc(p.image)+'" alt="" loading="lazy">':'')+'</a>'+
      '<a class="ai-cmp__name" href="'+esc(url(p))+'">'+esc(p.name)+'</a>'+
      (p.color&&!cmp.sameStyle?'<div class="ai-cmp__sub">'+esc(p.color)+'</div>':'')+
      (p.color&&cmp.sameStyle?'<div class="ai-cmp__sub is-strong">'+esc(p.color)+'</div>':'')+
      '<div class="ai-cmp__price">'+(pv?esc(pv.label)+(pv.compareAt?' <s>'+esc(pv.compareAt)+'</s>':''):CMP_NA)+'</div>'+
      (ratingRow?'<div class="ai-cmp__rating">'+(rv?'<span class="ai-cmp__stars" aria-label="'+esc(rv.avg+' out of 5 stars'+(rv.count!=null?', '+rv.count+' reviews':''))+'">'+CMP_STAR+'<b>'+esc(String(rv.avg))+'</b>'+(rv.count!=null?'<span class="ai-cmp__count">('+esc(String(rv.count))+')</span>':'')+'</span>':'<span class="ai-cmp__na">No reviews yet</span>')+'</div>':'')+
      ((bestP||bestR)?'<div class="ai-cmp__tags">'+(bestP?'<span class="ai-cmp__tag">'+esc(priceRow.bestLabel||'Lower price')+'</span>':'')+(bestR?'<span class="ai-cmp__tag">'+esc(ratingRow.bestLabel||'Higher rated')+'</span>':'')+'</div>':'')+
    '</div>';
  });
  h+='</div>';
  if(useToggle){
    h+='<div class="ai-cmp__seg" role="radiogroup" aria-label="Show">'+
      '<button type="button" role="radio" class="ai-cmp__segbtn" data-cmp-mode="diffs" aria-checked="'+(mode==='diffs')+'">Differences<span class="ai-cmp__segn">'+diffs+'</span></button>'+
      '<button type="button" role="radio" class="ai-cmp__segbtn" data-cmp-mode="all" aria-checked="'+(mode==='all')+'">All details</button></div>';
  }else if(cmp.sameStyle||!diffs){
    h+='<div class="ai-cmp__note">'+(cmp.sameStyle?'Same style — built the same, only the color differs.':'These match on everything the store lists.')+'</div>';
  }
  h+='<div class="ai-cmp__rows">';
  rows.forEach(function(r){
    h+='<div class="ai-cmp__row'+(r.differ?' is-diff':'')+'" role="group" aria-label="'+esc(r.label)+'"><div class="ai-cmp__label">'+esc(r.label)+'</div>';
    /* What they all share comes first, right under the row's title. */
    if(r.type==='list'&&r.differ&&r.shared&&r.shared.length){
      h+='<div class="ai-cmp__both"><span class="ai-cmp__bothlabel">'+(n===2?'Both':'All '+n)+'</span>'+esc(r.shared.join(' · '))+'</div>';
    }
    h+='<div class="ai-cmp__grid">';
    for(var i=0;i<n;i++){
      var cell;
      if(r.type==='list'){
        var all=r.values[i]||[],uni=(r.unique&&r.unique[i])||[];
        cell='<div class="ai-cmp__a">'+(all.length?cmpListHtml(all):CMP_NA)+'</div>'+
          '<div class="ai-cmp__u">'+(uni.length?cmpListHtml(uni):(all.length?CMP_SAME:CMP_NA))+'</div>';
      }else{
        cell=r.values[i]?esc(String(r.values[i])):CMP_NA;
      }
      h+='<div class="ai-cmp__cell">'+sr(i)+cell+'</div>';
    }
    h+='</div></div>';
  });
  h+='</div></div><span class="ai-cmp__fade is-l" aria-hidden="true"></span><span class="ai-cmp__fade" aria-hidden="true"></span></div>';
  /* One buy button per column, pinned to the bottom of the chat while the
     table scrolls (each names its product, since the photos scroll away;
     prices are in the columns above).
     "Select size" until there's nothing left to choose, like the cards;
     sizes and stock are read live at the tap. */
  h+='<div class="ai-cmp__foot"><div class="ai-cmp__grid">';
  P.forEach(function(p){
    var u=url(p),t=esc(p.title||p.name);
    var choose=Array.isArray(p.choose)?p.choose:['Size'];
    var first=choose.filter(function(n){return /size/i.test(n)})[0]||choose[0];
    var label=choose.length?'Select '+String(first).toLowerCase():'Add to cart';
    h+='<div class="ai-cmp__col ai-cmp__buy" data-handle="'+esc(p.handle)+'" data-title="'+t+'" data-url="'+esc(u)+'" data-image="'+esc(p.image||'')+'">'+
      '<div class="ai-cmp__mini"><a class="ai-cmp__mininame" href="'+esc(u)+'">'+esc(p.name)+'<span class="ai-sr"> \u2014 view product</span></a></div>'+
      (p.inStock===false?'<span class="ai-cmp__na">Sold out</span>':'<button type="button" class="ai-cmp__atc" data-atc aria-label="'+(choose.length?esc(label)+' for '+t:'Add '+t+' to cart')+'">'+esc(label)+'</button>')+
      '</div>';
  });
  h+='</div></div></div>';
  return h;
}
/* Sideways scrolling (three on a phone): the table and its pinned buy row
   move as one. The one being touched leads; the other follows, so momentum
   never fights. The swipe dots and edge fade follow the position. */
var cmpLead=null;
function cmpScrollSetup(){
  var lead=function(e){var t=e.target&&e.target.closest&&e.target.closest('.ai-cmp__scroll,.ai-cmp__foot');if(t)cmpLead=t};
  ['touchstart','pointerdown','wheel','keydown','focusin'].forEach(function(ev){msgsEl.addEventListener(ev,lead,{passive:true,capture:true})});
  msgsEl.addEventListener('scroll',function(e){
    var t=e.target;if(!t||!t.classList||!(t.classList.contains('ai-cmp__scroll')||t.classList.contains('ai-cmp__foot')))return;
    var c=t.closest('.ai-cmp');if(!c)return;
    if(cmpLead&&cmpLead!==t&&c.contains(cmpLead))return;
    var other=$(t.classList.contains('ai-cmp__scroll')?'.ai-cmp__foot':'.ai-cmp__scroll',c);
    if(other&&Math.abs(other.scrollLeft-t.scrollLeft)>0.5)other.scrollLeft=t.scrollLeft;
    var x=t.scrollLeft,w=t.clientWidth,max=t.scrollWidth-w;
    c.classList.toggle('is-end',x>=max-2);c.classList.toggle('is-moved',x>2);
    var dots=c.querySelectorAll('.ai-cmp__dots i'),cols=c.querySelectorAll('.ai-cmp__heads > .ai-cmp__col');
    for(var i=0;i<dots.length&&i<cols.length;i++){var l=cols[i].offsetLeft,r=l+cols[i].offsetWidth;dots[i].classList.toggle('is-on',Math.min(r,x+w)-Math.max(l,x)>(r-l)/2)}
  },true);
  /* The buy row pins to the very bottom of the chat, not short of it by the
     list's bottom padding (which would leave a see-through gap). */
  var pad=function(){try{msgsEl.style.setProperty('--msgs-pad-b',getComputedStyle(msgsEl).paddingBottom)}catch(e){}};
  pad();window.addEventListener('resize',pad);
}
cmpScrollSetup();
function cmpMode(btn){
  var root=btn.closest('.ai-cmp');if(!root)return;
  var m=btn.getAttribute('data-cmp-mode');
  root.classList.toggle('is-diffs',m==='diffs');root.classList.toggle('is-all',m==='all');
  Array.prototype.forEach.call(root.querySelectorAll('[data-cmp-mode]'),function(b){b.setAttribute('aria-checked',String(b===btn))});
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
/* Buy now on a card: the variant the card already names (sold out → the
   picker, to choose another), straight to checkout. */
function startBuyNow(card,btn){
  if(!card||btn.classList.contains('is-busy'))return;
  var handle=card.getAttribute('data-handle');
  var pre=null;try{pre=JSON.parse(card.getAttribute('data-preselect')||'null')}catch(_){}
  setBusy(btn,true);
  fetchProductJs(handle).then(function(product){
    var m=optModel(product),sel=initialSelection(m,pre);
    var v=selectionComplete(m,sel)?variantFor(m,sel):null;
    if(v&&v.available)return buyNowGo(v.id).catch(function(err){setBusy(btn,false);openAtcPanel(card,product,m,sel,{error:err.message||'We couldn\u2019t start checkout. Please try again.'})});
    setBusy(btn,false);
    var keep={};m.opts.forEach(function(op){if(op.values.length===1)keep[op.name]=sel[op.name]});
    openAtcPanel(card,product,m,keep,{note:'That one is sold out right now \u2014 choose another.'});
  }).catch(function(){
    setBusy(btn,false);
    openAtcPanel(card,null,null,{},{error:'We couldn\u2019t load the sizes right now.'});
  });
}
/* Straight to checkout with one item, credited to the chat (the order's
   _seos_attributed, as Add to cart sets, and _seos_buy_now; "ava-chat" as
   its referral code), with the store's code. An empty cart goes by a cart
   link that carries all of it; a cart with other things in it is kept — the
   item joins it, then checkout. Rejects with what to tell the shopper; on
   success the page leaves. */
function buyNowGo(vid){
  var id=parseInt(vid,10),code=BUY_CODE;
  if(!(id>0))return Promise.reject(new Error('That one can\u2019t be bought here right now.'));
  var JS={'Content-Type':'application/json','Accept':'application/json'};
  var link=SHOP_ROOT+'cart/'+id+':1?attributes%5B_seos_attributed%5D=1&attributes%5B_seos_buy_now%5D=1&ref=ava-chat'+(code?'&discount='+encodeURIComponent(code):'');
  var checkout=code?SHOP_ROOT+'discount/'+encodeURIComponent(code)+'?redirect='+encodeURIComponent(SHOP_ROOT+'checkout'):SHOP_ROOT+'checkout';
  var fail=function(r,d){var err=new Error((d&&(d.description||d.message))||'We couldn\u2019t start checkout. Please try again.');err.status=r&&r.status;throw err};
  return fetch(SHOP_ROOT+'cart.js',{credentials:'same-origin',cache:'no-store',headers:{'Accept':'application/json'}})
    .then(function(r){return r.ok?r.json():fail(r)})
    .then(function(cart){
      if(cart&&cart.item_count===0)return link;
      return fetch(SHOP_ROOT+'cart/add.js',{method:'POST',credentials:'same-origin',headers:JS,body:JSON.stringify({items:[{id:id,quantity:1}]})})
        .then(function(r){return r.json().catch(function(){return{}}).then(function(d){if(!r.ok)fail(r,d)})})
        .then(function(){return fetch(SHOP_ROOT+'cart/update.js',{method:'POST',credentials:'same-origin',headers:JS,body:JSON.stringify({attributes:{_seos_attributed:'1',_seos_buy_now:'1'}})})})
        .then(function(r){if(!r.ok)fail(r);return checkout});
    })
    .then(function(url){avaActivity({kind:'checkout',source:'buy_now',variant:String(id)});rateNote('buy_now');location.assign(url)});
}
/* Checkout from the size picker, after adding (Shopify Analytics). */
document.addEventListener('click',function(e){
  var a=e.target&&e.target.closest&&e.target.closest('.ai-chat-atc-primary');
  if(a&&panel&&panel.contains(a))avaActivity({kind:'checkout',source:'checkout'});
},true);
/* Back from checkout (the page restored as it was left): Buy now is ready again. */
window.addEventListener('pageshow',function(e){
  if(!e.persisted)return;
  var b=document.querySelectorAll('.ai-buynow.is-busy');
  for(var i=0;i<b.length;i++)setBusy(b[i],false);
  /* The chat still open: how did it go? */
  if(isOpen&&ratePending())maybeAskRating();
});
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
  var inGrid=!!card.closest('.ai-chat-products--grid');
  var inline=!inGrid&&!card.closest('.ai-chat-viz-host')&&card.parentNode&&card.parentNode.children.length===1;
  if(inline){
    panel.classList.add('is-inline');
    card.classList.add('has-inline-picker');
    card.appendChild(panel);
  }else if(inGrid){
    /* In the "View all" grid: full width, right under the tapped card's row. */
    var last=card,nx=card.nextElementSibling;
    while(nx&&nx.classList.contains('ai-chat-product-card')&&nx.offsetTop===card.offsetTop){last=nx;nx=nx.nextElementSibling}
    last.parentNode.insertBefore(panel,last.nextSibling);
  }else{
    var anchor=card.closest('.ai-cmp')||card.closest('.ai-chat-viz-host')||card.closest('.ai-chat-products-wrap')||card.closest('.ai-chat-products')||card;
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
      '<div class="ai-chat-atc-addrow'+(canAdd&&BUY_ON?' has-buynow':'')+'">'+
        '<button type="button" class="ai-chat-atc-add" data-atc-add'+(canAdd?'':' disabled')+'>'+addLabel+'</button>'+
        (canAdd&&BUY_ON?'<button type="button" class="ai-buynow ai-buynow--picker" data-atc-buynow aria-label="Buy now, '+esc(title)+': straight to checkout">Buy now</button>':'')+
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
      /* All chosen, with Buy now: both buttons in view. */
      var addRow=panel.querySelector('.ai-chat-atc-addrow.has-buynow');
      if(addRow)keepInView(addRow);
      return;
    }
    var now=e.target.closest('[data-atc-buynow]');
    if(now&&!now.classList.contains('is-busy')){
      e.preventDefault();
      var bv=variantFor(m,sel);
      if(!bv||!bv.available)return;
      setBusy(now,true);
      buyNowGo(bv.id).catch(function(err){setBusy(now,false);delete productJsCache[card.getAttribute('data-handle')];render({error:err.message||'We couldn\u2019t start checkout. Please try again.'})});
      return;
    }
    var add=e.target.closest('[data-atc-add]');
    if(add&&!add.disabled){
      e.preventDefault();
      var v=variantFor(m,sel);
      if(!v||!v.available)return;
      setBusy(add,true);add.textContent='Adding\u2026';
      addToCart(v.id,1).then(function(){render({added:v});keepInView(panel)}).catch(function(err){
        delete productJsCache[card.getAttribute('data-handle')];
        render({error:err.message||'Could not add to cart.'});
      });
    }
  });
  panel.addEventListener('keydown',function(e){if(e.key==='Escape'){e.stopPropagation();closeAtcPanel(panel);var b=card.querySelector('[data-atc]');if(b)b.focus()}});
  render(state);
  keepInView(panel);
  var first=panel.querySelector('.ai-chat-atc-val:not(.is-out),.ai-chat-atc-primary,.ai-chat-atc-add:not([disabled])');
  if(first&&first.focus)try{first.focus({preventScroll:true})}catch(_){first.focus()}
}

/* Home → chat. The header shows the assistant's name only: no avatar once
   the conversation starts. */
function leaveHome(){panel.classList.remove('is-home');if(FOCUS)focusRingToLine()}
/* ── Orders & returns in the chat ──
   "Where's my order?": signed-in shoppers see their orders as cards
   (status, progress, items, tracking). Signed out, a sign-in card opens
   Shopify's own sign-in in a small window and the chat carries on once
   they're in. "Return an item" walks through items → reason → refund, or an
   exchange (the return plus the same shoe in the next size, ready to add). */
var RETURNS_URL='/apps/hajirai/returns';
var RESUME_KEY='hajirai_resume';
var SIGNED_IN_URL='/apps/hajirai/signed-in';
var pendingOrders=null,pendingLogin=null;
var ordersById={};
var RET_REASONS=[
  {key:'too_small',label:'Too small',change:'a bigger size'},
  {key:'too_large',label:'Too large',change:'a smaller size'},
  {key:'too_narrow',label:'Too narrow',change:'a wider width'},
  {key:'too_wide',label:'Too wide',change:'a narrower width'},
  {key:'changed_mind',label:'Changed my mind'},
  {key:'damaged',label:'Damaged or defective'},
  {key:'not_as_described',label:'Not as described'},
  {key:'other',label:'Other'}
];
/* How it goes back (Happy Returns, mail…), as the store offers them. */
var RET_METHODS=[];
/* Reasons with no return fee (Settings → Customer care → Return rules). */
var RET_FREE=[];
function retFeeWaived(reason){return RET_FREE.indexOf(reason)>-1}
var ORD_STEPS=['Ordered','Shipped','Out for delivery','Delivered'];
function fmtDay(d){if(!d)return'';try{var p=String(d).split('-');var dt=new Date(+p[0],+p[1]-1,+p[2]);return dt.toLocaleDateString(undefined,{month:'short',day:'numeric'})}catch(e){return d}}
function optLine(o){var v=[];for(var k in (o||{}))if(Object.prototype.hasOwnProperty.call(o,k))v.push(o[k]);return v.join(' · ')}
var ORD_ICON={bag:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 8h14l-1 12H6L5 8z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>',
  user:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0 1 16 0"/></svg>',
  check:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
  box:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8 12 3 3 8v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5M12 13v8M7.5 5.5l9 5"/></svg>',
  search:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>',
  lock:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9.5" rx="2.2"/><path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3"/></svg>',
  chev:'<svg class="ai-ordl__chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
  ext:'<svg class="ai-ordl__chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 16 16 8M10 8h6v6"/></svg>',
  truck:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6.5h11v9h-11zM13.5 9.5h4l3 3v3h-7"/><circle cx="6.5" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/></svg>',
  back:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 7 4.5 11.5 9 16"/><path d="M4.5 11.5H15a4.5 4.5 0 0 1 0 9h-2"/></svg>'};
/* The store's own tracking page and returns center (Settings), offered beside the chat's way. */
var ordPages={};
function cleanPages(p){var o={};if(p&&typeof p==='object'){if(/^https:\/\/[^\s"'<>]+$/i.test(String(p.track||'')))o.track=String(p.track);if(/^https:\/\/[^\s"'<>]+$/i.test(String(p.returns||'')))o.returns=String(p.returns)}return o}
function hostOf(u){try{return new URL(u).hostname.replace(/^www\./,'')}catch(e){return ''}}
/* Returns started for this order: what the server knows plus what this
   browser saw go through (so the card is right even before it asks again). */
function cardReturns(o){
  var out=(o.returns||[]).slice(),loc=doneGet(o.id);
  for(var i=0;i<loc.length;i++){var l=loc[i],dup=false;
    for(var j=0;j<out.length;j++)if((l.rma&&out[j].rma===l.rma)||String(out[j].lineIds)===String(l.lineIds))dup=true;
    if(!dup)out.push(l)}
  return out;
}
/* Items still free to return, after returns started in the chat. */
function returnableItems(o){
  var local=doneGet(o.id),fromLocal={};
  for(var k=0;k<local.length;k++)for(var m=0;m<(local[k].lineIds||[]).length;m++)fromLocal[local[k].lineIds[m]]=1;
  /* Server counts are already in returnable; only subtract what it hasn't seen yet. */
  var serverSeen={};for(var s=0;s<(o.returns||[]).length;s++)for(var t=0;t<(o.returns[s].lineIds||[]).length;t++)serverSeen[o.returns[s].lineIds[t]]=1;
  return (o.items||[]).filter(function(it){var left=it.returnable-((fromLocal[it.lineId]&&!serverSeen[it.lineId])?1:0);return left>0});
}
function orderCardHtml(o){
  ordersById[o.id]=o;
  var cancelled=o.stage==='cancelled';
  var started=cardReturns(o);
  var h='<div class="ai-ord'+(started.length?' is-returned':'')+'" data-ord="'+esc(o.id)+'">';
  h+='<div class="ai-ord__head"><div class="ai-ord__id"><div class="ai-ord__num">Order #'+esc(o.number)+'</div><div class="ai-ord__date">Placed '+esc(fmtDay(o.date))+'</div></div>';
  h+='<span class="ai-ord__pill is-'+esc(o.stage)+'">'+esc(o.stageLabel)+'</span></div>';
  if(!cancelled){
    h+='<ol class="ai-ord__steps" aria-label="Progress: '+esc(o.stageLabel)+'">';
    for(var i=0;i<ORD_STEPS.length;i++)h+='<li class="'+(i<=o.step?'is-done':'')+(i===o.step?' is-now':'')+'"><span class="ai-ord__dot"></span><span class="ai-ord__steplabel">'+ORD_STEPS[i]+'</span></li>';
    h+='</ol>';
    var when=o.deliveredAt?'Delivered '+fmtDay(o.deliveredAt):o.eta?'Arrives by '+fmtDay(o.eta):o.stage==='ordered'?'We’re getting it ready':'On its way';
    h+='<div class="ai-ord__when">'+esc(when)+(o.carrier?' <span class="ai-ord__carrier">· '+esc(o.carrier)+'</span>':'')+'</div>';
  }
  if(o.returnStatus&&!started.length)h+='<div class="ai-ord__return">'+esc(o.returnStatus)+'</div>';
  h+='<ul class="ai-ord__items">';
  var items=o.items||[];
  for(var j=0;j<Math.min(items.length,3);j++){var it=items[j];
    h+='<li class="ai-ord__item">'+(safeUrl(it.image)?'<img src="'+safeUrl(it.image)+'" alt="" loading="lazy">':'<span class="ai-ord__ph">'+ORD_ICON.bag+'</span>')+
      '<div class="ai-ord__itxt"><div class="ai-ord__ititle">'+esc(it.title)+'</div>'+(optLine(it.options)||it.quantity>1?'<div class="ai-ord__iopt">'+esc(optLine(it.options))+(it.quantity>1?(optLine(it.options)?' · ':'')+'Qty '+it.quantity:'')+'</div>':'')+'</div></li>';}
  if(items.length>3)h+='<li class="ai-ord__more">+'+(items.length-3)+' more</li>';
  h+='</ul>';
  /* Actions sit right under the items; returns started show below them. */
  /* In the Returns & exchanges card the return button comes first and
     leads; elsewhere tracking leads. */
  var rf=o.focus==='return';
  var track=safeUrl(o.trackUrl)&&!cancelled?'<a class="ai-ord__btn'+(rf?'':' is-primary')+'" href="'+safeUrl(o.trackUrl)+'" target="_blank" rel="noopener">Track package</a>':'';
  /* Looked up without signing in: returns need the shopper signed in. */
  var alt='',ret='';
  if(o.guest){if(!cancelled)ret='<button type="button" class="ai-ord__btn'+(rf?' is-primary':'')+'" data-ord-login="return">Sign in to return</button>';if(safeUrl(o.returnsPage))alt=safeUrl(o.returnsPage)}
  else if(o.canReturn&&returnableItems(o).length){
    /* The store's returns center is always an option too. */
    if(o.returnMode!=='page'&&safeUrl(o.returnsUrl))alt=safeUrl(o.returnsUrl);
    /* The store runs returns on its own page: open it with the order filled in. */
    if(o.returnMode==='page'){if(safeUrl(o.returnsUrl))ret='<a class="ai-ord__btn'+(rf?' is-primary':'')+'" href="'+safeUrl(o.returnsUrl)+'" target="_blank" rel="noopener">Start a return</a>'}
    else ret='<button type="button" class="ai-ord__btn'+(rf?' is-primary':'')+'" data-ord-return="'+esc(o.id)+'">'+(started.length?'Return another item':'Return an item')+'</button>';
  }
  else if(rf&&!cancelled&&ORD_WHY[o.returnBlocked])h+='<div class="ai-ord__why">'+ORD_WHY[o.returnBlocked]+'</div>';
  h+='<div class="ai-ord__actions">'+(rf?ret+track:track+ret)+'</div>';
  if(alt)h+='<a class="ai-ord__alt" href="'+alt+'" target="_blank" rel="noopener">Or use our returns center'+ORD_ICON.ext+'</a>';
  for(var r=0;r<started.length;r++)h+='<div class="ai-ret ai-ret--started">'+doneHtml(started[r],o)+'</div>';
  h+='</div>';
  return h;
}
function ordersHtml(list,max){
  var h='<div class="ai-ords">';
  for(var i=0;i<Math.min(list.length,max||3);i++)h+=orderCardHtml(list[i]);
  return h+'</div>';
}
/* Why an order has no return button (the Returns & exchanges card). */
var ORD_WHY={not_delivered:'Returns open once it\u2019s delivered.',not_shipped:'Returns open once it ships.',window_closed:'Past the return window.',nothing_left:'Everything in it is already being returned.',not_returnable:'Nothing in this order can be returned (gift cards, final sale).'};
function loginCardHtml(p){
  if(typeof p==='string')p={intent:p};
  /* Points: sign in to see them (no order lookup for those). */
  if(p&&p.intent==='rewards')return '<div class="ai-ord ai-ord--signin"><div class="ai-ord__signin-icon">'+ORD_ICON.user+'</div>'+
    '<div class="ai-ord__signin-text"><div class="ai-ord__num">Sign in to see your points</div><div class="ai-ord__date">Your rewards and orders, right here.</div></div>'+
    '<button type="button" class="ai-ord__btn is-primary" data-ord-login="rewards">Sign in</button></div>';
  var intent=p&&p.intent==='return'?'return':'track',pages=cleanPages(p&&p.pages);
  if(p&&p.pages)ordPages=pages;
  if(p&&(p.lookup||pages.track||pages.returns))return lookupCardHtml(intent,p.order||'',false,{lookup:!!p.lookup,pages:pages});
  if(!p||!p.lookup)return '<div class="ai-ord ai-ord--signin"><div class="ai-ord__signin-icon">'+ORD_ICON.user+'</div>'+
    '<div class="ai-ord__signin-text"><div class="ai-ord__num">Sign in to see your orders</div><div class="ai-ord__date">Track packages and start returns right here.</div></div>'+
    '<button type="button" class="ai-ord__btn is-primary" data-ord-login="'+intent+'">Sign in</button></div>';
}
/* Order status without signing in. Two ways in, one card: sign in (every
   order, returns), or look one order up with its number (or the
   confirmation code from the email) and the email it was placed with. The
   form goes straight to the store — never to the assistant — and both have
   to match. The order shows here only: it's never saved in this browser. */
var ORDER_LOOKUP_URL='/apps/hajirai/order-lookup';
var ordlSeq=0;
function lookupCardHtml(intent,order,open,opt){
  opt=opt||{lookup:true,pages:ordPages};
  var n=++ordlSeq,ret=intent==='return'||intent==='returns-card',f='ai-ordl-'+n,hint=/^[A-Za-z0-9-]{3,24}$/.test(order)?order:'',pg=opt.pages||{};
  var noHead=!!opt.noHead;
  var pageRow=function(url,icon,title,sub){return '<a class="ai-ordl__opt" href="'+esc(url)+'" target="_blank" rel="noopener"><span class="ai-ordl__oi">'+icon+'</span><span class="ai-ordl__ot"><b>'+title+'</b><span>'+esc(sub)+'</span></span>'+ORD_ICON.ext+'<span class="ai-sr"> (opens in a new tab)</span></a>'};
  var trackRow=pg.track&&!ret?pageRow(pg.track,ORD_ICON.truck,'Tracking page',hostOf(pg.track)||'Track your package'):'';
  var returnsRow=pg.returns&&ret?pageRow(pg.returns,ORD_ICON.back,'Returns center','Start your return there'):'';
  var lookupRow=opt.lookup?'<button type="button" class="ai-ordl__opt" data-ordl-open aria-expanded="'+(open?'true':'false')+'" aria-controls="'+f+'"><span class="ai-ordl__oi">'+ORD_ICON.search+'</span><span class="ai-ordl__ot"><b>'+(ret?'Order status':'Look up an order')+'</b><span>Order number and email</span></span>'+ORD_ICON.chev+'</button>':'';
  return '<div class="ai-ord ai-ordl" data-ordl>'+
    (noHead?'':'<div class="ai-ordl__head"><span class="ai-ordl__icon">'+(ret?ORD_ICON.back:ORD_ICON.box)+'</span><span class="ai-ordl__htxt"><span class="ai-ord__num">'+(ret?'Start a return':'Check on your order')+'</span><span class="ai-ord__date">'+(ret?(returnsRow?'Here in the chat, or on our returns center.':'Returns start here once you\u2019re signed in.'):'Its status, tracking and items.')+'</span></span></div>')+
    '<div class="ai-ordl__opts">'+
      '<button type="button" class="ai-ordl__opt" data-ord-login="'+intent+'"><span class="ai-ordl__oi is-ink">'+ORD_ICON.user+'</span><span class="ai-ordl__ot"><b>Sign in</b><span>'+(ret?'Start a return right here':'Every order, plus returns')+'</span></span>'+ORD_ICON.chev+'</button>'+
      returnsRow+lookupRow+
      (opt.lookup?'<form class="ai-ordl__form" id="'+f+'" novalidate'+(open?'':' hidden')+'>'+
        '<div class="ai-ordl__field"><label for="'+f+'-o">Order or confirmation number</label>'+
          '<input id="'+f+'-o" name="order" type="text" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="30" placeholder="e.g. 1234567" value="'+esc(hint)+'" aria-describedby="'+f+'-oh '+f+'-oe">'+
          '<span class="ai-ordl__hint" id="'+f+'-oh">It\u2019s in your order confirmation email.</span><span class="ai-ordl__ferr" id="'+f+'-oe" hidden></span></div>'+
        '<div class="ai-ordl__field"><label for="'+f+'-e">Email used for the order</label>'+
          '<input id="'+f+'-e" name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="254" placeholder="you@example.com" aria-describedby="'+f+'-ee">'+
          '<span class="ai-ordl__ferr" id="'+f+'-ee" hidden></span></div>'+
        '<div class="ai-ordl__err" role="alert" hidden></div>'+
        '<button type="submit" class="ai-ord__btn is-primary ai-ordl__go">Find my order</button>'+
        '<p class="ai-ordl__note">'+ORD_ICON.lock+'Used only to find it. Never saved.</p>'+
      '</form>':'')+
      trackRow+
    '</div></div>';
}
function ordlField(form,name,msg){
  var input=form.querySelector('[name="'+name+'"]'),err=form.querySelector('#'+input.id+'e');
  if(msg){input.setAttribute('aria-invalid','true');err.textContent=msg;err.hidden=false}
  else{input.removeAttribute('aria-invalid');err.textContent='';err.hidden=true}
}
function ordlOpen(btn,open){
  var form=document.getElementById(btn.getAttribute('aria-controls'));if(!form)return;
  if(open==null)open=form.hidden;
  form.hidden=!open;btn.setAttribute('aria-expanded',String(open));
  if(open){var first=form.querySelector('input[name="order"]');if(first&&first.value)first=form.querySelector('input[name="email"]');if(first)try{first.focus()}catch(e){}}
}
function ordlSubmit(form){
  if(form.__busy)return;
  var oIn=form.querySelector('[name="order"]'),eIn=form.querySelector('[name="email"]');
  var order=String(oIn.value||'').replace(/\s+/g,'').replace(/^#+/,''),email=String(eIn.value||'').trim();
  var bad={};
  if(!/^[A-Za-z0-9-]{3,24}$/.test(order))bad.order='Enter your order number or confirmation number.';
  if(email.length>254||!/^[^\s@<>()",;:]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(email))bad.email='Enter the email you used for the order.';
  ordlField(form,'order',bad.order);ordlField(form,'email',bad.email);
  var errBox=form.querySelector('.ai-ordl__err');errBox.hidden=true;
  if(bad.order||bad.email){try{(bad.order?oIn:eIn).focus()}catch(e){}return}
  var go=form.querySelector('.ai-ordl__go');
  form.__busy=true;go.disabled=true;go.classList.add('is-busy');go.setAttribute('aria-busy','true');
  var done=function(){form.__busy=false;go.disabled=false;go.classList.remove('is-busy');go.removeAttribute('aria-busy')};
  var fail=function(msg){done();errBox.textContent=msg;errBox.hidden=false};
  fetch(ORDER_LOOKUP_URL,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({order:order,email:email})})
    .then(function(r){return r.json().catch(function(){return {}}).then(function(d){return {status:r.status,d:d}})})
    .then(function(x){
      var d=x.d||{};
      if(x.status===200&&d.ok&&d.order&&d.order.number){done();ordlShow(form.closest('.ai-ordl'),d.order);return}
      if(x.status===400&&d.fields){done();ordlField(form,'order',d.fields.order);ordlField(form,'email',d.fields.email);return}
      if(x.status===403&&d.error==='off'){var row=form.closest('.ai-ordl').querySelector('[data-ordl-open]');if(row)row.remove();form.remove();return}
      /* Not found: the same words whatever was wrong — no hint which detail. */
      if(x.status===404){done();errBox.innerHTML='<b>We couldn\u2019t find an order with those details.</b><span>Check them against your confirmation email. Orders from the last 60 days can be looked up here.</span>';errBox.hidden=false;return}
      fail(d.message||'We couldn\u2019t look that up right now. Please try again in a moment.');
    })
    .catch(function(){fail('We couldn\u2019t look that up right now. Please try again in a moment.')});
}
/* The order, in place of the form. The assistant learns its status (never
   the email) for follow-up questions in this visit only. */
function ordlShow(card,o){
  if(!card)return;
  o.guest=true;o.id='guest-'+String(o.number).replace(/[^A-Za-z0-9-]/g,'');
  var bubble=card.closest('.ai-chat-msg-bubble');
  var wrap=document.createElement('div');wrap.className='ai-ordl-done';
  wrap.innerHTML='<div class="ai-ords">'+orderCardHtml(o)+'</div>'+
    '<div class="ai-ordl__after"><span>'+ORD_ICON.lock+'This order only \u00b7 not saved</span><button type="button" class="ai-ordl__again" data-ordl-again>Look up another order</button></div>';
  card.replaceWith(wrap);
  var when=o.deliveredAt?'delivered '+fmtDay(o.deliveredAt):o.eta?'arriving by '+fmtDay(o.eta):'';
  var items=(o.items||[]).map(function(i){return i.title}).slice(0,4).join(', ');
  messages.push({role:'assistant',guestOrder:true,content:'Order #'+o.number+' (looked up with its number and email): '+o.stageLabel+(when?', '+when:'')+(o.carrier?' via '+o.carrier:'')+'.'+(items?' Items: '+items+'.':'')+' Returns need sign-in.'});
  var head=wrap.querySelector('.ai-ord__num');if(head){head.setAttribute('tabindex','-1');try{head.focus({preventScroll:true})}catch(e){}}
  fbOrderShown(bubble);
}
/* Sign-in: Shopify's own sign-in in a small window; it lands on a page that
   tells the chat and closes. Blocked pop-up: same tab, and the chat picks up
   where it left off when the shopper comes back. */
function startSignIn(intent){
  var q=lastAskedOrders||(intent==='rewards'?'How many points do I have?':'Where’s my order?');
  try{sessionStorage.setItem(RESUME_KEY,JSON.stringify({q:q,intent:intent,at:Date.now()}))}catch(e){}
  var back=location.pathname+location.search;
  var landing='/apps/hajirai/signed-in?back='+encodeURIComponent(back);
  var url=CUST_LOGIN_URL+(CUST_LOGIN_URL.indexOf('?')>-1?'&':'?')+'return_url='+encodeURIComponent(landing)+'&return_to='+encodeURIComponent(landing);
  var w=null;
  try{var W=Math.min(480,screen.availWidth),H=Math.min(720,screen.availHeight);w=window.open(url,'hajirai-signin','popup=yes,width='+W+',height='+H+',left='+Math.max(0,(screen.availWidth-W)/2)+',top='+Math.max(0,(screen.availHeight-H)/2))}catch(e){w=null}
  if(!w)location.href=url;
}
var lastAskedOrders='';
function resumeAfterSignIn(){
  if(resumeAfterSignIn.busy)return;
  var r=null;try{r=JSON.parse(sessionStorage.getItem(RESUME_KEY)||'null');sessionStorage.removeItem(RESUME_KEY)}catch(e){}
  if(!r||Date.now()-(r.at||0)>15*60*1000)return;
  resumeAfterSignIn.busy=true;setTimeout(function(){resumeAfterSignIn.busy=false},3000);
  CUST_LOGGED_IN=true;
  if(FOCUS)focusTitleBuild();
  var pill=panel.querySelector('.ai-chat-header__login-pill');if(pill)pill.remove();
  /* Back from signing in for FITFinder: the FIT they chose goes to their
     profile now, and the sheet shows it saved — or runs the scan lookup
     they asked for. No message to the assistant. */
  if(r.intent==='fitfinder'||r.intent==='fitfinder-scan'){
    if(ff)ff.loggedIn=true;
    var pk='';try{pk=sessionStorage.getItem(FFS_PENDING)||'';sessionStorage.removeItem(FFS_PENDING)}catch(e){}
    if(pk&&ff)ffSave(pk);
    if(!isOpen)toggle(true);
    setTimeout(function(){
      if(!ffNative())return;
      if(r.intent==='fitfinder-scan'){ffs.from=savedFit()?'done':'quiz';ffs.view='scan';if(openFitFinder(null,'keep'))ffsScanStart(fbSheet)}
      else{ffs.view='done';ffs.done='account';openFitFinder(null,'keep')}
    },isOpen?150:700);
    return;
  }
  /* The sign-in cards above have done their job. */
  var done=panel.querySelectorAll('[data-ord-login]');
  for(var i=0;i<done.length;i++){var sp=document.createElement('span');sp.className='ai-ord__signedin';sp.innerHTML=ORD_ICON.check+'Signed in';done[i].replaceWith(sp)}
  if(!isOpen)toggle(true);
  /* From the Returns & exchanges card: the card again, with their orders now. */
  if(r.intent==='returns-card'){setTimeout(openReturns,isOpen?150:700);return}
  setTimeout(function(){inputEl.value=r.q||'Where’s my order?';BTN_SEND=true;sendMessage()},isOpen?150:700);
}
window.addEventListener('message',function(e){
  if(e.origin!==location.origin||!e.data||e.data.type!=='hajirai-signed-in')return;
  resumeAfterSignIn();
});
/* Shopify's sign-in pages cut the pop-up's link back to this tab, so the
   "signed in" note also arrives on a BroadcastChannel / localStorage, and
   when the shopper comes back to this tab the chat asks the store itself. */
try{var signBc=new BroadcastChannel('hajirai');signBc.onmessage=function(e){if(e.data&&e.data.type==='hajirai-signed-in')resumeAfterSignIn()}}catch(e){}
window.addEventListener('storage',function(e){if(e.key==='hajirai_signed_in'&&e.newValue)resumeAfterSignIn()});
var signCheckBusy=false;
function checkSignedIn(){
  if(CUST_LOGGED_IN||signCheckBusy)return;
  var pending=null;try{pending=sessionStorage.getItem(RESUME_KEY)}catch(e){}
  if(!pending)return;
  signCheckBusy=true;
  fetch(SIGNED_IN_URL+'?check=1',{credentials:'same-origin',cache:'no-store',headers:{'Accept':'application/json'}})
  .then(function(r){return r.json()}).then(function(d){if(d&&d.signedIn)resumeAfterSignIn()})
  .catch(function(){}).then(function(){signCheckBusy=false});
}
window.addEventListener('focus',checkSignedIn);
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')checkSignedIn()});
/* Came back from a same-tab sign-in. */
if(CUST_LOGGED_IN){try{if(sessionStorage.getItem(RESUME_KEY))setTimeout(resumeAfterSignIn,600)}catch(e){}}

/* The return walkthrough, inside the order card. It holds up whatever the
   shopper does: the step they're on is kept (closing the chat or reloading
   picks it up again), a return that went through is remembered (the card
   shows it, never a second "Return an item" for the same thing), and the
   server never starts the same return twice, so retrying is always safe. */
var RP_KEY='hajirai_ret_progress',RD_KEY='hajirai_ret_done',RET_KEEP_MS=2*24*60*60*1000;
function lsJson(k){try{return JSON.parse(localStorage.getItem(k)||'{}')||{}}catch(e){return{}}}
function lsPut(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}
function progGet(id){var all=lsJson(RP_KEY),p=all[id];return p&&Date.now()-(p.at||0)<RET_KEEP_MS?p:null}
function progSet(id,st,step){var all=lsJson(RP_KEY);all[id]={step:step,items:st.items||{},reason:st.reason||'',method:st.method||'',at:Date.now()};
  for(var k in all)if(Date.now()-(all[k].at||0)>RET_KEEP_MS)delete all[k];lsPut(RP_KEY,all)}
function progClear(id){var all=lsJson(RP_KEY);if(all[id]){delete all[id];lsPut(RP_KEY,all)}}
function doneGet(id){var all=lsJson(RD_KEY);return Array.isArray(all[id])?all[id]:[]}
function doneAdd(id,d){var all=lsJson(RD_KEY),list=Array.isArray(all[id])?all[id]:[];
  for(var i=0;i<list.length;i++)if((d.rma&&list[i].rma===d.rma)||String(list[i].lineIds)===String(d.lineIds)){list[i]=Object.assign({},list[i],d);all[id]=list;lsPut(RD_KEY,all);return}
  list.push(d);all[id]=list.slice(-5);lsPut(RD_KEY,all)}
function retState(card){
  if(card.__ret)return card.__ret;
  var p=progGet(card.getAttribute('data-ord'));
  return(card.__ret=p?{items:p.items||{},reason:p.reason||'',method:p.method||''}:{items:{},reason:'',method:''});
}
function retMethodByKey(k){for(var i=0;i<RET_METHODS.length;i++)if(RET_METHODS[i].key===k)return RET_METHODS[i];return null}
/* The "return started" panel: the same wherever and whenever it's shown. */
function doneHtml(d,o){
  var m=d.method||{},find=safeUrl(m.findUrl),label=safeUrl(d.labelUrl);
  var titles=(o&&o.items||[]).filter(function(i){return (d.lineIds||[]).indexOf(i.lineId)>-1}).map(function(i){return i.title});
  var how=find?'Bring it to a drop-off location — your drop-off code and steps are in your email. No box or label needed.':label?'Your return label is ready — print it, pack the item and drop it off.':'Your return label and drop-off steps are in your email.';
  return '<div class="ai-ret__done" role="status"><span class="ai-ret__doneicon">'+ORD_ICON.check+'</span><div>'+
    '<div class="ai-ret__title">Return started'+(d.rma?' · #'+esc(d.rma):'')+'</div>'+
    (titles.length?'<div class="ai-ret__why">'+esc(titles.join(', '))+'</div>':'')+
    (m.label?'<div class="ai-ret__why">'+esc(m.label)+(m.feeWaived?' · No return fee':'')+'</div>':'')+
    '<div class="ai-ret__note">'+how+' Refund to your original payment once it’s back with us.'+(d.exchange?' Your new size is in the chat above — add it to your cart whenever you’re ready.':'')+'</div>'+
    '<div class="ai-ret__choices">'+(label?'<a class="ai-ord__btn is-primary" href="'+label+'" target="_blank" rel="noopener">Get return label</a>':'')+
    (find?'<a class="ai-ord__btn'+(label?'':' is-primary')+'" href="'+find+'" target="_blank" rel="noopener">Find a drop-off location</a>':'')+
    (safeUrl(d.returnsUrl||(o&&o.returnsUrl))?'<a class="ai-ord__btn" href="'+safeUrl(d.returnsUrl||o.returnsUrl)+'" target="_blank" rel="noopener">View return</a>':'')+'</div></div></div>';
}
function renderReturn(card,step,info){
  var id=card.getAttribute('data-ord'),o=ordersById[id];if(!o)return;
  var st=retState(card);
  var box=card.querySelector('.ai-ret:not(.ai-ret--started)');
  if(!box){box=document.createElement('div');box.className='ai-ret';card.appendChild(box)}
  card.classList.add('is-returning');
  var h='';
  if(step==='items'||step==='reason'||step==='method'||step==='confirm')progSet(id,st,step);
  if(step==='items'){
    var ret=returnableItems(o);
    for(var sk in st.items)if(!ret.some(function(i){return i.lineId===sk}))delete st.items[sk];
    if(ret.length===1&&!Object.keys(st.items).length)st.items[ret[0].lineId]=1;
    h+='<div class="ai-ret__title">What would you like to return?</div><div class="ai-ret__list">';
    for(var i=0;i<ret.length;i++){var it=ret[i],on=!!st.items[it.lineId];
      h+='<button type="button" class="ai-ret__item'+(on?' is-on':'')+'" role="checkbox" aria-checked="'+on+'" data-ret-item="'+esc(it.lineId)+'">'+
        (safeUrl(it.image)?'<img src="'+safeUrl(it.image)+'" alt="">':'<span class="ai-ord__ph">'+ORD_ICON.bag+'</span>')+
        '<span class="ai-ret__itxt"><span class="ai-ord__ititle">'+esc(it.title)+'</span><span class="ai-ord__iopt">'+esc(optLine(it.options))+'</span></span><span class="ai-ret__check">'+ORD_ICON.check+'</span></button>';}
    /* The store's return rules (AfterShip's, mirrored): a gift card or a
       final-sale item is listed, greyed, with why — never pickable. */
    var blockedItems=(o.items||[]).filter(function(i){return i.blocked});
    for(var bi=0;bi<blockedItems.length;bi++){var bt=blockedItems[bi];
      h+='<div class="ai-ret__item is-blocked" aria-disabled="true">'+
        (safeUrl(bt.image)?'<img src="'+safeUrl(bt.image)+'" alt="">':'<span class="ai-ord__ph">'+ORD_ICON.bag+'</span>')+
        '<span class="ai-ret__itxt"><span class="ai-ord__ititle">'+esc(bt.title)+'</span><span class="ai-ord__iopt ai-ret__blocked">'+esc(bt.blockedWhy||'Not returnable')+'</span></span></div>';}
    h+='</div><div class="ai-ret__nav"><button type="button" class="ai-ret__link" data-ret-cancel>Cancel</button><button type="button" class="ai-ord__btn is-primary" data-ret-next="reason"'+(Object.keys(st.items).length?'':' disabled')+'>Next</button></div>';
  }else if(step==='reason'){
    h+='<div class="ai-ret__title">Why are you returning it?</div><div class="ai-ret__reasons">';
    for(var r=0;r<RET_REASONS.length;r++)h+='<button type="button" class="ai-ret__reason'+(st.reason===RET_REASONS[r].key?' is-on':'')+'" data-ret-reason="'+RET_REASONS[r].key+'">'+esc(RET_REASONS[r].label)+'</button>';
    h+='</div><div class="ai-ret__nav"><button type="button" class="ai-ret__link" data-ret-next="items">Back</button><button type="button" class="ai-ret__link" data-ret-cancel>Cancel</button></div>';
  }else if(step==='method'){
    if(!retMethodByKey(st.method)&&RET_METHODS.length)st.method=RET_METHODS[0].key;
    h+='<div class="ai-ret__title">How would you like to send it back?</div><div class="ai-ret__methods" role="radiogroup">';
    for(var m=0;m<RET_METHODS.length;m++){var rm=RET_METHODS[m],mon=st.method===rm.key;
      h+='<button type="button" class="ai-ret__method'+(mon?' is-on':'')+'" role="radio" aria-checked="'+mon+'" data-ret-method="'+esc(rm.key)+'">'+
        '<span class="ai-ret__mtop"><span class="ai-ret__mlabel">'+esc(rm.label)+'</span>'+(rm.fee?(retFeeWaived(st.reason)?'<span class="ai-ret__mfee is-free"><s>'+esc(rm.fee)+'</s> Free</span>':'<span class="ai-ret__mfee">'+esc(rm.fee)+'</span>'):'')+'</span>'+
        (rm.detail?'<span class="ai-ret__mdetail">'+esc(rm.detail)+'</span>':'')+'</button>';}
    h+='</div>';
    if(retFeeWaived(st.reason)&&RET_METHODS.some(function(x){return x.fee}))h+='<div class="ai-ret__note">No return fee for this reason.</div>';
    var cur=retMethodByKey(st.method);
    if(cur&&safeUrl(cur.findUrl))h+='<a class="ai-ret__find" href="'+safeUrl(cur.findUrl)+'" target="_blank" rel="noopener">Find a drop-off location near you</a>';
    h+='<div class="ai-ret__nav"><button type="button" class="ai-ret__link" data-ret-next="reason">Back</button><button type="button" class="ai-ord__btn is-primary" data-ret-next="confirm"'+(cur?'':' disabled')+'>Next</button></div>';
  }else if(step==='confirm'){
    var rs=null;for(var k=0;k<RET_REASONS.length;k++)if(RET_REASONS[k].key===st.reason)rs=RET_REASONS[k];
    if(!rs){renderReturn(card,'reason');return}
    var picked=o.items.filter(function(i){return st.items[i.lineId]});
    if(!picked.length){renderReturn(card,'items');return}
    var cm=RET_METHODS.length>1?retMethodByKey(st.method):null;
    /* A swap for the next size is only for items that come in sizes. */
    var swappable=!!rs.change&&picked.every(function(i){return i.sizeable!==false});
    h+='<div class="ai-ret__title">'+(swappable?'Return it, or swap for '+esc(rs.change)+'?':'Ready to start your return')+'</div>';
    h+='<div class="ai-ret__summary">'+picked.map(function(i){return esc(i.title)+(optLine(i.options)?' <span>('+esc(optLine(i.options))+')</span>':'')}).join('<br>')+'<div class="ai-ret__why">Reason: '+esc(rs.label)+'</div>'+(cm?'<div class="ai-ret__why">Send back: '+esc(cm.label)+(cm.fee?' · '+(retFeeWaived(st.reason)?'<s>'+esc(cm.fee)+'</s> Free':esc(cm.fee)):'')+'</div>':'')+'</div>';
    if(swappable){
      h+='<div class="ai-ret__choices"><button type="button" class="ai-ord__btn is-primary" data-ret-submit="exchange">Exchange for '+esc(rs.change)+'</button>'+
        '<button type="button" class="ai-ord__btn" data-ret-submit="return">Return for a refund</button></div>'+
        '<div class="ai-ret__note">Exchange: we start the return, then show you the new size to add to your cart. Your refund for this pair is issued once it’s back with us.</div>';
    }else{
      h+='<div class="ai-ret__choices"><button type="button" class="ai-ord__btn is-primary" data-ret-submit="return">Submit return</button></div>';
    }
    h+='<div class="ai-ret__nav"><button type="button" class="ai-ret__link" data-ret-next="'+(RET_METHODS.length>1?'method':'reason')+'">Back</button><button type="button" class="ai-ret__link" data-ret-cancel>Cancel</button></div>';
  }else if(step==='loading'||step==='sending'||step==='checking'){
    h+='<div class="ai-ret__sending" role="status"><span class="ai-ret__spinner"></span>'+(step==='sending'?'Submitting your return…':step==='checking'?'Checking on your return…':'Getting your order…')+'</div>';
  }else if(step==='signin'){
    lastAskedOrders='I’d like to finish my return';
    h+='<div class="ai-ret__err" role="alert">Please sign in again to finish your return — we’ll keep your choices.</div>'+
      '<div class="ai-ret__choices"><button type="button" class="ai-ord__btn is-primary" data-ord-login="return">Sign in</button></div>';
  }else if(step==='blocked'||step==='error'){
    var msg=(info&&info.message)||'Something went wrong — please try again.';
    h+='<div class="ai-ret__err" role="alert">'+esc(msg)+'</div><div class="ai-ret__choices">'+
      (safeUrl(info&&info.url)?'<a class="ai-ord__btn'+(step==='blocked'?'':' is-primary')+'" href="'+safeUrl(info.url)+'" target="_blank" rel="noopener">'+(step==='blocked'?'Our returns page':'Finish on our returns page')+'</a>':'')+
      (step==='error'?'<button type="button" class="ai-ord__btn" data-ret-next="confirm">Try again</button>':'<button type="button" class="ai-ord__btn" data-ret-cancel>Close</button>')+'</div>';
  }
  box.innerHTML=h;
  keepInView(box);
}
/* Keep the return steps on screen without jumping to the end of the chat:
   scroll only as far as needed to show the box, never past its top. */
function keepInView(el){requestAnimationFrame(function(){
  if(!el||!msgsEl||!el.isConnected)return;
  var sc=el.closest('.ai-chat-fbsheet__list')||msgsEl;
  if(!sc.contains(el))return;
  var m=sc.getBoundingClientRect(),r=el.getBoundingClientRect(),pad=12;
  if(r.bottom>m.bottom-pad)sc.scrollTop+=Math.max(0,Math.min(r.bottom-m.bottom+pad,r.top-m.top-pad));
  else if(r.top<m.top+pad)sc.scrollTop-=m.top+pad-r.top;
})}
/* fetch with a time limit; resolves {status, d} and never throws on HTTP errors. */
function retFetch(url,opts,ms){
  var ctl=typeof AbortController!=='undefined'?new AbortController():null,timer=ctl?setTimeout(function(){ctl.abort()},ms):0;
  opts=Object.assign({credentials:'same-origin',cache:'no-store',headers:{'Accept':'application/json'}},opts||{});
  if(ctl)opts.signal=ctl.signal;
  return fetch(url,opts).then(function(r){return r.json().catch(function(){return{}}).then(function(d){clearTimeout(timer);return{status:r.status,d:d||{}}})},function(e){clearTimeout(timer);throw e});
}
/* Swap a card for one built from fresh order data, everywhere it appears,
   and keep the saved chat history in step. */
function refreshCards(fresh,keep){
  if(!fresh||!fresh.id)return keep;
  ordersById[fresh.id]=fresh;
  var cards=panel.querySelectorAll('.ai-ord[data-ord="'+String(fresh.id).replace(/"/g,'')+'"]'),out=keep;
  for(var i=0;i<cards.length;i++){var c=cards[i],tmp=document.createElement('div');tmp.innerHTML=orderCardHtml(fresh);var nc=tmp.firstChild;
    if(c===keep){nc.__ret=c.__ret;out=nc}
    c.replaceWith(nc)}
  var changed=false;
  for(var m=0;m<messages.length;m++){var os=messages[m].orders;if(!os)continue;
    for(var j=0;j<os.length;j++)if(os[j].id===fresh.id){os[j]=fresh;changed=true}}
  if(changed)saveH(messages);
  return out;
}
function startReturn(card){
  var id=card.getAttribute('data-ord');
  renderReturn(card,'loading');
  retFetch(RETURNS_URL+'?orderId='+encodeURIComponent(id),{method:'GET'},15000).then(function(res){
    if(res.status===401){renderReturn(card,'signin');return}
    var d=res.d;
    if(d.error==='returns_off'){progClear(id);renderReturn(card,'blocked',{message:d.message,url:d.returnsUrl});return}
    if(!d.ok||!d.order){renderReturn(card,'items');return}
    if(Array.isArray(d.methods)&&d.methods.length)RET_METHODS=d.methods;
    if(Array.isArray(d.freeReasons))RET_FREE=d.freeReasons.map(String);
    if(d.returnsUrl)d.order.returnsUrl=d.returnsUrl;
    card=refreshCards(d.order,card);
    if(!d.order.canReturn||!returnableItems(d.order).length){
      if((d.order.returns||[]).length){progClear(id);var b=card.querySelector('.ai-ret:not(.ai-ret--started)');if(b)b.remove();card.classList.remove('is-returning');return}
      renderReturn(card,'blocked',{message:d.message||'This order can’t be returned.',url:d.returnsUrl});return;
    }
    var pg=progGet(id),step=pg&&pg.step;
    if(step==='sending'){var ps=[];for(var k in retState(card).items)if(retState(card).items[k])ps.push(k);checkAfterDrop(card,ps,'return');return}
    renderReturn(card,/^(reason|method|confirm)$/.test(step||'')?step:'items');
  },function(){renderReturn(card,'items')});
}
function finishReturn(card,d,mode,picked){
  var o=ordersById[card.getAttribute('data-ord')];if(!o)return;
  var prevShown=doneGet(o.id).some(function(x){return (d.rma&&x.rma===d.rma)&&x.exShown});
  var rec={rma:d.rma||'',labelUrl:d.labelUrl||'',returnsUrl:d.returnsUrl||'',method:d.method||{},exchange:!!d.exchange||mode==='exchange',lineIds:d.lineIds||picked,at:Date.now(),exShown:prevShown};
  doneAdd(o.id,rec);progClear(o.id);card.__ret=null;
  card=refreshCards(o,card);
  var exCards=d.exchangeCards||[];
  if(exCards.length&&!prevShown){
    doneAdd(o.id,Object.assign({},rec,{exShown:true}));
    var ex=exCards[0],to=ex.exchange_to?' in '+ex.exchange_to:'';
    var txt=ex.exchange_to?'Here’s your new size'+to+' — tap Add to cart, then check out whenever you’re ready.':'Here’s the same style — pick your new size and tap Add to cart.';
    var cards=exCards.map(function(c){var x={};for(var k in c)if(k!=='exchange_from'&&k!=='exchange_to')x[k]=c[k];return x});
    setTimeout(function(){appendMsg('assistant',txt,cards);messages.push({role:'assistant',content:txt,products:cards});saveH(messages);scrollBottom()},350);
  }else{var p=card.querySelector('.ai-ret--started:last-of-type');if(p)keepInView(p)}
}
/* The connection dropped mid-way: ask the store whether it went through
   before offering to try again (a retry is safe either way). */
function checkAfterDrop(card,picked,mode){
  var id=card.getAttribute('data-ord');
  renderReturn(card,'checking');
  retFetch(RETURNS_URL+'?orderId='+encodeURIComponent(id),{method:'GET'},15000).then(function(res){
    if(res.status===401){var s2=retState(card);progSet(id,s2,'confirm');renderReturn(card,'signin');return}
    var o=res.d&&res.d.order,hit=null;
    for(var i=0;o&&i<(o.returns||[]).length;i++){var r=o.returns[i];if(picked.every(function(l){return r.lineIds.indexOf(l)>-1}))hit=r}
    if(hit){if(Array.isArray(res.d.methods)&&res.d.methods.length)RET_METHODS=res.d.methods;finishReturn(card,Object.assign({},hit,{returnsUrl:res.d.returnsUrl||''}),hit.exchange?'exchange':mode,picked);return}
    if(o)card=refreshCards(o,card);
    progSet(id,retState(card),'confirm');
    renderReturn(card,'error',{message:'Your return wasn’t started yet — the connection dropped. Tap Try again; it won’t start twice.'});
  },function(){renderReturn(card,'error',{message:'Connection problem — your return may not have started. Tap Try again; it won’t start twice.'})});
}
function submitReturn(card,mode){
  var id=card.getAttribute('data-ord'),o=ordersById[id];if(!o)return;
  var st=retState(card);
  var items=[],picked=[];for(var k in st.items)if(st.items[k]){items.push({lineId:k,quantity:1});picked.push(k)}
  if(!items.length){renderReturn(card,'items');return}
  progSet(id,st,'sending');
  renderReturn(card,'sending');
  retFetch(RETURNS_URL,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({orderId:id,items:items,reason:st.reason,method:st.method||'',exchange:mode==='exchange'})},30000)
  .then(function(res){
    var d=res.d;
    if(res.status===401){progSet(id,st,'confirm');renderReturn(card,'signin');return}
    if(d.ok){finishReturn(card,d,mode,picked);return}
    progSet(id,st,'confirm');
    if(d.order){card=refreshCards(d.order,card)}
    if(res.status===409||d.error==='already_returned'){progClear(id);renderReturn(card,'blocked',{message:d.message,url:d.fallbackUrl||o.returnsUrl});return}
    renderReturn(card,'error',{message:d.message||'Something went wrong — please try again.',url:d.fallbackUrl});
  },function(){progSet(id,st,'sending');checkAfterDrop(card,picked,mode)});
}
/* Pick up any return left half-way (chat closed, page reloaded, signed in
   again) on the newest card for that order. */
function resumeReturns(){
  var all=lsJson(RP_KEY);
  for(var id in all){
    if(!progGet(id))continue;
    var cards=panel.querySelectorAll('.ai-ord[data-ord="'+String(id).replace(/"/g,'')+'"]');if(!cards.length)continue;
    var card=cards[cards.length-1],step=all[id].step;
    if(card.querySelector('.ai-ret:not(.ai-ret--started)'))continue;
    if(step==='sending'){var st=retState(card),picked=[];for(var k in st.items)if(st.items[k])picked.push(k);checkAfterDrop(card,picked,'return');continue}
    if(!ordersById[id]||!ordersById[id].canReturn||ordersById[id].returnMode==='page'){progClear(id);continue}
    renderReturn(card,step||'items');
  }
}
panel.addEventListener('click',function(e){
  var lk=e.target.closest&&e.target.closest('[data-ordl-open],[data-ordl-again]');
  if(lk&&panel.contains(lk)){
    e.preventDefault();
    if(lk.hasAttribute('data-ordl-open')){ordlOpen(lk);return}
    var done=lk.closest('.ai-ordl-done');if(!done)return;
    var holder=document.createElement('div');holder.innerHTML=lookupCardHtml('track','',true);
    var fresh=holder.firstChild;done.replaceWith(fresh);
    var inp=fresh.querySelector('input[name="order"]');if(inp)try{inp.focus()}catch(_){}
    return;
  }
  var t=e.target.closest&&e.target.closest('[data-ord-login],[data-ord-return],[data-ret-item],[data-ret-next],[data-ret-reason],[data-ret-method],[data-ret-submit],[data-ret-cancel]');
  if(!t||!panel.contains(t))return;
  if(t.hasAttribute('data-ord-login')){e.preventDefault();startSignIn(t.getAttribute('data-ord-login'));return}
  var card=t.closest('.ai-ord');if(!card)return;
  var id=card.getAttribute('data-ord'),st=retState(card);
  if(t.hasAttribute('data-ord-return')){startReturn(card);return}
  if(t.hasAttribute('data-ret-cancel')){var b=card.querySelector('.ai-ret:not(.ai-ret--started)');if(b)b.remove();card.classList.remove('is-returning');card.__ret=null;progClear(id);return}
  if(t.hasAttribute('data-ret-item')){var li=t.getAttribute('data-ret-item');st.items[li]=st.items[li]?0:1;if(!st.items[li])delete st.items[li];renderReturn(card,'items');return}
  if(t.hasAttribute('data-ret-next')){renderReturn(card,t.getAttribute('data-ret-next'));return}
  if(t.hasAttribute('data-ret-reason')){st.reason=t.getAttribute('data-ret-reason');renderReturn(card,RET_METHODS.length>1?'method':'confirm');return}
  if(t.hasAttribute('data-ret-method')){st.method=t.getAttribute('data-ret-method');renderReturn(card,'method');return}
  if(t.hasAttribute('data-ret-submit')){if(card.__sending)return;card.__sending=true;setTimeout(function(){card.__sending=false},1500);submitReturn(card,t.getAttribute('data-ret-submit'));return}
});

panel.addEventListener('submit',function(e){
  var form=e.target&&e.target.closest&&e.target.closest('.ai-ordl__form');
  if(form){e.preventDefault();ordlSubmit(form);return}
  var bis=e.target&&e.target.closest&&e.target.closest('.ai-bis__form');
  if(bis){e.preventDefault();bisSubmit(bis)}
});

/* ── Back-in-stock alert card ──
   Under a reply about a sold-out size: one email field, one tap. The email
   goes from this browser to the store's Klaviyo back-in-stock subscription
   for that exact Shopify variant (the same subscription the store's own
   Notify-me buttons make), and the store's flow emails them when it's
   back. The assistant never sees the email; the card remembers only that
   it's done. */
var BIS_URL='https://a.klaviyo.com/client/back-in-stock-subscriptions/';
var BIS_ICON='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>';
var BIS_DONE='You’re on the list — one email the moment it’s back.';
var bisSeq=0;
/* The server sends the card only for a store with Klaviyo; it's drawn even
   before this page's settings arrive (a restored chat), and a tap before
   then is told to try again. */
function restockCardHtml(r){
  if(!r)return '';
  var n=++bisSeq,f='ai-bis-'+n;
  var head='<div class="ai-ord__signin-icon">'+BIS_ICON+'</div>'+
    '<div class="ai-ord__signin-text"><div class="ai-ord__num">Get an email when it’s back</div><div class="ai-ord__date">'+esc(r.title)+(r.choice?' · '+esc(r.choice):'')+'</div></div>';
  if(r.done)return '<div class="ai-ord ai-ord--signin ai-bis is-done" data-bis>'+head+'<div class="ai-ord__signedin ai-bis__done">'+ORD_ICON.check+esc(BIS_DONE)+'</div></div>';
  return '<div class="ai-ord ai-ord--signin ai-bis" data-bis data-bis-variant="'+esc(r.variant)+'">'+head+
    '<form class="ai-bis__form" id="'+f+'" novalidate>'+
      '<label class="ai-sr" for="'+f+'-e">Email address</label>'+
      '<div class="ai-bis__row"><input id="'+f+'-e" name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="254" placeholder="you@example.com" aria-describedby="'+f+'-err">'+
      '<button type="submit" class="ai-ord__btn is-primary ai-bis__go">Notify me</button></div>'+
      '<span class="ai-bis__err" id="'+f+'-err" role="alert" hidden></span>'+
      '<p class="ai-bis__note">'+ORD_ICON.lock+'<a href="'+esc(safeUrl(PRIVURL)||'/policies/privacy-policy')+'" target="_blank" rel="noopener">Privacy Policy</a></p>'+
    '</form></div>';
}
function bisSubmit(form){
  var card=form.closest('[data-bis]'),variant=card?String(card.getAttribute('data-bis-variant')||''):'';
  var input=$('input[name="email"]',form),btn=$('.ai-bis__go',form),err=$('.ai-bis__err',form);
  if(!input||!btn||!err)return;
  var email=(input.value||'').trim();
  var fail=function(msg){err.textContent=msg;err.hidden=false;input.setAttribute('aria-invalid','true');btn.disabled=false;btn.textContent='Notify me';input.focus()};
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))return fail('Please enter a valid email address.');
  if(!/^\d{1,20}$/.test(variant)||!KLAVIYO_COMPANY_ID)return fail('This alert isn’t available right now.');
  err.hidden=true;input.removeAttribute('aria-invalid');btn.disabled=true;btn.textContent='Saving…';
  fetch(BIS_URL+'?company_id='+encodeURIComponent(KLAVIYO_COMPANY_ID),{
    method:'POST',
    headers:{'Content-Type':'application/json','revision':'2024-10-15'},
    body:JSON.stringify({data:{type:'back-in-stock-subscription',attributes:{channels:['EMAIL'],profile:{data:{type:'profile',attributes:{email:email}}}},relationships:{variant:{data:{type:'catalog-variant',id:'$shopify:::$default:::'+variant}}}}})
  }).then(function(r){
    if(!(r.ok||r.status===202)){
      r.text().then(function(t){console.error('[klaviyo] back in stock status='+r.status,t)}).catch(function(){});
      return fail('Couldn’t save that just now. Please try again.');
    }
    card.classList.add('is-done');
    form.outerHTML='<div class="ai-ord__signedin ai-bis__done" role="status">'+ORD_ICON.check+esc(BIS_DONE)+'</div>';
    var md=card.closest('.ai-chat-msg');
    if(md&&md.__msg&&md.__msg.restock){md.__msg.restock.done=true;saveH(messages)}
  }).catch(function(){fail('Connection error. Please try again.')});
}

function sendMessage(){
var text=inputEl.value.trim();
var byButton=BTN_SEND;BTN_SEND=false;
if(!text||isStreaming)return;
var paused=chatPausedUntil();if(paused){pauseChat(paused);return}
SENT_TYPED=!byButton;
rateStepAside();
fbRetire();
var w=$('.ai-chat-welcome',msgsEl);
if(w)w.remove();
msgsEl.classList.remove('is-welcome');
leaveHome();
/* Deactivate any prior choice/suggestion chip rows so chips from
   earlier turns can no longer be tapped — the visible history stays
   readable, but only the latest assistant turn's chips are live. */
var stale=msgsEl.querySelectorAll('.ai-chat-choices, .ai-chat-suggestions, .ai-chat-welcome__qps, .ai-chat-welcome__ctas, .ai-chat-dead-end');
for(var si=0;si<stale.length;si++){stale[si].classList.add('is-stale')}
lastUserMessage=text;
if(/order|track|ship|deliver|package|return|exchange|refund|point|reward|loyal|credit/i.test(text))lastAskedOrders=text;
messages.push({role:'user',content:text});
appendMsg('user',text);
saveH(messages);
inputEl.value='';inputEl.style.height='auto';panel.classList.remove('has-text');
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
var dr=msgsEl.querySelector('.ai-chat-msg.is-draft');if(dr)dr.remove();
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
/* Styled (light and dark) by the stylesheet. Email only — a phone number for
   texts would need its own SMS consent wording. */
var formHtml='<div class="ai-chat-klaviyo-form">'
+'<input type="email" class="ai-kl-email" placeholder="Email address" aria-label="Email address" autocomplete="email" required />'
+'<button class="ai-kl-submit" type="submit">Subscribe</button>'
+'<p class="ai-kl-note">By subscribing you agree to get marketing emails from us. Unsubscribe anytime. <a href="'+esc(safeUrl(PRIVURL)||'/policies/privacy-policy')+'" target="_blank" rel="noopener">Privacy Policy</a></p>'
+'<div class="ai-kl-status" role="status" aria-live="polite" hidden></div>'
+'</div>';
b.insertAdjacentHTML('beforeend',formHtml);
var form=$('.ai-chat-klaviyo-form',b);
var emailIn=$('.ai-kl-email',form);
var submitBtn=$('.ai-kl-submit',form);
var statusEl=$('.ai-kl-status',form);
submitBtn.addEventListener('click',function(){
  var email=(emailIn.value||'').trim();
  if(!email||email.indexOf('@')===-1){statusEl.hidden=false;statusEl.classList.add('is-error');statusEl.textContent='Please enter a valid email.';return}
  submitBtn.disabled=true;submitBtn.textContent='Subscribing...';
  var profileAttrs={email:email};
  fetch('https://a.klaviyo.com/client/subscriptions/?company_id='+encodeURIComponent(KLAVIYO_COMPANY_ID),{
    method:'POST',
    headers:{'Content-Type':'application/json','revision':'2024-10-15'},
    body:JSON.stringify({data:{type:'subscription',attributes:{custom_source:'SEoS Assistant Chat',profile:{data:{type:'profile',attributes:profileAttrs}}},relationships:{list:{data:{type:'list',id:KLAVIYO_LIST_ID}}}}})
  }).then(function(r){
    if(r.ok||r.status===202){
      form.innerHTML='<div class="ai-kl-done">You\'re subscribed!</div>';
    } else {
      r.text().then(function(t){console.error('[klaviyo] status='+r.status,t)});
      statusEl.hidden=false;statusEl.classList.add('is-error');statusEl.textContent='Something went wrong ('+r.status+'). Please try again.';
      submitBtn.disabled=false;submitBtn.textContent='Subscribe';
    }
  }).catch(function(){
    statusEl.hidden=false;statusEl.classList.add('is-error');statusEl.textContent='Connection error. Please try again.';
    submitBtn.disabled=false;submitBtn.textContent='Subscribe';
  });
});
scrollBottom();
}

/* ── My rewards: the instant rewards card (no AI) ──
   "My rewards" on the home draws the store's card at once: how points are
   earned and spent, what to know, the rewards page — and a signed-in
   shopper's balance, read live. Settings → Shopping tools → My rewards. */
var RW_ICON='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.6l2.5 5.2 5.7.8-4.1 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.1-4 5.7-.8z"/></svg>';
var RW_TICK='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7"/></svg>';
var RW_ARROW='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
function rwRows(list){var h='';for(var i=0;i<list.length;i++){var r=list[i]||{};if(!r.label||!r.value)continue;h+='<li><span>'+esc(r.label)+'</span><b>'+esc(r.value)+'</b></li>'}return h?'<ul class="ai-rw__list">'+h+'</ul>':''}
function rewardsCardHtml(c){
  var logo=c.logo&&(safeUrl(c.logo)||/^data:image\//.test(c.logo))?c.logo:'';
  var head=logo?'<img class="ai-rw__logo" src="'+esc(logo)+'" alt="'+esc(c.brand||'Rewards')+'">':'<span class="ai-rw__mark">'+RW_ICON+'<span>'+esc(c.brand||'Rewards')+'</span></span>';
  var earn=Array.isArray(c.earn)?c.earn:[],use=Array.isArray(c.use)?c.use:[],notes=Array.isArray(c.notes)?c.notes:[];
  var h='<div class="ai-rw" data-rw role="group" aria-label="'+esc(c.brand||'Rewards')+'">';
  h+='<div class="ai-rw__top">'+head+'<span class="ai-rw__bal" data-rw-bal aria-live="polite"></span></div>';
  h+='<div class="ai-rw__head"><strong>'+esc(c.title)+'</strong>'+(c.sub?'<span>'+esc(c.sub)+'</span>':'')+'</div>';
  var cols='';if(earn.length)cols+='<section class="ai-rw__col"><h4>Earn</h4>'+rwRows(earn)+'</section>';if(use.length)cols+='<section class="ai-rw__col"><h4>Spend</h4>'+rwRows(use)+'</section>';
  if(cols)h+='<div class="ai-rw__cols">'+cols+'</div>';
  if(notes.length){h+='<ul class="ai-rw__notes">';for(var i=0;i<notes.length;i++)if(notes[i])h+='<li>'+RW_TICK+'<span>'+esc(notes[i])+'</span></li>';h+='</ul>'}
  var url=safeUrl(c.ctaUrl||'');
  if(url)h+='<a class="ai-rw__cta" href="'+esc(url)+'" target="_blank" rel="noopener"><span>'+esc(c.ctaLabel||'See my rewards')+'</span>'+RW_ARROW+'</a>';
  h+='</div>';return h;
}
/* The balance line: signed in, read live; signed out, a sign-in link. */
function rwFillBalance(card){
  var el=$('[data-rw-bal]',card);if(!el)return;
  if(!CUST_LOGGED_IN){el.innerHTML='<a href="'+esc(loginUrl())+'">Log in to see your balance</a>';return}
  el.textContent='Checking your balance\u2026';el.classList.add('is-wait');
  fetch('/apps/hajirai/rewards',{credentials:'same-origin'}).then(function(r){return r.ok?r.json():null}).then(function(d){
    el.classList.remove('is-wait');
    if(d&&d.balance)el.innerHTML='<b>'+esc(d.balance)+'</b>';
    else if(d&&d.signedIn&&d.member===false)el.textContent='No rewards account yet \u2014 joining is free.';
    else el.textContent='';
  }).catch(function(){el.classList.remove('is-wait');el.textContent=''});
}
function rewardsPlainText(c){return c.brand?'Here\u2019s '+c.brand+' at a glance.':'Here\u2019s how rewards work.'}
function openRewards(){
  if(!REWARDS||isStreaming)return;
  var w=$('.ai-chat-welcome',msgsEl);if(w)w.remove();msgsEl.classList.remove('is-welcome');leaveHome();
  messages.push({role:'user',content:'My rewards',local:true});var ud=appendMsg('user','My rewards');
  var text=rewardsPlainText(REWARDS),m={role:'assistant',content:text,rewards:true};
  messages.push(m);
  var md=appendMsg('assistant',text);md.__msg=m;restoreExtras(m,md,true);
  saveH(messages);
  /* The card is tall on a phone: land on its top (the tap and the lockup),
     not its bottom, so it reads from the beginning. */
  scrollMsgTop(ud||md);
}

/* ── Talk to a person ──
   In the menu at any point: one tap shows the ways to reach the team — the
   live chat (opened straight away when the page has one), the phone with
   its hours, the email with its reply time — and the customer service log
   notes which was used. Settings → Customer care → Talk to a person. */
var HH_ICON={
  chat:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  phone:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z"/></svg>',
  mail:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
  chev:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>'
};
function hhRow(tag,attrs,icon,title,sub){return '<'+tag+' class="ai-hh__row" '+attrs+'><span class="ai-hh__ico">'+icon+'</span><span class="ai-hh__t"><b>'+esc(title)+'</b>'+(sub?'<span>'+esc(sub)+'</span>':'')+'</span>'+HH_ICON.chev+'</'+tag+'>'}
function humanCardHtml(h){
  var rows=hhRow('button','type="button" data-human="live_chat"',HH_ICON.chat,h.liveLabel||'Live chat',h.hours||'');
  if(h.phone)rows+=hhRow('a','href="'+esc(h.telHref||('tel:'+h.phone))+'" data-human="phone"',HH_ICON.phone,h.phone,h.hours||'Call us');
  if(h.email)rows+=hhRow('a','href="mailto:'+esc(h.email)+'" data-human="email"',HH_ICON.mail,h.email,h.reply?'We reply '+h.reply:'Email us');
  return '<div class="ai-hh" role="group" aria-label="Ways to reach a person">'+rows+'</div>';
}
function humanUsed(how){postActivity({kind:'human',session_id:getSess(),how:String(how||'page')})}
function openHuman(){
  if(!HUMAN)return;
  var w=$('.ai-chat-welcome',msgsEl);if(w)w.remove();msgsEl.classList.remove('is-welcome');leaveHome();
  var text='Here\u2019s how to reach a person on our team.',m={role:'assistant',content:text,human:true};
  messages.push(m);
  var md=appendMsg('assistant',text);md.__msg=m;restoreExtras(m,md,true);
  saveH(messages);scrollMsgTop(md);
  /* One tap is the transfer: a live chat on the page opens straight away. */
  if(typeof window.zE==='function'||typeof window.Intercom==='function'||(window.GorgiasChat&&typeof window.GorgiasChat.open==='function')){humanUsed('live_chat');openSupportChat(SUPPORT_URL)}
}

/* ── Returns & exchanges ──
   A pill on the home: one tap, no AI. Signed in: their recent orders, the
   return button leading on each (the chat's own return flow, or the store's
   returns page). Signed out: sign in — which brings them back to this card —
   or look one order up with its number and email, with a note on where to
   find those. The orders read here are kept with the message, so the card
   comes back after a reload without another read. */
var RT_CHEV='<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6 9l6 6 6-6"/></svg>';
var rtSeq=0;
function returnsCardHtml(m){
  var signed=CUST_LOGGED_IN,sub=signed?'Pick the order, then the item \u2014 it\u2019s set up right here.':(RETURNS&&RETURNS.lookup?'Sign in to start one here, or look an order up.':'Sign in to start one here.');
  var h='<div class="ai-rt'+(signed?' is-signed':'')+'" data-rt role="group" aria-label="Returns & exchanges">';
  h+='<div class="ai-rt__head"><strong>Returns &amp; exchanges</strong><span>'+sub+'</span></div>';
  if(signed){
    h+='<div class="ai-rt__body" data-rt-body>'+(Array.isArray(m&&m.orders)?rtOrdersHtml(m):'<div class="ai-rt__wait" aria-label="Loading your orders"><span></span><span></span><span></span></div>')+'</div>';
  }else{
    var n=++rtSeq,hid='ai-rt-help-'+n;
    h+='<div class="ai-rt__opts">'+lookupCardHtml('returns-card','',false,{lookup:!!(RETURNS&&RETURNS.lookup),pages:ordPages,noHead:true})+'</div>';
    h+='<button type="button" class="ai-rt__helpbtn" data-rt-help aria-expanded="false" aria-controls="'+hid+'"><span>Where do I find these?</span>'+RT_CHEV+'</button>';
    h+='<ul class="ai-rt__help" id="'+hid+'" hidden>'+
      '<li><b>Order number</b><span>In the subject line of your order confirmation email (\u201cOrder #1234567\u201d) and on the packing slip in the box.</span></li>'+
      '<li><b>Confirmation number</b><span>The short code in that same email \u2014 it works here too.</span></li>'+
      '<li><b>Email</b><span>The one you typed at checkout.</span></li></ul>';
  }
  h+='</div>';return h;
}
function rtOrdersHtml(m){
  var list=(m.orders||[]).map(function(o){return Object.assign({},o,{focus:'return'})});
  var pg=ordPages||{},more='';
  if(!list.length)return '<p class="ai-rt__empty">No orders on this account yet.'+(pg.returns?' <a href="'+esc(pg.returns)+'" target="_blank" rel="noopener">Returns center</a>':'')+'</p>';
  if(m.numberOfOrders>list.length)more='<p class="ai-rt__more">Your last '+list.length+' orders. For older ones, '+(pg.returns?'<a href="'+esc(pg.returns)+'" target="_blank" rel="noopener">use our returns center</a>':'<a href="/account">see your account</a>')+'.</p>';
  return ordersHtml(list,5)+more;
}
function rtFill(card,m){
  if(!card||!CUST_LOGGED_IN||!m||Array.isArray(m.orders))return;
  var body=$('[data-rt-body]',card);if(!body)return;
  fetch('/apps/hajirai/orders',{credentials:'same-origin'}).then(function(r){return r.ok?r.json():null}).then(function(d){
    if(!d||!d.signedIn||!Array.isArray(d.orders)){body.innerHTML='<p class="ai-rt__empty">We couldn\u2019t load your orders just now. '+(ordPages&&ordPages.returns?'<a href="'+esc(ordPages.returns)+'" target="_blank" rel="noopener">Use our returns center</a>, or try':'Try')+' again in a moment.</p>';return}
    if(Array.isArray(d.returnMethods)&&d.returnMethods.length){RET_METHODS=d.returnMethods;m.returnMethods=d.returnMethods}
    if(Array.isArray(d.freeReasons))RET_FREE=d.freeReasons.map(String);
    m.orders=d.orders.slice(0,5);m.numberOfOrders=d.numberOfOrders||0;saveH(messages);
    body.innerHTML=rtOrdersHtml(m);
  }).catch(function(){body.innerHTML='<p class="ai-rt__empty">We couldn\u2019t load your orders just now. Try again in a moment.</p>'});
}
/* ── Deals ──
   A pill on the home: one tap, no AI at tap time. The server answers with
   the offers running now (the store's promotions page and dated campaigns,
   in short lines checked against the page's own words) and the products on
   sale, best discount first. Offers sit in a quiet typographic card under
   the words; the sale products follow as the chat's usual product cards.
   Kept with the message, so it comes back after a reload without a read. */
function dlInsert(b,m){
  var p=b.querySelector(':scope > p');
  if(p)p.insertAdjacentHTML('afterend',dealsCardHtml(m));else b.insertAdjacentHTML('afterbegin',dealsCardHtml(m));
}
function dealsCardHtml(m){
  var has=Array.isArray(m&&m.offers);
  var h='<div class="ai-dl" data-dl role="group" aria-label="Deals">';
  h+='<div class="ai-dl__head"><strong>'+esc((DEALS&&DEALS.label)||'Deals')+'</strong><span>'+(has?(m.offers.length?'Running right now':'No store-wide offers at the moment'):'Checking what\u2019s on\u2026')+'</span></div>';
  h+='<div class="ai-dl__body" data-dl-body>'+(has?dlBodyHtml(m):'<div class="ai-dl__wait" aria-label="Loading"><span></span><span></span></div>')+'</div>';
  h+='</div>';return h;
}
function dlBodyHtml(m){
  var offers=m.offers||[],prods=m.products||[],url=safeUrl((m.dealsUrl||(DEALS&&DEALS.url)||'')),h='';
  if(offers.length){
    h+='<ol class="ai-dl__offers">';
    for(var i=0;i<offers.length;i++){var o=offers[i];
      h+='<li class="ai-dl__offer"><span class="ai-dl__otxt"><b>'+esc(o.title)+'</b>'+(o.detail?'<span>'+esc(o.detail)+'</span>':'')+(o.ends?'<em>Ends '+esc(o.ends)+'</em>':'')+'</span>'+
        (o.code?'<button type="button" class="ai-dl__code" data-dl-code="'+esc(o.code)+'" aria-label="Copy code '+esc(o.code)+'"><span class="ai-dl__codetxt">'+esc(o.code)+'</span><span class="ai-dl__copy">Copy</span></button>':'')+'</li>';}
    h+='</ol>';
  }
  /* The sale cards follow the card on their own; here only the store's see-all link, when it has one. */
  if(prods.length){if(url)h+='<p class="ai-dl__more"><a href="'+esc(url)+'" target="_blank" rel="noopener">See all deals</a></p>'}
  else if(!offers.length)h+='<p class="ai-dl__empty">Nothing is on sale right now'+(url?' \u2014 <a href="'+esc(url)+'" target="_blank" rel="noopener">see the sale page</a>':'')+'. Check back soon, or ask me about a style.</p>';
  else if(url)h+='<p class="ai-dl__more"><a href="'+esc(url)+'" target="_blank" rel="noopener">See all deals</a></p>';
  return h;
}
function dlCopy(btn){
  var code=btn.getAttribute('data-dl-code')||'';if(!code)return;
  var done=function(){var c=btn.querySelector('.ai-dl__copy');if(c){c.textContent='Copied';btn.classList.add('is-copied');setTimeout(function(){c.textContent='Copy';btn.classList.remove('is-copied')},1600)}};
  if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(code).then(done,done);
  else{try{var ta=document.createElement('textarea');ta.value=code;ta.setAttribute('readonly','');ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove()}catch(e){}done()}
}
/* Read once per message: the offers and the sale cards are kept with it. */
function dlFill(card,m){
  if(!card||!m||Array.isArray(m.offers))return;
  var md=card.closest('.ai-chat-msg');
  fetch('/apps/hajirai/deals',{credentials:'same-origin'}).then(function(r){return r.ok?r.json():null}).then(function(d){
    if(!d||!Array.isArray(d.offers)){var bd=$('[data-dl-body]',card);if(bd)bd.innerHTML='<p class="ai-dl__empty">We couldn\u2019t load the deals just now. Try again in a moment.</p>';return}
    m.offers=d.offers.slice(0,6).map(function(o){return {title:String(o.title||'').slice(0,60),detail:String(o.detail||'').slice(0,140),code:String(o.code||'').slice(0,24),ends:String(o.ends||'').slice(0,40)}});
    m.products=(d.products||[]).slice(0,8).map(vaCard).filter(Boolean);
    if(d.url)m.dealsUrl=String(d.url).slice(0,500);
    saveH(messages);
    /* Draw the message again: the card under the words, the sale cards after it. */
    if(md&&md.isConnected&&md.__msg===m){var md2=appendMsg('assistant',m.content,m.products);md2.__msg=m;md.replaceWith(md2);restoreExtras(m,md2,true);
      /* Just opened (the newest message): back to its top — the redraw with the sale cards had scrolled to the bottom on phones. */
      if(messages[messages.length-1]===m){var ud=md2.previousElementSibling;scrollMsgTop(ud&&ud.classList.contains('ai-chat-msg--user')?ud:md2)}}
  }).catch(function(){var bd=$('[data-dl-body]',card);if(bd)bd.innerHTML='<p class="ai-dl__empty">We couldn\u2019t load the deals just now. Try again in a moment.</p>'});
}
function openDeals(){
  if(!DEALS||isStreaming)return;
  var w=$('.ai-chat-welcome',msgsEl);if(w)w.remove();msgsEl.classList.remove('is-welcome');leaveHome();
  var label=(DEALS.label||'Deals');
  messages.push({role:'user',content:label,local:true});var ud=appendMsg('user',label);
  var text='Here\u2019s what\u2019s on right now.',m={role:'assistant',content:text,deals:true};
  messages.push(m);
  var md=appendMsg('assistant',text);md.__msg=m;restoreExtras(m,md,true);
  saveH(messages);scrollMsgTop(ud||md);
}

function openReturns(){
  if(!RETURNS||isStreaming)return;
  var w=$('.ai-chat-welcome',msgsEl);if(w)w.remove();msgsEl.classList.remove('is-welcome');leaveHome();
  messages.push({role:'user',content:'Returns & exchanges',local:true});var ud=appendMsg('user','Returns & exchanges');
  var text=CUST_LOGGED_IN?'Here are your recent orders \u2014 pick the one you\u2019d like to return or exchange.':'Sign in to start a return here'+(RETURNS.lookup?', or look an order up.':'.'),m={role:'assistant',content:text,returns:true};
  messages.push(m);
  var md=appendMsg('assistant',text);md.__msg=m;restoreExtras(m,md,true);
  saveH(messages);scrollMsgTop(ud||md);
}

/* The chat guard (server) ended this chat. The pause is kept here too, so a
   reload or "Start a new chat" doesn't send again before the time is up —
   the server would turn it away anyway. */
var PAUSE_KEY='hajirai_chat_paused';
function chatPausedUntil(){var t=0;try{t=parseInt(localStorage.getItem(PAUSE_KEY)||'0',10)||0}catch(e){}if(t>Date.now())return t;if(t){try{localStorage.removeItem(PAUSE_KEY)}catch(e){}}return 0}
function pauseChat(until){
try{localStorage.setItem(PAUSE_KEY,String(until))}catch(e){}
inputEl.disabled=true;inputEl.placeholder='Chat paused for now';sendBtn.disabled=true;panel.classList.add('is-paused');
var ms=until-Date.now();
if(ms>0&&ms<36e5)setTimeout(function(){if(!chatPausedUntil())resumeChat()},ms+500);
}
function resumeChat(){if(chatPausedUntil())return;panel.classList.remove('is-paused');inputEl.disabled=false;inputEl.placeholder=IPLACE;sendBtn.disabled=false}
function showChatEnded(text,until){
clearWatchdog();isStreaming=false;typingEl.classList.remove('visible');
var t=Date.parse(until||'');if(!(t>Date.now()))t=Date.now()+30*60000;
messages.push({role:'assistant',content:text});saveH(messages);
appendMsg('assistant',text);scrollBottom();
pauseChat(t);
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
        fits:d.fits.map(function(f){return{key:f.key,label:f.label,code:f.code,name:f.name,description:f.description,details:f.details||'',image:safeUrl(f.image||'')}}),
        questions:((d.quiz&&d.quiz.questions)||[]).map(function(q){return{id:String(q.id||''),text:q.text,helpTitle:q.helpTitle||'',helpText:q.helpText,options:(q.options||[]).map(function(o){return{id:String(o.id||''),label:o.label,sublabel:o.sublabel}})}}),
        /* The answers' combinations → the FIT (the app's own table), the
           app's words, its accent, and whether the in-store scan lookup is on. */
        mappings:(d.quiz&&d.quiz.mappings&&typeof d.quiz.mappings==='object')?d.quiz.mappings:{},
        words:{cta:String((d.content&&d.content.cta)||''),learnMore:String((d.content&&d.content.learnMore)||''),savePrompt:String((d.content&&d.content.savePromptLabel)||''),skipSave:String((d.content&&d.content.skipSaveLabel)||''),prefix:String((d.content&&d.content.fitPrefix)||'FIT')},
        accent:/^#[0-9a-f]{3,8}$/i.test(String((d.content&&d.content.accent)||''))?d.content.accent:'',
        scanCta:!!(d.behavior&&d.behavior.scanCta===true),
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
/* What the assistant gets with each message: the FITs and the questions
   as before (no ids, no table — it asks in its own words when a shopper
   types rather than taps). */
function ffFitsForAi(){return ff.fits.map(function(f){return{key:f.key,label:f.label,code:f.code,name:f.name,description:f.description}})}
function ffQuestionsForAi(){return ff.questions.map(function(q){return{text:q.text,helpText:q.helpText,options:q.options.map(function(o){return{label:o.label,sublabel:o.sublabel}})}})}
function ffPayload(){
  if(!ff)return null;
  var local=ffStored();/* a save on this device is the newest choice */
  /* "Retake my FIT": this one message goes without the saved FIT, so the
     questions are asked again; the new answer is saved as usual. */
  if(ffRetake){ffRetake=false;return{fits:ffFitsForAi(),questions:ffQuestionsForAi(),saved:{key:''},retake:true}}
  return{fits:ffFitsForAi(),questions:ffQuestionsForAi(),saved:{key:(local&&local.key)||ff.saved||''}};
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
  var stale=msgsEl.querySelectorAll('.ai-chat-product-card [data-helper="fitfinder"]');
  for(var si=0;si<stale.length;si++){var row=stale[si].parentNode;row.removeChild(stale[si]);if(row.classList.contains('ai-tools'))toolsRelayout(row)}
}

/* ── FITFinder, in the chat's own sheet ──
   The FitFinder app's flow, without the assistant: its questions with their
   "How do I know?" notes, the FIT they map to (the app's own table) as a
   card — its name, what it's for, Learn more — saved to the account or
   carried on with as a guest, the in-store scan lookup, Start over. Nothing
   here costs a turn with the assistant; the saved FIT reaches the chat as
   it always has (ffSave). */
var FFS_PENDING='hajirai_ff_pending';
var FFS_CHEV='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
var FFS_RESTART='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>';
var ffs={view:'quiz',a:{},scan:null,done:'',from:'quiz'};
/* The app's flow can run here: questions with ids, options with ids, a table. */
function ffNative(){
  if(!ff||!ff.questions.length||!ff.mappings)return false;
  var any=false;for(var k in ff.mappings){if(Object.prototype.hasOwnProperty.call(ff.mappings,k)){any=true;break}}
  if(!any)return false;
  for(var i=0;i<ff.questions.length;i++){var q=ff.questions[i];if(!q.id||!q.options.length)return false;for(var j=0;j<q.options.length;j++)if(!q.options[j].id)return false}
  return true;
}
function ffFitByKey(key){for(var i=0;i<ff.fits.length;i++)if(ff.fits[i].key===key)return ff.fits[i];return null}
/* The FIT the answers map to: null until every question is answered,
   false when the table has nothing for that combination. */
function ffsFit(){
  var ids=[];
  for(var i=0;i<ff.questions.length;i++){var v=ffs.a[ff.questions[i].id];if(!v)return null;ids.push(v)}
  var key=ff.mappings[ids.join('|')];
  return key?(ffFitByKey(String(key))||false):false;
}
function ffsLogged(){return !!((ff&&ff.loggedIn)||CUST_LOGGED_IN)}
function ffsKeyLabel(f){return f.label||((ff.words.prefix||'FIT')+' '+f.key)}
/* mode: '' — a saved FIT opens as itself (Your FIT), else the questions;
   'retake' — the questions, cleared; 'keep' — as it was left. */
function openFitFinder(opener,mode){
  if(!ffNative())return false;
  fbOpener=opener||null;
  var sh=fbSheetEl();
  if(mode==='retake'){ffs.view='quiz';ffs.a={};ffs.done='';ffs.scan=null}
  else if(mode!=='keep'){
    var mine=savedFit(),answered=false;for(var k in ffs.a){if(ffs.a[k]){answered=true;break}}
    if(ffs.view!=='done'&&mine&&!answered){ffs.view='done';ffs.done=ffs.done||'known'}
    if(ffs.view==='scan')ffs.view=mine?'done':'quiz';
  }
  if(ffs.view==='done'&&!savedFit()){ffs.view='quiz';ffs.done=''}
  sheetKind='fitfinder';sheetTitle='FITFinder';
  $('.ai-chat-fbsheet__title',sh).textContent=sheetTitle;
  sh.setAttribute('aria-label',sheetTitle);
  sh.setAttribute('data-kind','fitfinder');
  sh.classList.remove('is-failed');sh.classList.add('is-ready');
  menu.style.display='none';
  /* Painted before it rises, so it opens at its own height. */
  clearTimeout(sh.__ffsT);sh.style.height='';ffsPaint(sh);
  sh.hidden=false;void sh.offsetWidth;sh.classList.add('is-open');
  fbBehind(true);
  setTimeout(function(){var b=$('.ai-chat-fbsheet__back',sh);if(b)try{b.focus({preventScroll:true})}catch(e){}},60);
  return true;
}
/* The sheet is only as tall as what it shows: a change in content eases
   its height from the old to the new (no motion for those who prefer
   less). Taller than the chat, it stops at the top and scrolls inside. */
function ffsResize(sh,change){
  if(!sh||sh.getAttribute('data-kind')!=='fitfinder'||!sh.classList.contains('is-open')||!focusMotionOk()){change();if(sh)sh.style.height='';return}
  var from=sh.getBoundingClientRect().height;
  sh.style.transition='none';sh.style.height='';
  change();
  var to=sh.getBoundingClientRect().height;
  if(Math.abs(to-from)<1){sh.style.transition='';return}
  sh.style.height=from+'px';void sh.offsetHeight;
  sh.style.transition='';sh.style.height=to+'px';
  clearTimeout(sh.__ffsT);
  sh.__ffsT=setTimeout(function(){sh.style.height=''},380);
}
function ffsRender(sh){ffsResize(sh,function(){ffsPaint(sh)})}
/* The chat above the FITFinder sheet is dimmed and out of reach (inert):
   a tap there lands on the panel itself, and closes the sheet. */
panel.addEventListener('click',function(e){
  if(!fbSheet||fbSheet.hidden||sheetKind!=='fitfinder'||!fbSheet.classList.contains('is-open'))return;
  if(fbSheet.contains(e.target))return;
  /* (Only the panel itself: the tap that opened the sheet bubbles here
     too, from a button that's now under it.) */
  if(e.target===panel){e.preventDefault();closeFeedback()}
});
function ffsPaint(sh){
  var box=$('.ai-chat-fbsheet__ff',sh);if(!box)return;
  if(ff.accent)box.style.setProperty('--ffs-accent',ff.accent);
  var title=ffs.view==='scan'?'Scanned in one of our stores?':(ff.words.cta||'Help me find my Fit');
  var h='<div class="ai-ffs__head"><span class="ai-ffs__brand" aria-hidden="true"><b>FIT</b>FINDER</span><div class="ai-ffs__title">'+esc(title)+'</div></div>';
  if(ffs.view==='scan')h+=ffsScanHtml();
  else if(ffs.view==='done')h+=ffsDoneHtml();
  else h+=ffsQuizHtml();
  h+='<div class="ai-ffs__foot">'+(ffs.view==='scan'?'<button type="button" class="ai-ffs__scan" data-ffs="quiz">'+(ffs.from==='done'?'Back to my FIT':'Back to the questions')+'</button>':ff.scanCta?'<button type="button" class="ai-ffs__scan" data-ffs="scan">Scanned in one of our stores?</button>':'<span></span>')+'<span class="ai-ffs__powered">Powered by Aetrex Technology</span></div>';
  box.innerHTML=h;
}
function ffsQuizHtml(){
  var h='';
  for(var i=0;i<ff.questions.length;i++){
    var q=ff.questions[i],on=ffs.a[q.id]||'';
    h+='<div class="ai-ffs__q" role="group" aria-labelledby="ai-ffs-q-'+i+'"><div class="ai-ffs__qrow"><span class="ai-ffs__qtext" id="ai-ffs-q-'+i+'">'+esc(q.text)+'</span>'+(q.helpText?'<button type="button" class="ai-ffs__help" data-ffs="help" aria-expanded="false" aria-controls="ai-ffs-help-'+i+'">'+esc(q.helpTitle||'How do I know?')+FFS_CHEV+'</button>':'')+'</div>';
    if(q.helpText)h+='<div class="ai-ffs__helpbox" id="ai-ffs-help-'+i+'" hidden>'+esc(q.helpText)+'</div>';
    h+='<div class="ai-ffs__opts">';
    for(var j=0;j<q.options.length;j++){var o=q.options[j];h+='<button type="button" class="ai-ffs__opt" data-ffs="opt" data-q="'+esc(q.id)+'" data-o="'+esc(o.id)+'" aria-pressed="'+(on===o.id?'true':'false')+'"><b>'+esc(o.label)+'</b>'+(o.sublabel?'<small>'+esc(o.sublabel)+'</small>':'')+'</button>'}
    h+='</div></div>';
  }
  var f=ffsFit();
  return h+'<div class="ai-ffs__tail" data-fit="'+(f?esc(f.key):f===false?'!':'')+'">'+ffsTailHtml(f)+'</div>';
}
/* What follows the questions: the card and Start over once there's a FIT;
   a word when the table has none for that combination; nothing before. */
function ffsTailHtml(f){
  if(f)return ffsRecHtml(f,false)+ffsClearHtml();
  if(f===false)return '<p class="ai-ffs__note is-warn">No matching FIT for that combination — try adjusting an answer.</p>';
  return '';
}
function ffsClearHtml(){return '<div class="ai-ffs__clear"><button type="button" class="ai-ffs__clearbtn" data-ffs="clear">'+FFS_RESTART+'<span>Start over</span></button></div>'}
function ffsDoneHtml(){
  var f=savedFit();
  return f?ffsRecHtml(f,true)+ffsClearHtml():ffsQuizHtml();
}
/* The FIT as a card: Recommended fit (or Your FIT once it's theirs), the
   letter and name, the line, Learn more folded; then the save choices — a
   guest is asked to sign in or carry on; a signed-in shopper's saves on its
   own; a saved one offers the orthotics in it. */
function ffsRecHtml(f,done){
  var h='<div class="ai-ffs__rec" role="status"><div class="ai-ffs__rec-label">'+(done?'Your FIT':'Recommended fit')+'</div><div class="ai-ffs__rec-line"><span class="ai-ffs__rec-key">'+esc(ffsKeyLabel(f))+'</span>'+(f.name?'<span class="ai-ffs__rec-name">'+esc(f.name)+'</span>':'')+'</div>';
  var more=!!(f.details||f.image);
  if(f.description||more){
    h+='<div class="ai-ffs__rec-descrow">'+(f.description?'<p class="ai-ffs__rec-desc">'+esc(f.description)+'</p>':'')+(more?'<button type="button" class="ai-ffs__more" data-ffs="more" aria-expanded="false" aria-controls="ai-ffs-more">'+esc(ff.words.learnMore||'Learn more')+FFS_CHEV+'</button>':'')+'</div>';
    if(more)h+='<div class="ai-ffs__drawer" id="ai-ffs-more" hidden>'+(f.image?'<img class="ai-ffs__img" src="'+esc(f.image)+'" alt="" loading="lazy">':'')+(f.details?'<p>'+esc(f.details)+'</p>':'')+'</div>';
  }
  h+='<div class="ai-ffs__save">';
  var shop='<button type="button" class="ai-ffs__btn is-primary" data-ffs="shop">Show orthotics in my '+esc(ffsKeyLabel(f))+'</button>',close='<button type="button" class="ai-ffs__btn" data-ffs="close">Done</button>';
  if(done){
    h+='<p class="ai-ffs__note">'+(ffs.done==='account'?'Saved to your profile — orthotic pages open on your FIT.':ffs.done==='guest'?'We’ll use this fit while you shop today.':'Your saved FIT — orthotic pages open on it.')+'</p><div class="ai-ffs__ctas">'+shop+close+'</div>';
  }else if(ffsLogged()){
    h+='<div class="ai-ffs__ctas">'+shop+close+'</div><p class="ai-ffs__note">You’re signed in — this fit saves to your profile automatically.</p>';
  }else{
    h+='<p class="ai-ffs__savetitle">'+esc(ff.words.savePrompt||'Save this fit to your account for next time?')+'</p><div class="ai-ffs__ctas"><button type="button" class="ai-ffs__btn is-primary" data-ffs="save-account">Yes (sign in required)</button><button type="button" class="ai-ffs__btn" data-ffs="save-guest">'+esc(ff.words.skipSave||'Continue as guest')+'</button></div><p class="ai-ffs__note">Either way, we’ll use this fit while you shop today.</p>';
  }
  return h+'</div></div>';
}
/* The in-store scan: sign in first (the lookup needs the account's email,
   read by the app, never typed here), then the scan's FIT with its date
   and report, or a word when there's none / it couldn't be checked. */
function ffsScanHtml(){
  var s=ffs.scan||{state:'finding'},h='<div class="ai-ffs__scanbox">';
  if(s.state==='login')h+='<p class="ai-ffs__note">Sign in with the email from your scan.</p><div class="ai-ffs__ctas is-one"><button type="button" class="ai-ffs__btn is-primary" data-ffs="scan-login">Sign in</button></div>';
  else if(s.state==='found'){var f=s.fit;h+='<div class="ai-ffs__rec" role="status"><div class="ai-ffs__rec-label">Your scanned fit</div><div class="ai-ffs__rec-line"><span class="ai-ffs__rec-key">'+esc(f.label||((ff.words.prefix||'FIT')+' '+f.key))+'</span>'+(f.name?'<span class="ai-ffs__rec-name">'+esc(f.name)+'</span>':'')+'</div>'+(s.date?'<div class="ai-ffs__scandate">Scanned '+esc(s.date)+'</div>':'')+'<p class="ai-ffs__note">From your foot scan at our store.</p><div class="ai-ffs__save"><div class="ai-ffs__ctas'+(s.url?'':' is-one')+'"><button type="button" class="ai-ffs__btn is-primary" data-ffs="scan-use">Use my scanned fit</button>'+(s.url?'<a class="ai-ffs__btn" href="'+esc(s.url)+'" target="_blank" rel="noopener">View my scan report</a>':'')+'</div></div></div>'}
  else if(s.state==='none')h+='<p class="ai-ffs__note">We couldn’t find a foot scan for your account. If you were scanned in one of our stores, sign in with the email you gave there.</p>';
  else if(s.state==='error')h+='<p class="ai-ffs__note">Sorry — that didn’t work. Please try again.</p><div class="ai-ffs__ctas is-one"><button type="button" class="ai-ffs__btn is-primary" data-ffs="scan-retry">Try again</button></div>';
  else h+='<div class="ai-ffs__progress" role="status"><span class="ai-ffs__spin" aria-hidden="true"></span>Finding your fit…</div>';
  return h+'</div>';
}
function ffsScanStart(sh){
  if(!ffsLogged()){ffs.scan={state:'login'};ffsRender(sh);return}
  var mine={state:'finding'};ffs.scan=mine;ffsRender(sh);
  fetch(SHOP_ROOT+'apps/fitfinder/scan-fit?visitor='+encodeURIComponent(getSess())+'&origin='+encodeURIComponent(location.origin),{credentials:'same-origin',headers:{'Accept':'application/json'}})
    .then(function(r){return r.json().then(function(d){return{s:r.status,d:d}},function(){return{s:r.status,d:null}})})
    .then(function(x){
      if(ffs.scan!==mine)return;
      var d=x.d||{};
      if(d.found&&d.fit&&d.fit.key){
        var date='';
        if(d.scannedAt){var dd=new Date(d.scannedAt);if(!isNaN(dd.getTime())){try{date=dd.toLocaleDateString(undefined,{year:'numeric',month:'long',day:'numeric'})}catch(e){date=dd.toDateString()}}}
        ffs.scan={state:'found',fit:{key:String(d.fit.key),label:d.fit.label||'',name:d.fit.name||''},date:date,url:safeUrl(d.scanUrl||'')};
      }
      else if(d.needLogin||x.s===401)ffs.scan={state:'login'};
      else if(d.retry||d.error==='unavailable'||d.error==='rate_limited'||x.s>=500||!x.d)ffs.scan={state:'error'};
      else ffs.scan={state:'none'};
      ffsRender(fbSheet);
    })
    .catch(function(){if(ffs.scan===mine){ffs.scan={state:'error'};ffsRender(fbSheet)}});
}
/* Fold / unfold a note (How do I know?, Learn more). */
function ffsFold(b){
  var box=document.getElementById(b.getAttribute('aria-controls')||'');if(!box)return;
  ffsResize(fbSheet,function(){var open=box.hidden;box.hidden=!open;b.setAttribute('aria-expanded',open?'true':'false');b.classList.toggle('is-open',open)});
}
/* The card follows the answers: it comes when they all have one, changes
   with them, goes when one is cleared — the questions themselves stay put
   (an open note stays open). */
function ffsRecUpdate(sh){
  var tail=$('.ai-ffs__tail',sh);if(!tail)return;
  var f=ffsFit(),key=f?f.key:f===false?'!':'';
  if(key===(tail.getAttribute('data-fit')||''))return;
  tail.setAttribute('data-fit',key);ffsResize(sh,function(){tail.innerHTML=ffsTailHtml(f)});
  var rec=$('.ai-ffs__rec',tail);
  if(rec&&rec.scrollIntoView)try{rec.scrollIntoView({block:'nearest',behavior:focusMotionOk()?'smooth':'auto'})}catch(e){}
}
function ffsSaved(how){ffs.view='done';ffs.done=how;ffs.a={};ffsRender(fbSheet)}
function ffsAct(b){
  var sh=fbSheet,a=b.getAttribute('data-ffs'),f;
  if(a==='opt'){
    var q=b.getAttribute('data-q'),o=b.getAttribute('data-o');
    ffs.a[q]=o;
    var sib=b.parentNode.querySelectorAll('.ai-ffs__opt');for(var i=0;i<sib.length;i++)sib[i].setAttribute('aria-pressed',sib[i]===b?'true':'false');
    ffsRecUpdate(sh);return;
  }
  if(a==='help'||a==='more'){ffsFold(b);return}
  if(a==='clear'){ffs.a={};ffs.view='quiz';ffsRender(sh);return}
  if(a==='save-guest'){f=ffsFit();if(!f)return;ffSave(f.key);ffsSaved('guest');return}
  if(a==='save-account'){
    f=ffsFit();if(!f)return;
    if(ffsLogged()){ffSave(f.key);ffsSaved('account');return}
    /* Today's visit has it already; the profile gets it once they're back. */
    ffSave(f.key);try{sessionStorage.setItem(FFS_PENDING,f.key)}catch(e){}
    startSignIn('fitfinder');return;
  }
  if(a==='shop'){
    f=ffs.view==='done'?savedFit():ffsFit();if(!f)return;
    if(ffs.view!=='done'){ffSave(f.key);ffs.view='done';ffs.done=ffsLogged()?'account':'guest';ffs.a={}}
    closeFeedback();focusSend('Show me orthotics in my '+fitTitle(f)+'.');return;
  }
  if(a==='close'){
    f=ffs.view==='done'?null:ffsFit();
    if(f){ffSave(f.key);ffs.view='done';ffs.done=ffsLogged()?'account':'guest';ffs.a={}}
    closeFeedback();return;
  }
  /* The scan leaves from the questions or from a saved FIT; its Back goes to the same. */
  if(a==='scan'){ffs.from=ffs.view==='done'?'done':'quiz';ffs.view='scan';ffsScanStart(sh);return}
  if(a==='quiz'){ffs.view=ffs.from==='done'&&savedFit()?'done':'quiz';ffs.scan=null;ffsRender(sh);return}
  if(a==='scan-login'){startSignIn('fitfinder-scan');return}
  if(a==='scan-retry'){ffsScanStart(sh);return}
  if(a==='scan-use'){
    var s=ffs.scan;if(!s||s.state!=='found')return;
    if(!ffFitByKey(s.fit.key)){ffs.scan={state:'error'};ffsRender(sh);return}
    ffSave(s.fit.key);ffs.scan=null;ffsSaved(ffsLogged()?'account':'guest');return;
  }
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
var body={message:msg,session_id:getSess(),shop_domain:SHOP,assistant_name:NAME,history:historyFor(msg).map(function(m){var out={role:m.role,content:m.content};if(m.role==='assistant'&&Array.isArray(m.compared)&&m.compared.length)out.compared=m.compared.slice(0,3).map(function(c){return{title:String(c&&c.title||''),price:String(c&&c.price||'')}});if(m.role==='assistant'&&m.products&&m.products.length){out.products=m.products.slice(0,10).map(function(p){return{handle:p.handle||'',title:p.title||'',url:p.url||'',image:p.image||'',price:p.price||'',price_formatted:p.price_formatted||'',compare_at_price:p.compare_at_price||'',category:p.category||p._category||'',gender:p.gender||p._gender||''}})}return out})};
if(SUPPORT_URL)body.support_url=SUPPORT_URL;
if(SUPPORT_LABEL)body.support_label=SUPPORT_LABEL;
var ffData=ffPayload();
var tfData=tfPayload();
if(tfData)body.size_finder=tfData;
if(TESTER)body.tester=TESTER;
/* Typed (or spoken) by the shopper, or sent by a button — the store's issues
   card (Recordings) reads only what shoppers type. */
body.typed=SENT_TYPED;
/* Sent by tapping the seasonal button: the chat shows its collection. */
if(SEA_TAP&&SEA_TAP===msg)body.seasonal=true;
SEA_TAP='';
/* "Find my shoe size" with no shoe picked yet, and a style tile from its
   answer: the server answers the first itself and knows what the second is for. */
/* Customer service log: this browser's random id, that a way to reach a
   person is offered (the menu), and on the first message the opening words shown. */
if(VISITOR)body.visitor=VISITOR;
body.human_offered=!!HUMAN;
if(!historyFor(msg).some(function(m){return m.role==='user'&&!m.local}))body.disclosure=(GREET+' '+DISCL).replace(/\s+/g,' ').trim().slice(0,1200);
if(TF_INTRO&&TF_INTRO===msg&&tfData)body.size_intro=true;
if(TF_PICK&&TF_PICK===msg)body.size_pick=true;
TF_INTRO='';TF_PICK='';
if(REC_ON&&(REC_SCOPE==='everyone'||TESTER))body.page=location.pathname.slice(0,200);
/* On a product page, the chat knows which product "this" is. */
var viewingHandle=pageProductHandle();if(viewingHandle)body.viewing=viewingHandle;
if(ffData)body.fitfinder=ffData;
else loadFitfinder();
fetch(CHAT_URL,{method:'POST',headers:{'Content-Type':'application/json','Accept':'text/event-stream'},body:JSON.stringify(body),signal:abortCtrl.signal}).then(function(r){
if(!r.ok){
  if(r.headers.get('content-type')&&r.headers.get('content-type').includes('text/event-stream'))return handleSSE(r);
  return r.json().catch(function(){return{}}).then(function(d){
    var err=new Error(d.message||'');err.status=r.status;err.code=d.error||'';err.until=d.until||'';throw err;
  });
}
var ct=r.headers.get('content-type')||'';
if(ct.includes('text/event-stream')||ct.includes('text/plain'))return handleSSE(r);
return r.json().then(function(d){handleJSON(d)});
}).catch(function(e){
clearWatchdog();
if(e.name==='AbortError')return;
typingEl.classList.remove('visible');isStreaming=false;sendBtn.disabled=false;
/* The chat guard ended this chat: the server's words, and the chat stays
   paused until the time it gave. */
if(e.status===423||e.code==='chat_ended'){showChatEnded(e.message||'I\'ve paused this chat for now. You can keep browsing the store, and the chat will be open again in about 30 minutes.',e.until);return}
/* The store's own limits and settings: say so plainly — retrying won't help. */
if(e.status===429&&e.code==='rate_limited'){showStreamError('You\'re sending messages quickly — please wait a few seconds and try again.');return}
if(e.status===402||e.status===503||(e.status===429&&(e.code==='daily_cap_reached'||e.code==='store_busy'))){showStreamError(e.message||'The assistant isn\'t available right now. Our customer service team will be glad to help.');return}
if(e.status===413||e.status===400){showStreamError('That message couldn\'t be sent. Please try a shorter question, or start a new chat from the menu.');return}
showHighTraffic();
});
}

function handleSSE(response){
var reader=response.body.getReader();
var decoder=new TextDecoder();
var buf='',full='',prods=[],msgDiv=null,buffSugg=[],buffChoices=[],linkCTA=null,fitReport=null,vizCta=null,supportCta=null,sizeFinder=null;
fitResult=null;pendingOrders=null;pendingLogin=null;pendingCompare=null;pendingForm=null;pendingMap=null;pendingViewAll=null;pendingSizeIntro=null;pendingRestock=null;
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
if(p.type==='draft'){
  /* The words as they are written: a draft in the reply's place (the
     typing dots go), swapped for the verified answer in finish() — never
     saved, no thumbs. Following the words only while the reader is at
     the bottom. */
  var dt=draftWords(p.text);
  if(dt){
    if(!msgDiv){typingEl.classList.remove('visible');msgDiv=appendMsg('assistant',dt);msgDiv.classList.add('is-draft');msgDiv.setAttribute('aria-busy','true')}
    else{var db=$('.ai-chat-msg-bubble',msgDiv);if(db){var nearEnd=msgsEl.scrollHeight-msgsEl.scrollTop-msgsEl.clientHeight<80;db.innerHTML='<p>'+md(esc(dt))+'</p>';if(nearEnd)scrollBottom()}}
  }
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
if(p.type==='order_cards'&&Array.isArray(p.orders)&&p.orders.length){pendingOrders=p.orders;if(Array.isArray(p.returnMethods)&&p.returnMethods.length)RET_METHODS=p.returnMethods;if(Array.isArray(p.freeReasons))RET_FREE=p.freeReasons.map(String)}
if(p.type==='login_prompt'){pendingLogin={intent:p.intent==='return'||p.intent==='rewards'?p.intent:'track',lookup:p.lookup===true,order:typeof p.order==='string'?p.order:'',pages:p.pages||null}}
if(p.type==='comparison'&&p.comparison&&Array.isArray(p.comparison.products)){pendingCompare=p.comparison}
if(p.type==='size_finder'&&p.handle){
  sizeFinder={handle:String(p.handle),title:String(p.title||'')};
}
if(p.type==='form_cta'&&/^[A-Za-z0-9]{4,32}$/.test(String(p.form||''))){pendingForm={form:String(p.form),label:String(p.label||'').trim().slice(0,40)||'Open the quiz'}}
if(p.type==='restock_cta'){pendingRestock=cleanRestock(p)}
if(p.type==='map_cta'){pendingMap=cleanMap(p)}
if(p.type==='view_all'){pendingViewAll=cleanViewAll(p)}
if(p.type==='size_intro'){pendingSizeIntro=cleanSizeIntro(p)}
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
var saved={role:'assistant',content:c,products:p,ai:1};
messages.push(saved);
var md=appendMsg('assistant',c,p);md.__msg=saved;saveH(messages);
isStreaming=false;sendBtn.disabled=false;
fbAttach(md,{text:c,prods:p,q:lastUserMessage});
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
/* A draft's words: the chips (<<…>>, even one still being written) and an
   unfinished link out, no dangling emphasis — the cleaning finish() gives
   the answer, applied mid-sentence. */
function draftWords(t){
var s=String(t||'').replace(/\s*<<[^<>]*>>/g,'').replace(/\s*<<[^<>]*$/,'').replace(/\[[^\]]*\]\([^)]*$/,'').replace(/\[[^\]]*$/,'');
return stripDanglingMd(s).trim();
}
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
/* A draft bubble (the words as they were written) becomes the answer. */
var wasDraft=!!(mDiv&&mDiv.classList.contains('is-draft'));
if(wasDraft){mDiv.classList.remove('is-draft');mDiv.removeAttribute('aria-busy')}
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
if(!cleanText&&wasDraft){mDiv.remove();mDiv=null}
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
  else{var b=$('.ai-chat-msg-bubble',mDiv);if(b){var atEnd=msgsEl.scrollHeight-msgsEl.scrollTop-msgsEl.clientHeight<80;b.innerHTML='<p>'+md(esc(cleanText))+'</p>';if(atEnd)scrollBottom();if(prods&&prods.length){var isShowcase2=PRODUCT_CARD_STYLE==='showcase';var styleSuffix2=isShowcase2?' ai-chat-products--showcase':'';var ph='<div class="ai-chat-products'+styleSuffix2+'">';for(var pi=0;pi<prods.length;pi++)ph+=prodCard(prods[pi],fitcAny(prods));ph+='</div>';b.insertAdjacentHTML('beforeend',isShowcase2?showcaseWrap(ph):ph);if(isShowcase2){var w2=b.querySelector('.ai-chat-products-wrap');if(w2)initShowcaseArrows(w2)}b.insertAdjacentHTML('beforeend',compareCtaHtml(prods))}}}
  /* ai: an answer from the assistant (thumbs come back with it after a reload). */
  var _saved={role:'assistant',content:cleanText,products:prods||[],ai:1};
  if(mDiv)mDiv.__msg=_saved;
  if(linkCTA&&linkCTA.url)_saved.linkCTA={url:linkCTA.url,label:linkCTA.label||''};
  /* Order cards come back with the chat (reload, another page). */
  if(pendingOrders){_saved.orders=pendingOrders.slice(0,3);if(RET_METHODS.length)_saved.returnMethods=RET_METHODS}
  /* The comparison table comes back with the chat too. */
  if(pendingCompare){_saved.comparison=pendingCompare;_saved.compared=cmpCompared(pendingCompare)}
  if(pendingForm)_saved.formCta=pendingForm;
  if(pendingMap)_saved.mapCta=pendingMap;
  if(pendingSizeIntro)_saved.sizeIntro=pendingSizeIntro;
  /* Everything else under the reply comes back with it too — the sign-in
     card, buttons, size results, choices — so a reopened chat reads the
     same as it did. */
  if(pendingLogin)_saved.login=pendingLogin;
  if(pendingRestock)_saved.restock=pendingRestock;
  if(supportCta)_saved.support=supportCta;
  if(sizeFinder)_saved.sizeFinder=sizeFinder;
  if(fitReport)_saved.fitReport=fitReport;
  if(vizCta&&vizCta.productHandle)_saved.viz=vizCta;
  if(choices.length)_saved.choices=choices.slice(0,8);
  if(sugg&&sugg.length)_saved.sugg=sugg.slice(0,6);
  if(fitResult&&ff){for(var sf=0;sf<ff.fits.length;sf++){var sfo=ff.fits[sf];if(sfo.key===fitResult)_saved.fit={key:sfo.key,label:sfo.label,name:sfo.name,description:sfo.description}}}
  if(pendingViewAll&&prods&&prods.length){
    _saved.viewAll=pendingViewAll;
    /* The full lists are big: only the latest three stay with the history. */
    for(var vk=messages.length-1,vn=1;vk>=0;vk--){if(messages[vk].viewAll&&++vn>3)delete messages[vk].viewAll}
  }
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
if(pendingForm&&mDiv){
  var fcb=$('.ai-chat-msg-bubble',mDiv);
  if(fcb)fcb.insertAdjacentHTML('beforeend',formCtaHtml(pendingForm));
}
if(pendingMap&&mDiv){
  var mcb=$('.ai-chat-msg-bubble',mDiv);
  if(mcb)mcb.insertAdjacentHTML('beforeend',mapCtaHtml(pendingMap));
}
if(pendingViewAll&&mDiv&&prods&&prods.length){
  var vab=$('.ai-chat-msg-bubble',mDiv);
  if(vab)placeViewAll(vab,pendingViewAll,prods);
}
if(pendingSizeIntro&&mDiv){
  var tib=$('.ai-chat-msg-bubble',mDiv);
  if(tib)tib.insertAdjacentHTML('beforeend',sizeIntroHtml(pendingSizeIntro));
}
pendingForm=null;pendingMap=null;pendingViewAll=null;pendingSizeIntro=null;
if(fitResult&&mDiv){
  var fitP=$('.ai-chat-msg-bubble > p',mDiv),fitObj=null;
  for(var fi=0;ff&&fi<ff.fits.length;fi++){if(ff.fits[fi].key===fitResult)fitObj=ff.fits[fi]}
  if(fitP&&fitObj)fitP.insertAdjacentHTML('afterend',fitCardHtml(fitObj));
  fitResult=null;
}
if(pendingCompare&&mDiv){
  var cmb=$('.ai-chat-msg-bubble',mDiv);
  if(cmb)cmb.insertAdjacentHTML('beforeend',compareHtml(pendingCompare));
  pendingCompare=null;
}
if(pendingOrders&&mDiv){
  var ob=$('.ai-chat-msg-bubble',mDiv);
  if(ob)ob.insertAdjacentHTML('beforeend',ordersHtml(pendingOrders));
  pendingOrders=null;
  setTimeout(resumeReturns,0);
}
if(pendingLogin&&mDiv){
  var lb2=$('.ai-chat-msg-bubble',mDiv);
  if(lb2)lb2.insertAdjacentHTML('beforeend',loginCardHtml(pendingLogin));
  pendingLogin=null;
}
if(pendingRestock&&mDiv){
  var rb=$('.ai-chat-msg-bubble',mDiv);
  if(rb)rb.insertAdjacentHTML('beforeend',restockCardHtml(pendingRestock));
  pendingRestock=null;
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
/* Thumbs under every answer (the newest one only). */
if(cleanText&&mDiv)fbAttach(mDiv,{text:cleanText,prods:prods||[],q:lastUserMessage});
var appSoon=!!(mDiv&&cleanText)&&maybeAppNote($('.ai-chat-msg-bubble',mDiv));
scrollMsgTop(mDiv);
if(!appSoon)maybeAskRating();
}

/* ── Was this answer helpful? ─────────────────────────────────────────
   Quiet thumbs at the foot of the newest answer — every answer, not only
   ones with products — that fold away once the shopper writes again. An
   answer about an order (its status, tracking, a return, shipping) asks in
   words: "Did that answer your question?". A thumbs-down offers a few
   one-tap reasons. A vote is kept with the answer in this browser, so a
   reload never asks again. Settings → "Helpful / Not helpful". */
var FB_WHY=[['wrong_product','Wrong product'],['not_answered','Didn’t answer my question'],['wrong_info','Info was wrong'],['too_slow','Too slow'],['other','Something else']];
var FB_ORDER_Q=/\b(where(?:'s|’s| is) my|track(?:ing)?|deliver(?:y|ed)?|shipping|ship(?:ped)?|package|returns?|returning|exchange|refund)\b/i;
function thumbSvg(dir,on){
  var s=RATE_ICON[dir];
  return on?s.replace('fill="none"','fill="currentColor"'):s;
}
/* A key that ties a vote to the reason picked after it. */
function fbKey(){
  try{if(window.crypto&&crypto.randomUUID)return 'v_'+crypto.randomUUID().replace(/-/g,'')}catch(e){}
  return 'v_'+Date.now().toString(36)+Math.random().toString(36).slice(2,12);
}
/* Asked in words: an answer about an order — order cards, or a reply (not
   a short question back) to a question about tracking, shipping or a
   return. Never on a reply that's waiting for the shopper (sign in, look up
   an order, pick a choice) or on product picks. */
function fbAsks(b,info){
  if(b.querySelector('.ai-ords'))return true;
  if(b.querySelector('.ai-chat-product-card,.ai-ordl,.ai-ord--signin,.ai-chat-choices'))return false;
  if(!FB_ORDER_Q.test(String(info.q||'')))return false;
  var t=String(info.text||'').trim();
  return !(/\?\s*$/.test(t)&&t.length<160);
}
function fbRowHtml(ask){
  return (ask?'<span class="ai-chat-feedback__q">Did that answer your question?</span>':'')+
    '<span class="ai-chat-feedback__btns"><button type="button" class="ai-chat-fb-btn" data-vote="up" aria-label="Helpful" title="Helpful">'+thumbSvg('up')+'</button>'+
    '<button type="button" class="ai-chat-fb-btn" data-vote="down" aria-label="Not helpful" title="Not helpful">'+thumbSvg('down')+'</button></span>';
}
function fbLabel(row,ask){
  row.classList.toggle('is-ask',!!ask);
  row.setAttribute('aria-label',ask?'Did that answer your question?':'Was this answer helpful?');
}
/* The thumbs row of the newest answer, if it has one. */
function fbNewest(){var r=msgsEl.querySelectorAll('.ai-chat-feedback:not(.is-out)');return r.length?r[r.length-1]:null}
/* Older answers stay clean: their rows fold away (a vote is already sent). */
function fbRetire(keep){
  var rows=msgsEl.querySelectorAll('.ai-chat-feedback:not(.is-out)');
  for(var i=0;i<rows.length;i++){if(keep&&keep.contains(rows[i]))continue;foldAway(rows[i])}
}
function fbAttach(md,info){
  if(!SHOW_FEEDBACK||!md)return;
  var b=$('.ai-chat-msg-bubble',md);
  if(!b||$('.ai-chat-feedback',b))return;
  fbRetire(md);
  var ask=fbAsks(b,info);
  var row=el('div','ai-chat-feedback',fbRowHtml(ask));
  row.setAttribute('role','group');fbLabel(row,ask);
  row.__fb={text:String(info.text||''),prods:(info.prods||[]).map(function(p){return String(p&&p.title||'')}).filter(Boolean).slice(0,5),ask:ask,key:fbKey()};
  /* Under the answer, above its quick replies. */
  var sg=b.querySelector('.ai-chat-suggestions');
  if(sg&&sg.parentNode===b)b.insertBefore(row,sg);else b.appendChild(row);
}
/* An order looked up in the answer's card: it's an order answer now. */
function fbOrderShown(b){
  var row=b&&$('.ai-chat-feedback:not(.is-out)',b);
  if(!row||row.getAttribute('data-voted')||(row.__fb&&row.__fb.ask))return;
  if(row.__fb)row.__fb.ask=true;
  row.innerHTML=fbRowHtml(true);fbLabel(row,true);
}
function fbSend(row,vote,reason){
  var f=row.__fb||{};
  var p={vote:vote,key:f.key||fbKey(),session:getSess(),botResponse:String(f.text||'').slice(0,500),products:f.prods||[]};
  if(f.ask)p.moment='order';
  if(reason)p.reason=reason;
  if(vote==='down')p.conversation=messages.slice(-10).map(function(m){return{role:m.role,content:String(m.content||'').slice(0,300)}});
  try{fetch(FEEDBACK_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p),keepalive:true}).catch(function(){})}catch(e){}
}
function fbSay(row){
  var s=$('.ai-chat-fb-say',row);
  if(s)try{s.focus({preventScroll:true})}catch(e){}
  return s;
}
function fbVote(row,vote){
  if(row.getAttribute('data-voted'))return;
  var hadFocus=row.contains(document.activeElement);
  row.setAttribute('data-voted',vote);
  var md=row.closest('.ai-chat-msg');
  if(md&&md.__msg){md.__msg.fb=vote;saveH(messages)}
  fbSend(row,vote,'');
  var keep=rateNearBottom();
  if(vote==='up'){
    row.innerHTML='<span class="ai-chat-fb-mark" aria-hidden="true">'+thumbSvg('up',1)+'</span><span class="ai-chat-fb-say" role="status" tabindex="-1">Thanks for the feedback</span>';
  }else{
    var hasProds=!!(row.__fb&&row.__fb.prods&&row.__fb.prods.length);
    var why=FB_WHY.filter(function(w){return w[0]!=='wrong_product'||hasProds});
    row.classList.add('is-why');
    row.innerHTML='<div class="ai-chat-fb-top"><span class="ai-chat-fb-mark" aria-hidden="true">'+thumbSvg('down',1)+'</span><span class="ai-chat-fb-say" role="status" tabindex="-1">Sorry about that. What went wrong?</span></div>'+
      '<div class="ai-chat-fb-why" role="group" aria-label="What went wrong?">'+why.map(function(w){return '<button type="button" class="ai-chat-fb-chip" data-why="'+w[0]+'">'+esc(w[1])+'</button>'}).join('')+'</div>';
  }
  if(keep)keepInView(row);
  if(hadFocus){
    var first=$('.ai-chat-fb-chip',row);
    if(first)try{first.focus({preventScroll:true})}catch(e){}else fbSay(row);
  }
}
function fbWhy(row,reason){
  if(row.getAttribute('data-why')||row.getAttribute('data-voted')!=='down')return;
  var hadFocus=row.contains(document.activeElement);
  row.setAttribute('data-why',reason);
  fbSend(row,'down',reason);
  row.classList.remove('is-why');
  row.innerHTML='<span class="ai-chat-fb-mark" aria-hidden="true">'+thumbSvg('down',1)+'</span><span class="ai-chat-fb-say" role="status" tabindex="-1">Thanks — this helps us get better</span>';
  if(hadFocus)fbSay(row);
}
msgsEl.addEventListener('click',function(e){
  var t=e.target.closest&&e.target.closest('.ai-chat-feedback [data-vote],.ai-chat-feedback [data-why]');
  if(!t)return;
  var row=t.closest('.ai-chat-feedback');
  if(!row||row.classList.contains('is-out'))return;
  if(t.hasAttribute('data-vote'))fbVote(row,t.getAttribute('data-vote')==='down'?'down':'up');
  else fbWhy(row,t.getAttribute('data-why'));
});

/* Delayed UI for the current chat only — "Clear chat" cancels it. */
var chatGen=0;
function later(fn,ms){var g=chatGen;setTimeout(function(){if(g===chatGen)fn()},ms)}
/* ── "How's the chat going?" ──────────────────────────────────────────
   One quiet note under the conversation — not a chat bubble: thumbs up or
   down for the whole chat. Asked at the moments that matter: right after
   an add to cart ("Did AVA help you find it?") — or, for Buy
   now, which leaves for checkout, when the shopper is back in the chat —
   or else after the store's number of replies. A thumbs-down offers
   one-tap reasons; then an optional comment. Asked once per conversation;
   once a shopper answers or closes it, not again for two weeks. Never while
   a reply is coming, while they're typing, or with a sheet open; never
   right after they rated the answer above; and it never pulls them away
   from what they're reading. Settings → "Ask how the chat went". */
var RATE_ON=true,RATE_AFTER=3,RATE_DONE='hajirai_rate_done',RATE_QUIET=14*864e5;
var RATE_MOMENT='hajirai_rate_moment',RATE_MOMENT_MS=3*864e5;
var RATE_ICON={
  up:'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3z"/><path d="M7 10l4.2-7.2a1.8 1.8 0 0 1 3.3 1.3L13.6 9H19a2 2 0 0 1 2 2.3l-1.2 7.5A2.6 2.6 0 0 1 17.2 21H7"/></svg>',
  down:'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M17 14V3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-3z"/><path d="M17 14l-4.2 7.2a1.8 1.8 0 0 1-3.3-1.3l.9-4.9H5a2 2 0 0 1-2-2.3l1.2-7.5A2.6 2.6 0 0 1 6.8 3H17"/></svg>',
  x:'<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  send:'<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  check:'<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'
};
function rateShownKey(){return 'hajirai_rate_'+getSess()}
/* Asked in this conversation already, or answered / closed lately. */
function rateQuiet(){try{return !!localStorage.getItem(rateShownKey())||Date.now()-(+localStorage.getItem(RATE_DONE)||0)<RATE_QUIET}catch(e){return true}}
function rateNearBottom(){return msgsEl.scrollHeight-msgsEl.scrollTop-msgsEl.clientHeight<90}
/* A moment worth asking about — "cart" (added from the chat) or "buy_now"
   (off to checkout) — kept until it's asked, for this conversation and a
   few days at most. */
function rateNote(m){
  if(!RATE_ON)return;
  try{localStorage.setItem(RATE_MOMENT,JSON.stringify({m:m,s:getSess(),at:Date.now()}))}catch(e){}
}
function ratePending(){
  try{
    var p=JSON.parse(localStorage.getItem(RATE_MOMENT)||'null');
    if(p&&(p.m==='cart'||p.m==='buy_now')&&p.s===getSess()&&Date.now()-(+p.at||0)<RATE_MOMENT_MS)return p.m;
    if(p)localStorage.removeItem(RATE_MOMENT);
  }catch(e){}
  return '';
}
function rateForget(){try{localStorage.removeItem(RATE_MOMENT)}catch(e){}}
function rateQuestion(m){
  if(m!=='cart'&&m!=='buy_now')return 'How’s the chat going?';
  /* The assistant's name when it's a short one ("AVA"). */
  var n=String(NAME||'').trim();
  return /^[^\s]{1,12}$/.test(n)?'Did '+n+' help you find it?':'Did the chat help you find it?';
}
function rateAskHtml(m){
  var moment=m==='cart'||m==='buy_now',yes=moment?'Yes, it helped':'Going well',no=moment?'No, it didn’t':'Not great';
  return '<div class="ai-chat-rate__card"><span class="ai-chat-rate__q">'+esc(rateQuestion(m))+'</span>'+
    '<span class="ai-chat-rate__btns"><button type="button" class="ai-chat-rate__vote" data-rate="up" aria-label="'+yes+'" title="'+yes+'">'+RATE_ICON.up+'</button>'+
    '<button type="button" class="ai-chat-rate__vote" data-rate="down" aria-label="'+no+'" title="'+no+'">'+RATE_ICON.down+'</button></span>'+
    '<button type="button" class="ai-chat-rate__x" data-rate-x aria-label="No thanks" title="No thanks">'+RATE_ICON.x+'</button></div>';
}
/* After a thumbs-down: what went wrong, one tap. */
function rateWhyHtml(prods){
  var why=FB_WHY.filter(function(w){return w[0]!=='wrong_product'||prods});
  return '<div class="ai-chat-rate__card is-voted is-why"><div class="ai-chat-rate__top"><span class="ai-chat-rate__mark">'+thumbSvg('down',1)+'</span>'+
    '<span class="ai-chat-rate__q" role="status">Sorry about that. What went wrong?</span>'+
    '<button type="button" class="ai-chat-rate__x" data-rate-x aria-label="Skip" title="Skip">'+RATE_ICON.x+'</button></div>'+
    '<div class="ai-chat-rate__why" role="group" aria-label="What went wrong?">'+why.map(function(w){return '<button type="button" class="ai-chat-rate__chip" data-rate-why="'+w[0]+'">'+esc(w[1])+'</button>'}).join('')+'</div></div>';
}
function rateCommentHtml(vote){
  return '<div class="ai-chat-rate__card is-voted"><div class="ai-chat-rate__top"><span class="ai-chat-rate__mark">'+thumbSvg(vote,1)+'</span>'+
    '<span class="ai-chat-rate__q" role="status">'+(vote==='up'?'Thanks! Anything to add?':'Thanks. Anything to add?')+'</span>'+
    '<button type="button" class="ai-chat-rate__x" data-rate-x aria-label="Skip" title="Skip">'+RATE_ICON.x+'</button></div>'+
    '<form class="ai-chat-rate__form" novalidate><input class="ai-chat-rate__input" type="text" maxlength="500" autocomplete="off" enterkeyhint="send" placeholder="Add a comment (optional)" aria-label="Add a comment (optional)">'+
    '<button type="submit" class="ai-chat-rate__send" aria-label="Send comment" disabled>'+RATE_ICON.send+'</button></form></div>';
}
function rateDoneHtml(){return '<div class="ai-chat-rate__card is-done" role="status"><span class="ai-chat-rate__check">'+RATE_ICON.check+'</span><span class="ai-chat-rate__q">Thanks for the feedback</span></div>'}
function ratePost(row,vote,comment,reason){
  var p={kind:'chat',vote:vote,session:getSess(),moment:row.getAttribute('data-moment')||'replies',conversation:messages.slice(-10).map(function(m){return{role:m.role,content:String(m.content||'').slice(0,300)}})};
  if(comment)p.comment=comment;
  if(reason)p.reason=reason;
  try{fetch(FEEDBACK_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p),keepalive:true}).catch(function(){})}catch(e){}
}
function rateMarkDone(){try{localStorage.setItem(RATE_DONE,String(Date.now()))}catch(e){}}
/* Fold away: fade, then collapse the space it took. */
function foldAway(row){
  if(!row||!row.isConnected||row.classList.contains('is-out'))return;
  row.style.maxHeight=row.offsetHeight+'px';void row.offsetHeight;
  row.classList.add('is-out');
  setTimeout(function(){if(row.isConnected)row.remove()},window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches?0:380);
}
function rateFinish(row){
  if(!row||!row.isConnected)return;
  row.innerHTML=rateDoneHtml();row.setAttribute('data-state','done');
  later(function(){foldAway(row)},3200);
}
/* A new chat message while the question is still open: it steps aside. */
function rateStepAside(){
  var row=$('.ai-chat-rate',msgsEl);if(!row)return;
  var st=row.getAttribute('data-state');
  if(st==='ask')foldAway(row);
  else if(st==='why')rateFinish(row);
  else if(st==='voted'){var inp=$('.ai-chat-rate__input',row);var c=inp?inp.value.trim():'';if(c)ratePost(row,row.getAttribute('data-vote'),c,row.getAttribute('data-why')||'');rateFinish(row)}
}
/* The optional comment, after a thumbs-up or a reason. */
function rateToComment(row,vote){
  var keep=rateNearBottom();
  row.innerHTML=rateCommentHtml(vote);row.setAttribute('data-state','voted');
  if(keep)keepInView(row);
  /* A keyboard on screen is a lot to ask for an optional comment: the
     field takes focus only with a mouse or trackpad. */
  if(window.matchMedia&&matchMedia('(hover: hover) and (pointer: fine)').matches){var inp=$('.ai-chat-rate__input',row);if(inp)try{inp.focus({preventScroll:true})}catch(_){}}
  else{var xb=$('.ai-chat-rate__x',row);if(xb)try{xb.focus({preventScroll:true})}catch(_){}}
}
/* Right after an add to cart the shopper is looking at "Added to your
   cart": the question comes into view only if that stays in view too. */
function rateReveal(row){requestAnimationFrame(function(){
  if(!row.isConnected)return;
  var mr=msgsEl.getBoundingClientRect(),rr=row.getBoundingClientRect(),pad=12;
  var need=rr.bottom-mr.bottom+pad;if(need<=0)return;
  var all=msgsEl.querySelectorAll('.ai-chat-atc-panel'),a=all[all.length-1];
  if(!a)return;
  var ar=a.getBoundingClientRect();
  if(ar.bottom<=mr.top||ar.top>=mr.bottom||ar.top-need<mr.top+pad)return;
  msgsEl.scrollTop+=need;
})}
function rateHadProducts(){
  for(var i=0;i<messages.length;i++)if(messages[i].role==='assistant'&&messages[i].products&&messages[i].products.length)return true;
  return false;
}
function maybeAskRating(){
  if(!RATE_ON||isStreaming||$('.ai-chat-rate',msgsEl))return;
  var n=0;for(var i=0;i<messages.length;i++)if(messages[i].role==='assistant')n++;
  var moment=ratePending();
  if(!n||(!moment&&n<RATE_AFTER))return;
  if(rateQuiet()){if(moment)rateForget();return}
  later(function(){
    if(!RATE_ON||!isOpen||isStreaming||$('.ai-chat-rate',msgsEl)||rateQuiet())return;
    if(inputEl.value.trim()||(fbSheet&&!fbSheet.hidden)||(fitx&&!fitx.hidden))return;
    /* They've just rated the answer above: not now. */
    var fbr=fbNewest();
    if(fbr&&fbr.getAttribute('data-voted'))return;
    var m=ratePending();
    if(!m&&n<RATE_AFTER)return;
    try{localStorage.setItem(rateShownKey(),'1')}catch(e){}
    rateForget();
    /* The question for the whole chat takes the place of the answer's thumbs. */
    if(fbr)foldAway(fbr);
    var near=rateNearBottom();
    var row=rateRowMake(m);
    msgsEl.appendChild(row);
    void row.offsetWidth;row.classList.add('is-in');
    if(near)keepInView(row);else if(m==='cart')rateReveal(row);
  },1600);
}
/* The rating card as a row with its three steps — the vote, what went
   wrong, a word to add. */
function rateRowMake(m){
  var row=el('div','ai-chat-rate',rateAskHtml(m));
  row.setAttribute('role','group');row.setAttribute('aria-label','Rate this chat');row.setAttribute('data-state','ask');row.setAttribute('data-moment',m||'replies');
  row.addEventListener('click',function(e){
    var v=e.target.closest('[data-rate]');
    if(v&&row.getAttribute('data-state')==='ask'){
      var vote=v.getAttribute('data-rate')==='down'?'down':'up';
      ratePost(row,vote,'','');rateMarkDone();
      try{localStorage.setItem(rateShownKey(),'1')}catch(_){}
      row.setAttribute('data-vote',vote);
      if(vote==='up'){rateToComment(row,'up');return}
      var keep=rateNearBottom();
      row.innerHTML=rateWhyHtml(m==='cart'||m==='buy_now'||rateHadProducts());row.setAttribute('data-state','why');
      if(keep)keepInView(row);
      var c1=$('.ai-chat-rate__chip',row);if(c1)try{c1.focus({preventScroll:true})}catch(_){}
      return;
    }
    var w=e.target.closest('[data-rate-why]');
    if(w&&row.getAttribute('data-state')==='why'){
      var reason=w.getAttribute('data-rate-why');
      row.setAttribute('data-why',reason);
      ratePost(row,'down','',reason);
      rateToComment(row,'down');
      return;
    }
    if(e.target.closest('[data-rate-x]')){
      if(row.getAttribute('data-state')==='ask'){rateMarkDone();foldAway(row);try{inputEl.focus({preventScroll:true})}catch(_){}}
      else rateFinish(row);
    }
  });
  row.addEventListener('input',function(e){
    if(!e.target.classList.contains('ai-chat-rate__input'))return;
    var b=$('.ai-chat-rate__send',row);if(b)b.disabled=!e.target.value.trim();
  });
  row.addEventListener('submit',function(e){
    e.preventDefault();
    var inp=$('.ai-chat-rate__input',row),c=inp?inp.value.trim():'';
    if(c)ratePost(row,row.getAttribute('data-vote')||'up',c,row.getAttribute('data-why')||'');
    rateFinish(row);
  });
  row.addEventListener('keydown',function(e){var st=row.getAttribute('data-state');if(e.key==='Escape'&&(st==='voted'||st==='why')){e.preventDefault();e.stopPropagation();rateFinish(row)}});
  return row;
}

function clearChat(){
chatGen++;clearWatchdog();
rateForget();
messages=[];_memSess='';try{localStorage.removeItem(HK);localStorage.removeItem(SK);localStorage.removeItem(HK_AT)}catch(e){}
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
inputEl.disabled=false;inputEl.placeholder=IPLACE;inputEl.value='';panel.classList.remove('has-text');
inputEl.style.height='auto';
sendBtn.disabled=false;
}

/* Events */
launcher.addEventListener('click',function(e){
if(e.target.closest('.ai-chat-launcher__close')){e.stopPropagation();setLauncherBubble(true,true);return}
if(launcher.classList.contains('is-bubble'))setLauncherBubble(false);
toggle(true);
});
closeBtn.addEventListener('click',function(){toggle(false)});
launcher.addEventListener('keydown',function(e){if((e.key==='Enter'||e.key===' ')&&!e.target.closest('.ai-chat-launcher__close')){e.preventDefault();if(launcher.classList.contains('is-bubble'))setLauncherBubble(false);toggle(true)}});
overlay.addEventListener('click',function(){if(Date.now()-focusSheetShut<600)return;toggle(false)});
sendBtn.addEventListener('click',function(){if(listening){stopVoice();return}sendMessage()});
/* Talk instead of typing. The mic (in Send's place while the box is empty) listens with the browser's own
   speech recognition: words appear in the box as the shopper speaks, and the
   message sends itself when they pause. Tap Send to finish now,
   × or Escape to cancel. The assistant still answers in text. Hidden where
   the browser has no speech recognition, or when the store turns it off. */
var SpeechRec=window.SpeechRecognition||window.webkitSpeechRecognition;
var micBtn=$('.ai-chat-mic',panel),voiceCancelBtn=$('.ai-chat-voice-cancel',panel),voiceStatus=$('.ai-chat-voice-status',panel);
var VOICE_OFF=VOICE_OFF||false,rec=null,listening=false,voiceText='',voiceCancelled=false,voiceErr='',voiceBase='',voiceHintT=0,voiceHearT=0;
function showMic(){var on=!!SpeechRec&&!VOICE_OFF;micBtn.hidden=!on;panel.classList.toggle('has-voice',on);if(!on&&listening)cancelVoice()}
function growInput(){inputEl.style.height='auto';inputEl.style.height=Math.min(inputEl.scrollHeight,100)+'px';hasText()}
function hasText(){panel.classList.toggle('has-text',!!inputEl.value.trim())}
inputEl.addEventListener('input',hasText);
function voiceHint(msg){
  clearTimeout(voiceHintT);
  inputEl.setAttribute('placeholder',msg);voiceStatus.textContent=msg;panel.classList.add('is-voice-hint');
  voiceHintT=setTimeout(function(){panel.classList.remove('is-voice-hint');if(!listening)inputEl.setAttribute('placeholder',IPLACE);voiceStatus.textContent=''},3400);
}
function voiceUI(on){
  listening=on;
  panel.classList.toggle('is-listening',on);
  if(!on)panel.classList.remove('is-hearing');
  micBtn.setAttribute('aria-pressed',on?'true':'false');
  micBtn.setAttribute('aria-label',on?'Stop listening':'Talk instead of typing');
  voiceCancelBtn.hidden=!on;
  inputEl.readOnly=on;
  if(on){clearTimeout(voiceHintT);panel.classList.remove('is-voice-hint');inputEl.setAttribute('placeholder','Listening\u2026');voiceStatus.textContent='Listening'}
  else if(!panel.classList.contains('is-voice-hint')){inputEl.setAttribute('placeholder',IPLACE);voiceStatus.textContent=''}
}
function hearing(){panel.classList.add('is-hearing');clearTimeout(voiceHearT);voiceHearT=setTimeout(function(){panel.classList.remove('is-hearing')},420)}
function startVoice(){
  if(listening||isStreaming||!SpeechRec||VOICE_OFF)return;
  try{rec=new SpeechRec()}catch(e){voiceHint('Voice isn\u2019t available here \u2014 please type');return}
  rec.lang=document.documentElement.getAttribute('lang')||navigator.language||'en-US';
  rec.interimResults=true;rec.continuous=false;rec.maxAlternatives=1;
  voiceBase=inputEl.value.trim();voiceText='';voiceCancelled=false;voiceErr='';
  rec.onspeechstart=hearing;
  rec.onresult=function(ev){
    var t='';for(var i=0;i<ev.results.length;i++)t+=ev.results[i][0].transcript;
    voiceText=t.replace(/\s+/g,' ').trim();
    inputEl.value=(voiceBase?voiceBase+' ':'')+voiceText;growInput();hearing();
  };
  rec.onerror=function(ev){voiceErr=ev&&ev.error||'error'};
  rec.onend=function(){
    var cancelled=voiceCancelled,heard=voiceText,err=voiceErr;
    rec=null;voiceUI(false);
    if(cancelled){inputEl.value=voiceBase;growInput();return}
    if(heard){sendMessage();return}
    if(err==='not-allowed'||err==='service-not-allowed')voiceHint('Allow microphone access to talk');
    else if(err==='network'||err==='audio-capture')voiceHint('Voice isn\u2019t available right now \u2014 please type');
    else voiceHint('Didn\u2019t catch that \u2014 tap the mic and try again');
  };
  voiceUI(true);
  try{rec.start()}catch(e){rec=null;voiceUI(false);voiceHint('Voice isn\u2019t available right now \u2014 please type');return}
  try{if(navigator.vibrate)navigator.vibrate(8)}catch(e){}
}
function stopVoice(){if(rec){try{rec.stop()}catch(e){}}}
function cancelVoice(){if(rec){voiceCancelled=true;try{rec.abort()}catch(e){}}}
/* One button, one place: the mic while the box is empty; once there are
   words (typed or spoken) the same circle is Send. Tapping the mic while it
   still hears nothing just stops listening. */
micBtn.addEventListener('click',function(){if(listening){if(voiceText)stopVoice();else cancelVoice()}else startVoice()});
voiceCancelBtn.addEventListener('click',function(){cancelVoice();inputEl.focus()});
panel.addEventListener('keydown',function(e){if(e.key==='Escape'&&listening){e.preventDefault();e.stopPropagation();cancelVoice()}},true);
closeBtn.addEventListener('click',cancelVoice);
showMic();
inputEl.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage()}});
inputEl.addEventListener('input',function(){this.style.height='auto';this.style.height=Math.min(this.scrollHeight,100)+'px'});
/* Escape steps back one level wherever focus is: a filter panel, then a
   sheet (View all, a survey, the map), picking cards to compare, then the
   chat itself. */
document.addEventListener('keydown',function(e){
  if(e.key!=='Escape'||!isOpen)return;
  if(focusSheetEl){closeFocusSheet();return}
  if(fitx&&!fitx.hidden){fitxClose();return}
  if(fbSheet&&!fbSheet.hidden){if(vfOpen)vfClose(true);else closeFeedback();return}
  var pk=document.activeElement&&document.activeElement.closest&&document.activeElement.closest('.is-cmp-picking');
  if(pk){cmpCancel(pk);return}
  var lf=document.activeElement&&document.activeElement.closest&&document.activeElement.closest('.ai-ordl__form');
  if(lf){var lb=panel.querySelector('[aria-controls="'+lf.id+'"]');if(lb){ordlOpen(lb,false);try{lb.focus()}catch(_){}}return}
  toggle(false);
});
menuBtn.setAttribute('aria-haspopup','true');menuBtn.setAttribute('aria-expanded','false');
menuBtn.addEventListener('click',function(e){e.stopPropagation();var show=menu.style.display==='none';if(show)menu.innerHTML=menuHtml();menu.style.display=show?'block':'none';menuBtn.setAttribute('aria-expanded',show?'true':'false');if(show){var first=menu.querySelector('.ai-chat-menu-item');if(first)first.focus({preventScroll:true})}});
menu.addEventListener('click',function(e){
  var item=e.target.closest('[data-action]');if(!item)return;
  var a=item.dataset.action;
  menu.style.display='none';menuBtn.setAttribute('aria-expanded','false');
  if(a==='clear')clearChat();
  else if(a==='human')openHuman();
  else if(a==='refit'){if(!isStreaming)startHelper('refit')}
  else if(a==='survey')openFeedback(menuBtn);
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
  inputEl.value=lastUserMessage;BTN_SEND=!SENT_TYPED;sendMessage();
  return;
}
var cmpBtn=e.target.closest('[data-cmp-start],[data-cmp-go],[data-cmp-cancel],[data-cmp-mode],[data-cmp-unpick]');
if(cmpBtn){
  e.preventDefault();
  var cbub=cmpBtn.closest('.ai-chat-msg-bubble');
  if(cmpBtn.hasAttribute('data-cmp-mode')){cmpMode(cmpBtn);return}
  if(!cbub)return;
  if(cmpBtn.hasAttribute('data-cmp-start'))startCompare(cbub);
  else if(cmpBtn.hasAttribute('data-cmp-go'))runCompare(cbub,cmpPicked(cbub));
  else if(cmpBtn.hasAttribute('data-cmp-unpick'))cmpUnpick(cbub,cmpBtn.getAttribute('data-cmp-unpick'));
  else cmpCancel(cbub);
  return;
}
/* The app mention: open it, and switch iPhone / Android. */
var appBtn=e.target.closest('[data-appn],[data-appn-pf],[data-appn-x]');
if(appBtn){e.preventDefault();if(appBtn.hasAttribute('data-appn'))appNoteToggle(appBtn);else if(appBtn.hasAttribute('data-appn-x'))appNoteClose(appBtn);else appNoteSwitch(appBtn);return}
/* How True Fit works: the line switch, and a style tile asks for those shoes. */
var tfiBtn=e.target.closest('[data-tfi-show],[data-tfi-ask]');
if(tfiBtn){
  e.preventDefault();
  if(tfiBtn.hasAttribute('data-tfi-show')){tfiShow(tfiBtn);return}
  if(isStreaming)return;
  var tfiAsk=tfiBtn.getAttribute('data-tfi-ask');
  TF_PICK=tfiAsk;inputEl.disabled=false;inputEl.placeholder=IPLACE;sendBtn.disabled=false;inputEl.value=tfiAsk;BTN_SEND=true;sendMessage();
  return;
}
/* Picking cards to compare: a tap anywhere on a card picks it. */
var pickCard=e.target.closest('.is-cmp-picking .ai-chat-product-card[data-handle]');
if(pickCard){e.preventDefault();e.stopPropagation();cmpToggle(pickCard);return}
var atcBtn=e.target.closest('[data-atc]');
if(atcBtn){e.preventDefault();e.stopPropagation();startAddToCart(atcBtn.closest('.ai-chat-product-card,.ai-cmp__buy'),atcBtn);return}
var nowBtn=e.target.closest('[data-buynow]');
if(nowBtn){e.preventDefault();e.stopPropagation();startBuyNow(nowBtn.closest('.ai-chat-product-card'),nowBtn);return}
// Handoff support CTA button → live chat (Zendesk/Intercom/Gorgias), Support
// Hub URL only as fallback.
var fitqBtn=e.target.closest('[data-fitq]');
if(fitqBtn){e.preventDefault();e.stopPropagation();fitqToggle(fitqBtn);return;}
var fitxBtn=e.target.closest('[data-fitx]');
if(fitxBtn){e.preventDefault();e.stopPropagation();fitxOpen(fitxBtn);return;}
var helperBtn=e.target.closest('[data-helper]');
if(helperBtn){e.preventDefault();if(!isStreaming)startHelper(helperBtn.getAttribute('data-helper'));return;}
var tfBtn=e.target.closest('[data-truefit]');
if(tfBtn){e.preventDefault();trueFitFor(tfBtn.getAttribute('data-truefit'),tfBtn.getAttribute('data-title')||'');return;}
var fbBtn=e.target.closest('[data-feedback]');
if(fbBtn){e.preventDefault();openFeedback(fbBtn);return;}
var vaBtn=e.target.closest('[data-viewall]');
if(vaBtn){e.preventDefault();openViewAll(vaBtn,vaBtn.getAttribute('data-viewall'));return;}
var mapBtn=e.target.closest('[data-map]');
if(mapBtn){e.preventDefault();openLocator(mapBtn,mapBtn.getAttribute('data-map'),mapBtn.getAttribute('data-map-label'),mapBtn.getAttribute('data-map-url'));return;}
var formBtn=e.target.closest('[data-form]');
if(formBtn){e.preventDefault();openForm(formBtn,formBtn.getAttribute('data-form'),formBtn.getAttribute('data-form-label'),'quiz');return;}
var supportCtaBtn=e.target.closest('[data-support-cta]');
if(supportCtaBtn){e.preventDefault();humanUsed('live_chat');openSupportChat(supportCtaBtn.getAttribute('data-fallback'));return;}
var rwOpen=e.target.closest('[data-rewards-open]');
if(rwOpen){e.preventDefault();openRewards();return;}
var rtOpen=e.target.closest('[data-returns-open]');
if(rtOpen){e.preventDefault();openReturns();return;}
var dlOpen=e.target.closest('[data-deals-open]');
if(dlOpen){e.preventDefault();openDeals();return;}
var dlCode=e.target.closest('[data-dl-code]');
if(dlCode){e.preventDefault();dlCopy(dlCode);return;}
var rtHelp=e.target.closest('[data-rt-help]');
if(rtHelp){e.preventDefault();var rtList=document.getElementById(rtHelp.getAttribute('aria-controls'));if(rtList){rtList.hidden=!rtList.hidden;rtHelp.setAttribute('aria-expanded',String(!rtList.hidden))}return;}
var hhRow=e.target.closest('[data-human]');
if(hhRow){var hhHow=hhRow.getAttribute('data-human');humanUsed(hhHow);if(hhHow==='live_chat'){e.preventDefault();openSupportChat(SUPPORT_URL)}return;}
var deadEnd=e.target.closest('[data-dead-end]');
if(deadEnd){
  var action=deadEnd.getAttribute('data-dead-end');
  if(action==='support'){humanUsed('live_chat');openSupportChat(SUPPORT_URL);}
  if(action==='new-chat'){clearChat();inputEl.disabled=false;inputEl.placeholder=IPLACE;sendBtn.disabled=false}
  return;
}
var cta=e.target.closest('[data-message]');
if(cta){var t=cta.getAttribute('data-message');if(t){SEA_TAP=cta.hasAttribute('data-seasonal')?t:'';inputEl.disabled=false;inputEl.placeholder=IPLACE;sendBtn.disabled=false;inputEl.value=t;BTN_SEND=true;sendMessage()}}
/* Chat product link clicks → set a cart attribute so the orders/create
   webhook can tag the resulting order "SEoS". keepalive lets the POST
   complete even though the browser is navigating away. Best-effort —
   any failure is silent (we don't block navigation on a tracking call). */
var prodLink=e.target.closest('.ai-chat-product-card a[href]');
if(prodLink)markChatAttributed();
});

/* A saved reply's extras, drawn in the order finish() draws them. Saved
   data is checked before it's shown. */
var STR=function(v,n){return typeof v==='string'?v.trim().slice(0,n||200):''};
function cleanStrs(a,max,len){return Array.isArray(a)?a.map(function(x){return STR(x,len)}).filter(Boolean).slice(0,max):[]}
var HANDLE_RE=/^[a-z0-9][a-z0-9-]{0,200}$/i;
function cleanLogin(p){
  if(!p||typeof p!=='object')return null;
  return {intent:p.intent==='return'||p.intent==='rewards'?p.intent:'track',lookup:p.lookup===true,order:/^[A-Za-z0-9-]{3,24}$/.test(String(p.order||''))?String(p.order):'',pages:p.pages||null};
}
function cleanRestock(p){
  if(!p||typeof p!=='object')return null;
  var v=String(p.variant||''),t=STR(p.title,120);
  if(!/^\d{1,20}$/.test(v)||!HANDLE_RE.test(String(p.handle||''))||!t)return null;
  return {handle:String(p.handle),title:t,choice:STR(p.choice,60),image:safeUrl(p.image),variant:v,done:p.done===true};
}
function cleanSupport(p){
  if(!p||typeof p!=='object')return null;
  var u=STR(p.fallbackUrl,500);
  return {label:STR(p.label,80)||SUPPORT_LABEL,fallbackUrl:/^(https?:\/\/|\/)/i.test(u)?u:''};
}
function cleanFinder(p){return p&&HANDLE_RE.test(String(p.handle||''))?{handle:String(p.handle),title:STR(p.title)}:null}
function cleanFitReport(p){
  if(!p||!STR(p.size,20))return null;
  return {handle:HANDLE_RE.test(String(p.handle||''))?String(p.handle):'',productTitle:STR(p.productTitle),size:STR(p.size,20),
    confidence:Math.max(0,Math.min(100,parseInt(p.confidence,10)||0)),reasons:cleanStrs(p.reasons,6,200),
    display:p.display==='percent'||p.display==='hide'?p.display:'bar'};
}
function cleanFit(p){return p&&STR(p.label,40)?{key:STR(p.key,40),label:STR(p.label,40),name:STR(p.name,80),description:STR(p.description,300)}:null}
function cleanViz(p){
  if(!p||!HANDLE_RE.test(String(p.productHandle||'')))return null;
  return {productHandle:String(p.productHandle),productTitle:STR(p.productTitle),styleContext:STR(p.styleContext,300),label:STR(p.label,40)||'See It Styled',
    scenes:Array.isArray(p.scenes)&&p.scenes.length?p.scenes.slice(0,12):null,sceneGroup:STR(p.sceneGroup,40),productCategory:STR(p.productCategory,60)};
}
function restoreExtras(m,md,live){
  var b=$('.ai-chat-msg-bubble',md);if(!b)return;
  var add=function(h){if(h)b.insertAdjacentHTML('beforeend',h)};
  var prods=m.products||[];
  var viz=cleanViz(m.viz);
  if(viz){var vc=b.querySelector('.ai-chat-product-card[data-handle="'+viz.productHandle+'"]');if(vc)injectVizButton(vc,viz)}
  var ch=cleanStrs(m.choices,8,120);
  if(ch.length){add(choiceButtonsHtml(ch));var lc=b.querySelector('.ai-chat-choices:last-of-type');if(lc)initChoicesScroll(lc)}
  if(m.linkCTA&&m.linkCTA.url)add(ctaHtml(m.linkCTA));
  var sup=cleanSupport(m.support);if(sup)add(supportCtaHtml(sup));
  var fc=m.formCta;
  if(fc&&/^[A-Za-z0-9]{4,32}$/.test(String(fc.form||'')))add(formCtaHtml({form:String(fc.form),label:String(fc.label||'').slice(0,40)||'Open the quiz'}));
  var mc=cleanMap(m.mapCta);if(mc)add(mapCtaHtml(mc));
  var va=m.viewAll&&prods.length?cleanViewAll(m.viewAll):null;if(va)placeViewAll(b,va,prods);
  var ti=cleanSizeIntro(m.sizeIntro);if(ti)add(sizeIntroHtml(ti));
  /* The instant cards (no AI): drawn from the store's current settings. */
  if(m.rewards&&REWARDS){add(rewardsCardHtml(REWARDS));var rwc=b.querySelector('[data-rw]');if(rwc)rwFillBalance(rwc)}
  if(m.human&&HUMAN)add(humanCardHtml(HUMAN));
  if(m.returns&&RETURNS){add(returnsCardHtml(m));var rtc=b.querySelector('[data-rt]');if(rtc)rtFill(rtc,m)}
  if(m.deals&&DEALS){dlInsert(b,m);var dlc=b.querySelector('[data-dl]');if(dlc)dlFill(dlc,m)}
  var fit=cleanFit(m.fit);
  if(fit){var fp=$('.ai-chat-msg-bubble > p',md);if(fp)fp.insertAdjacentHTML('afterend',fitCardHtml(fit))}
  if(m.comparison)add(compareHtml(m.comparison));
  if(Array.isArray(m.orders)&&m.orders.length&&!m.returns){
    if(Array.isArray(m.returnMethods)&&m.returnMethods.length)RET_METHODS=m.returnMethods;
    add(ordersHtml(m.orders));
  }
  /* Signed in since: the orders come in the chat now, not this card. */
  var lg=CUST_LOGGED_IN?null:cleanLogin(m.login);if(lg)add(loginCardHtml(lg));
  var rs=cleanRestock(m.restock);if(rs)add(restockCardHtml(rs));
  var tf=cleanFinder(m.sizeFinder);if(tf)add(trueFitBtnHtml(tf));
  var fr=cleanFitReport(m.fitReport);
  if(fr){
    var mp=fr.handle?b.querySelector('.ai-chat-product-card[data-handle="'+fr.handle+'"]'):null;
    if(mp&&!mp.closest('.ai-chat-products--showcase')){mp.classList.add('has-fit');mp.insertAdjacentHTML('beforeend',fitSnippetHtml(fr))}
    else add(fitReportHtml(fr));
  }
  var sg=cleanStrs(m.sugg,6,200);
  if(sg.length){var h='<div class="ai-chat-suggestions"><div class="ai-chat-suggestions-label">Quick replies</div>';for(var si=0;si<sg.length;si++){h+='<button class="ai-chat-suggest-btn" data-message="'+esc(sg[si])+'"><span class="suggest-plus">+</span> '+esc(sg[si])+'</button>'}add(h+'</div>')}
  if(!live){var st=b.querySelectorAll('.ai-chat-choices, .ai-chat-suggestions');for(var sj=0;sj<st.length;sj++)st[sj].classList.add('is-stale')}
}

/* Init */
setTimeout(tfResume,0);
/* A chat already under way: the line, not the face, from the start. */
if(FOCUS&&messages.length)focusSetChatting(true);
if(messages.length===0)buildWelcome();
else{
  /* Only the last reply's choices stay tappable, as in a live chat. */
  var _last=messages[messages.length-1];
  for(var i=0;i<messages.length;i++){
    var _md=appendMsg(messages[i].role,messages[i].content,messages[i].products);
    if(_md&&messages[i].role==='assistant'){
      _md.__msg=messages[i];
      restoreExtras(messages[i],_md,messages[i]===_last);
      /* The newest answer keeps its thumbs until they're used. */
      if(messages[i]===_last&&_last.ai&&!_last.fb){var _q=messages[i-1];fbAttach(_md,{text:_last.content,prods:_last.products||[],q:_q&&_q.role==='user'?_q.content:''})}
    }
  }
}
if(messages.length)resumeReturns();

})();
