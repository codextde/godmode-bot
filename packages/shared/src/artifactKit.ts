
export const ARTIFACT_KIT_CSS = String.raw`:root{--gm-s1:#2a78d6;--gm-s2:#eb6834;--gm-s3:#1baf7a;--gm-s4:#eda100;--gm-s5:#e87ba4;--gm-s6:#008300;--gm-s7:#6250d6;--gm-s8:#e34948;--gm-good:#0ca30c;--gm-warning:#fab219;--gm-serious:#ec835a;--gm-critical:#d03b3b;--gm-grid:#e9e8e2;--gm-axis:#898781}
:root.dark{--gm-s1:#3987e5;--gm-s2:#d95926;--gm-s3:#199e70;--gm-s4:#c98500;--gm-s5:#d55181;--gm-s6:#008300;--gm-s7:#9085e9;--gm-s8:#e66767;--gm-grid:#2f2e2b;--gm-axis:#898781}
.gm-page{max-width:1160px;margin:0 auto;padding:24px 20px 48px;font-family:var(--gm-font);color:var(--gm-fg);font-size:14px;line-height:1.45}
.gm-page *,.gm-page *::before,.gm-page *::after{box-sizing:border-box}
.gm-header{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:12px;margin-bottom:20px}
.gm-title{font-size:22px;font-weight:650;letter-spacing:-.01em;margin:0;line-height:1.25}
.gm-subtitle,.gm-muted{color:var(--gm-muted);font-size:13px}
.gm-vstack{display:flex;flex-direction:column;gap:16px;min-width:0}
.gm-row{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(min(var(--gm-min,200px),100%),1fr))}
.gm-cols{display:grid;gap:12px;align-items:start}
@media (max-width:760px){.gm-cols{grid-template-columns:1fr!important}}
.gm-section{margin-top:12px}.gm-section-head{margin-bottom:12px}
.gm-h2{font-size:17px;font-weight:600;margin:0 0 2px;letter-spacing:-.01em}
.gm-card{background:var(--gm-card);border:1px solid var(--gm-border);border-radius:12px;padding:16px;min-width:0}
.gm-card-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:12px}
.gm-card-title{font-size:14px;font-weight:600;margin:0}
.gm-card-sub{color:var(--gm-muted);font-size:12.5px;margin-top:1px}
.gm-kpi-label{color:var(--gm-muted);font-size:12px;font-weight:500}
.gm-kpi-value{font-size:30px;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums;margin-top:4px;line-height:1.15}
.gm-kpi-note{font-size:12px;color:var(--gm-muted);margin-top:4px}
.gm-delta{font-weight:600;white-space:nowrap}.gm-delta.gm-up{color:var(--gm-positive)}.gm-delta.gm-down{color:var(--gm-negative)}
.gm-seg{display:inline-flex;border:1px solid var(--gm-border);border-radius:8px;overflow:hidden;flex:none}
.gm-seg button{border:0;background:transparent;color:var(--gm-muted);font:inherit;font-size:12px;padding:5px 10px;cursor:pointer}
.gm-seg button[aria-pressed=true]{background:var(--gm-fg);color:var(--gm-bg)}
.gm-btn{border:1px solid var(--gm-border);background:var(--gm-card);color:var(--gm-fg);border-radius:8px;padding:6px 12px;font:inherit;font-size:13px;cursor:pointer}
.gm-btn:hover{border-color:var(--gm-muted)}.gm-btn-primary{background:var(--gm-accent);color:var(--gm-accent-fg);border-color:transparent}
.gm-badge{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;font-size:11.5px;font-weight:600;background:color-mix(in oklab,var(--gm-fg) 7%,transparent);color:var(--gm-fg)}
.gm-badge::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--gm-tone,var(--gm-muted))}
.gm-tone-good{--gm-tone:var(--gm-good)}.gm-tone-warning{--gm-tone:var(--gm-warning)}.gm-tone-serious{--gm-tone:var(--gm-serious)}.gm-tone-critical{--gm-tone:var(--gm-critical)}.gm-tone-info{--gm-tone:var(--gm-s1)}
.gm-table-wrap{overflow-x:auto}
.gm-table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}
.gm-table th,.gm-table td{padding:7px 8px;border-bottom:1px solid var(--gm-border);text-align:left;white-space:nowrap}
.gm-table th{color:var(--gm-muted);font-weight:500;font-size:12px}
.gm-table th.gm-sort{cursor:pointer;user-select:none}.gm-table th.gm-sort:hover{color:var(--gm-fg)}
.gm-table .gm-r{text-align:right}
.gm-bars-row{display:grid;grid-template-columns:minmax(90px,200px) 1fr minmax(36px,auto);gap:10px;align-items:center;padding:4px 0;font-size:13px}
.gm-bars-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gm-bars-track{display:flex;gap:2px;height:12px}
.gm-bars-track>i{display:block;height:100%;min-width:2px}.gm-bars-track>i:last-child{border-radius:0 4px 4px 0}
.gm-bars-value{text-align:right;font-variant-numeric:tabular-nums}
.gm-bars-group{font-size:11px;color:var(--gm-muted);text-transform:uppercase;letter-spacing:.04em;margin:12px 0 2px}.gm-bars-group:first-child{margin-top:0}
.gm-callout{border-left:3px solid var(--gm-tone,var(--gm-s1));padding:10px 14px;background:color-mix(in oklab,var(--gm-card) 90%,var(--gm-tone,var(--gm-s1)));border-radius:0 8px 8px 0;font-size:13px}
.gm-legend{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;color:var(--gm-muted)}
.gm-legend>span{display:inline-flex;align-items:center;gap:6px}
.gm-sw{width:10px;height:10px;border-radius:3px;display:inline-block;flex:none}
.gm-chart{position:relative;min-width:0}.gm-plot{position:relative;width:100%}
.gm-chart-top{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px}
.gm-chart svg{display:block;overflow:visible}
.gm-chart svg text{fill:var(--gm-muted);font-size:11px;font-family:var(--gm-font)}
.gm-tip{position:absolute;pointer-events:none;background:var(--gm-card);border:1px solid var(--gm-border);border-radius:8px;padding:8px 10px;font-size:12px;box-shadow:0 6px 20px rgba(0,0,0,.14);min-width:150px;opacity:0;transition:opacity .08s;z-index:20;color:var(--gm-fg)}
.gm-tip-t{font-weight:600;margin-bottom:4px}
.gm-tip-r{display:flex;justify-content:space-between;gap:14px}.gm-tip-r>span{display:inline-flex;align-items:center;gap:6px;color:var(--gm-muted)}.gm-tip-r>b{font-weight:600;font-variant-numeric:tabular-nums}
.gm-stack-row{display:grid;grid-template-columns:minmax(100px,170px) 1fr;gap:12px;align-items:center;padding:6px 0}
.gm-stackbar{display:flex;gap:2px;height:22px;min-width:0}
.gm-stackbar>div{height:100%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;color:#fff;overflow:hidden;white-space:nowrap}
.gm-stackbar>div:first-child{border-radius:4px 0 0 4px}.gm-stackbar>div:last-child{border-radius:0 4px 4px 0}.gm-stackbar>div:only-child{border-radius:4px}
.gm-text{font-size:13.5px}.gm-text p{margin:0 0 6px}
.gm-list{margin:0;padding-left:18px;font-size:13.5px}.gm-list li{margin:3px 0}
.gm-tabs{display:flex;flex-direction:column;gap:12px}
.gm-donut{display:flex;flex-wrap:wrap;align-items:center;gap:18px}
.gm-donut-legend{display:flex;flex-direction:column;gap:6px;font-size:12.5px;min-width:160px;max-width:420px;flex:1}
.gm-donut-legend>div{display:grid;grid-template-columns:auto 1fr auto auto;gap:8px;align-items:center}
.gm-donut-legend b{font-weight:600;font-variant-numeric:tabular-nums}
.gm-error{border:1px dashed var(--gm-negative);color:var(--gm-negative);padding:8px 10px;border-radius:8px;font-size:12px}
.gm-hidden{display:none!important}
@media (max-width:600px){.gm-page{padding:16px 12px 32px}.gm-kpi-value{font-size:26px}.gm-title{font-size:19px}.gm-bars-row{grid-template-columns:minmax(80px,120px) 1fr minmax(32px,auto)}.gm-stack-row{grid-template-columns:1fr}}`;

