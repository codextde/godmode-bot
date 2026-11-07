import type { ArtifactFile } from "./artifacts";
import { ARTIFACT_KIT_CSS, ARTIFACT_KIT_JS } from "./artifactKit";

/** The artifact's files as its page sees them. `base`: absolute, loaded from the core. `inline`: name to data URL, for a download that stands alone. */
export interface ArtifactDocumentFiles {
  base: string | null;
  list: ArtifactFile[];
  inline?: Record<string, string>;
}

export const ARTIFACT_THEME_LIGHT = {
  bg: "#faf9f5",
  card: "#ffffff",
  fg: "#1a1a1a",
  muted: "#75716a",
  border: "rgb(38 32 22 / 0.1)",
  accent: "#0eca7b",
  "accent-fg": "#04130c",
  positive: "#087f4d",
  negative: "#d4101f",
};

export const ARTIFACT_THEME_DARK = {
  bg: "#1c1b19",
  card: "#232220",
  fg: "#f4f2ed",
  muted: "#a29e96",
  border: "rgb(255 250 240 / 0.09)",
  accent: "#2fd690",
  "accent-fg": "#06140d",
  positive: "#2fd690",
  negative: "#f0525b",
};

const FONT = `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

const vars = (p: Record<string, string>) => Object.entries(p).map(([k, v]) => `--gm-${k}:${v};`).join("") + `--gm-font:${FONT};`;

const BASE_STYLE = `:root{${vars(ARTIFACT_THEME_LIGHT)}color-scheme:light}:root.dark{${vars(ARTIFACT_THEME_DARK)}color-scheme:dark}html,body{margin:0}body{background:var(--gm-bg);color:var(--gm-fg);font-family:var(--gm-font);-webkit-font-smoothing:antialiased}`;

const scriptSafe = (code: string) => code.replace(/<\/script/gi, "<\\/script");

export function bridgeScript(token: string, data: unknown, theme: "light" | "dark", standalone = false, files?: ArtifactDocumentFiles): string {
  const json = (v: unknown) => JSON.stringify(v ?? null).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
  const base = files?.base ?? "";
  const attr = base.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<style>${BASE_STYLE}${ARTIFACT_KIT_CSS}</style><base target="_blank"${base ? ` href="${attr}"` : ""}><script>(function(){
var T=${json(token)},P=${standalone ? "null" : "window.parent"},B=${json(base)},I=${json(files?.inline ?? null)},dl=[],tl=[],w={},n=0,bad={};
function post(m){if(!P)return;m.__gm=T;P.postMessage(m,"*");}
function call(fn,v){try{fn(v);}catch(e){report(e);}}
function report(e){post({type:"error",message:String(e&&e.message||e),stack:String(e&&e.stack||"").slice(0,2000)});}
function setTheme(t){g.theme=t;document.documentElement.classList.toggle("dark",t==="dark");tl.forEach(function(f){call(f,t);});}
var F=${json(files?.list ?? [])},N={},S={};F.forEach(function(f){N[f.name]=1;if(f.source)S[f.source]=f.name;});
function nameOf(s){s=String(s||"");if(!s||/^(https?:|data:|blob:|#|mailto:|tel:|javascript:)/i.test(s))return null;if(N[s])return s;var p=s.replace(/^file:\\/\\/(localhost)?/i,"").split(/[?#]/)[0];try{p=decodeURIComponent(p);}catch(x){}if(S[p])return S[p];var b=p.split(/[\\\\/]/).pop();return N[b]?b:null;}
function fileUrl(name){name=String(name);var k=nameOf(name)||name;if(I&&I[k])return I[k];return B?B+encodeURIComponent(k):k;}
function own(u){if(!B)return null;u=String(u||"");if(u.indexOf(B)!==0)return null;try{return decodeURIComponent(u.slice(B.length).split(/[?#]/)[0]);}catch(x){return null;}}
var g={data:${json(data)},theme:${json(theme)},files:F.map(function(f){f.url=fileUrl(f.name);return f;}),
file:fileUrl,nameOf:nameOf,
view:function(name){post({type:"viewFile",name:nameOf(name)||String(name)});},
reviewDone:function(){post({type:"reviewDone"});},
onData:function(f){dl.push(f);call(f,g.data);return function(){dl=dl.filter(function(x){return x!==f;});};},
onTheme:function(f){tl.push(f);return function(){tl=tl.filter(function(x){return x!==f;});};},
setData:function(next){if(typeof next==="function")next=next(g.data);g.data=next;dl.forEach(function(f){call(f,next);});if(!P)return Promise.resolve(true);var id=++n;return new Promise(function(res,rej){w[id]=[res,rej];post({type:"setData",id:id,data:next});});},
ask:function(text){post({type:"ask",text:String(text||"").slice(0,500)});},
refresh:function(){post({type:"refresh"});}};
window.godmode=g;
document.documentElement.classList.toggle("dark",g.theme==="dark");
window.addEventListener("message",function(e){if(e.source!==P)return;var m=e.data;if(!m||m.__gm!==T)return;
if(m.type==="data"){g.data=m.data;dl.forEach(function(f){call(f,m.data);});}
else if(m.type==="theme")setTheme(m.theme);
else if(m.type==="reply"&&w[m.id]){var p=w[m.id];delete w[m.id];if(m.ok)p[0](true);else{var err=new Error(m.error||"Not saved");err.gmSave=true;p[1](err);}}});
function open(u){var k=nameOf(u);if(k){g.view(k);return;}try{u=new URL(String(u),document.baseURI).href;}catch(x){return;}var f=own(u);if(f)g.view(f);else if(/^(https?|mailto|tel):/i.test(u))post({type:"open",url:u});}
window.open=function(u){open(u);return null;};
function shown(t){return t&&t.tagName==="IMG"&&!(t.closest&&t.closest("a,button,[data-gm-noview]"))&&own(t.currentSrc||t.src);}
document.addEventListener("click",function(e){var a=e.target&&e.target.closest&&e.target.closest("a[href]");if(!a||a.hasAttribute("download"))return;var h=a.getAttribute("href")||"";if(/^javascript:/i.test(h))return;e.preventDefault();if(h.charAt(0)==="#"){if(h.length>1)location.hash=h;return;}open(a.href);},true);
document.addEventListener("click",function(e){if(e.defaultPrevented)return;var f=shown(e.target);if(f)g.view(f);});
document.addEventListener("load",function(e){if(shown(e.target))e.target.style.cursor="zoom-in";},true);
document.addEventListener("error",function(e){var t=e.target;if(!t||t.tagName!=="IMG")return;var s=t.getAttribute("src")||"";if(!s||/^(https:|data:|blob:)/i.test(s)||bad[s])return;var k=nameOf(s);if(k&&fileUrl(k)!==s){t.setAttribute("src",fileUrl(k));return;}bad[s]=1;report("The image "+s+" didn't load");},true);
document.addEventListener("DOMContentLoaded",function(){post({type:"ready"});});
if(F.length){var Q="img,video,audio,source,a",A=["src","poster","href"],fix=function(x){if(x.nodeType!==1)return;var l=x.matches(Q)?[x]:[];l=l.concat([].slice.call(x.querySelectorAll(Q)));l.forEach(function(y){A.forEach(function(a){var s=y.getAttribute(a),k=s&&nameOf(s),u=k&&fileUrl(k);if(u&&u!==s&&(I||s!==k))y.setAttribute(a,u);});});};new MutationObserver(function(r){r.forEach(function(m){if(m.type==="attributes")fix(m.target);else m.addedNodes.forEach(fix);});}).observe(document,{childList:true,subtree:true,attributes:true,attributeFilter:A});}
window.addEventListener("error",function(e){if(e.target&&e.target!==window)return;report(e.error||e.message);});
window.addEventListener("unhandledrejection",function(e){if(e.reason&&e.reason.gmSave)return;report(e.reason);});
})();</script><script>${scriptSafe(ARTIFACT_KIT_JS)}</script>`;
}

