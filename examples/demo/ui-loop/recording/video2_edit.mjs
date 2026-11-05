// Video 2 ("Our rubric said 92. The founder said: still AI.") composed frame by frame from real artifacts:
// page screenshots of every state, the audit scorer's boxes, the agents' own scores, and Take D's terminal bytes.
//   node edit2.mjs out.mp4 [--still sec out.png] [--fps 30]
// Writes cues.json next to the video for the SFX pass.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = createRequire(import.meta.url)("playwright");

const here = dirname(fileURLToPath(import.meta.url));
const mods = join(here, "node_modules"); // npm i @xterm/xterm@5.5.0 in this folder
const [outPath, ...rest] = process.argv.slice(2);
const opt = (n, d) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : d; };
const fps = Number(opt("fps", 30));
const stillAt = opt("still", null), stillOut = stillAt != null ? rest[rest.indexOf("--still") + 2] : null;
const A = JSON.parse(readFileSync(join(here, "assets/data.json"), "utf8"));

// ---------------- timeline ----------------
const T = { hook: 0, montage: 3, founder: 11, rebuild: 15.5, takeC: 20.5, takeD: 28, wipe: 49.3, end: 54.3, total: 58.3 };
// Take D: source (cast seconds) → video, slow at every real event, fast in between.
const warp = [[31, 80.4, 30], [80.4, 81.6, 1], [81.6, 156.9, 50], [156.9, 158.4, 1], [158.4, 202.3, 30], [202.3, 203.6, 1], [203.6, 223.8, 25],
  [223.8, 246, 6], [246, 255.3, 15], [255.3, 256.6, 1], [256.6, 286.4, 25], [286.4, 291, 4], [291, 297.6, 12], [297.6, 299.6, 1], [299.6, 316, 12]];
let acc = T.takeD; const segs = warp.map(([a, b, sp]) => { const s = { a, b, sp, v0: acc }; acc += (b - a) / sp; s.v1 = acc; return s; });
T.takeDEnd = acc; // ≈ 49.3
const vidAt = (src) => { for (const s of segs) if (src <= s.b) return s.v0 + Math.max(0, src - s.a) / s.sp; return segs.at(-1).v1; };
const D = A.takeD;
const dStates = D.states.map((s) => ({ ...s, v: vidAt(s.src) }));
const dEvals = D.evals.map((e) => ({ ...e, v: vidAt(e.src) }));
const B = A.takeB.v1; // 27 42 42 48 51 92
const bStep = (k) => T.montage + 0.35 + k * 1.25;

// ---------------- cues for the SFX pass ----------------
const cues = [];
const cue = (t, kind, extra = {}) => cues.push({ t: Math.round(t * 1000) / 1000, kind, ...extra });
cue(0.05, "riser_soft");
B.forEach((sc, k) => { cue(bStep(k), k ? "swap" : "pop"); cue(bStep(k) + 0.55, "bell", { score: sc }); });
cue(bStep(5) + 0.75, "chord_major");
cue(T.founder + 0.25, "thud");
cue(T.founder + 1.5, "drop", { from: 92, to: A.takeB.v21Final });
for (let k = 0; k < 13; k++) cue(T.rebuild + 0.5 + k * 0.28, "tick_soft", { k });
cue(T.takeC + 0.2, "bell", { score: A.takeC.v2 });
cue(T.takeC + 1.6, "thud");
for (let k = 0; k < A.xray.c.length + 1; k++) cue(T.takeC + 3.0 + k * 0.22, "mark");
cue(T.takeC + 4.6, "drop", { from: A.takeC.v2, to: A.takeC.v21 });
dStates.slice(1).forEach((s, k) => cue(s.v, k === 0 ? "whoosh_big" : "swap"));
dEvals.forEach((e, k) => { cue(e.v, "ticks"); cue(e.v + 0.7, "bell", { score: e.score }); });
cue(dEvals.at(-1).v + 0.95, "chord_major");
cue(T.wipe + 0.4, "whoosh_big");
cue(T.end - 0.5, "riser");
cue(T.end + 0.02, "boom");
writeFileSync(outPath.replace(/\.mp4$/, "") + ".cues.json", JSON.stringify({ total: T.total, cues }, null, 1));