export const ARTIFACT_KIT_JS = String.raw`(function(){"use strict";
var NS="http://www.w3.org/2000/svg",DAY=/^\d{4}-\d{2}-\d{2}$/;
function isNum(v){return typeof v==="number"&&isFinite(v);}
function toDate(v){if(v instanceof Date)return v;if(typeof v==="string"&&DAY.test(v))return new Date(v+"T12:00:00");if(typeof v==="string"||isNum(v)){var d=new Date(v);return isNaN(d.getTime())?null:d;}return null;}
function digits(v){var a=Math.abs(v);return v%1===0?0:a<10?2:a<100?1:0;}
var fmt={
num:function(v,d){return isNum(v)?v.toLocaleString(undefined,{maximumFractionDigits:d==null?digits(v):d}):(v==null?"–":String(v));},
pct:function(v,d){return isNum(v)?(v*100).toLocaleString(undefined,{maximumFractionDigits:d==null?(Math.abs(v)<.1&&v!==0?1:0):d})+"%":"–";},
pct100:function(v,d){return isNum(v)?fmt.pct(v/100,d):"–";},
money:function(v,cur,d){if(!isNum(v))return "–";try{return v.toLocaleString(undefined,{style:"currency",currency:cur||"EUR",maximumFractionDigits:d==null?(Math.abs(v)>=1000?0:2):d,minimumFractionDigits:d==null?(Math.abs(v)>=1000?0:2):d});}catch(e){return fmt.num(v,2)+" "+(cur||"");}},
compact:function(v){return isNum(v)?v.toLocaleString(undefined,{notation:"compact",maximumFractionDigits:1}):"–";},
date:function(v){var d=toDate(v);return d?d.toLocaleDateString(undefined,{day:"numeric",month:"short",year:"numeric"}):(v==null?"–":String(v));},
day:function(v){var d=toDate(v);return d?d.toLocaleDateString(undefined,{day:"numeric",month:"short"}):(v==null?"–":String(v));},
datetime:function(v){var d=toDate(v);return d?d.toLocaleString(undefined,{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}):(v==null?"–":String(v));}};
function format(v,f){if(typeof f==="function")return f(v);if(v==null||v==="")return "–";var s=String(f||(isNum(v)?"num":"text")),sign=false;if(s.charAt(0)==="+"){sign=true;s=s.slice(1);}var p=s.split(":"),n=p[0],a=p[1],out;
if(n==="date"||n==="day"||n==="datetime")return fmt[n](v);if(n==="text"||!isNum(v))return String(v);
if(n==="pct"||n==="pct100")out=fmt[n](v,a!=null?+a:undefined);else if(n==="money")out=fmt.money(v,a||"EUR");else if(n==="compact")out=fmt.compact(v);else out=fmt.num(v,a!=null?+a:undefined);
return sign&&v>0?"+"+out:out;}
function add(p,c){if(c==null||c===false)return;if(Array.isArray(c)){for(var i=0;i<c.length;i++)add(p,c[i]);return;}p.appendChild(c instanceof Node?c:document.createTextNode(String(c)));}
function el(tag,attrs){var e=document.createElement(tag);if(attrs)for(var k in attrs){var v=attrs[k];if(v==null||v===false)continue;if(k==="class")e.className=v;else if(k==="style"&&typeof v==="object")Object.assign(e.style,v);else if(k==="text")e.textContent=v;else if(k==="html")e.innerHTML=v;else if(k.slice(0,2)==="on"&&typeof v==="function")e.addEventListener(k.slice(2),v);else e.setAttribute(k,v===true?"":v);}for(var i=2;i<arguments.length;i++)add(e,arguments[i]);return e;}
function sv(tag,attrs){var e=document.createElementNS(NS,tag);if(attrs)for(var k in attrs)if(attrs[k]!=null)e.setAttribute(k,attrs[k]);return e;}
function host(t){var h=typeof t==="string"?document.querySelector(t):t;if(!h)throw new Error("No element "+t);return h;}
function color(i){return "var(--gm-s"+(i%8+1)+")";}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];});}
function rich(s){return esc(s==null?"":s).replace(/\*\*([^*]+)\*\*/g,"<b>$1</b>").replace(/\n/g,"<br>");}
function legend(series){return el("div",{class:"gm-legend"},series.map(function(s){return el("span",null,el("i",{class:"gm-sw",style:{background:s.color}}),s.label);}));}
function tip(box){var t=box.querySelector(":scope>.gm-tip");if(!t){t=el("div",{class:"gm-tip"});box.appendChild(t);}return t;}
function showTip(box,ev,title,rows){var t=tip(box);t.innerHTML="";t.appendChild(el("div",{class:"gm-tip-t"},title));rows.forEach(function(r){t.appendChild(el("div",{class:"gm-tip-r"},el("span",null,r.color?el("i",{class:"gm-sw",style:{background:r.color}}):null,r.label),el("b",null,r.value)));});
var b=box.getBoundingClientRect(),x=ev.clientX-b.left+14,y=ev.clientY-b.top-12;t.style.opacity="1";var w=t.offsetWidth,h=t.offsetHeight;if(x+w>b.width)x=ev.clientX-b.left-w-14;if(x<0)x=0;if(y+h>b.height+40)y=b.height+40-h;if(y<0)y=0;t.style.left=x+"px";t.style.top=y+"px";}
function hideTip(box){var t=box.querySelector(":scope>.gm-tip");if(t)t.style.opacity="0";}
function niceScale(lo,hi,n){if(lo===hi)hi=lo+1;var raw=(hi-lo)/(n||4),mag=Math.pow(10,Math.floor(Math.log10(raw))),r=raw/mag,step=(r<=1?1:r<=2?2:r<=2.5?2.5:r<=5?5:10)*mag,a=Math.floor(lo/step+1e-9)*step,b=Math.ceil(hi/step-1e-9)*step,t=[];for(var v=a;v<=b+step/2;v+=step)t.push(+v.toFixed(10));return {lo:a,hi:b,ticks:t};}
function roundTop(x,y,w,h,r){if(h<=0||w<=0)return "";r=Math.min(r,w/2,h);return "M"+x+","+(y+h)+"V"+(y+r)+"Q"+x+","+y+" "+(x+r)+","+y+"H"+(x+w-r)+"Q"+(x+w)+","+y+" "+(x+w)+","+(y+r)+"V"+(y+h)+"Z";}
function seriesOf(o){var s=o.series||[{key:o.y||"value",label:o.label||o.y||"Value"}];return s.slice(0,8).map(function(se,i){if(typeof se==="string")se={key:se,label:se};return {key:se.key,label:se.label||se.key,color:se.color||color(i),format:se.format};});}
function val(r,k){var v=r?+r[k]:NaN;return isFinite(v)?v:null;}
function observe(plot,draw){var last=-1;function go(){var w=plot.clientWidth;if(w&&w!==last){last=w;draw(w);}}if(typeof ResizeObserver!=="undefined")new ResizeObserver(go).observe(plot);else window.addEventListener("resize",go);requestAnimationFrame(go);}
function chart(t,o){o=o||{};var box=host(t);box.innerHTML="";box.classList.add("gm-chart");var type=o.type||"bar",S=seriesOf(o),st={share:!!o.share,table:false},top=el("div",{class:"gm-chart-top"}),plot=el("div",{class:"gm-plot"}),tbl=el("div",{class:"gm-hidden"});
if(type==="donut")return donut(box,o,S);if(type==="hbar")return hbar(box,o,S);
var stacked=type==="stackedBar"||(type==="area"&&o.stacked);
if(S.length>1)top.appendChild(legend(S));else top.appendChild(el("span"));
var ctr=el("div",{style:{display:"flex",gap:"8px",flexWrap:"wrap"}});
function seg(opts,cur,on){return el("div",{class:"gm-seg",role:"group"},opts.map(function(p){return el("button",{type:"button","aria-pressed":String(p[0]===cur),onclick:function(){on(p[0]);[].forEach.call(this.parentNode.children,function(b){b.setAttribute("aria-pressed",String(b===this));},this);}},p[1]);}));}
if(stacked&&o.toggle)ctr.appendChild(seg([["share",o.shareLabel||"Share"],["count",o.countLabel||"Count"]],st.share?"share":"count",function(v){st.share=v==="share";draw(plot.clientWidth);}));
if(o.tableToggle)ctr.appendChild(seg([["chart",o.chartLabel||"Chart"],["table",o.tableLabel||"Table"]],"chart",function(v){st.table=v==="table";plot.classList.toggle("gm-hidden",st.table);tbl.classList.toggle("gm-hidden",!st.table);}));
if(ctr.children.length)top.appendChild(ctr);if(S.length>1||ctr.children.length)box.appendChild(top);box.appendChild(plot);box.appendChild(tbl);
if(o.tableToggle)table(tbl,{rows:o.data||[],columns:[{key:o.x||"x",label:o.xLabel||"",format:o.xFormat||(DAY.test(String((o.data||[])[0]&&(o.data||[])[0][o.x||"x"]))?"day":"text")}].concat(S.map(function(s){return {key:s.key,label:s.label,format:s.format||o.format,align:"right"};}))});
function draw(W){xy(plot,box,o,S,type,stacked&&st.share,stacked,W);}
observe(plot,draw);return box;}
function xy(plot,box,o,S,type,share,stacked,W){plot.innerHTML="";var data=o.data||[],xk=o.x||"x",n=data.length,H=o.height||240;if(!n){plot.appendChild(el("div",{class:"gm-muted",style:{padding:"24px 0"}},o.empty||"No data"));return;}
var lo=0,hi=0;function tot(r){var s=0;S.forEach(function(se){var v=val(r,se.key);if(v!=null)s+=v;});return s;}
data.forEach(function(r){if(stacked)hi=Math.max(hi,share?1:tot(r));else S.forEach(function(se){var v=val(r,se.key);if(v!=null){hi=Math.max(hi,v);lo=Math.min(lo,v);}});});
if(type==="line"&&o.zero===false){var mn=Infinity;data.forEach(function(r){S.forEach(function(se){var v=val(r,se.key);if(v!=null)mn=Math.min(mn,v);});});if(isFinite(mn))lo=mn;}
var sc=share?{lo:0,hi:1,ticks:[0,.25,.5,.75,1]}:niceScale(lo,hi,4),yf=share?"pct":(o.format||"num"),labs=sc.ticks.map(function(v){return format(v,yf);}),line=type==="line"||type==="area",direct=line&&S.length>1&&S.length<=4;
var m={t:8,r:direct?Math.min(110,Math.max.apply(null,S.map(function(s){return s.label.length;}))*6.2+12):8,b:30,l:Math.max.apply(null,labs.map(function(s){return s.length;}))*6.4+12},iw=Math.max(40,W-m.l-m.r),ih=H-m.t-m.b,step=iw/n;
function y(v){return m.t+ih-(v-sc.lo)/(sc.hi-sc.lo)*ih;}function cx(i){return m.l+step*(i+.5);}
var svg=sv("svg",{width:W,height:H,role:"img","aria-label":o.title||"Chart"});
sc.ticks.forEach(function(t,i){svg.appendChild(sv("line",{x1:m.l,x2:W-m.r,y1:y(t),y2:y(t),stroke:"var(--gm-grid)","stroke-width":t===0?1.25:1}));var tx=sv("text",{x:m.l-8,y:y(t)+4,"text-anchor":"end"});tx.textContent=labs[i];svg.appendChild(tx);});
var xf=o.xFormat||(DAY.test(String(data[0][xk]))?"day":"text"),xl=data.map(function(r){return format(r[xk],xf);}),maxL=Math.max.apply(null,xl.map(function(s){return s.length;})),every=Math.max(1,Math.ceil(n/Math.max(1,Math.floor(iw/(maxL*6.3+12)))));
xl.forEach(function(s,i){if(i%every&&i!==n-1)return;if(i===n-1&&i%every&&(n-1)%every<every*.6)return;var tx=sv("text",{x:cx(i),y:H-m.b+16,"text-anchor":"middle"});tx.textContent=s;svg.appendChild(tx);});
var g=sv("g");svg.appendChild(g);
if(!line){var gw=Math.min(step*(stacked||S.length===1?.68:.8),stacked||S.length===1?44:Math.max(14,S.length*18)),bw=stacked?gw:(gw-2*(S.length-1))/S.length;
data.forEach(function(r,i){var x0=cx(i)-gw/2;if(stacked){var T=tot(r),acc=0,segs=[];S.forEach(function(se){var v=val(r,se.key);if(v&&v>0)segs.push([se,share?(T?v/T:0):v]);});segs.forEach(function(sg,j){var y0=y(acc),y1=y(acc+sg[1]);acc+=sg[1];var h=y0-y1-(j<segs.length-1?0:0),gap=j>0?2:0;if(j===segs.length-1)g.appendChild(sv("path",{d:roundTop(x0,y1,gw,h-gap,4),fill:sg[0].color}));else g.appendChild(sv("rect",{x:x0,y:y1,width:gw,height:Math.max(0,h-gap),fill:sg[0].color}));});}
else S.forEach(function(se,j){var v=val(r,se.key);if(v==null)return;var x=x0+j*(bw+2);if(v>=0)g.appendChild(sv("path",{d:roundTop(x,y(v),bw,y(0)-y(v),4),fill:se.color}));else g.appendChild(sv("rect",{x:x,y:y(0),width:bw,height:y(v)-y(0),fill:se.color}));});});}
else{var base=data.map(function(){return 0;});S.forEach(function(se){var pts=[],prev=base.slice();data.forEach(function(r,i){var v=val(r,se.key);if(v==null){pts.push(null);return;}if(share){var T=tot(r);v=T?v/T:0;}if(stacked){base[i]+=v;v=base[i];}pts.push([cx(i),y(v),i]);});
var d="",segs=[],cur=[];pts.forEach(function(p){if(p)cur.push(p);else if(cur.length){segs.push(cur);cur=[];}});if(cur.length)segs.push(cur);
segs.forEach(function(sgm){d+=sgm.map(function(p,k){return (k?"L":"M")+p[0].toFixed(1)+","+p[1].toFixed(1);}).join("");if(type==="area"){var bl=stacked?sgm.map(function(p){return [p[0],y(prev[p[2]])];}).reverse():[[sgm[sgm.length-1][0],y(Math.max(sc.lo,0))],[sgm[0][0],y(Math.max(sc.lo,0))]];g.appendChild(sv("path",{d:sgm.map(function(p,k){return (k?"L":"M")+p[0]+","+p[1];}).join("")+bl.map(function(p){return "L"+p[0]+","+p[1];}).join("")+"Z",fill:se.color,"fill-opacity":stacked?.55:.16}));}});
g.appendChild(sv("path",{d:d,fill:"none",stroke:se.color,"stroke-width":2,"stroke-linejoin":"round","stroke-linecap":"round"}));
if(pts.length===1&&pts[0])g.appendChild(sv("circle",{cx:pts[0][0],cy:pts[0][1],r:4,fill:se.color}));
var last=null;for(var k=pts.length-1;k>=0;k--)if(pts[k]){last=pts[k];break;}if(direct&&last){var tx=sv("text",{x:last[0]+8,y:last[1]+4});tx.textContent=se.label;svg.appendChild(tx);}});}
var hov=sv("g");svg.appendChild(hov);
data.forEach(function(r,i){var hit=sv("rect",{x:m.l+step*i,y:m.t,width:step,height:ih,fill:"transparent"});hit.addEventListener("mousemove",function(ev){hov.innerHTML="";if(line){hov.appendChild(sv("line",{x1:cx(i),x2:cx(i),y1:m.t,y2:m.t+ih,stroke:"var(--gm-muted)","stroke-dasharray":"3 3"}));var acc=0,T=tot(r);S.forEach(function(se){var v=val(r,se.key);if(v==null)return;if(share)v=T?v/T:0;if(stacked){acc+=v;v=acc;}hov.appendChild(sv("circle",{cx:cx(i),cy:y(v),r:4.5,fill:se.color,stroke:"var(--gm-card)","stroke-width":2}));});}else hov.appendChild(sv("rect",{x:m.l+step*i,y:m.t,width:step,height:ih,fill:"var(--gm-fg)","fill-opacity":.05}));
var T2=tot(r),rows=S.map(function(se){var v=val(r,se.key);return {label:se.label,color:se.color,value:format(v,se.format||o.format||"num")+(stacked&&T2&&v!=null?" · "+fmt.pct(v/T2):"")};});if(stacked)rows.reverse();showTip(box,ev,format(r[xk],xf==="day"?"date":xf)+(stacked?" · "+format(T2,o.format||"num"):""),rows);});
hit.addEventListener("mouseleave",function(){hov.innerHTML="";hideTip(box);});svg.appendChild(hit);});
plot.appendChild(svg);}
function hbar(box,o,S){var data=o.data||[],xk=o.x||"x",stacked=S.length>1,max=0;function tot(r){var s=0;S.forEach(function(se){var v=val(r,se.key);if(v!=null&&v>0)s+=v;});return s;}data.forEach(function(r){max=Math.max(max,tot(r));});
if(stacked)box.appendChild(el("div",{class:"gm-chart-top"},legend(S)));
data.forEach(function(r){var T=tot(r),tr=el("div",{class:"gm-bars-track"});S.forEach(function(se){var v=val(r,se.key);if(v&&v>0)tr.appendChild(el("i",{style:{width:(max?v/max*100:0)+"%",background:se.color}}));});
var row=el("div",{class:"gm-bars-row"},el("div",{class:"gm-bars-label",title:String(r[xk])},format(r[xk],o.xFormat||"text")),tr,el("div",{class:"gm-bars-value"},format(T,o.format||"num")));
row.addEventListener("mousemove",function(ev){showTip(box,ev,String(r[xk]),S.map(function(se){return {label:se.label,color:se.color,value:format(val(r,se.key),o.format||"num")};}));});row.addEventListener("mouseleave",function(){hideTip(box);});box.appendChild(row);});return box;}
function donut(box,o,S){var data=o.data||[],xk=o.x||"x",k=S[0].key,items=data.map(function(r){return {label:String(r[xk]),value:Math.max(0,val(r,k)||0)};}).filter(function(i){return i.value>0;});
if(items.length>8){var rest=items.slice(7).reduce(function(a,i){return a+i.value;},0);items=items.slice(0,7).concat([{label:o.otherLabel||"Other",value:rest}]);}
var T=items.reduce(function(a,i){return a+i.value;},0),size=o.size||180,R=size/2-12,C=2*Math.PI*R,svg=sv("svg",{width:size,height:size,viewBox:"0 0 "+size+" "+size,role:"img","aria-label":o.title||"Donut chart"}),off=0,wrap=el("div",{class:"gm-donut"}),lg=el("div",{class:"gm-donut-legend"});
svg.appendChild(sv("circle",{cx:size/2,cy:size/2,r:R,fill:"none",stroke:"var(--gm-grid)","stroke-width":22}));
items.forEach(function(it,i){var len=T?it.value/T*C:0,c=sv("circle",{cx:size/2,cy:size/2,r:R,fill:"none",stroke:color(i),"stroke-width":22,"stroke-dasharray":Math.max(0,len-(items.length>1?2:0))+" "+C,"stroke-dashoffset":-off,transform:"rotate(-90 "+size/2+" "+size/2+")"});off+=len;
function mv(ev){showTip(box,ev,it.label,[{label:"",value:format(it.value,o.format||"num")+" · "+fmt.pct(T?it.value/T:0)}]);}c.addEventListener("mousemove",mv);c.addEventListener("mouseleave",function(){hideTip(box);});svg.appendChild(c);
lg.appendChild(el("div",null,el("i",{class:"gm-sw",style:{background:color(i)}}),el("span",null,it.label),el("b",null,format(it.value,o.format||"num")),el("span",{class:"gm-muted"},fmt.pct(T?it.value/T:0))));});
var t1=sv("text",{x:size/2,y:size/2+2,"text-anchor":"middle",style:"font-size:20px;font-weight:650;fill:var(--gm-fg)"});t1.textContent=format(T,o.format||"compact");svg.appendChild(t1);var t2=sv("text",{x:size/2,y:size/2+19,"text-anchor":"middle"});t2.textContent=o.centerLabel||"Total";svg.appendChild(t2);
wrap.appendChild(svg);wrap.appendChild(lg);box.appendChild(wrap);return box;}
function table(t,o){var h=host(t),rows=(o.rows||o.data||[]).slice(),cols=(o.columns||(rows[0]?Object.keys(rows[0]).map(function(k){return {key:k,label:k};}):[])).map(function(c){return typeof c==="string"?{key:c,label:c}:c;}),sk=null,dir=1,all=false;
cols.forEach(function(c){if(!c.align&&rows.some(function(r){return isNum(r[c.key]);}))c.align="right";});
function draw(){h.innerHTML="";var rs=rows.slice();if(sk!=null)rs.sort(function(a,b){var x=a[sk],y=b[sk];return (x==null?1:y==null?-1:x<y?-1:x>y?1:0)*dir;});var lim=o.limit&&!all?rs.slice(0,o.limit):rs;
var tb=el("table",{class:"gm-table"},el("thead",null,el("tr",null,cols.map(function(c){return el("th",{class:(c.align==="right"?"gm-r ":"")+(o.sortable!==false?"gm-sort":""),onclick:o.sortable!==false?function(){dir=sk===c.key?-dir:(c.align==="right"?-1:1);sk=c.key;draw();}:null},(c.label==null?c.key:c.label)+(sk===c.key?(dir>0?" ↑":" ↓"):""));}))),
el("tbody",null,lim.map(function(r){return el("tr",null,cols.map(function(c){return el("td",{class:c.align==="right"?"gm-r":null},format(r[c.key],c.format));}));})));
h.appendChild(el("div",{class:"gm-table-wrap"},tb));if(o.limit&&rs.length>o.limit)h.appendChild(el("button",{class:"gm-btn",style:{marginTop:"10px"},type:"button",onclick:function(){all=!all;draw();}},all?(o.lessLabel||"Show less"):(o.moreLabel||"Show all "+rs.length)));}
draw();return h;}
function bars(t,o){var h=host(t);h.innerHTML="";var items=o.items||[],max=Math.max.apply(null,items.map(function(i){return +i.value||0;}).concat([0])),total=items.reduce(function(a,i){return a+(+i.value||0);},0),groups=[];
items.forEach(function(i){if(groups.indexOf(i.group||"")<0)groups.push(i.group||"");});var gc=o.groupColors||{};
groups.forEach(function(g,gi){var its=items.filter(function(i){return (i.group||"")===g;}),sum=its.reduce(function(a,i){return a+(+i.value||0);},0);if(g)h.appendChild(el("div",{class:"gm-bars-group"},g+" · "+format(sum,o.format||"num")+(o.share!==false&&total?" ("+fmt.pct(sum/total)+")":"")));
its.forEach(function(i,k){var c=i.color||gc[g]||color(g?gi:(o.color!=null?o.color:0));h.appendChild(el("div",{class:"gm-bars-row",title:i.label+": "+format(i.value,o.format||"num")},el("div",{class:"gm-bars-label"},i.label),el("div",{class:"gm-bars-track"},el("i",{style:{width:(max?(+i.value||0)/max*100:0)+"%",background:c}})),el("div",{class:"gm-bars-value"},format(i.value,o.format||"num"))));});});return h;}
function stackbar(items,f,showLeg){var T=items.reduce(function(a,i){return a+(+i.value||0);},0),bar=el("div",{class:"gm-stackbar"});items.forEach(function(it,i){var w=T?(+it.value||0)/T*100:0;if(w>0)bar.appendChild(el("div",{style:{width:w+"%",background:it.color||color(i)},title:it.label+": "+format(it.value,f||"num")+" ("+fmt.pct(w/100)+")"},w>=9?fmt.pct(w/100):""));});return bar;}
function kpi(o){var d=o.delta,dn=isNum(d),up=dn&&d>0,good=o.good==="down"?!up:up,de=d==null?null:el("span",{class:"gm-delta"+(dn&&d!==0?(good?" gm-up":" gm-down"):"")},(dn&&d!==0?(up?"▲ ":"▼ "):"")+(dn?format(Math.abs(d),o.deltaFormat||o.format||"num"):d));
return el("div",{class:"gm-card gm-kpi"},el("div",{class:"gm-kpi-label"},o.label),el("div",{class:"gm-kpi-value"},format(o.value,o.format)),(o.note!=null||de)?el("div",{class:"gm-kpi-note"},de,de&&o.note!=null?" ":null,o.note):null);}
function path(data,p){if(p==="$")return data;var parts=String(p).replace(/^\$\.?/,"").match(/[^.[\]]+/g)||[],v=data;for(var i=0;i<parts.length;i++){if(v==null)return undefined;v=v[parts[i]];}return v;}
var TPL=/\{\{\s*(\$[^}|]*?)\s*(?:\|\s*([^}]+?))?\s*\}\}/g;
function bind(v,data){if(typeof v==="string"){if(v.indexOf("{{")>=0)return v.replace(TPL,function(m,p,f){var r=path(data,p);return format(r,f?f.trim():undefined);});return /^\$(\.|\[|$)/.test(v)?path(data,v):v;}if(Array.isArray(v))return v.map(function(x){return bind(x,data);});if(v&&typeof v==="object"){var o={};for(var k in v)o[k]=k==="children"||k==="tabs"||(k==="note"&&v.type==="stack"&&v.data)?v[k]:bind(v[k],data);return o;}return v;}
function errBox(m){return el("div",{class:"gm-error"},m);}
function head(b,cls){return b.title||b.subtitle?el("div",{class:cls||"gm-card-head"},el("div",null,b.title?el("div",{class:"gm-card-title"},b.title):null,b.subtitle?el("div",{class:"gm-card-sub"},b.subtitle):null)):null;}
function boxed(b,inner){return b.title||b.subtitle||b.card?el("div",{class:"gm-card"},head(b),inner):inner;}
function later(fn){var d=el("div");fn(d);return d;}
var R={
page:function(b,d){return el("div",{class:"gm-page"},el("header",{class:"gm-header"},el("div",null,b.title?el("h1",{class:"gm-title"},b.title):null,b.subtitle?el("div",{class:"gm-subtitle"},b.subtitle):null),b.refresh&&window.godmode?el("button",{class:"gm-btn",type:"button",onclick:function(){godmode.refresh();}},typeof b.refresh==="string"?b.refresh:"Refresh data"):null),el("div",{class:"gm-vstack"},kids(b,d)));},
row:function(b,d){return el("div",{class:"gm-row",style:b.min?{"--gm-min":b.min+"px"}:null},kids(b,d));},
columns:function(b,d){var w=b.widths||(b.children||[]).map(function(){return 1;});return el("div",{class:"gm-cols",style:{gridTemplateColumns:w.map(function(x){return "minmax(0,"+x+"fr)";}).join(" ")}},kids(b,d));},
section:function(b,d){return el("section",{class:"gm-section"},b.title||b.subtitle?el("div",{class:"gm-section-head"},b.title?el("h2",{class:"gm-h2"},b.title):null,b.subtitle?el("div",{class:"gm-subtitle"},b.subtitle):null):null,el("div",{class:"gm-vstack"},kids(b,d)));},
card:function(b,d){return el("div",{class:"gm-card"},head(b),el("div",{class:"gm-vstack",style:{gap:"12px"}},kids(b,d)));},
kpi:function(b){return kpi(b);},
chart:function(b){return boxed(b,later(function(x){chart(x,Object.assign({},b,{type:b.kind||"bar"}));}));},
table:function(b){return boxed(b,later(function(x){table(x,b);}));},
bars:function(b){return boxed(b,later(function(x){bars(x,b);}));},
stack:function(b){var inner;if(b.data){var S=seriesOf(b),xk=b.x||"x";inner=el("div",null,(b.data||[]).map(function(r){return el("div",{class:"gm-stack-row"},el("div",null,el("div",{style:{fontWeight:600,fontSize:"13px"}},format(r[xk],b.xFormat||"text")),b.note?el("div",{class:"gm-muted",style:{fontSize:"12px"}},bind(b.note,r)):null),stackbar(S.map(function(s){return {label:s.label,value:val(r,s.key),color:s.color};}),b.format));}),el("div",{style:{marginTop:"8px"}},legend(S)));}else{var its=(b.items||[]).map(function(i,k){return {label:i.label,value:i.value,color:i.color||color(k)};});inner=el("div",null,stackbar(its,b.format),el("div",{style:{marginTop:"8px"}},legend(its)));}return boxed(b,inner);},
text:function(b){return el("div",{class:"gm-text",html:rich(b.text)});},
list:function(b){return boxed(b,el("ul",{class:"gm-list"},(b.items||[]).map(function(i){return el("li",{html:rich(i)});})));},
callout:function(b){return el("div",{class:"gm-callout gm-tone-"+(b.tone||"info"),html:(b.title?"<b>"+esc(b.title)+"</b><br>":"")+rich(b.text)});},
badge:function(b){return el("span",{class:"gm-badge gm-tone-"+(b.tone||"info")},b.text);},
html:function(b){return el("div",{html:b.html||""});},
tabs:function(b,d,raw){var i=raw._tab||0,tabs=b.tabs||[],body=el("div"),bar=el("div",{class:"gm-seg",role:"tablist"},tabs.map(function(t,k){return el("button",{type:"button","aria-pressed":String(k===i),onclick:function(){raw._tab=k;[].forEach.call(bar.children,function(x,j){x.setAttribute("aria-pressed",String(j===k));});show(k);}},bind(t.label,d));}));function show(k){body.innerHTML="";add(body,el("div",{class:"gm-vstack"},kids(tabs[k]||{},d)));}show(i);return el("div",{class:"gm-tabs"},el("div",null,bar),body);}};
function kids(b,d){return (b.children||[]).map(function(c){return node(c,d);});}
function node(n,d){if(n==null)return null;if(typeof n==="string")return el("div",{class:"gm-text",html:rich(bind(n,d))});if(Array.isArray(n))return n.map(function(c){return node(c,d);});if(typeof n!=="object"||!n.type)return errBox("Each node needs a type");var f=R[n.type];if(!f)return errBox('Unknown node type "'+n.type+'"');try{return f(bind(n,d),d,n);}catch(e){return errBox(n.type+": "+(e&&e.message||e));}}
function render(spec,data){return node(spec,data==null?{}:data);}
function mount(root,spec){root=host(root);function draw(d){root.innerHTML="";add(root,render(spec,d));}if(window.godmode&&godmode.onData)godmode.onData(draw);else draw(spec&&spec.data||{});}
window.gm={fmt:fmt,format:format,el:el,svg:sv,color:color,path:path,bind:bind,kpi:function(t,o){var h=host(t);h.innerHTML="";h.appendChild(kpi(o));return h;},table:table,bars:bars,chart:chart,stack:function(t,o){var h=host(t);h.innerHTML="";h.appendChild(R.stack(o));return h;},render:render,mount:mount,types:Object.keys(R)};
})();`;