/** Whether the page brings its own <html>, <head> or <body>; comments and scripts don't count. In one pass: a regex over them starts over at every "<!--" that never closes. */
function isWholePage(html: string): boolean {
  const tag = /<!--|<script\b|<(?:html|head|body)[\s>]/gi;
  for (let found = tag.exec(html); found; found = tag.exec(html)) {
    if (/^<(?:html|head|body)/i.test(found[0])) return true;
    const end = found[0] === "<!--" ? /-->/g : /<\/script\b/gi;
    end.lastIndex = tag.lastIndex;
    if (!end.exec(html)) return false;
    tag.lastIndex = end.lastIndex;
  }
  return false;
}

/**
 * The page with the policy and the bridge in front of any byte of it, so nothing in it can decide where they land or run
 * ahead of them. A page's own <html> and <head> after this only add their attributes and contents. What is looked for in
 * the page only sets the layout: a fragment gets its <body>.
 */
export function policyFirstDocument(html: string, head: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">${head}</head>${isWholePage(html) ? html : `<body>${html}</body>`}`;
}

/** The bridge sets the theme's class before the page's <html> is parsed, and the parser then drops the page's own class: this puts it back. */
function pageClasses(html: string): string {
  const open = /<html\b/i.exec(html)?.index ?? -1;
  if (open === -1) return "";
  const close = html.indexOf(">", open);
  const tag = html.slice(open, close === -1 ? undefined : close);
  const classes = /\sclass="([\w\s:./-]*)"/i.exec(tag)?.[1]?.split(/\s+/).filter(Boolean) ?? [];
  return classes.length ? `<script>document.documentElement.classList.add(...${JSON.stringify(classes)});</script>` : "";
}

