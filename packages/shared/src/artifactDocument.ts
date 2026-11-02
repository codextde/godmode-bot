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
function fileUrl(name){name=String(name);if(I&&I[name])return I[name];return B?B+encodeURIComponent(name):name;}
function own(u){if(!B)return null;u=String(u||"");if(u.indexOf(B)!==0)return null;try{return decodeURIComponent(u.slice(B.length).split(/[?#]/)[0]);}catch(x){return null;}}
var g={data:${json(data)},theme:${json(theme)},files:${json(files?.list ?? [])}.map(function(f){f.url=fileUrl(f.name);return f;}),
file:fileUrl,
view:function(name){post({type:"viewFile",name:String(name)});},
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
function open(u){try{u=new URL(String(u),document.baseURI).href;}catch(x){return;}var f=own(u);if(f)g.view(f);else if(/^(https?|mailto|tel):/i.test(u))post({type:"open",url:u});}
window.open=function(u){open(u);return null;};
function shown(t){return t&&t.tagName==="IMG"&&!(t.closest&&t.closest("a,button,[data-gm-noview]"))&&own(t.currentSrc||t.src);}
document.addEventListener("click",function(e){var a=e.target&&e.target.closest&&e.target.closest("a[href]");if(!a||a.hasAttribute("download"))return;var h=a.getAttribute("href")||"";if(/^javascript:/i.test(h))return;e.preventDefault();if(h.charAt(0)==="#"){if(h.length>1)location.hash=h;return;}open(a.href);},true);
document.addEventListener("click",function(e){if(e.defaultPrevented)return;var f=shown(e.target);if(f)g.view(f);});
document.addEventListener("load",function(e){if(shown(e.target))e.target.style.cursor="zoom-in";},true);
document.addEventListener("error",function(e){var t=e.target;if(!t||t.tagName!=="IMG")return;var s=t.getAttribute("src")||"";if(!s||/^(https:|data:|blob:)/i.test(s)||bad[s])return;bad[s]=1;report("The image "+s+" didn't load"+(own(t.currentSrc||t.src)?"":": it isn't attached to the artifact"));},true);
document.addEventListener("DOMContentLoaded",function(){post({type:"ready"});});
if(I){var fix=function(x){if(x.nodeType!==1)return;var l=x.matches("img,video,audio,source")?[x]:[];l=l.concat([].slice.call(x.querySelectorAll("img,video,audio,source")));l.forEach(function(y){var s=y.getAttribute("src");if(s&&I[s])y.setAttribute("src",I[s]);});};new MutationObserver(function(r){r.forEach(function(m){if(m.type==="attributes")fix(m.target);else m.addedNodes.forEach(fix);});}).observe(document,{childList:true,subtree:true,attributes:true,attributeFilter:["src"]});}
window.addEventListener("error",function(e){if(e.target&&e.target!==window)return;report(e.error||e.message);});
window.addEventListener("unhandledrejection",function(e){if(e.reason&&e.reason.gmSave)return;report(e.reason);});
})();</script><script>${scriptSafe(ARTIFACT_KIT_JS)}</script>`;
}

export function artifactDocument(html: string, bridge: string): string {
  const plain = html.replace(/<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script>/gi, (m) => " ".repeat(m.length));
  const head = /<head(\s[^>]*)?>/i.exec(plain);
  if (head) return html.slice(0, head.index + head[0].length) + bridge + html.slice(head.index + head[0].length);
  const root = /<html(\s[^>]*)?>/i.exec(plain);
  if (root) return html.slice(0, root.index + root[0].length) + `<head>${bridge}</head>` + html.slice(root.index + root[0].length);
  const doctype = /<!doctype[^>]*>/i.exec(plain);
  const body = doctype ? html.slice(doctype.index + doctype[0].length) : html;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${bridge}</head><body>${body}</body></html>`;
}

const standaloneCsp = (from: string) =>
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https: blob: data:; style-src 'unsafe-inline' https:; img-src https: data: blob:${from}; font-src https: data:; connect-src https: wss:; media-src https: data: blob:${from}; worker-src blob:; frame-src https:">`;

export const ARTIFACT_STANDALONE_CSP = standaloneCsp("");

export function standaloneDocument(html: string, data: unknown, theme: "light" | "dark", files?: ArtifactDocumentFiles): string {
  const origin = files?.base ? /^https?:\/\/[^/]+/.exec(files.base)?.[0] : null;
  const from = origin ? ` ${origin}` : "";
  return artifactDocument(html, standaloneCsp(from) + bridgeScript("standalone", data, theme, true, files));
}