export const ARTIFACT_KIT_DOC = `Kit (preloaded, no CDN needed): prefer a declarative \`spec\` over hand-written HTML for dashboards and reports — far less to write, themed, responsive, charts with tooltips.
Spec = a tree of nodes {type, ...props, children?}. Any string prop starting with "$." is a path into the artifact's data ("$.daily", "$.periods[2].human"); "{{$.path|format}}" interpolates inside text. Re-renders when the data changes. Put derived numbers (shares, deltas, totals) into the data, not the spec.
Nodes:
- page {title, subtitle, refresh?: true|"label", children} · section {title, subtitle, children} · card {title, subtitle, children}
- row {min?: px, children} (auto-fit grid, e.g. KPI tiles) · columns {widths?: [2,1], children} (stacks on narrow screens)
- kpi {label, value, format, note, delta, deltaFormat, good: "up"|"down"} (delta number → ▲/▼ coloured)
- chart {kind: "bar"|"stackedBar"|"line"|"area"|"hbar"|"donut", data: "$.rows", x: "day", series: [{key, label}], format, xFormat, height, share, toggle (share/count switch), tableToggle, stacked (area), zero: false (line), title, subtitle}. Donut: x = label key, one series.
- table {rows, columns: [{key, label, format, align}], sortable, limit, title} · bars {items: [{label, value, group, color}], format, title} (ranked horizontal bars, grouped)
- stack {items: [{label, value}]} or {data, x, series, note} (100% bars per row; in note "{{$.field}}" reads the row) · text {text} (**bold**, newlines) · list {items, title} · callout {title, text, tone: info|good|warning|critical} · badge {text, tone} · tabs {tabs: [{label, children}]} · html {html}
Formats: num, num:1, pct (0..1), pct:1, pct100, money:EUR, compact, date, day, datetime, text; prefix "+" shows the sign.
Series colours come from a fixed, colour-blind-checked palette (--gm-s1…--gm-s8); keep ≤ 8 series and give each a label.
Example: {"type":"page","title":"Sales","children":[{"type":"row","children":[{"type":"kpi","label":"Revenue","value":"$.revenue","format":"money:EUR","delta":"$.revenueDelta","deltaFormat":"pct"}]},{"type":"chart","kind":"line","title":"Revenue per day","data":"$.daily","x":"day","series":[{"key":"revenue","label":"Revenue"}],"format":"money:EUR"}]}
In your own HTML the same pieces are available: classes gm-page, gm-header, gm-title, gm-subtitle, gm-row, gm-cols, gm-card, gm-card-title, gm-kpi-label/-value/-note, gm-seg, gm-btn, gm-badge, gm-table, gm-callout, gm-legend, gm-muted; and JS gm.chart(el, {type, ...chart props}), gm.table(el, opts), gm.bars(el, opts), gm.kpi(el, opts), gm.stack(el, opts), gm.format(value, "pct"), gm.el(tag, attrs, ...children), gm.mount(el, spec), gm.render(spec, data).`;