/** The artifact in the desktop app's frame, whose server sets the policy. */
export function artifactDocument(html: string, bridge: string): string {
  return policyFirstDocument(html, pageClasses(html) + bridge);
}

const standaloneCsp = (from: string) =>
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https: blob: data:; style-src 'unsafe-inline' https:; img-src https: data: blob:${from}; font-src https: data:; connect-src https: wss:; media-src https: data: blob:${from}; worker-src blob:; frame-src https:">`;

export const ARTIFACT_STANDALONE_CSP = standaloneCsp("");

export function standaloneDocument(html: string, data: unknown, theme: "light" | "dark", files?: ArtifactDocumentFiles): string {
  const origin = files?.base ? /^https?:\/\/[^/]+/.exec(files.base)?.[0] : null;
  const from = origin ? ` ${origin}` : "";
  const viewport = `<meta name="viewport" content="width=device-width, initial-scale=1">`;
  return policyFirstDocument(html, viewport + standaloneCsp(from) + pageClasses(html) + bridgeScript("standalone", data, theme, true, files));
}

/**
 * For a native WebView (the phone app): the page has no parent, so the bridge posts to its own window and this relay
 * hands what it says to the app (`window.ReactNativeWebView`); the app answers with `window.postMessage`. Like a
 * standalone download it keeps to its CDN libraries and its files, never the network the phone is on.
 */
export function webViewDocument(html: string, token: string, data: unknown, theme: "light" | "dark", files?: ArtifactDocumentFiles): string {
  const origin = files?.base ? /^https?:\/\/[^/]+/.exec(files.base)?.[0] : null;
  const from = origin ? ` ${origin}` : "";
  const relay = `<script>(function(){var T=${JSON.stringify(token)},A={data:1,theme:1,reply:1};window.addEventListener("message",function(e){var m=e.data;if(e.source!==window||!m||m.__gm!==T||A[m.type]||!window.ReactNativeWebView)return;try{window.ReactNativeWebView.postMessage(JSON.stringify(m));}catch(x){}});})();</script>`;
  // A phone-wide viewport first: a page's own viewport tag comes later and wins.
  const viewport = `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`;
  return policyFirstDocument(html, viewport + standaloneCsp(from) + relay + pageClasses(html) + bridgeScript(token, data, theme, false, files));
}