// ---------------- page ----------------
const css = readFileSync(join(mods, "@xterm/xterm/css/xterm.css"), "utf8");
const xtermJs = readFileSync(join(mods, "@xterm/xterm/lib/xterm.js"), "utf8");
const J = (x) => JSON.stringify(x).replace(/</g, "\\u003c");
const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}
:root{--bg:#0e0e10;--fg:#ededf0;--mut:#8f8f99;--line:#2a2a30;--acc:#4ade80;--red:#f05252;--amb:#f5b841}
*{box-sizing:border-box}html,body{margin:0;width:1920px;height:1080px;background:var(--bg);color:var(--fg);font-family:Inter,sans-serif;overflow:hidden}
.layer{position:absolute;inset:0;opacity:0}
.panel{position:absolute;left:180px;top:36px;width:1360px;height:850px;border-radius:14px;overflow:hidden;box-shadow:0 0 0 1px var(--line);background:#fff}
.panel img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:top}
.box{position:absolute;border:3px solid var(--red);border-radius:4px;background:rgba(240,82,82,.10)}
.box.amb{border-color:var(--amb);background:rgba(245,184,65,.12)}
.box span{position:absolute;left:-3px;top:-24px;font:700 13px Inter;background:var(--red);color:#fff;padding:2px 6px;border-radius:4px;white-space:nowrap}
.box.amb span{background:var(--amb);color:#111}
.chip{position:absolute;left:1570px;top:36px;width:310px;padding:18px 20px;border-radius:14px;background:#17171b;box-shadow:0 0 0 1px var(--line)}
.chip .lbl{font:600 15px Inter;color:var(--mut);letter-spacing:.02em}
.chip .num{font:800 96px/1 "Inter Display",Inter;margin:6px 0 4px;letter-spacing:-.02em}
.chip .gr{display:inline-block;font:700 18px Inter;padding:3px 10px;border-radius:7px}
.chip .sub{font:500 15px/1.35 Inter;color:var(--mut);margin-top:10px}
.stamp{position:absolute;font:900 76px/1 "Inter Display";padding:12px 26px;border:8px solid;border-radius:18px;transform:rotate(-7deg);background:rgba(255,255,255,.9)}
#quote{position:absolute;left:50%;top:330px;width:1120px;margin-left:-560px;text-align:center}
#quote q{display:block;font:800 92px/1.1 "Inter Display";quotes:"“" "”"}
#quote div{font:600 30px Inter;color:var(--mut);margin-top:24px}
#tags{position:absolute;left:50%;top:640px;transform:translateX(-50%);display:flex;gap:16px}
.tag{font:700 24px Inter;padding:10px 18px;border-radius:10px;background:rgba(240,82,82,.15);color:#ffb4b4;border:1px solid rgba(240,82,82,.5)}
#pgrid{position:absolute;left:50%;top:120px;width:1500px;margin-left:-750px;display:grid;grid-template-columns:1fr 1fr;gap:12px 48px}
.pr{display:flex;gap:16px;align-items:baseline;font:600 30px/1.3 Inter;opacity:0}
.pr b{font:800 22px "JetBrains Mono";color:var(--acc);width:64px;flex:none}
.pr.new b{color:var(--amb)}
#psrc{position:absolute;left:0;right:0;top:820px;text-align:center;font:500 24px Inter;color:var(--mut)}
#dpanel{position:absolute;left:40px;top:60px;width:1220px;height:762px;border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px var(--line);background:#fff}
#dpanel img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:top}
#dhead{position:absolute;left:40px;top:22px;font:600 16px "JetBrains Mono";color:var(--mut)}
#dcard{position:absolute;left:1290px;top:60px;width:590px;height:300px;border-radius:12px;background:#17171b;box-shadow:0 0 0 1px var(--line);padding:20px 24px}
#dcard .num{font:800 104px/1 "Inter Display"}
#dcard .row{display:flex;align-items:center;gap:14px}
#brief{position:absolute;left:1290px;top:376px;width:590px;height:56px;border-radius:12px;background:#17171b;box-shadow:0 0 0 1px var(--line);padding:14px 24px;font:600 20px Inter;color:var(--mut)}
#brief b{color:var(--acc)}
#term{position:absolute;left:1290px;top:448px;width:590px;height:374px;border-radius:12px;background:#141414;box-shadow:0 0 0 1px var(--line);padding:8px;overflow:hidden}
#speed{position:absolute;left:1790px;top:22px;font:700 15px "JetBrains Mono";color:#111;background:var(--amb);padding:3px 9px;border-radius:6px}
#wipe .panel img.after{clip-path:inset(0 0 0 var(--cut))}
#wipe .bar{position:absolute;top:36px;height:850px;width:4px;background:#fff;box-shadow:0 0 0 1px #000}
#wipe .lab{position:absolute;top:900px;font:700 26px Inter}
#endw{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px}
#endw .w{font:800 150px/1 "JetBrains Mono";letter-spacing:-.03em}
#endw .t{font:600 46px Inter}
#endw .s{font:500 28px Inter;color:var(--mut)}
#disc{position:absolute;bottom:30px;left:0;right:0;text-align:center;font:500 18px Inter;color:#6f6f7a}
#cap{position:absolute;left:0;right:0;bottom:40px;text-align:center}
#capM{display:inline-block;font:700 44px/1.2 Inter;background:rgba(10,10,12,.86);padding:12px 26px;border-radius:14px;max-width:1760px}
#capS{display:block;margin-top:10px;font:700 30px "JetBrains Mono";color:var(--acc)}
#capS:empty{display:none}
</style></head><body>
<div id="L_page" class="layer"><div class="panel" id="pg"><img id="pgA"><img id="pgB"><div id="boxes"></div></div>
  <div class="chip" id="chip"><div class="lbl" id="chipL"></div><div class="num" id="chipN"></div><span class="gr" id="chipG"></span><div class="sub" id="chipS"></div></div>
  <div class="stamp" id="stamp"></div></div>
<div id="L_founder" class="layer"><div id="quote"><q>Still looks AI-made.</q><div>the founder, looking at the 92</div></div><div id="tags"></div></div>
<div id="L_rebuild" class="layer"><div id="pgrid"></div><div id="psrc">Few · Tufte · Cleveland &amp; McGill · NN/g · IBM Carbon · Refactoring UI · AI-tells catalogues</div></div>
<div id="L_d" class="layer"><div id="dhead">take three · live render of the agent's index.html</div><div id="speed"></div>
  <div id="dpanel"><img id="dA"><img id="dB"></div>
  <div id="dcard"><div class="lbl" style="font:600 15px Inter;color:#8f8f99">rubric v2.1 · real evaluations</div><div class="row"><div class="num" id="dN">–</div><span class="gr" id="dG" style="font:700 20px Inter;padding:4px 12px;border-radius:8px"></span></div><div id="dS" style="font:500 17px/1.4 Inter;color:#8f8f99;margin-top:8px"></div></div>
  <div id="brief">BRIEF.md · <span id="briefS">writing…</span></div>
  <div id="term"><div id="xt"></div></div></div>
<div id="L_wipe" class="layer"><div id="wipe"><div class="panel"><img id="wB"><img id="wA" class="after"></div><div class="bar" id="wbar"></div>
  <div class="lab" style="left:180px">AI one-shot · <span style="color:#f05252">33</span></div><div class="lab" style="right:380px;text-align:right">Take three · <span style="color:#4ade80">84</span></div></div></div>
<div id="L_end" class="layer"><div id="endw"><div class="w">verdict</div><div class="t">Write down what good means. Let the agent argue with it.</div><div class="s">Rubrics, prompts, briefs and every step in the replies ↓</div></div>
  <div id="disc">Real, unattended Claude Code runs · waiting time sped up · scores by Verdict (Jev + Clef + a render audit) · fictional data</div></div>
<div id="cap"><span id="capM"></span><span id="capS"></span></div>
<script>window.A=${J(A)};window.T=${J(T)};window.SEGS=${J(segs)};window.DS=${J(dStates)};window.DE=${J(dEvals)};</script>
<script>${xtermJs}</script>
<script>
const A=window.A,T=window.T,SEGS=window.SEGS,DS=window.DS,DE=window.DE,$=(i)=>document.getElementById(i);
const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x)),ease=(x)=>1-Math.pow(1-clamp(x),3),fade=(v,a,b,f=.3)=>clamp(Math.min((v-a)/f,(b-v)/f));
const G={"rework":["#3a2020","#ffb4b4"],"almost":["#4a3a10","#f5b841"],"ship it":["#0f3d22","#4ade80"]};
const srcAt=(v)=>{for(const s of SEGS) if(v<=s.v1) return s.a+Math.max(0,v-s.v0)*s.sp; return SEGS.at(-1).b;};
const speedAt=(v)=>{for(const s of SEGS) if(v<=s.v1) return s.sp; return 1;};
const shot=(n)=>"shots/"+n+".png";
let cur={A:null,B:null};
function setPage(a,b,mix){ if(cur.A!==a){$("pgA").src=shot(a);cur.A=a;} if(cur.B!==b){$("pgB").src=shot(b);cur.B=b;} $("pgB").style.opacity=mix.toFixed(3); }
const SC=1360/1280;
function boxes(list,v0,v,step,cls){ const el=$("boxes"); if(!list){el.innerHTML="";el.dataset.k="";return;} const key=list.length+"|"+cls; if(el.dataset.k!==key){el.dataset.k=key; el.innerHTML=list.filter(b=>b.y<800).map((b,i)=>'<div class="box '+(cls(b)||"")+'" data-i="'+i+'" style="left:'+(b.x*SC)+'px;top:'+(b.y*SC)+'px;width:'+(Math.max(b.w,8)*SC)+'px;height:'+(Math.max(b.h,8)*SC)+'px">'+(b.showLabel?'<span>'+b.label+'</span>':'')+'</div>').join("");}
  el.querySelectorAll(".box").forEach((d)=>{d.style.opacity=v>=v0+Number(d.dataset.i)*step?1:0;}); }
function chip(lbl,n,g,sub){ $("chipL").textContent=lbl; $("chipN").textContent=n; const c=G[g]||G.rework; $("chipG").textContent=g; $("chipG").style.background=c[0]; $("chipG").style.color=c[1]; $("chipS").textContent=sub||""; $("chipN").style.color=c[1]; }
function stamp(text,color,a,rot){ const s=$("stamp"); s.textContent=text; s.style.color=color; s.style.borderColor=color; s.style.opacity=a; s.style.transform="rotate(-7deg) scale("+(1.6-.6*ease(rot))+")"; }
const lerp=(a,b,x)=>a+(b-a)*ease(x);
// principles board
const PR=[["P1","Answer the operator's questions"],["P2","Context for every number"],["P3","What needs attention comes first"],["P4","Each figure once"],["P5","Position and length, not angle"],["P6","Data-ink, no chartjunk"],["P7","Colour is a signal"],["P8","Hierarchy by importance"],["P9","Answers on the first screen"],["P10","Numbers set for reading"],["P11","No AI defaults, first or second order"],["P12","Write for the user, not the reviewer"],["P13","Advice only from stated rules"]];
$("pgrid").innerHTML=PR.map(([k,t],i)=>'<div class="pr'+(i>=11?' new':'')+'" id="pr'+i+'"><b>'+k+'</b><span>'+t+'</span></div>').join("");
// x-ray sets
const XS=A.xray.start.map((b)=>({...b,showLabel:false}));
const firstOf={}; for(const b of XS){ if(!firstOf[b.kind]){firstOf[b.kind]=1;b.showLabel=true;} }
const XC=A.xray.c.map((b)=>({...b,showLabel:true}));
// terminal
const term=new Terminal({cols:100,rows:30,fontFamily:'"JetBrains Mono",monospace',fontSize:9.7,lineHeight:1.18,scrollback:0,cursorBlink:false,allowProposedApi:true,theme:{background:"#141414",foreground:"#e6e6e6",cursor:"#141414"}});
term.open($("xt")); let ci=0; async function feedTo(src){let s="";while(ci<A.cast.length&&A.cast[ci][0]<=src) s+=A.cast[ci++][1]; if(s) await new Promise(r=>term.write(s,r));}
// captions
const DSv=DS.map(s=>s.v), DEv=DE.map(e=>e.v);
const CAPS=[[0.15,T.montage,"We asked an AI for a “modern, beautiful” dashboard.",""],
 [T.montage+.1,T.montage+4.2,"An agent fixed it until our first rubric said yes.",""],
 [T.montage+4.2,T.founder,"27 → 92. Ship it.","rubric v1: colour, effects, motion"],
 [T.founder+1.6,T.rebuild,"They were right. Our rubric was judging the paint.",""],
 [T.rebuild+.2,T.takeC,"So we rebuilt it from the books.","13 principles · 3 kinds of judges · every one gated"],
 [T.takeC+.2,T.takeC+2.9,"Take two passed: 82. The founder: “still AI.”",""],
 [T.takeC+2.9,T.takeD,"v2.1 caught what we missed.","Inter on 100% of the text · numbered sections · copy written for the judge → 71"],
 [T.takeD+.15,DEv[0]+.6,"Take three: write the brief first.",""],
 [DEv[0]+.6,DSv[1]-.1,"Brief: 100. Now rebuild the page from it.",""],
 [DSv[1]-.1,DEv[1]+.7,"Layout thrown away, rebuilt from the brief.",""],
 [DEv[1]+.7,DSv[2]-.05,"79. Fix the weakest principle.",""],
 [DSv[2]-.05,DEv[2]+.7,"Fix the weakest principle.",""],
 [DEv[2]+.7,DEv[3]+.7,"78. Again.",""],
 [DEv[3]+.7,T.wipe,"84. Every principle passes.","brief 100 · 79 · 78 · 84 · 4 min 45 s, unattended"],
 [T.wipe+.2,T.end,"Same data. Same agent. A better rubric.",""]];
function caption(v){const c=CAPS.find(([a,b])=>v>=a&&v<b); $("cap").style.opacity=c?fade(v,c[0],c[1],.15).toFixed(3):0; if(c){ if($("capM").textContent!==c[2]) $("capM").textContent=c[2]; $("capS").textContent=c[3]; }}
let dCur={A:null,B:null};
window.setTime=async(v)=>{
  const L={page:fade(v,-1,T.founder+.4,.35),founder:fade(v,T.founder,T.rebuild),rebuild:fade(v,T.rebuild,T.takeC),d:fade(v,T.takeD,T.wipe),wipe:fade(v,T.wipe,T.end),end:fade(v,T.end,T.total+1)};
  if(v>=T.takeC-.3&&v<T.takeD) L.page=fade(v,T.takeC,T.takeD);
  for(const k in L) $("L_"+k).style.opacity=L[k].toFixed(3);
  $("stamp").style.opacity=0;
  // 1-2: hook + Take B montage
  if(v<T.founder+.5){
    const k=v<T.montage?-1:Math.min(5,Math.floor((v-bStepJS(0))/1.25));
    const from=k<=0?"start":"b"+(k-1>=0?k-1:0), to=k<0?"start":"b"+k, mix=k<0?0:clamp((v-bStepJS(k))/.35);
    setPage(k<=0?"start":"b"+(k-1),to,k<0?0:mix);
    $("pg").style.transform="scale("+(1+.03*clamp(v/3))+")";
    if(v<T.montage+.2) boxes(null); else if(v<T.montage+1.4) boxes(XS,T.montage+.25,v,.012,(b)=>b.kind==="motion"?"amb":""); else boxes(null);
    if(v>=T.montage){ const kk=Math.max(0,k); const prev=kk?A.takeB.v1[kk-1]:A.takeB.v1[0]; const n=Math.round(lerp(prev,A.takeB.v1[kk],(v-bStepJS(kk)-.1)/.6)); chip("rubric v1",n,kk===5?"ship it":"rework",kk===0?"AI one-shot":"agent fix "+kk+" of 5"); $("chip").style.opacity=1; } else $("chip").style.opacity=0;
    if(v>=bStepJS(5)+.7&&v<T.founder) stamp("SHIP IT","#16a34a",1,(v-bStepJS(5)-.7)/.25);
  }
  // 3: founder
  if(v>=T.founder-.3&&v<T.rebuild+.3){
    const t=v-T.founder, tags=["second-order AI default","a decorative donut","an inventory, not answers"];
    $("tags").innerHTML=tags.map((x,i)=>'<span class="tag" style="opacity:'+clamp((t-2.0-i*.3)/.25)+'">'+x+'</span>').join("");
    $("quote").style.transform="translateY("+(-120*ease((t-1.4)/.4))+"px)";
    $("tags").style.top=(640-120*ease((t-1.4)/.4)+60)+"px";
    const drop=clamp((t-1.5)/.6), n=Math.round(92+(A.takeB.v21Final-92)*ease(drop));
    $("quote").querySelector("div").innerHTML=t<1.5?"the founder, looking at the 92":'the new rubric agrees: <b style="color:#f05252">'+n+'</b>';
  }
  // 4: principles
  if(v>=T.rebuild-.3&&v<T.takeC+.3){ PR.forEach((_,i)=>{ $("pr"+i).style.opacity=clamp((v-T.rebuild-.5-i*.28)/.25); }); }
  // 5: Take C
  if(v>=T.takeC-.3&&v<T.takeD){
    const t=v-T.takeC; setPage("c-final","c-final",0); $("pg").style.transform="none";
    if(t<2.9){ chip("rubric v2",A.takeC.v2,"ship it","take two · passed"); $("chip").style.opacity=1; stamp("82 · PASSED","#16a34a",clamp(t/.2)*(t<1.6?1:clamp((2.6-t)/.4)),t/.25); boxes(null); }
    else { boxes(XC,T.takeC+3.0,v,.22,()=>""); const n=Math.round(lerp(A.takeC.v2,A.takeC.v21,(t-4.6)/.6)); chip("rubric v2.1",n,t>4.9?"almost":"ship it",t>4.9?"fails P12: writes for the reviewer":"re-scoring…"); }
  }
  // 6: Take D split
  if(v>=T.takeD-.3&&v<T.wipe+.3){
    await feedTo(v<T.takeD?31:srcAt(v));
    let i=0; DS.forEach((s,k)=>{ if(k>0&&s.v<=v) i=k; }); const s=DS[i], prev=DS[Math.max(0,i-1)], mix=i?clamp((v-s.v)/.35):1;
    if(dCur.A!==prev.shot){$("dA").src=shot(prev.shot);dCur.A=prev.shot;} if(dCur.B!==s.shot){$("dB").src=shot(s.shot);dCur.B=s.shot;} $("dB").style.opacity=mix.toFixed(3);
    const sp=speedAt(v); $("speed").textContent=sp>1.5?"▶▶ "+Math.round(sp)+"×":""; $("speed").style.display=$("speed").textContent?"":"none";
    $("briefS").innerHTML=v>=DE[0].v?'<b>100 · ready</b> · 3 ranked questions, attention rules, no invented targets':"writing…";
    let e=-1; DE.forEach((x,k)=>{ if(k>0&&x.v<=v) e=k; });
    if(e<0){ $("dN").textContent=A.start.v21; $("dN").style.color="#ffb4b4"; $("dG").textContent="rework"; $("dG").style.background="#3a2020"; $("dG").style.color="#ffb4b4"; $("dS").textContent="the AI one-shot under the same rubric"; }
    else { const p=e>1?DE[e-1].score:A.start.v21, x=DE[e], n=Math.round(lerp(p,x.score,(v-x.v)/.7)); const g=x.score>=80?"ship it":x.score>=60?"almost":"rework", c=G[g]; $("dN").textContent=n; $("dN").style.color=c[1]; $("dG").textContent=g; $("dG").style.background=c[0]; $("dG").style.color=c[1]; $("dS").textContent=e===3?"passed · every principle ≥ 3/5":"round "+e+" · weakest principle next"; }
  }
  // 7: wipe
  if(v>=T.wipe-.3){ $("wB").src=$("wB").src||shot("start"); if(!$("wA").dataset.s){$("wA").src=shot("d08");$("wA").dataset.s=1;} const cut=100-100*ease((v-T.wipe-.4)/2.2); $("wA").style.setProperty("--cut",cut+"%"); $("wbar").style.left=(180+1360*cut/100-2)+"px"; }
  caption(v);
};
function bStepJS(k){return T.montage+.35+k*1.25;}
</script></body></html>`;
writeFileSync(join(here, "assets/edit2.html"), html);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto("file://" + join(here, "assets/edit2.html"), { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
const settleImages = () => page.evaluate(() => Promise.all([...document.images].filter((i) => i.src && !i.complete).map((i) => new Promise((r) => { i.onload = i.onerror = r; }))));

if (stillAt != null) {
  for (let v = 0; v <= Number(stillAt); v += 1 / fps) await page.evaluate((v) => window.setTime(v), v);
  await settleImages();
  await page.screenshot({ path: stillOut });
  await browser.close();
  console.log(`still ${stillAt}s -> ${stillOut} (total ${T.total}s, take D ends ${T.takeDEnd.toFixed(1)}s)`);
  process.exit(0);
}
const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
  "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", outPath], { stdio: ["pipe", "inherit", "inherit"] });
const frames = Math.ceil(T.total * fps);
for (let f = 0; f < frames; f++) {
  await page.evaluate((v) => window.setTime(v), f / fps);
  await settleImages();
  const img = await page.screenshot({ type: "jpeg", quality: 92 });
  if (!ff.stdin.write(img)) await new Promise((r) => ff.stdin.once("drain", r));
  if (f % (fps * 5) === 0) process.stderr.write(`\r${(f / fps).toFixed(0)}s / ${T.total}s`);
}
ff.stdin.end(); await new Promise((r) => ff.on("close", r)); await browser.close();
console.log(`\nwrote ${outPath}: ${T.total}s; take D section ends at ${T.takeDEnd.toFixed(2)}s`);