export type ArtifactSpecNode = { type: string; [k: string]: unknown };

export const ARTIFACT_SPEC_TYPES = [
  "page",
  "row",
  "columns",
  "section",
  "card",
  "kpi",
  "chart",
  "table",
  "bars",
  "stack",
  "text",
  "list",
  "callout",
  "badge",
  "html",
  "tabs",
] as const;

const SPEC_TYPES = new Set<string>(ARTIFACT_SPEC_TYPES);

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function specDocument(spec: ArtifactSpecNode, title: string): string {
  const json = JSON.stringify(spec, null, 1).replace(/<\//g, "<\\/").replace(/<!--/g, "<\\!--");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body>
<div id="gm-root"></div>
<script type="application/json" id="gm-spec">
${json}
</script>
<script>gm.mount(document.getElementById("gm-root"),JSON.parse(document.getElementById("gm-spec").textContent))</script>
</body>
</html>
`;
}

export function checkSpec(spec: unknown): string | null {
  const visit = (node: unknown, where: string): string | null => {
    if (typeof node === "string") return null;
    if (!node || typeof node !== "object" || Array.isArray(node)) return `${where}: a node must be an object with a type`;
    const n = node as Record<string, unknown>;
    if (typeof n.type !== "string" || !n.type) return `${where}: the node has no type`;
    if (!SPEC_TYPES.has(n.type)) return `${where}: unknown node type "${n.type}" (use ${ARTIFACT_SPEC_TYPES.join(", ")})`;
    if (n.children !== undefined) {
      if (!Array.isArray(n.children)) return `${where} (${n.type}): children must be an array`;
      for (let i = 0; i < n.children.length; i++) {
        const err = visit(n.children[i], `${where}.children[${i}]`);
        if (err) return err;
      }
    }
    if (n.type === "tabs") {
      if (!Array.isArray(n.tabs)) return `${where} (tabs): tabs must be an array of {label, children}`;
      for (let i = 0; i < n.tabs.length; i++) {
        const tab = n.tabs[i] as Record<string, unknown> | null;
        if (!tab || typeof tab !== "object") return `${where}.tabs[${i}]: a tab must be {label, children}`;
        if (tab.children !== undefined && !Array.isArray(tab.children)) return `${where}.tabs[${i}]: children must be an array`;
        for (let j = 0; j < ((tab.children as unknown[]) ?? []).length; j++) {
          const err = visit((tab.children as unknown[])[j], `${where}.tabs[${i}].children[${j}]`);
          if (err) return err;
        }
      }
    }
    return null;
  };
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return "the spec must be an object with a type";
  return visit(spec, "spec");
}
