/* ============================================================
   LU FAMILY GAME PORTAL — 盧家遊樂園（德州撲克 + 台灣麻將十六張）(zero dependencies)
   Run:   node lu_family_portal.js
   TV:    open the printed URL on the big screen  (host view)
   Phones: scan the QR shown on the TV            (player view)
   Fixed-limit 10/20 · blinds 5/10 · 2–5 players · AI fill
   ============================================================ */
"use strict";
const http = require("http");
const os   = require("os");
const crypto = require("crypto");
const PORT = process.env.PORT || 3000;

/* ================= GAME ENGINE ================= */
const SB=5, BB=10, SMALL_BET=10, BIG_BET=20, CAP=4;
const SUITS=["♠","♥","♦","♣"], RNAME={11:"J",12:"Q",13:"K",14:"A"};
const HAND_NAMES=["High card","Pair","Two pair","Three of a kind","Straight","Flush","Full house","Four of a kind","Straight flush"];
const AI_NAMES=["Bot Ada","Bot Ben","Bot Cleo","Bot Dex"];

/* 桌號：開機時產生一次。四個人的手機上如果看到同一個桌號，就是同一桌。
   （這台伺服器只有一桌，桌號是給人確認用的，不是用來分房間的。）*/
function makeTableCode(){
  const A="ACDEFGHJKLMNPQRTUVWXY34679";   // 拿掉看起來像的 B/8 I/1 O/0 S/5 Z/2
  let out=""; for(let i=0;i<4;i++) out+=A[Math.floor(Math.random()*A.length)];
  return out;
}
const TABLE_CODE = makeTableCode();

let G = {
  phase:"lobby",          // lobby | play
  game:null,              // null = portal | "poker" | "mahjong"
  stack:1000,
  mode:"fl",              // fl = fixed-limit | nl = no-limit (preset raise buttons)
  aiLevel:"int",          // beg | int | adv
  sbA:5, bbA:10,          // blinds (selectable in lobby)
  lastRaise:10,           // NL min-raise tracking
  pace:2.2,               // delay multiplier: 2.2 = Relaxed (learning), 1 = Normal
  players:[],             // {id,token,isAI,name,chips,start,handsWon,hole,folded,allIn,bet,total,need,inHand,won,showName,connected}
  dealer:-1, sb:-1, bb:-1,
  stage:0, board:[], deck:[], curBet:0, betsCount:0, turn:-1,
  handOver:false, banner:"", log:[], revealAll:false, seq:0
};

function rName(r){ return RNAME[r]||String(r); }
function newDeck(){
  const d=[]; for(let s=0;s<4;s++) for(let r=2;r<=14;r++) d.push({r,s});
  for(let i=d.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [d[i],d[j]]=[d[j],d[i]]; }
  return d;
}
function ev5(cs){
  const byR={}; cs.forEach(c=>byR[c.r]=(byR[c.r]||0)+1);
  const groups=Object.keys(byR).map(Number).sort((a,b)=> byR[b]-byR[a] || b-a);
  const counts=groups.map(r=>byR[r]);
  const flush=cs.every(c=>c.s===cs[0].s);
  const uniq=[...new Set(cs.map(c=>c.r))].sort((a,b)=>b-a);
  let sHigh=0;
  if(uniq.length===5){
    if(uniq[0]-uniq[4]===4) sHigh=uniq[0];
    else if(uniq[0]===14&&uniq[1]===5&&uniq[4]===2) sHigh=5;
  }
  if(flush&&sHigh) return [8,sHigh];
  if(counts[0]===4) return [7,groups[0],groups[1]];
  if(counts[0]===3&&counts[1]===2) return [6,groups[0],groups[1]];
  if(flush) return [5,...uniq];
  if(sHigh) return [4,sHigh];
  if(counts[0]===3) return [3,groups[0],...groups.slice(1)];
  if(counts[0]===2&&counts[1]===2) return [2,groups[0],groups[1],groups[2]];
  if(counts[0]===2) return [1,groups[0],...groups.slice(1)];
  return [0,...uniq];
}
function cmpH(a,b){ for(let i=0;i<Math.max(a.length,b.length);i++){ const x=a[i]||0,y=b[i]||0; if(x!==y) return x-y; } return 0; }
function bestOf(cards){
  if(cards.length===5) return ev5(cards);
  let best=null; const n=cards.length;
  (function rec(start,chosen){
    if(chosen.length===5){ const v=ev5(chosen); if(!best||cmpH(v,best)>0) best=v; return; }
    for(let i=start;i<n;i++) rec(i+1,chosen.concat(cards[i]));
  })(0,[]);
  return best;
}

function banner(t){ G.banner=t; G.log.unshift(t); G.log=G.log.slice(0,6); }
function nextSeat(from,pred){
  const n=G.players.length;
  for(let k=1;k<=n;k++){ const i=(from+k)%n; if(pred(G.players[i])) return i; }
  return -1;
}
function alive(){ return G.players.filter(p=>p.chips>0).length; }
function potTotal(){ return G.players.reduce((s,p)=>s+p.total,0); }
function betSize(){ return (G.stage<2)?G.bbA:2*G.bbA; }
function inHandCount(){ return G.players.filter(p=>p.inHand&&!p.folded).length; }
function actables(){ return G.players.filter(p=>p.inHand&&!p.folded&&!p.allIn).length; }
function post(i,amt){
  const p=G.players[i]; const a=Math.min(amt,p.chips);
  p.chips-=a; p.bet+=a; p.total+=a; p.wagered=(p.wagered||0)+a; p.handBet=(p.handBet||0)+a;
  if(p.chips===0) p.allIn=true;
}
function later(ms,fn){ const s=G.seq; setTimeout(()=>{ if(G.seq===s) fn(); },Math.round(ms*G.pace)); }

function removeSeat(i,verb){
  const p=G.players[i];
  if(G.phase==="lobby"){ G.players.splice(i,1); broadcast(); return; }
  p.removed=true;
  banner(p.name+" "+verb+".");
  if(!G.handOver && p.inHand && !p.folded){
    p.folded=true; p.need=false;
    if(inHandCount()===1){ G.seq++; settleFoldWin(); }
    else if(G.turn===i){ broadcast(); later(300,step); }
    else broadcast();
  } else { p.inHand=false; broadcast(); }
}
function purgeRemoved(){
  if(!G.players.some(p=>p.removed)) return;
  const oldDealer=G.dealer;
  let newDealer=-1; const kept=[];
  G.players.forEach((p,i)=>{ if(!p.removed){ kept.push(p); if(i<=oldDealer) newDealer=kept.length-1; } });
  G.players=kept; G.dealer=newDealer;
}
function newHand(){
  purgeRemoved();
  if(alive()<2){ banner("Session over — one player has all the chips. Rebuy from Standings."); G.handOver=true; broadcast(); return; }
  G.seq++;
  G.players.forEach(p=>{ p.hole=[]; p.folded=false; p.allIn=false; p.bet=0; p.total=0;
    p.inHand=p.chips>0; p.won=false; p.showName=""; p.need=false; p.handBet=0; });
  G.dealer=nextSeat(G.dealer,p=>p.chips>0);
  EQC={}; EQCN=0;
  G.deck=newDeck(); G.board=[]; G.stage=0; G.curBet=G.bbA; G.betsCount=1; G.lastRaise=G.bbA; G.handOver=false;
  const liveN=G.players.filter(p=>p.inHand).length;
  G.sb = liveN===2 ? G.dealer : nextSeat(G.dealer,p=>p.inHand);
  G.bb = nextSeat(G.sb,p=>p.inHand);
  post(G.sb,G.sbA); post(G.bb,G.bbA);
  G.players.forEach(p=>{ if(p.inHand&&!p.allIn) p.need=true; });
  for(let d=0;d<2;d++) G.players.forEach(p=>{ if(p.inHand) p.hole.push(G.deck.pop()); });
  G.turn=nextSeat(G.bb,p=>p.inHand&&!p.allIn&&p.need);
  banner("New hand — "+G.players[G.dealer].name+" deals. Blinds "+G.sbA+"/"+G.bbA+" posted.");
  broadcast();
  later(700,step);
}
function step(){
  if(G.handOver) return;
  if(inHandCount()===1) return settleFoldWin();
  let n=-1;
  if(actables()>0){
    const N=G.players.length;
    for(let k=0;k<N;k++){ const i=(G.turn+k)%N; const p=G.players[i];
      if(p.inHand&&!p.folded&&!p.allIn&&p.need){ n=i; break; } }
  }
  if(n===-1) return endRound();
  G.turn=n;
  broadcast();
  // 代打的位子跟 AI 一樣由電腦接手（CIO 2026-08-23）
  if(G.players[n].isAI||G.players[n].auto) later(900,()=>aiAct(n));
  // humans: wait for POST /api/action
}
function actionDone(i){
  G.players[i].need=false;
  G.turn=(i+1)%G.players.length;
  broadcast();
  later(600,step);
}
function doFold(i){ G.players[i].folded=true; banner(G.players[i].name+" folds."); actionDone(i); }
function doCall(i){
  const p=G.players[i]; const owe=G.curBet-p.bet;
  if(owe<=0) banner(p.name+" checks.");
  else { const a=Math.min(owe,p.chips); post(i,a);
    banner(p.name+(p.allIn?" calls ALL-IN for "+a+".":" calls "+a+".")); }
  actionDone(i);
}
function doRaise(i){
  const p=G.players[i]; const target=G.curBet+betSize();
  post(i,Math.min(target-p.bet,p.chips));
  G.curBet=p.bet; G.betsCount++;
  G.players.forEach((q,j)=>{ if(j!==i&&q.inHand&&!q.folded&&!q.allIn) q.need=true; });
  banner(p.name+(G.stage>0&&G.curBet===betSize()?" bets ":" raises to ")+G.curBet+(p.allIn?" (all-in)":"")+".");
  actionDone(i);
}
function canRaise(i){
  const p=G.players[i];
  if(G.mode==="nl") return p.chips > Math.max(0,G.curBet-p.bet); // has more than a call
  return G.betsCount<CAP && p.chips >= (G.curBet+betSize()-p.bet);
}
function minRaiseTo(){ return G.curBet===0 ? G.bbA : G.curBet + Math.max(G.lastRaise,G.bbA); }
function raiseOptions(i){
  const p=G.players[i]; const allInTo=p.bet+p.chips;
  const pot=potTotal();
  const minTo=Math.min(minRaiseTo(),allInTo);
  const r5=x=>Math.max(G.sbA,Math.round(x/G.sbA)*G.sbA);
  const opts=[];
  const push=(label,to)=>{ to=Math.min(to,allInTo);
    if(to>G.curBet && to>p.bet && !opts.some(o=>o.to===to)) opts.push({label:label+" "+to,to}); };
  push("Min",minTo);
  push("½ Pot",r5(Math.max(minTo,G.curBet+Math.round(pot/2))));
  push("Pot",r5(Math.max(minTo,G.curBet+pot)));
  push("All-in",allInTo);
  return opts.slice(0,4);
}
function doRaiseTo(i,to){
  const p=G.players[i]; const allInTo=p.bet+p.chips;
  to=Math.min(Math.max(to,Math.min(minRaiseTo(),allInTo)),allInTo);
  const wasBet=G.curBet===0; const inc=to-G.curBet;
  post(i,to-p.bet);
  if(p.bet>G.curBet){
    if(inc>=Math.max(G.lastRaise,G.bbA)) G.lastRaise=inc;
    G.curBet=p.bet; G.betsCount++;
    G.players.forEach((q,j)=>{ if(j!==i&&q.inHand&&!q.folded&&!q.allIn) q.need=true; });
    banner(p.name+(wasBet?" bets ":" raises to ")+G.curBet+(p.allIn?" (all-in)":"")+".");
  } else banner(p.name+" calls all-in.");
  actionDone(i);
}
function endRound(){
  G.players.forEach(p=>p.bet=0);
  G.curBet=0; G.betsCount=0; G.lastRaise=G.bbA;
  G.players.forEach(p=>{ p.need = p.inHand&&!p.folded&&!p.allIn; });
  if(G.stage===0){ G.board.push(G.deck.pop(),G.deck.pop(),G.deck.pop()); G.stage=1; banner("Flop."); }
  else if(G.stage===1){ G.board.push(G.deck.pop()); G.stage=2; banner("Turn."); }
  else if(G.stage===2){ G.board.push(G.deck.pop()); G.stage=3; banner("River."); }
  else return showdown();
  G.turn=nextSeat(G.dealer,p=>p.inHand&&!p.folded&&!p.allIn);
  broadcast();
  if(actables()<=1) later(1000,endRound);
  else later(800,step);
}
function settleFoldWin(){
  const w=G.players.findIndex(p=>p.inHand&&!p.folded);
  const amt=potTotal();
  G.players[w].chips+=amt; G.players[w].handsWon++; G.players[w].won=true;
  G.players.forEach(p=>p.total=0);
  banner(G.players[w].name+" wins "+amt+" — everyone else folded.");
  finishHand();
}
function showdown(){
  G.stage=4;
  const results={};
  G.players.forEach((p,i)=>{ if(p.inHand&&!p.folded){
    const v=bestOf(p.hole.concat(G.board));
    results[i]=v; p.showName=HAND_NAMES[v[0]];
  }});
  const rem=G.players.map(p=>p.total); const pots=[];
  while(Math.max(...rem)>0){
    const lvl=Math.min(...rem.filter(x=>x>0));
    let amt=0; const elig=[];
    G.players.forEach((p,i)=>{ if(rem[i]>0){ amt+=Math.min(rem[i],lvl); rem[i]-=lvl;
      if(p.inHand&&!p.folded) elig.push(i); }});
    pots.push({amt,elig});
  }
  const winners=new Set();
  pots.forEach(pot=>{
    let best=null,ws=[];
    pot.elig.forEach(i=>{ const v=results[i];
      if(!best||cmpH(v,best)>0){ best=v; ws=[i]; } else if(cmpH(v,best)===0) ws.push(i); });
    const share=Math.floor(pot.amt/ws.length); let left=pot.amt-share*ws.length;
    ws.forEach(i=>{ G.players[i].chips+=share; if(left>0){G.players[i].chips++; left--;}
      G.players[i].won=true; winners.add(i); });
  });
  G.players.forEach(p=>p.total=0);
  [...winners].forEach(i=>G.players[i].handsWon++);
  banner("Showdown — pot to "+[...winners].map(i=>G.players[i].name+" ("+G.players[i].showName+")").join(", ")+".");
  finishHand();
}
function finishHand(){ G.handOver=true; broadcast(); }

/* ---------- AI ---------- */
const AI_PROFILES={
  // loose = min strength to call; betS = bet/raise when free; raiseS = raise facing a bet;
  // bluff = bluff frequency; rand = noise; potOdds/draws/pos = smarter features on/off
  beg:{loose:0.28, raiseS:0.74, betS:0.64, bluff:0.04, rand:0.13, potOdds:false, draws:false, pos:false},
  int:{loose:0.38, raiseS:0.66, betS:0.58, bluff:0.10, rand:0.08, potOdds:true,  draws:true,  pos:false},
  adv:{loose:0.46, raiseS:0.60, betS:0.54, bluff:0.16, rand:0.05, potOdds:true,  draws:true,  pos:true}
};
function drawBonus(p){
  if(G.stage===0||G.stage>=3) return 0;               // draws only matter on flop/turn
  const cards=p.hole.concat(G.board);
  const suitCount={}; cards.forEach(c=>suitCount[c.s]=(suitCount[c.s]||0)+1);
  let b=0;
  if(Object.values(suitCount).some(x=>x===4)) b+=0.16; // flush draw
  const rs=[...new Set(cards.map(c=>c.r))]; if(rs.includes(14)) rs.push(1);
  let best=0;
  for(let lo=1;lo<=10;lo++){ let cnt=0; for(let r=lo;r<lo+5;r++) if(rs.includes(r)) cnt++; best=Math.max(best,cnt); }
  if(best===4) b+=(b>0?0.07:0.12);                     // straight draw
  return b;
}
function pickSize(opts,s){
  if(s>0.9&&opts.length>2) return opts[2].to;          // pot
  if(s>0.75&&opts.length>1) return opts[1].to;         // ½ pot
  return opts[0].to;                                   // min
}
function aiAct(i){
  const PF=AI_PROFILES[G.aiLevel]||AI_PROFILES.int;
  const p=G.players[i]; const owe=G.curBet-p.bet;
  let s=strength(i);
  if(PF.draws) s+=drawBonus(p);
  if(PF.pos){ const n=G.players.length; s+=(((i-G.dealer+n)%n)/n)*0.05; }
  s+=(Math.random()*2-1)*PF.rand;
  const pot=potTotal();
  if(G.mode==="nl"){
    const opts=raiseOptions(i); const canR=canRaise(i)&&opts.length;
    if(owe<=0){
      if(canR&&G.betsCount<4&&(s>PF.betS||Math.random()<PF.bluff*0.6))
        return doRaiseTo(i,pickSize(opts,s));
      return doCall(i);
    }
    if(canR&&G.betsCount<4&&(s>PF.raiseS+0.1||(s>PF.raiseS&&Math.random()<0.5)))
      return doRaiseTo(i,pickSize(opts,s));
    if(PF.potOdds&&owe>p.chips*0.5&&s<0.68) return doFold(i);
    if(PF.potOdds){
      const need=owe/(pot+owe);
      const eq=Math.max(0,Math.min(1,(s-0.15)/0.8));
      if(eq>need*1.1) return doCall(i);
    } else if(s>PF.loose) return doCall(i);
    if(owe<=G.bbA&&s>PF.loose-0.1) return doCall(i);
    if(Math.random()<0.04) return doCall(i);
    return doFold(i);
  }
  if(owe<=0){
    if(canRaise(i)&&(s>PF.betS||Math.random()<PF.bluff*0.5)) return doRaise(i);
    return doCall(i);
  }
  if(canRaise(i)&&s>PF.raiseS) return doRaise(i);
  if(s>PF.loose||owe<=G.sbA||Math.random()<0.05) return doCall(i);
  return doFold(i);
}
function strength(i){
  const p=G.players[i];
  if(G.stage===0){
    const [a,b]=p.hole; const hi=Math.max(a.r,b.r), lo=Math.min(a.r,b.r);
    let s;
    if(a.r===b.r) s=0.55+a.r/45;
    else { s=hi/40+lo/90;
      if(hi>=12&&lo>=10) s+=0.18;
      if(a.s===b.s) s+=0.05;
      if(hi-lo===1) s+=0.05;
      if(hi===14) s+=0.08; }
    return Math.min(s,0.95);
  }
  const v=bestOf(p.hole.concat(G.board));
  return Math.min(0.18+v[0]*0.11+(v[1]||0)/140,0.97);
}
/* ---------- coach ---------- */
/* fast 7-card evaluator -> single comparable integer (cat*15^5 + kickers) */
const P15=[759375,50625,3375,225,15,1];
function ev7(cs){
  const rc=new Array(15).fill(0), sc=[0,0,0,0], sm=[0,0,0,0];
  let rm=0;
  for(let i=0;i<cs.length;i++){ const c=cs[i]; rc[c.r]++; sc[c.s]++; sm[c.s]|=1<<c.r; rm|=1<<c.r; }
  const sHi=m=>{ if(m&(1<<14)) m|=2; let run=0;
    for(let r=14;r>=1;r--){ if(m&(1<<r)){ if(++run===5) return r+4; } else run=0; } return 0; };
  let fs=-1; for(let s=0;s<4;s++) if(sc[s]>=5){ fs=s; break; }
  if(fs>=0){ const sf=sHi(sm[fs]); if(sf) return 8*P15[0]+sf*P15[1]; }
  let quad=0; const trips=[], pairs=[];
  for(let r=14;r>=2;r--){ if(rc[r]===4) quad=r; else if(rc[r]===3) trips.push(r); else if(rc[r]===2) pairs.push(r); }
  if(quad){ let k=0; for(let r=14;r>=2;r--) if(r!==quad&&rc[r]>0){ k=r; break; }
    return 7*P15[0]+quad*P15[1]+k*P15[2]; }
  if(trips.length&&(pairs.length||trips.length>1))
    return 6*P15[0]+trips[0]*P15[1]+Math.max(pairs[0]||0,trips[1]||0)*P15[2];
  if(fs>=0){ let v=5*P15[0],n=0; for(let r=14;r>=2&&n<5;r--) if(sm[fs]&(1<<r)) v+=r*P15[++n]; return v; }
  const st=sHi(rm); if(st) return 4*P15[0]+st*P15[1];
  if(trips.length){ let v=3*P15[0]+trips[0]*P15[1],n=1;
    for(let r=14;r>=2&&n<3;r--) if(r!==trips[0]&&rc[r]>0) v+=r*P15[++n]; return v; }
  if(pairs.length>=2){ let k=0; for(let r=14;r>=2;r--) if(r!==pairs[0]&&r!==pairs[1]&&rc[r]>0){ k=r; break; }
    return 2*P15[0]+pairs[0]*P15[1]+pairs[1]*P15[2]+k*P15[3]; }
  if(pairs.length===1){ let v=1*P15[0]+pairs[0]*P15[1],n=1;
    for(let r=14;r>=2&&n<4;r--) if(r!==pairs[0]&&rc[r]>0) v+=r*P15[++n]; return v; }
  let v=0,n=0; for(let r=14;r>=2&&n<5;r--) if(rc[r]>0) v+=r*P15[++n]; return v;
}
const catOf=v=>Math.floor(v/P15[0]);

/* Monte-Carlo equity vs N random opponents, cached per (hole,board,opps) */
let EQC={}, EQCN=0;
function mcEquity(hole,board,nOpp,sims){
  const k=c=>c.r*4+c.s;
  const key=hole.map(k).sort((a,b)=>a-b).join(",")+"|"+board.map(k).join(",")+"|"+nOpp;
  if(EQC[key]!==undefined) return EQC[key];
  const known={}; hole.concat(board).forEach(c=>known[c.s*100+c.r]=1);
  const deck=[]; for(let s=0;s<4;s++) for(let r=2;r<=14;r++) if(!known[s*100+r]) deck.push({r,s});
  const needB=5-board.length, take=needB+2*nOpp;
  let win=0,tie=0;
  for(let t=0;t<sims;t++){
    for(let j=0;j<take;j++){ const q=j+Math.floor(Math.random()*(deck.length-j));
      const tmp=deck[j]; deck[j]=deck[q]; deck[q]=tmp; }
    const full=board.concat(deck.slice(0,needB));
    const mine=ev7(hole.concat(full));
    let beat=false,tied=false;
    for(let o=0;o<nOpp;o++){
      const v=ev7([deck[needB+2*o],deck[needB+2*o+1]].concat(full));
      if(v>mine){ beat=true; break; } if(v===mine) tied=true;
    }
    if(beat) continue; if(tied) tie++; else win++;
  }
  const e=(win+tie*0.5)/sims;
  if(EQCN>600){ EQC={}; EQCN=0; }
  EQC[key]=e; EQCN++; return e;
}
/* unseen cards that lift you to a BETTER, actually-winning hand
   (a new pair only counts if it beats the top board card) */
function outsCount(hole,board){
  if(board.length<3||board.length>=5) return 0;
  const topB=Math.max.apply(null,board.map(c=>c.r));
  const cur=catOf(ev7(hole.concat(board)));
  const known={}; hole.concat(board).forEach(c=>known[c.s*100+c.r]=1);
  const pairRank=cards=>{ const rc={}; cards.forEach(c=>rc[c.r]=(rc[c.r]||0)+1);
    return Math.max.apply(null,Object.keys(rc).filter(r=>rc[r]>=2).map(Number).concat([0])); };
  let n=0;
  for(let s=0;s<4;s++) for(let r=2;r<=14;r++){ if(known[s*100+r]) continue;
    const all=hole.concat(board,[{r,s}]); const c=catOf(ev7(all));
    if(c<=cur) continue;
    if(c===1&&pairRank(all)<=topB) continue;   // low pair is not an out
    n++; }
  return n;
}
function preflopLabel(hole){
  const [a,b]=hole; const hi=Math.max(a.r,b.r), lo=Math.min(a.r,b.r);
  if(a.r===b.r) return "Pocket "+rName(a.r)+"s";
  return rName(hi)+rName(lo)+(a.s===b.s?" suited":" offsuit");
}
function madeDesc(hole,board){
  const all=hole.concat(board); const v=ev7(all); const cat=catOf(v);
  const rc={}; all.forEach(c=>rc[c.r]=(rc[c.r]||0)+1);
  const br=[...new Set(board.map(c=>c.r))].sort((x,y)=>y-x);
  if(cat===1){
    const pr=Object.keys(rc).map(Number).filter(r=>rc[r]===2).sort((x,y)=>y-x)[0];
    const pocket=hole[0].r===hole[1].r;
    let q="Weak pair";
    if(pocket&&pr>br[0]) q="Overpair"; else if(pr===br[0]) q="Top pair";
    else if(pr===br[1]) q="Second pair"; else if(pocket) q="Underpair";
    const kick=hole.map(c=>c.r).filter(r=>r!==pr).sort((x,y)=>y-x)[0];
    return q+" — "+rName(pr)+"s"+(kick?", "+rName(kick)+" kicker":"");
  }
  if(cat===3){ const tr=Object.keys(rc).map(Number).filter(r=>rc[r]===3)[0];
    const inHole=hole.filter(c=>c.r===tr).length;
    return (inHole===2?"Set of ":"Trip ")+rName(tr)+"s"; }
  if(cat===0){ const hi=hole.map(c=>c.r).sort((x,y)=>y-x)[0];
    const over=hole.filter(c=>c.r>br[0]).length;
    return "No pair — "+rName(hi)+" high"+(over?" ("+over+" overcard"+(over>1?"s":"")+")":""); }
  return HAND_NAMES[cat];
}
function texture(board){
  if(board.length<3) return "";
  const t=[]; const sc={}; board.forEach(c=>sc[c.s]=(sc[c.s]||0)+1);
  const mx=Math.max.apply(null,Object.keys(sc).map(k=>sc[k]));
  if(mx>=3) t.push("flush-heavy"); else if(mx===2) t.push("two-tone"); else t.push("rainbow");
  const rs=[...new Set(board.map(c=>c.r))].sort((a,b)=>a-b);
  if(rs.length<board.length) t.push("paired");
  for(let i=0;i+2<rs.length;i++) if(rs[i+2]-rs[i]<=4){ t.push("connected"); break; }
  if(rs[rs.length-1]>=12) t.push("high card out");
  return t.join(" · ");
}
function posName(i){
  const n=G.players.filter(p=>p.inHand).length;
  if(n<=2) return i===G.dealer? "BTN/SB — first in, last after" : "BB — last pre-flop";
  const off=(i-G.dealer+G.players.length)%G.players.length;
  return ["BTN (best — act last)","SB (worst — act first)","BB","UTG (act first)","CO"][off]||"MP";
}
/* the advanced coach: numbers first, then a verdict */
function coachAdv(i){
  const p=G.players[i];
  if(!p.hole.length||G.phase!=="play"||G.stage>=4||p.folded) return null;
  const opp=G.players.filter((q,j)=>j!==i&&q.inHand&&!q.folded).length;
  if(opp<1) return null;
  const eq=mcEquity(p.hole,G.board,opp,G.stage===0?900:700);
  const pot=potTotal(), owe=Math.max(0,G.curBet-p.bet);
  const need=owe>0? owe/(pot+owe) : 0;
  const outs=outsCount(p.hole,G.board);
  const rows=[];
  const fair=1/(opp+1);
  rows.push(["Hand", G.stage===0? preflopLabel(p.hole) : madeDesc(p.hole,G.board)]);
  rows.push(["Seat", posName(i)+" · "+opp+" live opponent"+(opp>1?"s":"")]);
  rows.push(["Equity", Math.round(eq*100)+"% to win at showdown"]);
  rows.push(["Fair share", Math.round(fair*100)+"% ("+(opp+1)+"-way) — you are "+
    (eq>fair? "ahead of average":"below average")]);
  if(outs) rows.push(["Outs", outs+" outs ≈ "+Math.round(outs*(G.stage===1?4:2))+"% to improve"]);
  if(G.stage>0) rows.push(["Board", texture(G.board)]);
  if(owe>0) rows.push(["Pot odds","call "+owe+" into "+pot+" → need "+Math.round(need*100)+"%, you have "+Math.round(eq*100)+"%"]);
  if(G.stage>0&&pot>0) rows.push(["SPR", (p.chips/pot).toFixed(1)+" (stack ÷ pot)"+(p.chips/pot<3?" — short, commit or fold":"")]);
  let verdict, why, tone;
  if(G.stage===0){
    /* pre-flop: judge against fair share, discount the price for implied odds */
    if(eq>fair*1.30&&canRaise(i)){ verdict="RAISE — for value"; tone="good";
      why="You are "+Math.round(eq*100)+"% against "+opp+" random hands, well over the "+Math.round(fair*100)+"% average. Raise to thin the field and build the pot."; }
    else if(eq>fair*1.05){ verdict=owe>0?"CALL":"CHECK — happy to see a flop"; tone="ok";
      why="Above average for a "+(opp+1)+"-way pot. Playable, but not strong enough to raise from "+posName(i).split(" ")[0]+"."; }
    else if(owe>0&&eq>need*0.85){ verdict="CALL — cheap"; tone="ok";
      why="Below average, but only "+owe+" to see a flop. Fold to any real raise behind you."; }
    else { verdict=owe>0?"FOLD":"CHECK"; tone="bad";
      why="Only "+Math.round(eq*100)+"% against "+opp+" hands versus a "+Math.round(fair*100)+"% average share. This hand loses money long-run."; }
  } else if(owe>0){
    const edge=eq-need;
    if(eq<need*0.92){ verdict="FOLD"; tone="bad";
      why="You need "+Math.round(need*100)+"% to break even and only have "+Math.round(eq*100)+"%. Calling loses money over time."
        +(outs>=8?" (Call only if you expect to get paid big when you hit.)":""); }
    else if(eq>0.72&&canRaise(i)){ verdict="RAISE — for value"; tone="good";
      why="You are ahead of most hands still in. Build the pot now, not on the river."; }
    else if(edge>0.08){ verdict="CALL"; tone="ok";
      why="Price is "+Math.round(need*100)+"%, your equity is "+Math.round(eq*100)+"% — profitable, but not strong enough to raise."; }
    else { verdict="CALL — marginal"; tone="ok";
      why="Barely profitable ("+Math.round(eq*100)+"% vs "+Math.round(need*100)+"% needed). Fold instead if you act first on the next street."; }
  } else {
    if(eq>0.70&&canRaise(i)){ verdict="BET — for value"; tone="good";
      why="You are ahead. Charge the draws; checking here just gives free cards."; }
    else if(outs>=8&&canRaise(i)){ verdict="BET — semi-bluff"; tone="ok";
      why=outs+" outs plus fold equity. You can win now or hit later — two ways to win."; }
    else if(eq>fair*1.15){ verdict="CHECK"; tone="ok";
      why="Ahead of average but thin. Keep the pot small and see the next card cheaply."; }
    else { verdict="CHECK — plan to fold"; tone="bad";
      why="Weak holding. Take the free card, release to any real bet."; }
  }
  if(G.mode==="nl"&&canRaise(i)&&/BET|RAISE/.test(verdict)){
    const o=raiseOptions(i); const pick=eq>0.8? (o[2]||o[1]||o[0]) : (o[1]||o[0]);
    if(pick) verdict+=" · "+pick.label;
  }
  return {rows,verdict,why,tone};
}
function coachLine(i){
  const p=G.players[i];
  if(!p.hole.length) return "";
  if(G.stage===0){
    const [a,b]=p.hole; const hi=Math.max(a.r,b.r), lo=Math.min(a.r,b.r);
    if(a.r===b.r) return "Pocket "+rName(a.r)+"s — a pair before the flop is strong. Raising is fine.";
    if(hi>=12&&lo>=10) return "Two big cards — worth playing. Call or raise.";
    if(a.s===b.s&&hi-lo===1) return "Suited connectors — speculative. Cheap call OK, fold to heavy raising.";
    if(hi===14) return "Ace with a weak kicker — playable cheaply, careful if others raise.";
    return "Weak starting hand — folding is usually right unless checking is free.";
  }
  if(G.stage>=4||!G.board.length) return "";
  const v=bestOf(p.hole.concat(G.board));
  const nm=HAND_NAMES[v[0]];
  let tip;
  if(v[0]>=4) tip="Very strong — bet or raise for value.";
  else if(v[0]>=2) tip="Solid — betting or calling is reasonable.";
  else if(v[0]===1) tip=(v[1]>=11)?"Decent pair — usually worth a call.":"Small pair — proceed carefully.";
  else tip="Nothing yet — check when free, fold to bets.";
  return "You have: "+nm+(v[0]===1?" of "+rName(v[1])+"s":"")+". "+tip;
}

/* ================= MAHJONG ENGINE — 台灣十六張 =================
   Tiles: 0-8 萬 1-9 · 9-17 筒 · 18-26 條 · 27-30 東南西北 · 31-33 中發白 · 34-41 花(春夏秋冬梅蘭菊竹)
   Scoring: 底 + 台×每台. NO dealer bonus / 連莊 (per house rules). */
const TESTMODE = !!process.env.MJ_TEST;
let MJ_TEST_HOOK = null;

const MJ_BOT_NAMES=["電腦阿福","電腦小美","電腦阿財","電腦大寶"];
const NUMC=["一","二","三","四","五","六","七","八","九"];
const HONORC=["東","南","西","北","中","發","白"];
const FLOWERC=["春","夏","秋","冬","梅","蘭","菊","竹"];
const WINDC=["東","南","西","北"];
function mjTileName(t){
  if(t<9) return NUMC[t]+"萬";
  if(t<18) return NUMC[t-9]+"筒";
  if(t<27) return NUMC[t-18]+"條";
  if(t<34) return HONORC[t-27];
  return FLOWERC[t-34];
}

let M={
  phase:"idle",            // idle (lobby) | play
  base:30, taiVal:10,      // 底 / 每台
  starter:-1, turn:-1,     // 起家 (turn order only — no dealer payouts)
  wall:[], f:0, b:0,       // draw front / replacement back
  seats:[],                // 4× {pi,hand,melds,flowers,discards,drawn,auto}
  pending:null,            // {kind:"discard"|"rob", tile, from, claims:[{seat,opts,resp}]}
  claimUntil:0,
  handOver:false, winInfo:null, drawGame:false,
  banner:"", log:[], seq:0, claimSeq:0,
  handCount:0, discTotal:0, claimsHappened:false, lastDrawGang:false
};

function mjBanner(t){ M.banner=t; M.log.unshift(t); M.log=M.log.slice(0,6); }
function mjLater(ms,fn){
  if(TESTMODE){ fn(); return; }
  const s=M.seq; setTimeout(()=>{ if(M.seq===s && G.game==="mahjong" && M.phase==="play") fn(); },Math.round(ms*G.pace));
}
function seatP(s){ return G.players[M.seats[s].pi]; }
function seatName(s){ const p=seatP(s); return p? p.name : "座位"+(s+1); }
function seatWind(s){ return (s-M.starter+4)%4; } // 0東1南2西3北
function isBotSeat(s){ const p=seatP(s); return !p || p.isAI || M.seats[s].auto; }
function liveLeft(){ return Math.max(0, M.b-M.f+1-16); }
function sortHand(st){ st.hand.sort((a,b)=>a-b); }
function countsOf(arr){ const c=new Array(34).fill(0); arr.forEach(t=>{ if(t<34) c[t]++; }); return c; }

/* ---------- win detection ---------- */
function mjSets(cnt,i,need){
  if(need===0){ for(let k=i;k<34;k++) if(cnt[k]>0) return false; return true; }
  while(i<34&&cnt[i]===0)i++;
  if(i>=34) return false;
  if(cnt[i]>=3){ cnt[i]-=3; if(mjSets(cnt,i,need-1)){cnt[i]+=3;return true;} cnt[i]+=3; }
  if(i<27&&(i%9)<7&&cnt[i+1]>0&&cnt[i+2]>0){
    cnt[i]--;cnt[i+1]--;cnt[i+2]--;
    if(mjSets(cnt,i,need-1)){cnt[i]++;cnt[i+1]++;cnt[i+2]++;return true;}
    cnt[i]++;cnt[i+1]++;cnt[i+2]++;
  }
  return false;
}
function mjCanWin(cnt,need){
  for(let i=0;i<34;i++) if(cnt[i]>=2){
    cnt[i]-=2;
    const ok=mjSets(cnt,0,need);
    cnt[i]+=2;
    if(ok) return true;
  }
  return false;
}
function canWinAdding(s,tile){
  const st=M.seats[s];
  const cnt=countsOf(st.hand); cnt[tile]++;
  return mjCanWin(cnt,5-st.melds.length);
}
function waitsOf(s){ // tiles that complete the 16-tile hand
  const st=M.seats[s];
  if(st.hand.length!==16-3*st.melds.length) return [];
  const cnt=countsOf(st.hand); const need=5-st.melds.length; const out=[];
  for(let t=0;t<34;t++){ if(cnt[t]>=4) continue; cnt[t]++; if(mjCanWin(cnt,need)) out.push(t); cnt[t]--; }
  return out;
}
function mjDecomps(cnt,need){
  const res=[];
  for(let i=0;i<34;i++) if(cnt[i]>=2){
    cnt[i]-=2;
    (function rec(j,acc){
      let k=j; while(k<34&&cnt[k]===0)k++;
      if(k>=34){ if(acc.length===need) res.push({pair:i,sets:acc.slice()}); return; }
      if(cnt[k]>=3){ cnt[k]-=3; acc.push({t:"pung",v:k}); rec(k,acc); acc.pop(); cnt[k]+=3; }
      if(k<27&&(k%9)<7&&cnt[k+1]>0&&cnt[k+2]>0){
        cnt[k]--;cnt[k+1]--;cnt[k+2]--; acc.push({t:"chow",v:k}); rec(k,acc); acc.pop();
        cnt[k]++;cnt[k+1]++;cnt[k+2]++;
      }
    })(0,[]);
    cnt[i]+=2;
  }
  return res;
}

/* ---------- shanten (bot heuristic) ---------- */
function mjShanten(cnt,need){
  let best=99;
  function rec(i,sets,pair,parts){
    if(sets+parts>need+1) return;
    const cap=Math.min(parts,need-sets);
    const sh=(need-sets)*2 - cap - pair;
    if(sh<best && i>=34) best=sh;
    if(i>=34) return;
    while(i<34&&cnt[i]===0)i++;
    if(i>=34){ const c2=Math.min(parts,need-sets); const s2=(need-sets)*2-c2-pair; if(s2<best)best=s2; return; }
    if(cnt[i]>=3){ cnt[i]-=3; rec(i,sets+1,pair,parts); cnt[i]+=3; }
    if(i<27&&(i%9)<7&&cnt[i+1]>0&&cnt[i+2]>0){ cnt[i]--;cnt[i+1]--;cnt[i+2]--; rec(i,sets+1,pair,parts); cnt[i]++;cnt[i+1]++;cnt[i+2]++; }
    if(cnt[i]>=2){ cnt[i]-=2; rec(i, sets, Math.max(pair,1), parts+(pair?1:0)); cnt[i]+=2; }
    if(i<27&&(i%9)<8&&cnt[i+1]>0){ cnt[i]--;cnt[i+1]--; rec(i,sets,pair,parts+1); cnt[i]++;cnt[i+1]++; }
    if(i<27&&(i%9)<7&&cnt[i+2]>0){ cnt[i]--;cnt[i+2]--; rec(i,sets,pair,parts+1); cnt[i]++;cnt[i+2]++; }
    const c=cnt[i]; cnt[i]=0; rec(i+1,sets,pair,parts); cnt[i]=c;
  }
  rec(0,0,0,0);
  return best;
}

/* ---------- hand flow ---------- */
function mjNewHand(){
  M.seq++; M.claimSeq++;
  M.phase="play"; M.handOver=false; M.winInfo=null; M.drawGame=false; M.pending=null;
  M.discTotal=0; M.claimsHappened=false; M.lastDrawGang=false;
  const deck=[];
  for(let t=0;t<34;t++) for(let k=0;k<4;k++) deck.push(t);
  for(let t=34;t<42;t++) deck.push(t);
  for(let i=deck.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [deck[i],deck[j]]=[deck[j],deck[i]]; }
  M.wall=deck; M.f=0; M.b=deck.length-1;
  M.starter=(M.starter+1)%4;
  M.handCount++;
  M.seats.forEach(st=>{ st.hand=[]; st.melds=[]; st.flowers=[]; st.discards=[]; st.drawn=null; });
  for(let r=0;r<16;r++) for(let k=0;k<4;k++) M.seats[(M.starter+k)%4].hand.push(M.wall[M.f++]);
  for(let k=0;k<4;k++){
    const s=(M.starter+k)%4, st=M.seats[s];
    let again=true;
    while(again){ again=false;
      for(let i=st.hand.length-1;i>=0;i--) if(st.hand[i]>=34){
        st.flowers.push(st.hand[i]); st.hand.splice(i,1); st.hand.push(M.wall[M.b--]); again=true;
      }
    }
    if(st.flowers.length===8) return mjWin(s,null,{baxian:true});
    sortHand(st);
  }
  mjBanner("第"+M.handCount+"局 — "+seatName(M.starter)+" 起家（"+WINDC[0]+"）。");
  broadcast();
  mjLater(900,()=>mjStartTurn(M.starter,false));
}
function mjDrawGame(){
  M.drawGame=true; M.handOver=true; M.winInfo=null; M.pending=null; M.seq++; M.claimSeq++;
  mjBanner("流局 — 牌牆摸完，無人胡牌。");
  broadcast();
  if(MJ_TEST_HOOK) setImmediate(MJ_TEST_HOOK);
}
function mjStartTurn(s,afterGang){
  if(M.handOver) return;
  M.turn=s;
  const st=M.seats[s];
  let t=null;
  while(true){
    if(liveLeft()<=0) return mjDrawGame();
    t=afterGang===true ? M.wall[M.b--] : M.wall[M.f++];
    if(t>=34){
      st.flowers.push(t);
      mjBanner(seatName(s)+" 補花 "+mjTileName(t));
      if(st.flowers.length===8) return mjWin(s,null,{baxian:true});
      afterGang=true; // flower replacement comes from the back
      continue;
    }
    break;
  }
  st.drawn=t;
  M.lastDrawGang=!!afterGang && arguments[1]===true;
  broadcast();
  if(isBotSeat(s)) mjLater(750,()=>botSelfMove(s));
}
function gangDraw(s){
  if(M.handOver) return;
  M.turn=s;
  const st=M.seats[s];
  let t=null;
  while(true){
    if(liveLeft()<=0) return mjDrawGame();
    t=M.wall[M.b--];
    if(t>=34){
      st.flowers.push(t);
      if(st.flowers.length===8) return mjWin(s,null,{baxian:true});
      continue;
    }
    break;
  }
  st.drawn=t;
  M.lastDrawGang=true;
  broadcast();
  if(isBotSeat(s)) mjLater(750,()=>botSelfMove(s));
}
function enterDiscard(s){ // after 吃/碰 — must discard, no draw
  M.turn=s;
  M.seats[s].drawn=null;
  M.lastDrawGang=false;
  broadcast();
  if(isBotSeat(s)) mjLater(700,()=>botDiscard(s));
}
function selfOptions(s){
  const st=M.seats[s];
  if(st.drawn===null) return {win:false,angang:[],jiagang:[]};
  const all=st.hand.concat([st.drawn]);
  const cnt=countsOf(all);
  const win=mjCanWin(cnt,5-st.melds.length);
  const angang=[]; for(let t=0;t<34;t++) if(cnt[t]===4) angang.push(t);
  const jiagang=[];
  st.melds.forEach(m=>{ if(m.t==="pong" && cnt[m.v]>=1) jiagang.push(m.v); });
  return {win,angang,jiagang};
}
function mjDiscard(s,tile){
  const st=M.seats[s];
  if(M.handOver||M.turn!==s||M.pending) return false;
  if(st.drawn===tile){ st.drawn=null; }
  else{
    const i=st.hand.indexOf(tile);
    if(i<0) return false;
    st.hand.splice(i,1);
    if(st.drawn!==null){ st.hand.push(st.drawn); st.drawn=null; }
    sortHand(st);
  }
  st.discards.push(tile);
  M.discTotal++;
  M.lastDrawGang=false;
  mjBanner(seatName(s)+" 打出 "+mjTileName(tile));
  // claim window
  const claims=[];
  for(let k=1;k<4;k++){
    const q=(s+k)%4;
    const o=claimOptions(q,tile,s);
    if(o) claims.push({seat:q,opts:o,resp:null});
  }
  if(!claims.length){ M.pending=null; broadcast(); mjLater(650,()=>mjStartTurn((s+1)%4,false)); return true; }
  M.pending={kind:"discard",tile,from:s,claims};
  claims.forEach(c=>{ if(isBotSeat(c.seat)) c.resp=botClaim(c.seat,c.opts,tile); });
  if(claims.every(c=>c.resp!==null)){ broadcast(); mjLater(500,resolveClaims); return true; }
  M.claimUntil=Date.now()+10000;
  const cs=++M.claimSeq, sq=M.seq;
  setTimeout(()=>mjClaimTimeout(cs,sq), M.claimUntil-Date.now());
  broadcast();
  return true;
}

/* 這個位子現在有沒有人看著？（真人、在線、而且沒交給電腦） */
function mjSeatWatching(q){
  const st=M.seats[q]; if(!st) return false;
  if(st.auto) return false;
  const p=seatP(q);
  return !!p && !p.isAI && !!p.connected;
}
/**
 * 宣告視窗到期時要不要硬幫人家 PASS。
 *
 * CIO 2026-08-23：斷線的人有 5 分鐘可以回來，所以 10 秒的視窗絕對不能替他決定
 * 胡／碰／槓／吃／搶槓 —— 那是會改變輸贏的一手。人不在就把視窗撐著等，
 * 等到他回來、或是有人把那個位子交給電腦為止。
 * 在線上的人與電腦照樣 10 秒到就算 PASS，牌桌不會因為一個人發呆而卡住。
 */
function mjClaimTimeout(cs, sq){
  if(!(M.claimSeq===cs && M.seq===sq && M.pending)) return;
  const away=M.pending.claims.filter(c=>c.resp===null && !mjSeatWatching(c.seat));
  const offline=away.filter(c=>{ const p=seatP(c.seat); return p && !p.isAI && !M.seats[c.seat].auto; });
  if(offline.length){
    // 有人斷線還沒回來 —— 視窗繼續掛著，每 2 秒再看一次
    M.claimUntil=Date.now()+2000;
    setTimeout(()=>mjClaimTimeout(cs,sq), 2000);
    broadcast();
    return;
  }
  M.pending.claims.forEach(c=>{ if(!c.resp) c.resp={t:"pass"}; });
  resolveClaims();
}
function claimOptions(q,tile,from){
  if(tile>=34) return null;
  const st=M.seats[q];
  const cnt=countsOf(st.hand);
  const o={win:false,pong:false,gang:false,chi:[]};
  o.win=canWinAdding(q,tile);
  if(cnt[tile]>=2) o.pong=true;
  if(cnt[tile]>=3) o.gang=true;
  if(q===(from+1)%4 && tile<27){
    const n=tile%9;
    if(n>=2&&cnt[tile-2]>0&&cnt[tile-1]>0) o.chi.push([tile-2,tile-1]);
    if(n>=1&&n<=7&&cnt[tile-1]>0&&cnt[tile+1]>0) o.chi.push([tile-1,tile+1]);
    if(n<=6&&cnt[tile+1]>0&&cnt[tile+2]>0) o.chi.push([tile+1,tile+2]);
  }
  return (o.win||o.pong||o.gang||o.chi.length)? o : null;
}
function mjClaimResp(s,resp){
  if(!M.pending) return false;
  const c=M.pending.claims.find(x=>x.seat===s&&x.resp===null);
  if(!c) return false;
  // validate
  const o=c.opts;
  if(resp.t==="win"&&!o.win) return false;
  if(resp.t==="pong"&&!o.pong) return false;
  if(resp.t==="gang"&&!(o.gang&&M.pending.kind==="discard")) return false;
  if(resp.t==="chi"&&!(o.chi&&o.chi.some(p=>p[0]===resp.a&&p[1]===resp.b))) return false;
  c.resp=resp;
  if(M.pending.claims.every(x=>x.resp!==null)){ M.claimSeq++; resolveClaims(); }
  return true;
}
function resolveClaims(){
  const P=M.pending; if(!P) return;
  M.pending=null;
  const order=P.claims.slice().sort((a,b)=>((a.seat-P.from+4)%4)-((b.seat-P.from+4)%4));
  const w=order.find(c=>c.resp&&c.resp.t==="win");
  if(P.kind==="rob"){
    if(w) return mjWin(w.seat,{tile:P.tile,from:P.from},{rob:true});
    return completeJiagang(P.from,P.tile);
  }
  if(w){ M.claimsHappened=true; return mjWin(w.seat,{tile:P.tile,from:P.from},{}); }
  const pg=order.find(c=>c.resp&&(c.resp.t==="pong"||c.resp.t==="gang"));
  if(pg){
    M.claimsHappened=true;
    const st=M.seats[pg.seat];
    M.seats[P.from].discards.pop();
    const n=pg.resp.t==="gang"?3:2;
    for(let k=0;k<n;k++) st.hand.splice(st.hand.indexOf(P.tile),1);
    st.melds.push({t:pg.resp.t==="gang"?"gang":"pong", v:P.tile, tiles:new Array(n+1).fill(P.tile), from:P.from});
    mjBanner(seatName(pg.seat)+(pg.resp.t==="gang"?" 槓！":" 碰！")+" "+mjTileName(P.tile));
    if(pg.resp.t==="gang") return gangDraw(pg.seat);
    return enterDiscard(pg.seat);
  }
  const ch=order.find(c=>c.resp&&c.resp.t==="chi");
  if(ch){
    M.claimsHappened=true;
    const st=M.seats[ch.seat];
    M.seats[P.from].discards.pop();
    st.hand.splice(st.hand.indexOf(ch.resp.a),1);
    st.hand.splice(st.hand.indexOf(ch.resp.b),1);
    const tiles=[P.tile,ch.resp.a,ch.resp.b].sort((x,y)=>x-y);
    st.melds.push({t:"chi", v:tiles[0], tiles, from:P.from});
    mjBanner(seatName(ch.seat)+" 吃！ "+tiles.map(mjTileName).join(""));
    return enterDiscard(ch.seat);
  }
  mjLater(500,()=>mjStartTurn((P.from+1)%4,false));
}
function doAngang(s,t){
  const st=M.seats[s];
  if(st.drawn!==null){ st.hand.push(st.drawn); st.drawn=null; }
  let c=0;
  for(let i=st.hand.length-1;i>=0&&c<4;i--) if(st.hand[i]===t){ st.hand.splice(i,1); c++; }
  if(c<4) return false;
  st.melds.push({t:"angang", v:t, tiles:[t,t,t,t], from:null});
  mjBanner(seatName(s)+" 暗槓！");
  gangDraw(s);
  return true;
}
function startJiagang(s,t){
  const st=M.seats[s];
  const m=st.melds.find(x=>x.t==="pong"&&x.v===t);
  if(!m) return false;
  if(st.drawn===t) st.drawn=null;
  else{
    const i=st.hand.indexOf(t);
    if(i<0) return false;
    st.hand.splice(i,1);
    if(st.drawn!==null){ st.hand.push(st.drawn); st.drawn=null; sortHand(st); }
  }
  // 搶槓 window
  const claims=[];
  for(let k=1;k<4;k++){
    const q=(s+k)%4;
    if(canWinAdding(q,t)) claims.push({seat:q,opts:{win:true,pong:false,gang:false,chi:[]},resp:null});
  }
  if(!claims.length) return completeJiagang(s,t);
  M.pending={kind:"rob",tile:t,from:s,claims};
  claims.forEach(c=>{ if(isBotSeat(c.seat)) c.resp={t:"win"}; }); // bots always rob
  if(claims.every(c=>c.resp!==null)){ resolveClaims(); return true; }
  M.claimUntil=Date.now()+10000;
  const cs=++M.claimSeq, sq=M.seq;
  setTimeout(()=>mjClaimTimeout(cs,sq), M.claimUntil-Date.now());
  broadcast();
  return true;
}
function completeJiagang(s,t){
  const st=M.seats[s];
  const m=st.melds.find(x=>x.t==="pong"&&x.v===t);
  if(m){ m.t="jiagang"; m.tiles=[t,t,t,t]; }
  mjBanner(seatName(s)+" 加槓 "+mjTileName(t));
  gangDraw(s);
}

/* ---------- tai (台) scoring ---------- */
function mjTai(s,winTile,selfDrawn,flags){
  const st=M.seats[s];
  if(flags.baxian) return {list:[["八仙過海（八花）",16]],tai:16};
  const hand16=st.hand.slice();
  const final17=hand16.concat([winTile]);
  const cnt17=countsOf(final17);
  const cnt16=countsOf(hand16);
  const need=5-st.melds.length;
  const decomps=mjDecomps(cnt17,need);
  const waits=waitsOf(s);
  const angangs=st.melds.filter(m=>m.t==="angang").length;
  const meldPungVals=st.melds.filter(m=>m.t!=="chi").map(m=>m.v);
  const allTiles=final17.concat([].concat.apply([],st.melds.map(m=>m.tiles)));
  const suits=new Set(), hasHonor=allTiles.some(t=>t>=27), hasSuit=allTiles.some(t=>t<27);
  allTiles.forEach(t=>{ if(t<27) suits.add(Math.floor(t/9)); });
  const swTile=27+seatWind(s);

  function listFor(d){ // d may be null (八仙 excluded already; decomps always exist for a real win)
    const L=[];
    const pungs=d.sets.filter(x=>x.t==="pung").map(x=>x.v).concat(meldPungVals);
    const chowsOnly=d.sets.every(x=>x.t==="chow") && st.melds.every(m=>m.t==="chi");
    const pungsOnly=d.sets.every(x=>x.t==="pung") && st.melds.every(m=>m.t!=="chi");
    // concealed pungs
    let anke=angangs;
    d.sets.forEach(x=>{ if(x.t==="pung"){
      const usedWin=(!selfDrawn && x.v===winTile && cnt16[winTile]===2);
      if(!usedWin) anke++;
    }});
    if(M.discTotal===0 && selfDrawn && s===M.starter) L.push(["天胡",24]);
    else if(!selfDrawn && M.discTotal===1 && !M.claimsHappened) L.push(["地胡",16]);
    if(selfDrawn) L.push(["自摸",1]);
    const menqing=st.melds.every(m=>m.t==="angang");
    if(menqing) L.push(["門清",1]);
    if(menqing&&selfDrawn) L.push(["門清自摸",1]);
    if(st.melds.length===5&&!selfDrawn) L.push(["全求人",2]);
    if(chowsOnly && d.pair<27 && st.flowers.length===0 && waits.length>=2) L.push(["平胡",2]);
    if(pungsOnly) L.push(["碰碰胡",4]);
    if(anke>=5) L.push(["五暗刻",8]);
    else if(anke===4) L.push(["四暗刻",5]);
    else if(anke===3) L.push(["三暗刻",2]);
    // colors
    if(!hasHonor && suits.size===1) L.push(["清一色",8]);
    else if(hasHonor && suits.size===1) L.push(["混一色",4]);
    else if(!hasSuit) L.push(["字一色",16]);
    // dragons
    const dr=pungs.filter(v=>v>=31).length;
    if(dr===3) L.push(["大三元",8]);
    else if(dr===2 && d.pair>=31) L.push(["小三元",4]);
    else if(dr>0) pungs.forEach(v=>{ if(v>=31) L.push([mjTileName(v)+"刻",1]); });
    // winds — 家規：見風見台（任何風刻都算 1 台，不必對位）
    const windPungs=pungs.filter(v=>v>=27&&v<31);
    const wd=windPungs.length;
    if(wd===4) L.push(["大四喜",16]);
    else if(wd===3 && d.pair>=27&&d.pair<31) L.push(["小四喜",8]);
    else windPungs.forEach(v=>L.push(["風牌"+WINDC[v-27]+"刻",1]));
    if(st.flowers.length>0) L.push(["花牌×"+st.flowers.length,st.flowers.length]);
    if(selfDrawn&&liveLeft()===0) L.push(["海底撈月",1]);
    if(!selfDrawn&&liveLeft()===0&&!flags.rob) L.push(["河底撈魚",1]);
    if(selfDrawn&&M.lastDrawGang) L.push(["槓上開花",1]);
    if(flags.rob) L.push(["搶槓",1]);
    if(waits.length===1) L.push(["獨聽",1]);
    return L;
  }
  let best={list:[],tai:0};
  decomps.forEach(d=>{
    const L=listFor(d);
    const tot=L.reduce((a,x)=>a+x[1],0);
    if(tot>=best.tai) best={list:L,tai:tot};
  });
  if(!decomps.length) best={list:[["胡牌",0]],tai:0};
  if(!best.list.length) best.list=[["無台（屁胡）",0]];
  return best;
}

function mjWin(s,src,flags){
  const st=M.seats[s];
  const selfDrawn=!src;
  const winTile=flags.baxian? null : (selfDrawn? st.drawn : src.tile);
  if(selfDrawn&&!flags.baxian) st.drawn=null;
  if(!selfDrawn&&!flags.rob&&!flags.baxian) M.seats[src.from].discards.pop(); // 胡的牌歸贏家
  const r=mjTai(s,winTile,selfDrawn,flags);
  const total=M.base + r.tai*M.taiVal;
  const pays=[];
  if(selfDrawn||flags.baxian){
    for(let k=0;k<4;k++) if(k!==s){ seatP(k).mjScore-=total; pays.push(seatName(k)); }
    seatP(s).mjScore+=total*3;
  }else{
    seatP(src.from).mjScore-=total;
    seatP(s).mjScore+=total;
    pays.push(seatName(src.from));
  }
  M.winInfo={
    seat:s, name:seatName(s), taiList:r.list, tai:r.tai, total,
    selfDrawn:selfDrawn||!!flags.baxian, rob:!!flags.rob, baxian:!!flags.baxian,
    winTile, payer:(selfDrawn||flags.baxian)?null:seatName(src.from),
    tiles:st.hand.slice().sort((a,b)=>a-b).concat(winTile!==null?[winTile]:[]),
    melds:st.melds, flowers:st.flowers
  };
  M.handOver=true; M.pending=null; M.seq++; M.claimSeq++;
  mjBanner(seatName(s)+(flags.baxian?" 八仙過海！":(selfDrawn?" 自摸！":" 胡！"))+" "+r.tai+"台，"
    +((selfDrawn||flags.baxian)?"三家各付 ":"由 "+seatName(src.from)+" 付 ")+total+"點。");
  broadcast();
  if(MJ_TEST_HOOK) setImmediate(MJ_TEST_HOOK);
}

/* ---------- bots ---------- */
function botSelfMove(s){
  if(M.handOver||M.turn!==s) return;
  const st=M.seats[s];
  const o=selfOptions(s);
  if(o.win) return mjWin(s,null,{});
  const need=5-st.melds.length;
  const cur=mjShanten(countsOf(st.hand.concat(st.drawn!==null?[st.drawn]:[])),need);
  for(const t of o.angang){
    const rest=st.hand.concat(st.drawn!==null?[st.drawn]:[]).filter(x=>x!==t);
    if(mjShanten(countsOf(rest),need-1)<=cur) return doAngang(s,t);
  }
  for(const t of o.jiagang){
    return startJiagang(s,t);
  }
  botDiscard(s);
}
function botDiscard(s){
  if(M.handOver||M.turn!==s) return;
  const st=M.seats[s];
  const all=st.hand.concat(st.drawn!==null?[st.drawn]:[]);
  const need=5-st.melds.length;
  const uniq=[...new Set(all)];
  let best=null,bestScore=1e9;
  uniq.forEach(t=>{
    const rest=all.slice(); rest.splice(rest.indexOf(t),1);
    const sh=mjShanten(countsOf(rest),need);
    let iso=0;
    if(t>=27) iso=-(3-Math.min(3,countsOf(all)[t]))*0.3;
    else{ const n=t%9; if(n===0||n===8) iso=-0.15;
      const c=countsOf(all);
      let nb=0; if(t%9>0)nb+=c[t-1]; if(t%9<8)nb+=c[t+1]; if(t%9>1)nb+=c[t-2]; if(t%9<7)nb+=c[t+2];
      iso+= nb*0.1; }
    const score=sh*10+iso+Math.random()*0.05;
    if(score<bestScore){ bestScore=score; best=t; }
  });
  mjDiscard(s,best);
}
function botClaim(s,o,tile){
  if(o.win) return {t:"win"};
  const st=M.seats[s];
  const need=5-st.melds.length;
  const cur=mjShanten(countsOf(st.hand),need);
  if(o.gang){
    const rest=st.hand.filter(x=>x!==tile);
    if(mjShanten(countsOf(rest),need-1)<=cur) return {t:"gang"};
  }
  if(o.pong){
    const rest=st.hand.slice();
    rest.splice(rest.indexOf(tile),1); rest.splice(rest.indexOf(tile),1);
    if(mjShanten(countsOf(rest),need-1)<cur) return {t:"pong"};
  }
  if(o.chi.length){
    for(const pr of o.chi){
      const rest=st.hand.slice();
      rest.splice(rest.indexOf(pr[0]),1); rest.splice(rest.indexOf(pr[1]),1);
      if(mjShanten(countsOf(rest),need-1)<cur && Math.random()<0.8) return {t:"chi",a:pr[0],b:pr[1]};
    }
  }
  return {t:"pass"};
}
function mjResumeAuto(s){
  if(M.pending){
    const c=M.pending.claims.find(x=>x.seat===s&&x.resp===null);
    if(c){ c.resp=botClaim(s,c.opts,M.pending.tile);
      if(M.pending.claims.every(x=>x.resp!==null)){ M.claimSeq++; resolveClaims(); } return; }
  }
  if(M.turn===s&&!M.handOver){
    if(M.seats[s].drawn!==null) botSelfMove(s); else botDiscard(s);
  }
}


/* ---------- 教練：把手牌拆成 順子／刻子／對子／搭子 ----------
   §K 只看這一家自己的牌，回傳的也只有他自己的牌。跟真人請旁邊的人幫忙理牌一樣。   */
function mjGroupPlan(hand){
  const tiles=hand.filter(t=>t<34);
  const cnt=countsOf(tiles);
  let best=null, bestScore=-1, nodes=0;
  const cur=[];
  const SCORE={chow:100,pung:100,pair:26,part:12};
  function total(){ let v=0; for(const g of cur) v+=SCORE[g.k]; return v; }
  function rec(i){
    if(++nodes>200000) return;
    while(i<34&&cnt[i]===0) i++;
    if(i>=34){ const v=total(); if(v>bestScore){ bestScore=v; best=cur.map(g=>({k:g.k,tiles:g.tiles.slice()})); } return; }
    if(cnt[i]>=3){ cnt[i]-=3; cur.push({k:"pung",tiles:[i,i,i]}); rec(i); cur.pop(); cnt[i]+=3; }
    if(i<27&&(i%9)<7&&cnt[i+1]>0&&cnt[i+2]>0){
      cnt[i]--;cnt[i+1]--;cnt[i+2]--; cur.push({k:"chow",tiles:[i,i+1,i+2]}); rec(i); cur.pop();
      cnt[i]++;cnt[i+1]++;cnt[i+2]++; }
    if(cnt[i]>=2){ cnt[i]-=2; cur.push({k:"pair",tiles:[i,i]}); rec(i); cur.pop(); cnt[i]+=2; }
    if(i<27&&(i%9)<8&&cnt[i+1]>0){ cnt[i]--;cnt[i+1]--; cur.push({k:"part",tiles:[i,i+1]}); rec(i); cur.pop(); cnt[i]++;cnt[i+1]++; }
    if(i<27&&(i%9)<7&&cnt[i+2]>0){ cnt[i]--;cnt[i+2]--; cur.push({k:"part",tiles:[i,i+2]}); rec(i); cur.pop(); cnt[i]++;cnt[i+2]++; }
    cnt[i]--; rec(i); cnt[i]++;                     // \u9019\u4e00\u5f35\u5148\u653e\u8457\u7576\u5b64\u5f35
  }
  rec(0);
  const groups=(best||[]).filter(g=>g.k!=="part"||true)
    .sort((a,b)=> b.tiles.length-a.tiles.length || a.tiles[0]-b.tiles[0]);
  return groups;
}
/* ---------- mahjong state for clients ---------- */
function mjPublicState(){
  return {
    phase:M.phase, banner:M.banner, log:M.log, handOver:M.handOver, drawGame:M.drawGame,
    base:M.base, taiVal:M.taiVal, left:liveLeft(), turn:M.turn, starter:M.starter,
    pace:G.pace, handCount:M.handCount, claimUntil:M.pending?M.claimUntil:0,
    pendingTile:M.pending?{tile:M.pending.tile,from:M.pending.from,kind:M.pending.kind}:null,
    winInfo:M.winInfo,
    roster:rosterOf(),
    seats:M.seats.map((st,s)=>{
      const p=seatP(s)||{};
      return { name:p.name||"?", avatar:p.avatar||null, isAI:!!p.isAI, auto:!!st.auto,
        connected:p.isAI?true:!!p.connected, score:p.mjScore||0, wind:WINDC[seatWind(s)],
        nHand:st.hand.length+(st.drawn!==null?1:0),
        melds:st.melds, flowers:st.flowers, discards:st.discards,
        hand:M.handOver? st.hand.slice().sort((a,b)=>a-b).concat(st.drawn!==null?[st.drawn]:[]) : null };
    }),
    spectators:G.players.filter(p=>!p.isAI&&!M.seats.some(st=>st.pi===G.players.indexOf(p))).map(p=>p.name)
  };
}
function mjPrivateFor(token){
  const pi=G.players.findIndex(p=>p.token===token);
  if(pi<0) return null;
  const s=M.seats.findIndex(st=>st.pi===pi);
  if(s<0) return {spectator:true};
  const st=M.seats[s];
  const myTurn = M.phase==="play" && !M.handOver && M.turn===s && !M.pending;
  const o = myTurn? selfOptions(s) : null;
  let claim=null;
  if(M.pending){
    const c=M.pending.claims.find(x=>x.seat===s&&x.resp===null);
    if(c) claim={tile:M.pending.tile, kind:M.pending.kind, win:c.opts.win, pong:c.opts.pong,
      gang:c.opts.gang&&M.pending.kind==="discard", chi:c.opts.chi, until:M.claimUntil};
  }
  return {
    seat:s, wind:WINDC[seatWind(s)], hand:st.hand, drawn:st.drawn,
    myTurn, mustDiscard:myTurn&&st.drawn===null,
    canWin:o?o.win:false, angang:o?o.angang:[], jiagang:o?o.jiagang:[],
    claim, waits:(M.phase==="play"&&!M.handOver)?waitsOf(s):[],
    melds:st.melds, flowers:st.flowers, score:seatP(s).mjScore||0
  };
}

/* ================= BRIDGE ENGINE — 橋牌 · Contract Bridge (Rubber) =================
   Full Laws of Duplicate/Rubber Contract Bridge — no house changes.
   Auction: legal-call enforcement, double / redouble, 3-pass end, pass-out.
   Play:    13 tricks, follow-suit compulsory, trump / NT trick resolution.
            盧家桌規：每個人打自己的牌，牌不攤開 —— 沒有明手。
            莊家只出自己那手，同伴自己出自己的，四家的牌全程不公開。
            人不在的時候才由電腦代打。（這一條偏離 Laws of Bridge 的明手規則，
            叫牌與計分則完全照規則走。）
   Score:   rubber bridge — below/above the line, vulnerability from games won,
            doubled & redoubled penalties, insult, slam bonus, honours,
            700/500 rubber bonus, 300/100 unfinished-rubber bonus.
   Bots:    SAYC bidding (5-card majors, 15-17 NT, Stayman, Jacoby transfers,
            weak twos, preempts, takeout doubles, negative doubles, Blackwood)
            + Monte-Carlo double-dummy card play with constrained hand sampling.
   ================================================================================ */
const BR_BOT_NAMES=["電腦 Ada","電腦 Ben","電腦 Cleo","電腦 Dex"];
const BSUIT=["♠","♥","♦","♣"];                 // suit index 0..3, high -> low
const BSTRAIN=["♣","♦","♥","♠","NT"];          // strain 0..4, low -> high
const ST2SU=[3,2,1,0];                          // strain -> suit index
const SU2ST=[3,2,1,0];                          // suit index -> strain
const BSEAT=["北 North","東 East","南 South","西 West"];
const BSEATS=["N","E","S","W"];
const HCPV=[0,0,0,0,0,0,0,0,0,1,2,3,4];         // rank index 0(=2)..12(=A)

let BR = {
  phase:"idle",            // idle | play
  stage:"auction",         // auction | play | over
  seats:[],                // {pi, hand:[cardId], auto:false, voids:[b,b,b,b], hcpLo, hcpHi}
  dealer:0, board:0,
  vuln:[false,false],      // [NS, EW]
  auction:[],              // {seat,t:'P'|'X'|'XX'|'B',lvl,str}
  contract:null,           // {lvl,str,dbl,declarer}
  declarer:-1, dummy:-1,
  turn:0, leader:0, trick:[], playedBy:[[],[],[],[]],
  tricks:[0,0],            // tricks won [NS,EW]
  trickHist:[],            // {cards:[{seat,card}], win}
  lastTrick:null,
  dummyShown:false, handOver:false, result:null,
  rub:{ games:[0,0], below:[0,0], above:[0,0], total:[0,0], rubbers:[0,0], hist:[] },
  banner:"", log:[], seq:0, thinking:false
};

/* ---------- cards ---------- */
const cSuit=c=>(c/13)|0, cRank=c=>c%13;
function cObj(c){ return {s:cSuit(c), r:cRank(c)+2}; }
function cStr(c){ return BSUIT[cSuit(c)]+(["2","3","4","5","6","7","8","9","10","J","Q","K","A"][cRank(c)]); }
function brBanner(t){ BR.banner=t; BR.log.unshift(t); BR.log=BR.log.slice(0,7); }
function brLater(ms,fn){ const s=BR.seq;
  setTimeout(()=>{ if(BR.seq===s && G.game==="bridge" && BR.phase==="play") fn(); }, Math.round(ms*G.pace)); }
function brSeatP(s){ return G.players[BR.seats[s].pi]; }
function brName(s){ const p=brSeatP(s); return p? p.name : BSEAT[s]; }
function brSide(s){ return s%2; }               // 0 = N/S, 1 = E/W
function brIsBot(s){ const p=brSeatP(s); return !p || p.isAI || BR.seats[s].auto; }
function brSortHand(h){ h.sort((a,b)=> cSuit(a)-cSuit(b) || cRank(b)-cRank(a) ); }
function brHcp(h){ let n=0; h.forEach(c=>n+=HCPV[cRank(c)]); return n; }
function brShape(h){ const l=[0,0,0,0]; h.forEach(c=>l[cSuit(c)]++); return l; }
function brSuitCards(h,s){ return h.filter(c=>cSuit(c)===s).sort((a,b)=>cRank(b)-cRank(a)); }
function brBalanced(l){ const d=[...l].sort((a,b)=>b-a); return (d[0]<=5&&d[3]>=2&&!(d[0]===5&&d[1]===4&&d[3]===2&&false)) &&
  (d.join("")==="4333"||d.join("")==="4432"||d.join("")==="5332"); }

/* ---------- deal ---------- */
function brNewDeal(){
  BR.seq++;
  BR.board++;
  BR.dealer = BR.board===1 ? 0 : (BR.dealer+1)%4;
  const deck=[]; for(let c=0;c<52;c++) deck.push(c);
  for(let i=51;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [deck[i],deck[j]]=[deck[j],deck[i]]; }
  BR.seats.forEach((st,s)=>{ st.hand=deck.slice(s*13,s*13+13); brSortHand(st.hand);
    st.voids=[false,false,false,false]; });
  BR.vuln=[BR.rub.games[0]>=1, BR.rub.games[1]>=1];
  BR.stage="auction"; BR.auction=[]; BR.contract=null; BR.declarer=-1; BR.dummy=-1;
  BR.turn=BR.dealer; BR.leader=-1; BR.trick=[]; BR.playedBy=[[],[],[],[]];
  BR.tricks=[0,0]; BR.trickHist=[]; BR.lastTrick=null; BR.dummyShown=false;   // 永遠 false：沒有明手
  BR.handOver=false; BR.result=null; BR.phase="play";
  brBanner("第 "+BR.board+" 副 · 發牌者 "+brName(BR.dealer)+" 開叫｜Board "+BR.board+" — "+BSEATS[BR.dealer]+" deals");
  broadcast();
  brStep();
}

/* ---------- auction ---------- */
function brBidVal(b){ return b.lvl*5+b.str; }
function brLastBid(){ for(let i=BR.auction.length-1;i>=0;i--) if(BR.auction[i].t==="B") return BR.auction[i]; return null; }
function brLastNonPass(){ for(let i=BR.auction.length-1;i>=0;i--) if(BR.auction[i].t!=="P") return BR.auction[i]; return null; }
function brDblState(){ const n=brLastNonPass(); if(!n) return 0; if(n.t==="XX") return 2; if(n.t==="X") return 1; return 0; }
function brCanCall(seat,call){
  if(BR.stage!=="auction") return false;
  if(call.t==="P") return true;
  const lb=brLastBid(), ln=brLastNonPass();
  if(call.t==="B") return !lb || brBidVal(call)>brBidVal(lb);
  if(call.t==="X") return !!ln && ln.t==="B" && (ln.seat%2)!==(seat%2);
  if(call.t==="XX") return !!ln && ln.t==="X" && (ln.seat%2)!==(seat%2);
  return false;
}
function brLegalCalls(seat){
  const out={pass:true,dbl:brCanCall(seat,{t:"X"}),rdbl:brCanCall(seat,{t:"XX"}),bids:[]};
  const lb=brLastBid(); const floor=lb? brBidVal(lb) : 0;
  for(let l=1;l<=7;l++) for(let st=0;st<5;st++) if(l*5+st>floor) out.bids.push(l*5+st);
  return out;
}
function brCall(seat,call){
  if(!brCanCall(seat,call)) return false;
  call={t:call.t,lvl:call.lvl,str:call.str,seat:seat};   // never share the PASS/DBL singletons
  BR.auction.push(call);
  brBanner(BSEATS[seat]+" "+brCallStr(call));
  const n=BR.auction.length;
  const bids=BR.auction.filter(c=>c.t!=="P").length;
  if(n>=4 && BR.auction.slice(-3).every(c=>c.t==="P") && bids>0){ brAuctionEnd(); return true; }
  if(n===4 && bids===0){ brBanner("四家全 Pass — 重新發牌｜Passed out — redeal");
    BR.handOver=true; BR.stage="over"; BR.result={passedOut:true}; broadcast(); return true; }
  BR.turn=(seat+1)%4; broadcast(); brStep(); return true;
}
function brCallStr(c){ return c.t==="P"?"Pass":c.t==="X"?"X (Double)":c.t==="XX"?"XX (Redouble)":(c.lvl+BSTRAIN[c.str]); }
function brAuctionEnd(){
  const lb=brLastBid(); const dbl=brDblState();
  const side=lb.seat%2;
  let dec=-1;
  for(const c of BR.auction) if(c.t==="B" && (c.seat%2)===side && c.str===lb.str){ dec=c.seat; break; }
  BR.contract={lvl:lb.lvl,str:lb.str,dbl,declarer:dec};
  BR.declarer=dec; BR.dummy=(dec+2)%4;
  BR.stage="play"; BR.leader=(dec+1)%4; BR.turn=BR.leader; BR.trick=[];
  brBanner("定約 "+brContractShort()+" · 莊家 "+brName(dec)+"（"+BSEATS[dec]+"）· "+BSEATS[BR.leader]+" 首攻 · 四家各打各的牌，不攤明手"
    +"｜Contract "+brContractShort()+" by "+BSEATS[dec]+", "+BSEATS[BR.leader]+" leads");
  broadcast(); brStep();
}
function brContractShort(){ const c=BR.contract; if(!c) return "—";
  return c.lvl+BSTRAIN[c.str]+(c.dbl===1?" X":c.dbl===2?" XX":""); }
function brContractStr(){ const c=BR.contract; if(!c) return "—";
  return brContractShort()+" by "+BSEATS[c.declarer]; }

/* ---------- play ---------- */
function brLegalCards(seat){
  const h=BR.seats[seat].hand;
  if(BR.trick.length===0) return h.slice();
  const led=cSuit(BR.trick[0].card);
  const f=h.filter(c=>cSuit(c)===led);
  return f.length? f : h.slice();
}
function brTrickWinner(cards,trumpSuit){
  const led=cSuit(cards[0].card); let best=cards[0];
  for(const x of cards.slice(1)){
    const bs=cSuit(best.card), xs=cSuit(x.card);
    if(trumpSuit>=0 && xs===trumpSuit && bs!==trumpSuit) best=x;
    else if(xs===bs && cRank(x.card)>cRank(best.card)) best=x;
  }
  return best.seat;
}
function brTrumpSuit(){ const c=BR.contract; return c.str===4? -1 : ST2SU[c.str]; }
function brPlay(seat,card){
  if(BR.stage!=="play"||BR.handOver) return false;
  if(BR.turn!==seat) return false;
  const legal=brLegalCards(seat);
  if(!legal.includes(card)) return false;
  const st=BR.seats[seat];
  // void inference for the bots' sampler
  if(BR.trick.length){ const led=cSuit(BR.trick[0].card); if(cSuit(card)!==led) st.voids[led]=true; }
  st.hand=st.hand.filter(c=>c!==card);
  BR.playedBy[seat].push(card);
  BR.trick.push({seat,card});
  if(BR.trick.length===4){
    const w=brTrickWinner(BR.trick,brTrumpSuit());
    BR.tricks[w%2]++;
    BR.trickHist.push({cards:BR.trick.slice(),win:w});
    BR.lastTrick={cards:BR.trick.slice(),win:w};
    BR.trick=[]; BR.leader=w; BR.turn=w;
    brBanner("第 "+BR.trickHist.length+" 墩 "+BSEATS[w]+" 贏｜Trick "+BR.trickHist.length+" to "+BSEATS[w]
      +"  (NS "+BR.tricks[0]+" – EW "+BR.tricks[1]+")");
    broadcast();
    if(BR.trickHist.length===13){ brLater(700,brFinishHand); return true; }
    brLater(750,brStep); return true;
  }
  BR.turn=(seat+1)%4; broadcast(); brStep(); return true;
}
/* 盧家桌規：每個人只出自己的牌 —— 沒有人幫別人出 */
function brController(seat){ return seat; }
function brStep(){
  if(BR.handOver||BR.phase!=="play") return;
  const s=BR.turn;
  if(BR.stage==="auction"){
    if(brIsBot(s)) brLater(900,()=>{ if(BR.turn===s&&BR.stage==="auction") brCall(s,brAIBid(s)); });
    return;
  }
  if(BR.stage!=="play") return;
  const ctrl=brController(s);
  if(brIsBot(ctrl)) brLater(BR.trick.length===0?600:450,()=>{ if(BR.turn===s&&BR.stage==="play"&&!BR.handOver){
    const c=brAIPlay(s); if(c!==undefined&&c!==null) brPlay(s,c); }});
}
function brResumeAuto(s){ if(BR.stage==="auction"){ if(BR.turn===s) brStep(); }
  else if(BR.stage==="play"){ if(brController(BR.turn)===s) brStep(); } }

/* 沒有明手可以攤，所以也沒有「攤牌宣告」這回事 —— 十三墩老老實實打完。 */
function brClaim(){ return {error:"這桌沒有明手，不能攤牌 — 打完十三墩｜No dummy at this table, so there is nothing to claim."}; }

/* ---------- scoring: RUBBER BRIDGE ---------- */
function brHonours(){
  const c=BR.contract; const out=[];
  const side=brSide(c.declarer);
  for(let s=0;s<4;s++){
    const orig=BR.seats[s].hand.concat(BR.playedBy[s]);
    if(c.str===4){
      const aces=orig.filter(x=>cRank(x)===12).length;
      if(aces===4) out.push({seat:s,pts:150,txt:"四張 A（無王）· 4 aces at NT"});
    } else {
      const t=ST2SU[c.str];
      const hon=orig.filter(x=>cSuit(x)===t&&cRank(x)>=8).length;   // 10,J,Q,K,A
      if(hon===5) out.push({seat:s,pts:150,txt:"五張大牌 A K Q J 10 · 5 trump honours"});
      else if(hon===4) out.push({seat:s,pts:100,txt:"四張大牌 · 4 trump honours"});
    }
  }
  return out;
}
function brScoreHand(){
  const c=BR.contract, side=brSide(c.declarer), opp=1-side;
  const vul=BR.vuln[side];
  const won=BR.tricks[side], need=c.lvl+6, res=won-need;
  const mult=c.dbl===1?2:c.dbl===2?4:1;
  const per=(c.str<=1)?20:(c.str<=3)?30:30;
  let below=0, aboveDec=0, aboveOpp=0, lines=[];
  if(res>=0){
    below=(c.str===4 ? 40+30*(c.lvl-1) : per*c.lvl)*mult;
    lines.push({k:"合約墩分 Contract tricks",v:below,side});
    if(res>0){
      let ot;
      if(c.dbl===0) ot=res*(c.str===4?30:per);
      else ot=res*(vul?200:100)*(c.dbl===2?2:1);
      aboveDec+=ot; lines.push({k:"超墩 Overtricks ×"+res,v:ot,side});
    }
    if(c.dbl>0){ const ins=c.dbl===1?50:100; aboveDec+=ins; lines.push({k:"加倍成約獎 Insult",v:ins,side}); }
    if(c.lvl===6){ const b=vul?750:500; aboveDec+=b; lines.push({k:"小滿貫 Small slam",v:b,side}); }
    if(c.lvl===7){ const b=vul?1500:1000; aboveDec+=b; lines.push({k:"大滿貫 Grand slam",v:b,side}); }
  } else {
    const n=-res; let pen;
    if(c.dbl===0) pen=n*(vul?100:50);
    else { pen = vul ? 200+300*(n-1)
                     : 100 + (n>=2?200:0) + (n>=3?200:0) + Math.max(0,n-3)*300;
           if(c.dbl===2) pen*=2; }
    aboveOpp+=pen; lines.push({k:"罰分 Down "+n,v:pen,side:opp});
  }
  brHonours().forEach(h=>{ const hs=brSide(h.seat);
    if(hs===side) aboveDec+=h.pts; else aboveOpp+=h.pts;
    lines.push({k:"榮牌 Honours ("+BSEATS[h.seat]+") "+h.txt,v:h.pts,side:hs}); });

  const R=BR.rub;
  R.above[side]+=aboveDec; R.above[opp]+=aboveOpp;
  R.total[side]+=aboveDec; R.total[opp]+=aboveOpp;
  let gameWon=null, rubberWon=null, rubBonus=0;
  if(below>0){
    R.below[side]+=below; R.total[side]+=below;
    if(R.below[side]>=100){
      gameWon=side; R.games[side]++; R.below=[0,0];
      if(R.games[side]===2){
        rubberWon=side; rubBonus = R.games[opp]===0?700:500;
        R.above[side]+=rubBonus; R.total[side]+=rubBonus; R.rubbers[side]++;
      }
    }
  }
  BR.result={ made:res>=0, res, need, won, lines, below, aboveDec, aboveOpp,
              gameWon, rubberWon, rubBonus, contract:brContractStr(), declarer:c.declarer };
  R.hist.unshift({board:BR.board, contract:brContractStr(), res, ns:R.total[0], ew:R.total[1]});
  R.hist=R.hist.slice(0,12);
  if(rubberWon!==null){ R.games=[0,0]; R.below=[0,0]; }
  // scoreboard on the player objects
  BR.seats.forEach((st,s)=>{ const p=brSeatP(s); if(p) p.brScore=R.total[brSide(s)]; });
}
/* Law 61 — unfinished rubber: 300 for a game won, 100 for a part-score in the unfinished game */
function brEndRubber(){
  const R=BR.rub; const lines=[];
  for(let sd=0;sd<2;sd++){
    if(R.games[sd]===1){ R.above[sd]+=300; R.total[sd]+=300; lines.push({k:"未完成局盤 · 已得一盤 Unfinished rubber (game)",v:300,side:sd}); }
    if(R.below[sd]>0){ R.above[sd]+=100; R.total[sd]+=100; lines.push({k:"未完成局盤 · 部分分 Part-score",v:100,side:sd}); }
  }
  R.games=[0,0]; R.below=[0,0];
  BR.vuln=[false,false];
  const w = R.total[0]===R.total[1] ? -1 : (R.total[0]>R.total[1]?0:1);
  brBanner("局盤結算：N/S "+R.total[0]+" — E/W "+R.total[1]
    +(w<0?"　平手 tie":"　★ "+(w===0?"N/S":"E/W")+" 領先")+"｜Rubber closed out.");
  BR.result=Object.assign({},BR.result||{},{endRubber:lines});
  broadcast();
  return lines;
}
function brFinishHand(){
  if(BR.handOver) return;
  if(BR.contract) brScoreHand();
  BR.handOver=true; BR.stage="over";
  const r=BR.result;
  if(r&&BR.contract) brBanner(brContractStr()+(r.made?(r.res===0?" 剛好成約 made exactly":" 成約 +"+r.res):" 倒 "+(-r.res)+" 墩 down "+(-r.res))
    +(r.rubberWon!==null?"　★ "+(r.rubberWon===0?"N/S":"E/W")+" 贏得一局盤 RUBBER!":(r.gameWon!==null?"　★ "+(r.gameWon===0?"N/S":"E/W")+" 拿下一盤 GAME":"")));
  broadcast();
}

/* ================= BOT BIDDING — SAYC ================= */
function brSupportPts(h,trump,asDummy){
  const l=brShape(h); let p=brHcp(h);
  if(asDummy){ [0,1,2,3].forEach(s=>{ if(s===trump) return;
    if(l[s]===0) p+=5; else if(l[s]===1) p+=3; else if(l[s]===2) p+=1; }); }
  else { [0,1,2,3].forEach(s=>{ if(l[s]>=5) p+=l[s]-4; }); }
  return p;
}
function brQuickTricks(h,s){ const c=brSuitCards(h,s).map(cRank);
  let q=0; const has=r=>c.includes(r);
  if(has(12)&&has(11)) q=2; else if(has(12)&&has(10)) q=1.5; else if(has(12)) q=1;
  else if(has(11)&&has(10)) q=1; else if(has(11)&&c.length>=2) q=0.5;
  return q; }
function brSuitQual(h,s){ const c=brSuitCards(h,s).map(cRank);
  return c.length + c.filter(r=>r>=10).length + (c.filter(r=>r>=8).length>=2?1:0); }
function brLongest(l,onlyMajor){ let best=-1,bl=0;
  for(let s=0;s<4;s++){ if(onlyMajor&&s>1) continue; if(l[s]>bl||(l[s]===bl&&s<best)){ bl=l[s]; best=s; } }
  return best; }
function brBid(l,st){ return {t:"B",lvl:l,str:st}; }
const PASS={t:"P"}, DBL={t:"X"}, RDBL={t:"XX"};

function brCtx(seat){
  const a=BR.auction;
  const mine=a.filter(c=>c.seat===seat), pard=a.filter(c=>c.seat===(seat+2)%4);
  const lho=a.filter(c=>c.seat===(seat+1)%4), rho=a.filter(c=>c.seat===(seat+3)%4);
  const bids=a.filter(c=>c.t==="B");
  const first=bids.length? bids[0] : null;
  return { a, mine, pard, lho, rho, bids, first,
    lastBid:brLastBid(), lastNP:brLastNonPass(),
    weOpened: !!first && (first.seat%2)===(seat%2),
    iOpened: !!first && first.seat===seat,
    pardOpened: !!first && first.seat===(seat+2)%4,
    oppOpened: !!first && (first.seat%2)!==(seat%2),
    myBids: mine.filter(c=>c.t==="B"), pardBids: pard.filter(c=>c.t==="B"),
    oppBid: bids.some(c=>(c.seat%2)!==(seat%2)),
    pardDbl: pard.some(c=>c.t==="X"),
    rhoBid: rho.length? rho[rho.length-1] : null,
    lhoBid: lho.length? lho[lho.length-1] : null };
}
function brSafe(call,seat){ return brCanCall(seat,call)? call : PASS; }

/* --- opening --- */
function brOpening(h,seat){
  const l=brShape(h), hcp=brHcp(h), pts=brSupportPts(h,-1,false);
  const bal=brBalanced(l);
  const qt=[0,1,2,3].reduce((a,s)=>a+brQuickTricks(h,s),0);
  const posn=(seat-BR.dealer+4)%4;                     // 0 = first seat
  // 2C strong
  if(hcp>=22 || (hcp>=19 && qt>=4.5 && l.some(x=>x>=6))) return brBid(2,0);
  if(bal){
    if(hcp>=15&&hcp<=17) return brBid(1,4);
    if(hcp>=20&&hcp<=21) return brBid(2,4);
  }
  const rule20 = hcp + l[brLongest(l,false)] + [...l].sort((a,b)=>b-a)[1];
  const open = hcp>=14 || (hcp>=12&&rule20>=20&&qt>=2) || (hcp>=13&&qt>=2);
  if(open){
    if(l[0]>=5&&l[0]>=l[1]) return brBid(1,SU2ST[0]);
    if(l[1]>=5&&l[1]>l[0]) return brBid(1,SU2ST[1]);
    if(l[0]>=5) return brBid(1,SU2ST[0]);
    if(l[1]>=5) return brBid(1,SU2ST[1]);
    if(l[2]>=l[3]&&l[2]>=4) return brBid(1,1);
    if(l[3]>=4) return brBid(1,0);
    if(l[2]>l[3]) return brBid(1,1);
    return brBid(1,0);                                  // 3-3 minors -> 1C
  }
  // preempts (not in 4th seat with a weak hand)
  if(posn<3||hcp>=11){
    for(let s=0;s<4;s++){
      const q=brSuitQual(h,s);
      if(l[s]===6&&hcp>=5&&hcp<=11&&q>=8&&s!==3&&!(l[0]>=4&&s!==0)) return brBid(2,SU2ST[s]);
      if(l[s]===7&&hcp>=5&&hcp<=11&&q>=8) return brBid(3,SU2ST[s]);
      if(l[s]>=8&&hcp<=11&&q>=9) return brBid(4,SU2ST[s]);
    }
  }
  return PASS;
}
/* --- responses to 1NT --- */
function brRespond1NT(h,seat,ctx){
  const l=brShape(h), hcp=brHcp(h);
  if(BR.auction.filter(c=>c.t!=="P").length>1) return brCompetitive(h,seat,ctx); // interference
  if(l[0]>=5) return brBid(2,SU2ST[1]);                 // transfer to spades = 2H
  if(l[1]>=5) return brBid(2,SU2ST[2]);                 // transfer to hearts = 2D
  if(hcp>=8&&(l[0]===4||l[1]===4)) return brBid(2,0);   // Stayman
  if(hcp<=7) return PASS;
  if(hcp<=9) return brBid(2,4);
  if(hcp<=15) return brBid(3,4);
  if(hcp<=17) return brBid(4,4);                        // quantitative
  return brBid(4,0);                                     // Gerber
}
/* --- responses to a 1-of-suit opening --- */
function brRespondSuit(h,seat,ctx,op){
  const l=brShape(h), hcp=brHcp(h);
  const os=ST2SU[op.str], major=os<=1;
  const sup=brSupportPts(h,os,true);
  const fit = major ? l[os]>=3 : l[os]>=4;
  if(hcp<6 && !(l[os]>=5&&hcp>=5)) return PASS;
  if(fit&&major){
    if(sup>=13) return brBid(4,op.str);                  // or splinter; keep it sound
    if(sup>=11) return brBid(3,op.str);                  // limit raise
    if(sup>=6) return brBid(2,op.str);
  }
  // new suit at the 1 level: longest first, ties bid up the line
  if(hcp>=6){
    const cand=[0,1,2,3].filter(s=>l[s]>=4 && SU2ST[s]>op.str)
      .sort((x,y)=> l[y]-l[x] || SU2ST[x]-SU2ST[y]);
    if(cand.length) return brBid(1,SU2ST[cand[0]]);
  }
  if(hcp>=6&&hcp<=10&&!fit) return brBid(1,4);
  if(hcp>=11){
    const s=brLongest(l,false);
    if(l[s]>=4&&SU2ST[s]!==op.str) return brSafe(brBid(2,SU2ST[s]),seat);
    if(hcp>=13) return brBid(3,4);
    return brBid(2,4);
  }
  if(fit&&!major&&hcp>=6) return brBid(2,op.str);
  return PASS;
}
/* --- opener's rebid --- */
function brOpenerRebid(h,seat,ctx){
  const l=brShape(h), hcp=brHcp(h), pts=brSupportPts(h,-1,false);
  const op=ctx.myBids[0], resp=ctx.pardBids[ctx.pardBids.length-1];
  const pardPassed=ctx.pard.length&&ctx.pard[ctx.pard.length-1].t==="P";
  if(!resp) { if(pardPassed) return PASS; return brCompetitive(h,seat,ctx); }
  const rs=resp.str===4?-1:ST2SU[resp.str];
  // partner raised our suit
  if(resp.str===op.str){
    const maj = op.str===2||op.str===3;
    if(resp.lvl===2){ if(pts>=17) return brSafe(brBid(maj?4:3,op.str),seat);
                      if(pts>=15) return brSafe(brBid(3,op.str),seat); return PASS; }
    if(resp.lvl===3){ if(pts>=13&&maj) return brSafe(brBid(4,op.str),seat);
                      if(pts>=16) return brSafe(brBid(maj?4:5,op.str),seat); return PASS; }
    return PASS;
  }
  // partner bid 1NT
  if(resp.str===4){
    if(resp.lvl===1){ if(pts>=18) return brSafe(brBid(2,4),seat);
      if(l[ST2SU[op.str]]>=6&&pts>=15) return brSafe(brBid(2,op.str),seat); return PASS; }
    if(resp.lvl===2){ if(pts>=13) return brSafe(brBid(3,4),seat); return PASS; }
    if(resp.lvl===3) return PASS;
  }
  // partner bid a new suit
  if(rs>=0&&l[rs]>=4){
    const lvl = (SU2ST[rs]>op.str && resp.lvl===1) ? (pts>=17?3:2) : (pts>=17?4:3);
    if(rs<=1){ if(pts>=19) return brSafe(brBid(4,SU2ST[rs]),seat);
               if(pts>=16) return brSafe(brBid(3,SU2ST[rs]),seat);
               return brSafe(brBid(resp.lvl===1?2:3,SU2ST[rs]),seat); }
  }
  if(l[ST2SU[op.str]]>=6){ if(pts>=17) return brSafe(brBid(3,op.str),seat);
                           return brSafe(brBid(2,op.str),seat); }
  if(brBalanced(l)){ if(pts>=18) return brSafe(brBid(2,4),seat);
    if(resp.lvl===1) return brSafe(brBid(1,4),seat); return brSafe(brBid(2,4),seat); }
  // second suit
  for(let s=0;s<4;s++) if(l[s]>=4&&s!==ST2SU[op.str]&&s!==rs){
    const b=brBid(resp.lvl===1?(SU2ST[s]>op.str?1:2):2,SU2ST[s]);
    if(brCanCall(seat,b)) return b;
  }
  return PASS;
}
/* --- overcalls, takeout doubles, competitive --- */
function brCompetitive(h,seat,ctx){
  const l=brShape(h), hcp=brHcp(h);
  const lb=ctx.lastBid;
  const oppOwns = lb && (lb.seat%2)!==(seat%2);
  const weOwn   = lb && (lb.seat%2)===(seat%2);
  // partner made a takeout double -> advance
  if(ctx.pardDbl && ctx.myBids.length===0 && oppOwns){
    const s=brLongest(l,false);
    const lvl = lb.lvl + ((SU2ST[s]>lb.str)?0:1);
    if(hcp>=11) return brSafe(brBid(Math.min(7,lvl+1),SU2ST[s]),seat);
    if(hcp>=9&&brBalanced(l)) return brSafe(brBid(lb.lvl+1,4),seat);
    return brSafe(brBid(lvl,SU2ST[s]),seat);
  }
  if(weOwn){
    // partner has the contract: raise with a fit and extra shape, else pass
    const ourLast=ctx.pardBids[ctx.pardBids.length-1]||ctx.myBids[ctx.myBids.length-1];
    if(ourLast&&ourLast.str<4&&l[ST2SU[ourLast.str]]>=3&&hcp>=10&&lb.lvl<4)
      return brSafe(brBid(lb.lvl+1,lb.str),seat);
    return PASS;
  }
  if(!oppOwns) return PASS;
  // takeout double
  const oppS = lb.str===4?-1:ST2SU[lb.str];
  if(ctx.myBids.length===0 && brBalanced(l) && hcp>=15 && hcp<=18 && lb.str<4 && l[ST2SU[lb.str]]>=1){
    const nt=brBid(lb.lvl,4); if(brCanCall(seat,nt)) return nt;
  }
  const shortOpp = oppS>=0 && l[oppS]<=2;
  const support = oppS>=0 && [0,1,2,3].every(s=> s===oppS || l[s]>=3);
  if(lb.lvl<=2 && hcp>=12 && shortOpp && support && ctx.myBids.length===0 && !ctx.mine.some(c=>c.t==="X"))
    return brSafe(DBL,seat);
  // simple overcall
  if(ctx.myBids.length===0){
    for(let s=0;s<4;s++){
      if(l[s]<5) continue;
      const q=brSuitQual(h,s);
      const one=brBid(1,SU2ST[s]), two=brBid(2,SU2ST[s]);
      if(brCanCall(seat,one)&&hcp>=8&&hcp<=17&&q>=7) return one;
      if(brCanCall(seat,two)&&hcp>=11&&hcp<=17&&q>=8) return two;
      if(l[s]>=6&&hcp>=6&&hcp<=10&&q>=8){
        const jump=brBid(lb.lvl+(SU2ST[s]>lb.str?1:2),SU2ST[s]);
        if(brCanCall(seat,jump)&&jump.lvl<=3) return jump;
      }
    }
    if(brBalanced(l)&&hcp>=15&&hcp<=18&&oppS>=0&&l[oppS]>=1){
      const nt=brBid(lb.lvl,4); if(brCanCall(seat,nt)) return nt;
    }
  }
  // penalty double of a high contract with defence
  if(lb.lvl>=4&&hcp>=15&&brCanCall(seat,DBL)&&ctx.myBids.length===0) return DBL;
  return PASS;
}
/* --- Blackwood / slam --- */
function brAcesCount(h){ return h.filter(c=>cRank(c)===12).length; }
function brKingsCount(h){ return h.filter(c=>cRank(c)===11).length; }
function brBlackwoodAnswer(h,seat){
  const a=brAcesCount(h);
  const step=[0,1,2,3,4][a>=4?0:a];                     // 5C=0 or 4, 5D=1, 5H=2, 5S=3
  const map=[0,1,2,3];                                   // strain for 5C/5D/5H/5S
  return brBid(5, map[a>=4?0:a]);
}
function brAIBid(seat){
  const h=BR.seats[seat].hand, ctx=brCtx(seat);
  const l=brShape(h), hcp=brHcp(h);
  try{
    // ---- answering Blackwood 4NT / Gerber 4C from partner ----
    const pl=ctx.pardBids[ctx.pardBids.length-1];
    if(pl&&pl.lvl===4&&pl.str===4&&ctx.bids.length>=3){ const r=brBlackwoodAnswer(h,seat); if(brCanCall(seat,r)) return r; }
    if(pl&&pl.lvl===4&&pl.str===0&&ctx.pardBids.length>=2&&ctx.pardBids[0].str===4){
      const a=brAcesCount(h); const r=brBid(4,[1,2,3,4][a>=4?0:a]); if(brCanCall(seat,r)) return r; }
    // ---- responding to partner's Blackwood answer: place the contract ----
    if(ctx.myBids.length&&ctx.myBids[ctx.myBids.length-1].lvl===4&&ctx.myBids[ctx.myBids.length-1].str===4&&pl&&pl.lvl===5){
      const aces=[0,1,2,3].indexOf(pl.str); const mine=brAcesCount(h);
      const trump=ctx.myBids.length>=2? ctx.myBids[ctx.myBids.length-2].str : 4;
      const tot=mine+(aces<0?0:aces);
      if(tot>=3&&hcp>=17) return brSafe(brBid(6,trump),seat);
      return brSafe(brBid(5,trump),seat);
    }
    // ---- 1NT opener answering Stayman / completing a Jacoby transfer ----
    if(ctx.iOpened && ctx.myBids.length===1 && ctx.myBids[0].lvl===1 && ctx.myBids[0].str===4 && pl && pl.lvl===2){
      if(pl.str===1){ const b=brBid(2,2); if(brCanCall(seat,b)) return b; }        // 2D -> 2H
      if(pl.str===2){ const b=brBid(2,3); if(brCanCall(seat,b)) return b; }        // 2H -> 2S
      if(pl.str===0){                                                              // Stayman
        if(l[0]>=4) return brSafe(brBid(2,3),seat);
        if(l[1]>=4) return brSafe(brBid(2,2),seat);
        return brSafe(brBid(2,1),seat);
      }
      if(pl.str===4) return hcp>=17? brSafe(brBid(3,4),seat) : PASS;               // 2NT invite
    }
    // ---- responder after a completed transfer ----
    if(ctx.pardOpened && ctx.pardBids[0] && ctx.pardBids[0].lvl===1 && ctx.pardBids[0].str===4
       && ctx.myBids.length===1 && ctx.myBids[0].lvl===2 && (ctx.myBids[0].str===1||ctx.myBids[0].str===2)){
      const maj = ctx.myBids[0].str===1 ? 1 : 0;                                   // suit index
      if(hcp<=7) return PASS;
      if(hcp<=9) return brSafe(brBid(3,SU2ST[maj]),seat);
      if(l[maj]>=6) return brSafe(brBid(4,SU2ST[maj]),seat);
      if(hcp>=10) return brSafe(brBid(3,4),seat);
      return PASS;
    }
    // ---- responder after a Stayman answer ----
    if(ctx.pardOpened && ctx.pardBids[0] && ctx.pardBids[0].lvl===1 && ctx.pardBids[0].str===4
       && ctx.myBids.length===1 && ctx.myBids[0].lvl===2 && ctx.myBids[0].str===0 && pl && pl.lvl===2){
      const ans = pl.str===3?0 : pl.str===2?1 : -1;
      if(ans>=0 && l[ans]>=4){ if(hcp>=10) return brSafe(brBid(4,SU2ST[ans]),seat);
                               return brSafe(brBid(3,SU2ST[ans]),seat); }
      if(hcp>=10) return brSafe(brBid(3,4),seat);
      return brSafe(brBid(2,4),seat);
    }
    // ---- 2C opener's rebid ----
    if(ctx.iOpened&&ctx.myBids.length===1&&ctx.myBids[0].lvl===2&&ctx.myBids[0].str===0){
      if(brBalanced(l)) return brSafe(brBid(2,4),seat);
      const s=brLongest(l,false); return brSafe(brBid(2,SU2ST[s]),seat);
    }
    // ---- nobody has bid: open ----
    if(!ctx.first) return brOpening(h,seat);
    // ---- partner opened, opponents silent-ish, my first call ----
    if(ctx.pardOpened&&ctx.myBids.length===0&&ctx.pardBids.length===1){
      const op=ctx.pardBids[0];
      if(ctx.oppBid&&brLastBid()&&(brLastBid().seat%2)!==(seat%2)){
        // negative double with both majors / values
        if(op.lvl===1&&brLastBid().lvl<=2&&hcp>=8&&op.str<4){
          const os=ST2SU[op.str], ov=ST2SU[brLastBid().str];
          const oth=[0,1].filter(s=>s!==os&&s!==ov);
          if(oth.some(s=>l[s]>=4)&&brCanCall(seat,DBL)) return DBL;
        }
        return brCompetitive(h,seat,ctx);
      }
      if(op.str===4&&op.lvl===1) return brRespond1NT(h,seat,ctx);
      if(op.str===4&&op.lvl===2){ if(hcp>=5) return brSafe(brBid(3,4),seat); return PASS; }
      if(op.lvl===2&&op.str===0){ if(hcp>=8) return brSafe(brBid(2,2),seat); return brSafe(brBid(2,1),seat); } // 2D waiting
      if(op.lvl>=2&&op.str<4){                                    // partner preempted
        const os=ST2SU[op.str];
        if(l[os]>=3&&hcp>=15) return brSafe(brBid(op.lvl+1,op.str),seat);
        if(hcp>=17&&brBalanced(l)) return brSafe(brBid(3,4),seat);
        return PASS;
      }
      return brRespondSuit(h,seat,ctx,op);
    }
    // ---- I opened, partner has responded ----
    if(ctx.iOpened&&ctx.myBids.length>=1&&ctx.pardBids.length>=1) return brOpenerRebid(h,seat,ctx);
    // ---- responder's rebid ----
    if(ctx.pardOpened&&ctx.myBids.length>=1&&ctx.pardBids.length>=2){
      const op=ctx.pardBids[0], reb=ctx.pardBids[ctx.pardBids.length-1];
      const lb=ctx.lastBid;
      if(lb&&(lb.seat%2)===(seat%2)){
        const trump=reb.str;
        const fitS=trump===4?-1:ST2SU[trump];
        const pts=brSupportPts(h,fitS,true);
        // slam try
        if(pts>=17&&fitS>=0&&l[fitS]>=3&&lb.lvl<=4&&brCanCall(seat,brBid(4,4))) return brBid(4,4);
        if(lb.lvl>=4) return PASS;
        if(fitS>=0&&l[fitS]>=3&&pts>=12) return brSafe(brBid(fitS<=1?4:5,trump),seat);
        if(pts>=12&&brBalanced(l)) return brSafe(brBid(3,4),seat);
        if(pts>=13){ const b=brBid(3,4); if(brCanCall(seat,b)) return b; }
        return PASS;
      }
      return brCompetitive(h,seat,ctx);
    }
    // ---- everything else ----
    return brCompetitive(h,seat,ctx);
  }catch(e){ return PASS; }
}

/* ================= BOT CARD PLAY — Monte-Carlo double dummy ================= */
let DD_NODES=0, DD_BUDGET=250000, DD_T0=0, DD_MS=400, DD_ABORT=false;
const BR_THINK = parseInt(process.env.BR_THINK||"400");
function ddMoves(hand,led){
  let m = led<0 ? hand : hand.filter(c=>cSuit(c)===led);
  if(!m.length) m=hand;
  m=m.slice().sort((a,b)=> cSuit(a)-cSuit(b) || cRank(b)-cRank(a));
  // collapse touching cards in the same suit (equivalent plays)
  const out=[];
  for(let i=0;i<m.length;i++){
    if(i>0 && cSuit(m[i])===cSuit(m[i-1]) && cRank(m[i-1])-cRank(m[i])===1) continue;
    out.push(m[i]);
  }
  return out;
}
function ddLeaf(hands,trump,decSide,turn){
  const total=hands[turn].length;
  if(!total) return 0;
  let dec=0,opp=0;
  for(let s=0;s<4;s++){
    let topR=-1,topP=-1;
    for(let p=0;p<4;p++){ const h=hands[p];
      for(let i=0;i<h.length;i++){ const c=h[i];
        if(((c/13)|0)!==s) continue;
        const r=c%13; if(r>topR){ topR=r; topP=p; } } }
    if(topP<0) continue;
    if(topR>=11){ if((topP%2)===decSide) dec++; else opp++; }
  }
  if(trump>=0){
    let dt=0,ot=0;
    for(let p=0;p<4;p++){ let n=0; const h=hands[p];
      for(let i=0;i<h.length;i++) if(((h[i]/13)|0)===trump) n++;
      if((p%2)===decSide){ if(n>dt) dt=n; } else if(n>ot) ot=n; }
    if(dt>ot) dec+=(dt-ot)*0.6; else opp+=(ot-dt)*0.6;
  }
  const rest=Math.max(0,total-dec-opp);
  return Math.min(total, dec+rest*0.45);
}
function ddRec(hands,trump,turn,trick,decSide,depth,alpha,beta){
  if(((++DD_NODES)&255)===0 && Date.now()-DD_T0>DD_MS) DD_ABORT=true;
  if(DD_ABORT) return 0;
  if(trick.length===0 && (depth<=0 || hands[turn].length===0)) return ddLeaf(hands,trump,decSide,turn);
  const maxing=(turn%2)===decSide;
  const moves=ddMoves(hands[turn], trick.length? ((trick[0].card/13)|0) : -1);
  let best = maxing? -1 : 99;
  for(let mi=0;mi<moves.length;mi++){
    const c=moves[mi];
    const h=hands[turn]; const idx=h.indexOf(c); h.splice(idx,1);
    trick.push({seat:turn,card:c});
    let val;
    if(trick.length===4){
      const w=brTrickWinner(trick,trump);
      const gain=((w%2)===decSide)?1:0;
      const saved=trick.splice(0,4);
      val=gain+ddRec(hands,trump,w,trick,decSide,depth-1,alpha-gain,beta-gain);
      for(let i=0;i<4;i++) trick.push(saved[i]);
    } else {
      val=ddRec(hands,trump,(turn+1)%4,trick,decSide,depth,alpha,beta);
    }
    trick.pop(); h.splice(idx,0,c);
    if(DD_ABORT) return 0;
    if(maxing){ if(val>best) best=val; if(best>alpha) alpha=best; }
    else { if(val<best) best=val; if(best<beta) beta=best; }
    if(alpha>=beta) break;
  }
  return (best===-1||best===99)? ddLeaf(hands,trump,decSide,turn) : best;
}
/* ---- constrained sampling of the hidden hands ---- */
function brSeen(seat,ctrl){
  const seen=new Set();
  BR.seats[seat].hand.forEach(c=>seen.add(c));
  for(let s=0;s<4;s++) BR.playedBy[s].forEach(c=>seen.add(c));
  BR.trick.forEach(x=>seen.add(x.card));
  return seen;
}
/* 沒有明手，所以每個人只知道自己那 13 張 —— 電腦跟真人看到的一樣多 */
function brKnownSeat(s,seat,ctrl){ return s===seat; }
function brHcpRange(s){
  // rough range from that seat's calls
  const calls=BR.auction.filter(c=>c.seat===s);
  if(!calls.length) return [0,40];
  const bids=calls.filter(c=>c.t==="B");
  let lo=0, hi=40;
  if(!bids.length){ hi=11; if(calls.some(c=>c.t==="X")) { lo=11; hi=40; } return [lo,hi]; }
  const f=bids[0];
  if(f.lvl===1&&f.str===4) return [15,17];
  if(f.lvl===2&&f.str===4) return [20,21];
  if(f.lvl===2&&f.str===0) return [21,40];
  if(f.lvl>=2&&f.str<4&&(BR.auction.filter(c=>c.t==="B")[0]===f)) return [4,11];   // preempt
  if(f.lvl===1) lo=11;
  if(bids.length>=2) lo=Math.max(lo,6);
  return [lo,hi];
}
function brSample(seat,ctrl){
  const seen=brSeen(seat,ctrl);
  const pool=[]; for(let c=0;c<52;c++) if(!seen.has(c)) pool.push(c);
  const need=[0,0,0,0], hands=[[],[],[],[]];
  for(let s=0;s<4;s++){
    if(brKnownSeat(s,seat,ctrl)){ hands[s]=BR.seats[s].hand.slice(); continue; }
    need[s]=BR.seats[s].hand.length;
  }
  if(need.reduce((a,b)=>a+b,0)!==pool.length) return null;
  const order=[0,1,2,3].filter(s=>need[s]>0);
  if(!order.length) return hands;
  for(let attempt=0;attempt<36;attempt++){
    const rem=pool.slice();
    const bySeat={}; let ok=true;
    for(const s of order){
      bySeat[s]=[];
      const legal=rem.filter(c=>!BR.seats[s].voids[cSuit(c)]);
      if(legal.length<need[s]){ ok=false; break; }
      for(let i=0;i<need[s];i++){
        const j=Math.floor(Math.random()*legal.length);
        const pick=legal[j]; legal.splice(j,1);
        bySeat[s].push(pick); rem.splice(rem.indexOf(pick),1);
      }
    }
    if(!ok) continue;
    let bad=false;
    for(const s of order){
      const [lo,hi]=brHcpRange(s);
      const p2=brHcp(bySeat[s].concat(BR.playedBy[s]));
      if(p2<lo-3||p2>hi+3){ bad=true; break; }
    }
    if(bad&&attempt<28) continue;
    order.forEach(s=>{ hands[s]=bySeat[s]; });
    return hands;
  }
  return null;
}
/* ---- opening-lead conventions (trick 1) ---- */
function brOpeningLead(seat){
  const h=BR.seats[seat].hand, l=brShape(h);
  const c=BR.contract, nt=(c.str===4), trump=nt?-1:ST2SU[c.str];
  const pardSuit=(()=>{ const p=(seat+2)%4;
    const b=BR.auction.filter(x=>x.seat===p&&x.t==="B"&&x.str<4); return b.length? ST2SU[b[b.length-1].str] : -1; })();
  const decSuits=BR.auction.filter(x=>(x.seat%2)!==(seat%2)&&x.t==="B"&&x.str<4).map(x=>ST2SU[x.str]);
  const seq=s=>{ const r=brSuitCards(h,s).map(cRank);
    if(r.length>=3&&r[0]>=9&&r[0]-r[1]===1&&r[1]-r[2]===1) return 3;      // 3-card honour sequence
    if(r.length>=3&&r[0]>=9&&r[0]-r[1]===1&&r[1]-r[2]===2) return 2;      // interior / broken
    return 0; };
  const pick=s=>{ const r=brSuitCards(h,s);
    if(seq(s)) return r[0];
    if(r.length>=4) return r[3];                                          // 4th best
    if(r.length===3) return r[1];                                         // MUD
    if(r.length===2) return r[0];                                         // top of doubleton
    return r[0]; };
  if(pardSuit>=0&&l[pardSuit]>0) return pick(pardSuit);
  if(nt){
    let best=-1,bq=-1;
    for(let s=0;s<4;s++){ if(decSuits.includes(s)&&l[s]<5) continue;
      const q=l[s]*2+brSuitCards(h,s).filter(x=>cRank(x)>=9).length+(seq(s)?4:0);
      if(l[s]>=4&&q>bq){ bq=q; best=s; } }
    if(best>=0) return pick(best);
    for(let s=0;s<4;s++) if(seq(s)) return brSuitCards(h,s)[0];
    return pick(brLongest(l,false));
  }
  // vs a suit contract
  for(let s=0;s<4;s++) if(s!==trump&&seq(s)===3) return brSuitCards(h,s)[0];
  for(let s=0;s<4;s++) if(s!==trump&&l[s]===1&&!decSuits.includes(s)) return brSuitCards(h,s)[0]; // singleton
  for(let s=0;s<4;s++){ const r=brSuitCards(h,s).map(cRank);
    if(s!==trump&&l[s]>=4&&r[0]<12&&!r.includes(12)) return brSuitCards(h,s)[3]; }              // 4th best, no A
  for(let s=0;s<4;s++){ const r=brSuitCards(h,s).map(cRank);
    if(s!==trump&&l[s]===2&&r[0]<11) return brSuitCards(h,s)[0]; }
  if(trump>=0&&l[trump]>=3) return brSuitCards(h,trump)[brSuitCards(h,trump).length-1];         // trump lead
  return pick(brLongest(l,false));
}
function brAIPlay(seat){
  const legal=brLegalCards(seat);
  if(!legal.length) return null;
  if(legal.length===1) return legal[0];
  if(BR.trickHist.length===0&&BR.trick.length===0&&seat===BR.leader){
    const c=brOpeningLead(seat);
    if(legal.includes(c)) return c;
  }
  const ctrl=brController(seat);
  const decSide=brSide(BR.declarer);
  const trump=brTrumpSuit();
  const left=BR.seats[seat].hand.length;
  const depth = left<=6 ? left : left<=8 ? 5 : left<=10 ? 4 : 3;
  const cands=ddMoves(BR.seats[seat].hand, BR.trick.length? cSuit(BR.trick[0].card) : -1);
  if(cands.length===1) return cands[0];
  const score={}; cands.forEach(c=>score[c]=0);
  let n=0; DD_T0=Date.now(); DD_MS=BR_THINK; DD_BUDGET=9000000; DD_NODES=0; DD_ABORT=false;
  const SAMPLES=left<=6?14:12;
  for(let k=0;k<SAMPLES;k++){
    const hands=brSample(seat,ctrl);
    if(!hands) break;
    for(const c of cands){
      const hh=hands.map(x=>x.slice());
      const idx=hh[seat].indexOf(c);
      if(idx<0) continue;
      hh[seat].splice(idx,1);
      const tr=BR.trick.map(x=>({seat:x.seat,card:x.card}));
      tr.push({seat,card:c});
      let v;
      if(tr.length===4){
        const w=brTrickWinner(tr,trump);
        const gain=((w%2)===decSide)?1:0;
        v=gain+ddRec(hh,trump,w,[],decSide,depth-1,-1,99);
      } else {
        v=ddRec(hh,trump,(seat+1)%4,tr,decSide,depth,-1,99);
      }
      score[c]+=v;
    }
    if(DD_ABORT) break;
    n++;
    if(Date.now()-DD_T0>BR_THINK) break;
  }
  if(!n) return legal[Math.floor(Math.random()*legal.length)];
  const maxing=(seat%2)===decSide;
  let best=cands[0], bv=maxing?-1e9:1e9;
  for(const c of cands){
    const v=score[c]/n;
    if(maxing? v>bv : v<bv){ bv=v; best=c; }
  }
  return best;
}
/* ---------- state for clients ---------- */
function brPublic(){
  const c=BR.contract;
  return {
    roster: rosterOf(),
    pace: G.pace,
    stage:BR.stage, board:BR.board, dealer:BR.dealer, vuln:BR.vuln,
    auction:BR.auction, contract:c, contractStr:c?brContractStr():"",
    declarer:BR.declarer, dummy:BR.dummy, dummyShown:BR.dummyShown,
    turn:BR.turn, leader:BR.leader, trick:BR.trick.map(x=>({seat:x.seat,card:cObj(x.card)})),
    lastTrick: BR.lastTrick? {cards:BR.lastTrick.cards.map(x=>({seat:x.seat,card:cObj(x.card)})),win:BR.lastTrick.win}:null,
    tricks:BR.tricks, played:BR.trickHist.length, handOver:BR.handOver, result:BR.result,
    rub:BR.rub, phase:BR.phase, banner:BR.banner, log:BR.log,
    seats:BR.seats.map((st,s)=>{
      const p=brSeatP(s);
      return { seat:s, label:BSEATS[s], name:p?p.name:BSEAT[s], isAI:p?p.isAI:true,
        auto:st.auto, connected:p?(p.isAI?true:p.connected):true, avatar:p?p.avatar:null,
        cards:st.hand.length, hand: BR.handOver? st.hand.map(cObj) : null,   // 打完才攤
        side:brSide(s) };
    })
  };
}
function brPrivate(token){
  const pi=G.players.findIndex(p=>p.token===token);
  if(pi<0) return null;
  const s=BR.seats.findIndex(st=>st.pi===pi);
  if(s<0) return {seat:-1};
  const me={ seat:s, label:BSEATS[s], hand:BR.seats[s].hand.map(cObj), auto:BR.seats[s].auto,
             partner:(s+2)%4, isDeclarer:s===BR.declarer, isDummy:s===BR.dummy };
  if(BR.handOver||BR.phase!=="play") { me.myTurn=false; return me; }
  if(BR.stage==="auction"){
    me.myTurn = BR.turn===s && !BR.seats[s].auto;
    me.calls = me.myTurn? brLegalCalls(s) : null;
    return me;
  }
  // 每個人只出自己的牌
  me.myTurn = BR.turn===s && !BR.seats[s].auto;
  me.playSeat = me.myTurn? s : -1;
  me.playingDummy = false;
  me.legal = me.myTurn? brLegalCards(s).map(cObj) : null;
  me.dummyHand = null;
  me.canClaim = false;
  return me;
}

/* ================= STATE BROADCAST (SSE) ================= */
let clients=[]; // {res, token|null(host)}
const KA_MS=20000;      // SSE heartbeat
const GRACE_MS=300000;   // stay "online" this long after a phone drops (app switch / screen lock)
function rosterOf(){
  return G.players.filter(p=>!p.isAI&&!p.removed)
    .map(p=>({id:p.id,name:p.name,connected:!!p.connected,avatar:p.avatar||null}));
}
function publicState(){
  return {
    roster:rosterOf(),
    phase:G.phase, stage:G.stage, board:G.board, pot:potTotal(),
    dealer:G.dealer, sb:G.sb, bb:G.bb, turn:G.turn,
    banner:G.banner, log:G.log, handOver:G.handOver, revealAll:G.revealAll, stack:G.stack,
    mode:G.mode, sbA:G.sbA, bbA:G.bbA, pace:G.pace, aiLevel:G.aiLevel,
    players:G.players.map((p,i)=>({
      id:p.id, name:p.name, isAI:p.isAI, chips:p.chips, bet:p.bet,
      folded:p.folded, allIn:p.allIn, inHand:p.inHand, won:p.won,
      handsWon:p.handsWon, net:p.chips-p.start, connected:p.isAI?true:p.connected, removed:!!p.removed, auto:!!p.auto,
      avatar:p.avatar||null, wagered:p.wagered||0, handBet:p.handBet||0,
      showName:(G.stage===4)?p.showName:"",
      hole:( (G.stage===4&&p.inHand&&!p.folded) || (G.revealAll&&p.inHand&&!p.folded) ) ? p.hole : null
    }))
  };
}
function privateFor(token){
  const i=G.players.findIndex(p=>p.token===token);
  if(i<0) return null;
  const p=G.players[i];
  const myTurn = G.phase==="play" && !G.handOver && G.turn===i && p.inHand && !p.folded && !p.allIn && p.need;
  const owe=Math.max(0,G.curBet-p.bet);
  return {
    seat:i, hole:p.hole, coach:coachLine(i), coachAdv:coachAdv(i), yourTurn:myTurn,
    actions: myTurn ? {
      canFold: owe>0,
      callLabel: owe<=0 ? "Check" : (owe>=p.chips ? "All-in "+p.chips : "Call "+owe),
      canRaise: canRaise(i),
      raiseLabel: (G.curBet===0 ? "Bet "+betSize() : "Raise to "+(G.curBet+betSize())),
      raises: (G.mode==="nl"&&canRaise(i)) ? raiseOptions(i) : null
    } : null
  };
}
function sendTo(c){
  let payload;
  if(G.game==="mahjong") payload={ game:"mahjong", pub:mjPublicState(), me: c.token? mjPrivateFor(c.token):null };
  else if(G.game==="bridge") payload={ game:"bridge", pub:brPublic(), me: c.token? brPrivate(c.token):null };
  else payload={ game:G.game, pub:publicState(), me: c.token? privateFor(c.token):null };
  payload.code=TABLE_CODE;
  payload.setup={
    humans:G.players.filter(p=>!p.isAI&&!p.removed).length,
    game:G.game,
    running:(G.game==="poker"&&G.phase==="play")
      ||(G.game==="mahjong"&&M.phase==="play")
      ||(G.game==="bridge"&&BR.phase==="play")
  };
  try{ c.res.write("data: "+JSON.stringify(payload)+"\n\n"); }catch(e){}
}
function broadcast(){ clients.forEach(sendTo); }

/* ================= HTTP ================= */
function allIPs(){
  const ifs=os.networkInterfaces(); const out=[];
  for(const name of Object.keys(ifs)) for(const a of ifs[name])
    if(a.family==="IPv4"&&!a.internal) out.push({name,ip:a.address});
  const score=x=>{
    const n=x.name.toLowerCase();
    let s=0;
    if(x.ip.startsWith("192.168.")) s+=100;                 // typical home Wi-Fi
    if(/^172\.(1[6-9]|2\d|3[01])\./.test(x.ip)) s+=60;
    if(x.ip.startsWith("10.")) s+=30;
    if(/wi-?fi|wlan|ethernet|en0|eth/.test(n)) s+=40;
    if(/vpn|nord|tap|tun|virtual|vmware|vbox|hyper|wsl|zerotier|tailscale|docker/.test(n)) s-=200;
    if(x.ip.startsWith("10.5.0.")||x.ip.startsWith("100.")||x.ip.startsWith("25.")) s-=150; // common VPN ranges
    return s;
  };
  return out.sort((a,b)=>score(b)-score(a));
}
function lanIP(){ const l=allIPs(); return l.length? l[0].ip : "localhost"; }
function body(req){ return new Promise(r=>{ let b="",done=false;
  const fin=v=>{ if(!done){done=true;r(v);} };
  req.on("data",c=>{ b+=c; if(b.length>300000){ try{req.destroy();}catch(e){} fin({}); } });
  req.on("end",()=>{ try{fin(JSON.parse(b||"{}"))}catch(e){fin({})} });
  req.on("error",()=>fin({})); }); }
function json(res,o,code=200){ res.writeHead(code,{"Content-Type":"application/json"}); res.end(JSON.stringify(o)); }

const server=http.createServer(async (req,res)=>{
  const url=new URL(req.url,"http://x");
  const path=url.pathname;

  // ---- 大老二 Big Two：/dalaoer 底下的一律交給 express ----
  if(path==="/dalaoer"||path.startsWith("/dalaoer/")) return big2(req,res);

  if(path==="/"){ res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"}); return res.end(HOST_HTML); }
  if(path==="/join"){ res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"}); return res.end(PLAYER_HTML); }

  if(path==="/events"){
    res.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-cache",
      "Connection":"keep-alive","X-Accel-Buffering":"no"});
    const token=url.searchParams.get("token")||null;
    const c={res,token};
    clients.push(c);
    const p=G.players.find(x=>x.token===token);
    if(p){ if(p.offTimer){ clearTimeout(p.offTimer); p.offTimer=null; } p.connected=true;
      // 本人回來了 → 位子還他，已經做過的不回捲（CIO 2026-08-23）
      if(p.auto){ p.auto=false; banner(p.name+" 回來了，位子還他｜"+p.name+" is back."); }
    }
    sendTo(c); if(p) broadcast();
    // heartbeat: keeps proxies (Render/nginx) from killing an idle stream
    c.ka=setInterval(()=>{ try{ res.write(":ka\n\n"); }catch(e){} }, KA_MS);
    req.on("close",()=>{ clients=clients.filter(x=>x!==c); clearInterval(c.ka);
      const q=G.players.find(x=>x.token===token);
      if(!q) return;
      if(clients.some(x=>x.token===token)) return;      // another tab still open
      if(q.offTimer) clearTimeout(q.offTimer);
      // GRACE: phone backgrounded / screen locked -> stay seated, don't flip offline
      q.offTimer=setTimeout(()=>{ q.offTimer=null;
        if(!clients.some(x=>x.token===token)){ q.connected=false; broadcast(); }
      }, GRACE_MS);
    });
    return;
  }

  if(req.method==="POST"&&path==="/api/join"){
    const b=await body(req);
    // resume?
    if(b.token){ const p=G.players.find(x=>x.token===b.token);
      if(p) return json(res,{token:p.token,name:p.name}); }
    if(G.game==="poker"&&G.phase!=="lobby") return json(res,{error:"牌局進行中 — 請等這場結束再加入。"},400);
    const humans=G.players.filter(p=>!p.isAI).length;
    if(humans>=5) return json(res,{error:"Table full (5 max)."},400);
    const name=String(b.name||"").trim().slice(0,14)||("Player "+(humans+1));
    const token=crypto.randomBytes(8).toString("hex");
    G.players.push({id:crypto.randomBytes(4).toString("hex"),token,isAI:false,name,
      chips:G.stack,start:G.stack,handsWon:0,hole:[],folded:false,allIn:false,
      bet:0,total:0,need:false,inHand:false,won:false,showName:"",connected:true,
      avatar:null,wagered:0});
    broadcast();
    return json(res,{token,name});
  }

  if(req.method==="POST"&&path==="/api/start"){
    const b=await body(req);
    if(G.game!=="poker"||G.phase!=="lobby") return json(res,{error:"Already started."},400);
    G.stack=[500,1000,2000].includes(b.stack)?b.stack:1000;
    G.mode = b.mode==="nl" ? "nl" : "fl";
    G.aiLevel = ["beg","int","adv"].includes(b.skill)? b.skill : "int";
    const bl={"5":[5,10],"10":[10,20],"25":[25,50]}[String(b.blinds)]||[5,10];
    G.sbA=bl[0]; G.bbA=bl[1]; G.lastRaise=G.bbA;
    G.players.forEach(p=>{ p.chips=G.stack; p.start=G.stack; p.handsWon=0; p.won=false; p.wagered=0; });
    const ai=Math.max(0,Math.min(4,b.ai|0));
    for(let k=0;k<ai&&G.players.length<5;k++)
      G.players.push({id:"ai"+k,token:null,isAI:true,name:AI_NAMES[k],
        chips:G.stack,start:G.stack,handsWon:0,hole:[],folded:false,allIn:false,
        bet:0,total:0,need:false,inHand:false,won:false,showName:"",connected:true,
        avatar:null,wagered:0});
    if(G.players.length<2) return json(res,{error:"Need at least 2 players (add AI)."},400);
    G.phase="play"; G.dealer=-1;
    newHand();
    return json(res,{ok:1});
  }

  if(req.method==="POST"&&path==="/api/action"){
    const b=await body(req);
    const i=G.players.findIndex(p=>p.token===b.token);
    if(i<0) return json(res,{error:"Unknown player."},400);
    const p=G.players[i];
    const isTurn=G.phase==="play"&&!G.handOver&&G.turn===i&&p.inHand&&!p.folded&&!p.allIn&&p.need;
    if(!isTurn) return json(res,{error:"Not your turn."},400);
    const owe=G.curBet-p.bet;
    if(b.action==="fold"){ if(owe<=0) return json(res,{error:"Checking is free — no need to fold."},400); doFold(i); }
    else if(b.action==="call") doCall(i);
    else if(b.action==="raise"){
      if(!canRaise(i)) return json(res,{error:"Raise not available."},400);
      if(G.mode==="nl") doRaiseTo(i, parseInt(b.to)||minRaiseTo());
      else doRaise(i);
    }
    else return json(res,{error:"Bad action."},400);
    return json(res,{ok:1});
  }

  if(req.method==="POST"&&path==="/api/avatar"){
    const b=await body(req);
    const p=G.players.find(x=>x.token===b.token);
    if(!p) return json(res,{error:"Unknown player."},400);
    const img=String(b.img||"");
    if(!/^data:image\/(jpeg|png|webp);base64,/.test(img)||img.length>120000)
      return json(res,{error:"Photo too large — try again."},400);
    p.avatar=img; broadcast(); return json(res,{ok:1});
  }

  if(req.method==="POST"&&path==="/api/rename"){
    const b=await body(req);
    const p=G.players.find(x=>x.token===b.token);
    if(!p) return json(res,{error:"Unknown player."},400);
    const nm=String(b.name||"").trim().slice(0,14);
    if(nm&&nm!==p.name){ banner(p.name+" is now "+nm+"."); p.name=nm; broadcast(); }
    return json(res,{ok:1,name:p.name});
  }

  if(req.method==="POST"&&path==="/api/kick"){
    const b=await body(req);
    const i=G.players.findIndex(x=>x.id===b.id);
    if(i<0) return json(res,{error:"Player not found."},400);
    if(G.game==="bridge"&&BR.phase==="play"){
      const s=BR.seats.findIndex(st=>st.pi===i);
      if(s>=0&&!BR.handOver&&!brSeatP(s).isAI&&!BR.seats[s].auto){
        BR.seats[s].auto=true; brBanner(brName(s)+" 改由電腦代打｜"+BSEATS[s]+" is now played by the computer.");
        broadcast(); brResumeAuto(s);
      }
      return json(res,{ok:1});
    }
    if(G.game==="mahjong"&&M.phase==="play"){
      const s=M.seats.findIndex(st=>st.pi===i);
      if(s>=0&&!M.handOver&&!seatP(s).isAI&&!M.seats[s].auto){
        M.seats[s].auto=true; mjBanner(seatName(s)+" 改由電腦代打。"); broadcast(); mjResumeAuto(s);
        if(M.pending){ const c=M.pending.claims.find(x=>x.seat===s&&x.resp===null);
          if(c){ c.resp=botClaim(s,c.opts,M.pending.tile)||{t:"pass"};
            if(M.pending.claims.every(x=>x.resp!==null)){ M.claimSeq++; resolveClaims(); } else broadcast(); } }
      }
      return json(res,{ok:1});
    }
    // 撲克：牌局進行中絕對不能把人蓋牌踢掉 —— 那會把他的底牌、籌碼和這一手一起丟掉。
    // 改成電腦代打，位子、底牌、籌碼、token 全部留著（CIO 2026-08-23）。
    if(G.game==="poker"&&G.phase==="play"&&!G.handOver){
      const p=G.players[i];
      if(p&&!p.isAI&&!p.auto){
        p.auto=true;
        banner(p.name+" 改由電腦代打｜"+p.name+" is now played by the computer.");
        broadcast();
        if(G.turn===i) later(300,step);
      }
      return json(res,{ok:1});
    }
    removeSeat(i,"was removed from the table");
    return json(res,{ok:1});
  }

  if(req.method==="POST"&&path==="/api/leave"){
    const b=await body(req);
    if(G.game==="bridge"&&BR.phase==="play"&&!BR.handOver){
      const pi0=G.players.findIndex(x=>x.token===b.token);
      const s0=BR.seats.findIndex(st=>st.pi===pi0);
      if(s0>=0){
        if(!BR.seats[s0].auto){ BR.seats[s0].auto=true;
          brBanner(brName(s0)+" 離開 — 電腦代打｜"+BSEATS[s0]+" left — computer takes over.");
          broadcast(); brResumeAuto(s0); }
        return json(res,{ok:1});
      }
    }
    if(G.game==="mahjong"&&M.phase==="play"&&!M.handOver){
      const pi=G.players.findIndex(x=>x.token===b.token);
      const s=M.seats.findIndex(st=>st.pi===pi);
      if(s>=0){
        if(!M.seats[s].auto){ M.seats[s].auto=true; mjBanner(seatName(s)+" 離開 — 電腦代打。"); broadcast(); mjResumeAuto(s); }
        return json(res,{ok:1});
      }
    }
    const i=G.players.findIndex(x=>x.token===b.token);
    if(i<0) return json(res,{ok:1}); // nothing to free — treat as success
    if(G.game==="poker"&&G.phase==="play"&&!G.handOver&&!G.players[i].isAI){
      G.players[i].auto=true;
      banner(G.players[i].name+" 離開 — 電腦代打｜left the table, computer takes over.");
      broadcast();
      if(G.turn===i) later(300,step);
      return json(res,{ok:1});
    }
    removeSeat(i,"left the table");
    return json(res,{ok:1});
  }

  if(req.method==="POST"&&path==="/api/pace"){
    G.pace = G.pace===1 ? 2.2 : 1;
    broadcast(); return json(res,{ok:1,pace:G.pace});
  }

  if(req.method==="POST"&&path==="/api/next"){
    if(G.phase!=="play"||!G.handOver) return json(res,{error:"Hand not finished."},400);
    newHand(); return json(res,{ok:1});
  }
  if(req.method==="POST"&&path==="/api/reveal"){
    G.revealAll=!G.revealAll; broadcast(); return json(res,{ok:1,revealAll:G.revealAll});
  }
  if(req.method==="POST"&&path==="/api/rebuy"){
    const b=await body(req);
    const p=G.players.find(x=>x.id===b.id);
    if(p&&p.chips===0){ p.chips+=G.stack; p.start+=G.stack; broadcast(); }
    return json(res,{ok:1});
  }
  if(req.method==="POST"&&path==="/api/transfer"){
    const b=await body(req);
    const from=G.players.find(x=>x.token===b.token);
    const to=G.players.find(x=>x.id===b.toId);
    if(!from||!to||from===to||to.removed) return json(res,{error:"Invalid transfer."},400);
    if(G.phase==="play"&&!G.handOver) return json(res,{error:"Wait until the hand ends, then send."},400);
    const amt=Math.floor(+b.amount||0);
    if(amt<=0) return json(res,{error:"Invalid amount."},400);
    if(amt>from.chips) return json(res,{error:"You only have "+from.chips+" chips."},400);
    from.chips-=amt; to.chips+=amt;
    banner(from.name+" sent "+amt+" chips to "+to.name+".");
    broadcast(); return json(res,{ok:1});
  }

  if(req.method==="POST"&&path==="/api/reset"){
    const b=await body(req);
    G.seq++;
    const keep = b.full ? [] : G.players.filter(p=>!p.isAI&&!p.removed);
    keep.forEach(p=>{ p.hole=[]; p.folded=false; p.allIn=false; p.bet=0; p.total=0;
      p.need=false; p.inHand=false; p.won=false; p.showName=""; p.handsWon=0; p.removed=false; p.wagered=0; });
    G.players=keep;
    if(b.portal) G.game=null;
    G.phase="lobby"; G.dealer=-1; G.sb=-1; G.bb=-1; G.stage=0; G.board=[]; G.deck=[];
    G.curBet=0; G.betsCount=0; G.turn=-1; G.handOver=false; G.banner=""; G.log=[]; G.revealAll=false;
    broadcast();
    return json(res,{ok:1});
  }

  /* ---------- 大廳：排座位 ---------- */
  if(req.method==="POST"&&path==="/api/seatorder"){
    const b=await body(req);
    const busy=(G.game==="poker"&&G.phase==="play")||(G.game==="mahjong"&&M.phase==="play"&&!M.handOver)
      ||(G.game==="bridge"&&BR.phase==="play"&&!BR.handOver);
    if(busy) return json(res,{error:"牌局進行中 — 這一局結束再排座位。"},400);
    const humans=G.players.filter(p=>!p.isAI&&!p.removed);
    const k=humans.findIndex(p=>p.id===b.id);
    if(k<0) return json(res,{error:"找不到這位玩家。"},400);
    const j=k+(b.dir==="up"?-1:1);
    if(j<0||j>=humans.length) return json(res,{ok:1});
    const ia=G.players.indexOf(humans[k]), ib=G.players.indexOf(humans[j]);
    [G.players[ia],G.players[ib]]=[G.players[ib],G.players[ia]];
    broadcast(); return json(res,{ok:1});
  }

  /* ---------- portal ---------- */
  if(req.method==="POST"&&path==="/api/portal"){
    const b=await body(req);
    const busy=(G.game==="poker"&&G.phase==="play")||(G.game==="mahjong"&&M.phase==="play"&&!M.handOver)
      ||(G.game==="bridge"&&BR.phase==="play"&&!BR.handOver);
    if(busy) return json(res,{error:"牌局進行中 — 先結束目前這局再換遊戲。"},400);
    G.game=(b.game==="poker"||b.game==="mahjong"||b.game==="bridge")?b.game:null;
    if(G.game!=="mahjong"&&M.phase==="play"){ M.phase="idle"; M.seq++; M.claimSeq++; }
    if(G.game!=="bridge"&&BR.phase==="play"){ BR.phase="idle"; BR.seq++; }
    broadcast(); return json(res,{ok:1});
  }

  /* ---------- mahjong ---------- */
  if(req.method==="POST"&&path==="/api/mj/start"){
    const b=await body(req);
    if(G.game!=="mahjong") return json(res,{error:"請先在大廳選擇麻將。"},400);
    if(M.phase==="play"&&!M.handOver) return json(res,{error:"已經開局。"},400);
    M.base=[10,20,30,50].includes(b.base)?b.base:30;
    M.taiVal=[5,10,20].includes(b.tai)?b.tai:10;
    // remove old bots, seat first 4 humans, fill with bots
    G.players=G.players.filter(p=>!p.isAI);
    const humans=G.players.filter(p=>!p.removed);
    if(humans.length<1) return json(res,{error:"至少要有一位玩家掃碼入座。"},400);
    const seated=humans.slice(0,4);
    for(let k=seated.length;k<4;k++){
      G.players.push({id:"mjai"+k,token:null,isAI:true,name:MJ_BOT_NAMES[k],chips:0,start:0,handsWon:0,
        hole:[],folded:false,allIn:false,bet:0,total:0,need:false,inHand:false,won:false,showName:"",
        connected:true,avatar:null,wagered:0,mjScore:0});
      seated.push(G.players[G.players.length-1]);
    }
    G.players.forEach(p=>{ p.mjScore=0; });
    M.seats=seated.map(p=>({pi:G.players.indexOf(p),hand:[],melds:[],flowers:[],discards:[],drawn:null,auto:false}));
    M.starter=-1; M.handCount=0; M.log=[]; M.banner="";
    mjNewHand();
    return json(res,{ok:1});
  }

  if(req.method==="POST"&&path==="/api/mj/discard"){
    const b=await body(req);
    const pi=G.players.findIndex(p=>p.token===b.token);
    const s=M.seats.findIndex(st=>st.pi===pi);
    if(pi<0||s<0) return json(res,{error:"你沒有入座。"},400);
    if(M.handOver||M.turn!==s||M.pending) return json(res,{error:"還沒輪到你。"},400);
    if(!mjDiscard(s,b.tile|0)) return json(res,{error:"不能打這張。"},400);
    return json(res,{ok:1});
  }

  if(req.method==="POST"&&path==="/api/mj/self"){
    const b=await body(req);
    const pi=G.players.findIndex(p=>p.token===b.token);
    const s=M.seats.findIndex(st=>st.pi===pi);
    if(pi<0||s<0) return json(res,{error:"你沒有入座。"},400);
    if(M.handOver||M.turn!==s||M.pending) return json(res,{error:"還沒輪到你。"},400);
    const o=selfOptions(s);
    if(b.action==="win"){ if(!o.win) return json(res,{error:"這手還不能胡。"},400); mjWin(s,null,{}); }
    else if(b.action==="angang"){ if(!o.angang.includes(b.tile|0)) return json(res,{error:"不能暗槓。"},400); doAngang(s,b.tile|0); }
    else if(b.action==="jiagang"){ if(!o.jiagang.includes(b.tile|0)) return json(res,{error:"不能加槓。"},400); startJiagang(s,b.tile|0); }
    else return json(res,{error:"Bad action."},400);
    return json(res,{ok:1});
  }

  if(req.method==="POST"&&path==="/api/mj/claim"){
    const b=await body(req);
    const pi=G.players.findIndex(p=>p.token===b.token);
    const s=M.seats.findIndex(st=>st.pi===pi);
    if(pi<0||s<0) return json(res,{error:"你沒有入座。"},400);
    const r=b.resp||{};
    if(!["pass","win","pong","gang","chi"].includes(r.t)) return json(res,{error:"Bad claim."},400);
    if(!mjClaimResp(s,r)) return json(res,{error:"沒有可以宣告的動作。"},400);
    broadcast();
    return json(res,{ok:1});
  }

  if(req.method==="POST"&&path==="/api/mj/groups"){
    const b=await body(req);
    const pi=G.players.findIndex(p=>p.token===b.token);
    const s=M.seats.findIndex(st=>st.pi===pi);
    if(pi<0||s<0) return json(res,{error:"\u4f60\u6c92\u6709\u5165\u5ea7\u3002"},400);
    const st=M.seats[s];
    const hand=st.hand.concat(st.drawn!==null&&st.drawn!==undefined?[st.drawn]:[]);
    if(!hand.length) return json(res,{ok:1,groups:[]});
    let groups=[];
    try{ groups=mjGroupPlan(hand); }catch(e){ return json(res,{error:"\u7406\u4e0d\u52d5\uff0c\u81ea\u5df1\u6392\u5427"},400); }
    const need=16-3*st.melds.length;
    const sh=mjShanten(countsOf(st.hand),Math.floor(need/3));
    return json(res,{ok:1,groups,shanten:sh});
  }

  if(req.method==="POST"&&path==="/api/mj/next"){
    if(G.game!=="mahjong"||M.phase!=="play"||!M.handOver) return json(res,{error:"這局還沒結束。"},400);
    mjNewHand(); return json(res,{ok:1});
  }

  if(req.method==="POST"&&path==="/api/mj/auto"){
    const b=await body(req);
    const s=b.seat|0;
    if(!(s>=0&&s<4)||!M.seats[s]) return json(res,{error:"Bad seat."},400);
    if(seatP(s).isAI) return json(res,{error:"這是電腦玩家。"},400);
    M.seats[s].auto=!M.seats[s].auto;
    mjBanner(seatName(s)+(M.seats[s].auto?" 改由電腦代打。":" 恢復自己打。"));
    broadcast();
    if(M.seats[s].auto) mjResumeAuto(s);
    return json(res,{ok:1});
  }

  if(req.method==="POST"&&path==="/api/mj/reset"){
    const b=await body(req);
    M.phase="idle"; M.seq++; M.claimSeq++; M.seats=[]; M.handOver=false; M.winInfo=null;
    M.banner=""; M.log=[]; M.handCount=0;
    G.players=G.players.filter(p=>!p.isAI);
    if(b.portal) G.game=null;
    broadcast(); return json(res,{ok:1});
  }


  /* ---------- bridge 橋牌 ---------- */
  if(req.method==="POST"&&path==="/api/br/start"){
    if(G.game!=="bridge") return json(res,{error:"請先在大廳選擇橋牌。"},400);
    if(BR.phase==="play"&&!BR.handOver) return json(res,{error:"已經開局。"},400);
    G.players=G.players.filter(p=>!p.isAI);
    const humans=G.players.filter(p=>!p.removed);
    if(humans.length<1) return json(res,{error:"至少要有一位玩家掃碼入座。"},400);
    const seated=humans.slice(0,4);
    for(let k=seated.length;k<4;k++){
      G.players.push({id:"brai"+k,token:null,isAI:true,name:BR_BOT_NAMES[k],chips:0,start:0,handsWon:0,
        hole:[],folded:false,allIn:false,bet:0,total:0,need:false,inHand:false,won:false,showName:"",
        connected:true,avatar:null,wagered:0,brScore:0});
      seated.push(G.players[G.players.length-1]);
    }
    G.players.forEach(p=>{ p.brScore=0; });
    BR.seats=seated.map(p=>({pi:G.players.indexOf(p),hand:[],auto:false,voids:[false,false,false,false]}));
    BR.rub={games:[0,0],below:[0,0],above:[0,0],total:[0,0],rubbers:[0,0],hist:[]};
    BR.board=0; BR.dealer=3; BR.log=[]; BR.banner="";
    brNewDeal();
    return json(res,{ok:1});
  }
  if(req.method==="POST"&&path==="/api/br/call"){
    const b=await body(req);
    const pi=G.players.findIndex(p=>p.token===b.token);
    const s=BR.seats.findIndex(st=>st.pi===pi);
    if(pi<0||s<0) return json(res,{error:"你沒有入座。"},400);
    if(G.game!=="bridge"||BR.stage!=="auction"||BR.handOver) return json(res,{error:"現在不是叫牌階段。"},400);
    if(BR.turn!==s||BR.seats[s].auto) return json(res,{error:"還沒輪到你。"},400);
    const c=b.call||{};
    if(!["P","X","XX","B"].includes(c.t)) return json(res,{error:"Bad call."},400);
    const call={t:c.t,lvl:c.lvl|0,str:c.str|0};
    if(!brCall(s,call)) return json(res,{error:"這個叫品不合法｜That call is not legal."},400);
    return json(res,{ok:1});
  }
  if(req.method==="POST"&&path==="/api/br/play"){
    const b=await body(req);
    const pi=G.players.findIndex(p=>p.token===b.token);
    const s=BR.seats.findIndex(st=>st.pi===pi);
    if(pi<0||s<0) return json(res,{error:"你沒有入座。"},400);
    if(G.game!=="bridge"||BR.stage!=="play"||BR.handOver) return json(res,{error:"現在不是打牌階段。"},400);
    if(brController(BR.turn)!==s||BR.seats[s].auto) return json(res,{error:"還沒輪到你。"},400);
    if(!brPlay(BR.turn,b.card|0)) return json(res,{error:"這張牌不能出（必須跟花色）｜Illegal card — you must follow suit."},400);
    return json(res,{ok:1});
  }
  if(req.method==="POST"&&path==="/api/br/next"){
    if(G.game!=="bridge"||BR.phase!=="play"||!BR.handOver) return json(res,{error:"這副還沒結束。"},400);
    brNewDeal(); return json(res,{ok:1});
  }
  if(req.method==="POST"&&path==="/api/br/auto"){
    const b=await body(req);
    const s=b.seat|0;
    if(!(s>=0&&s<4)||!BR.seats[s]) return json(res,{error:"Bad seat."},400);
    if(brSeatP(s).isAI) return json(res,{error:"這是電腦玩家。"},400);
    BR.seats[s].auto=!BR.seats[s].auto;
    brBanner(brName(s)+(BR.seats[s].auto?" 改由電腦代打｜computer takes over":" 恢復自己打｜back in the driver's seat"));
    broadcast();
    if(BR.seats[s].auto) brResumeAuto(s);
    return json(res,{ok:1});
  }
  if(req.method==="POST"&&path==="/api/br/endrubber"){
    if(G.game!=="bridge"||!BR.seats.length) return json(res,{error:"還沒開局。"},400);
    brEndRubber(); return json(res,{ok:1});
  }
  if(req.method==="POST"&&path==="/api/br/reset"){
    const b=await body(req);
    BR.phase="idle"; BR.seq++; BR.seats=[]; BR.handOver=false; BR.result=null;
    BR.banner=""; BR.log=[]; BR.board=0; BR.auction=[]; BR.contract=null; BR.trick=[]; BR.trickHist=[];
    BR.rub={games:[0,0],below:[0,0],above:[0,0],total:[0,0],rubbers:[0,0],hist:[]};
    G.players=G.players.filter(p=>!p.isAI);
    if(b.portal) G.game=null;
    broadcast(); return json(res,{ok:1});
  }

  res.writeHead(404); res.end("Not found");
});

/* ================= SHARED CSS ================= */
const CSS=`
:root{--felt:#26604a;--felt-deep:#1b4a38;--rail:#4a382a;--cream:#f7f3e8;--ink:#23261f;
--line:#dcd4c0;--gold:#d9a441;--red-suit:#bb4130;--mut:#8a8474;--ok:#3f7d5a;--warn:#a3542e;}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent;}
body{background:var(--cream);color:var(--ink);font-family:"Avenir Next","Segoe UI",system-ui,sans-serif;min-height:100vh;}
.disp{font-family:Palatino,"Palatino Linotype",Georgia,serif;}
.card{width:46px;height:66px;border-radius:6px;background:#fdfcf7;color:#2a2d31;display:flex;flex-direction:column;
justify-content:center;align-items:center;font-weight:700;font-size:1.1rem;box-shadow:0 1px 3px rgba(0,0,0,.35);border:1px solid #e6e0d0;}
.card .s{font-size:1rem;line-height:1;}
.card.red{color:var(--red-suit);}
.card.back{background:repeating-linear-gradient(45deg,#7d4b3a 0 6px,#6d3f30 6px 12px);border-color:#5c352a;}
.card.slot{background:rgba(255,255,255,.07);border:1px dashed rgba(255,255,255,.25);box-shadow:none;}
.card.sm{width:36px;height:50px;font-size:.9rem;} .card.sm .s{font-size:.78rem;}
.card.xl{width:88px;height:124px;font-size:2rem;} .card.xl .s{font-size:1.7rem;}
.badge{font-size:.62rem;padding:1px 6px;border-radius:6px;background:var(--ink);color:#fff;}
.badge.d{background:var(--gold);color:#3d2f10;} .badge.ai{background:#7a86a0;}
.badge.fold{background:#b0aa99;} .badge.allin{background:var(--warn);} .badge.win{background:var(--ok);}
.badge.off{background:#b45050;}
.tbtn{border:1px solid var(--line);background:#fff;border-radius:8px;padding:7px 12px;font-size:.8rem;cursor:pointer;color:var(--ink);}
.tbtn.on{background:var(--ink);color:#fff;border-color:var(--ink);}
table.st{width:100%;border-collapse:collapse;font-size:.9rem;}
table.st th{background:#6c757d;color:#fff;text-align:left;padding:8px 9px;font-weight:600;}
table.st td{padding:8px 9px;border-bottom:1px solid var(--line);}
.pos{color:var(--ok);font-weight:600;}.neg{color:var(--warn);font-weight:600;}
.hidden{display:none!important;}
`;

/* ===== shared PORTAL (identical on TV and on every phone) ===== */
const PORTAL_CSS=`
.lobbyGrid{display:grid;grid-template-columns:270px 1fr;gap:24px;align-items:start;}
@media(max-width:700px){.lobbyGrid{grid-template-columns:1fr;gap:16px;}}
.qrBox{background:#fff;border:1px solid var(--line);border-radius:14px;padding:16px;text-align:center;}
.qrBox #qr2{display:flex;justify-content:center;margin:8px 0;}
.qrBox .url{font-size:1rem;font-weight:700;word-break:break-all;}
.pl{list-style:none;} .pl li{padding:10px 4px;border-bottom:1px solid var(--line);font-size:1rem;display:flex;gap:8px;align-items:center;}
.av{width:26px;height:26px;border-radius:50%;background:#e4ddc9 center/cover no-repeat;display:inline-block;border:1px solid var(--line);flex:none;}
.codeChip{display:inline-block;vertical-align:middle;margin-left:10px;font-family:ui-monospace,Menlo,Consolas,monospace;letter-spacing:.22em;font-size:1rem;background:var(--ink);color:var(--gold);border-radius:8px;padding:4px 12px 4px 14px;}
.steps{list-style:none;display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 8px;padding:0;}
.steps li{display:flex;align-items:center;gap:7px;font-size:.82rem;color:var(--mut);background:#fff;border:1px solid var(--line);border-radius:999px;padding:5px 13px 5px 6px;}
.steps li b{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:#eee7d8;color:var(--mut);font-size:.72rem;}
.steps li.on{color:var(--ink);border-color:var(--felt);box-shadow:inset 0 0 0 1px var(--felt);font-weight:700;}
.steps li.on b{background:var(--felt);color:#fff;}
.steps li.done{color:var(--ok);} .steps li.done b{background:var(--ok);color:#fff;}
.nowBar{display:flex;align-items:center;gap:9px;flex-wrap:wrap;background:#fff;border:1px solid var(--line);border-left:4px solid var(--gold);border-radius:0 11px 11px 0;padding:10px 13px;font-size:.9rem;margin-bottom:6px;}
.nowDot{width:8px;height:8px;border-radius:50%;background:var(--gold);flex:none;}
.goBtn{margin-left:auto;border:0;border-radius:9px;background:var(--felt);color:#fff;font-weight:700;font-size:.92rem;padding:10px 20px;cursor:pointer;}
.seatMove{display:inline-flex;gap:2px;margin-left:4px;}
.seatMove button{border:1px solid var(--line);background:#fff;border-radius:5px;font-size:.62rem;line-height:1;padding:3px 5px;cursor:pointer;color:var(--mut);}
.seatMove button:disabled{opacity:.25;cursor:not-allowed;}
.pl li .seatNo{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:var(--felt);color:#fff;font-size:.72rem;font-weight:700;flex:none;}
.pl li .seatTag{font-size:.66rem;letter-spacing:.06em;background:#eee7d8;color:var(--mut);border-radius:5px;padding:1px 6px;}
.pl li .kick{margin-left:auto;}
.gameCards{display:flex;gap:18px;flex-wrap:wrap;margin:16px 0;}
.gameCard{flex:1;min-width:200px;background:#fff;border:2px solid var(--line);border-radius:16px;padding:26px 20px;text-align:center;cursor:pointer;transition:.15s;}
.gameCard:hover{border-color:var(--gold);transform:translateY(-2px);}
.gameCard.on{border-color:var(--felt);box-shadow:inset 0 0 0 2px var(--felt);}
.gameCard .big{font-size:2.4rem;}
.gameCard h2{font-size:1.35rem;margin:8px 0 4px;}
.gameCard .gcsub{color:var(--mut);font-size:.8rem;}
.gameCard .live{display:inline-block;margin-top:7px;font-size:.68rem;letter-spacing:.1em;background:var(--felt);color:#fff;border-radius:6px;padding:2px 8px;}
`;
const PORTAL_BODY=`
  <h1 class="disp">盧家遊樂園 · Lu Family Game Portal <span class="codeChip" id="tableCode">—</span></h1>
  <div class="sub" id="portalSub"></div>
  <ol class="steps" id="setupSteps">
    <li data-k="1"><b>1</b> 掃碼入座</li>
    <li data-k="2"><b>2</b> 排座位</li>
    <li data-k="3"><b>3</b> 選遊戲</li>
    <li data-k="4"><b>4</b> 開始</li>
  </ol>
  <div class="nowBar"><span class="nowDot"></span><span id="setupHint"></span><button class="goBtn hidden" id="setupGo"></button></div>
  <div class="lobbyGrid">
    <div class="qrBox">
      <div style="font-size:.8rem;color:var(--mut)">Scan to join · 掃碼入座</div>
      <div id="qr2"></div>
      <div class="url" id="joinUrl2"></div>
    </div>
    <div>
      <h3 class="disp">已入座 Players <span style="font-size:.72rem;color:var(--mut);font-weight:400">— 座位順序就是入座順序（麻將、橋牌照這個排）</span></h3>
      <ul class="pl" id="portalList"></ul>
      <div class="sub" id="portalSeatHint" style="margin:2px 0 0"></div>
      <div class="gameCards">
        <div class="gameCard" id="gcPoker" onclick="api('/api/portal',{game:'poker'})">
          <div class="big">🃏</div><h2>德州撲克</h2>
          <div class="gcsub">Family Hold'em · 2–5人 · AI 補位</div>
          <div class="live hidden" id="gcPokerLive">進行中 LIVE</div>
        </div>
        <div class="gameCard" id="gcMahjong" onclick="api('/api/portal',{game:'mahjong'})">
          <div class="big">🀄</div><h2>台灣麻將</h2>
          <div class="gcsub">十六張 · 4人 · 電腦補位 · 底＋台計分</div>
          <div class="live hidden" id="gcMahjongLive">進行中 LIVE</div>
        </div>
        <div class="gameCard" id="gcBridge" onclick="api('/api/portal',{game:'bridge'})">
          <div class="big">\u2660\u2665</div><h2>橋牌 Bridge</h2>
          <div class="gcsub">Contract Bridge · 4人 · 電腦高手補位 · 局盤 Rubber 計分</div>
          <div class="live hidden" id="gcBridgeLive">進行中 LIVE</div>
        </div>
        <div class="gameCard" id="gcBig2" onclick="location.href='/dalaoer'">
          <div class="big">🀫</div><h2>大老二</h2>
          <div class="gcsub">Big Two · 4人 · 電腦補位 · 盧家玩法</div>
        </div>
      </div>
    </div>
  </div>
`;
const PORTAL_JS=`
function seatMove(id,dir){ api("/api/seatorder",{id:id,dir:dir}); }
var GAME_LABEL={poker:"\u5fb7\u5dde\u64b2\u514b",mahjong:"\u53f0\u7063\u9ebb\u5c07",bridge:"\u6a4b\u724c Bridge"};
function renderSetup(list,host){
  var codeEl=document.getElementById("tableCode");
  if(codeEl) codeEl.textContent=(window.__code||"\u2014");
  var su=(window.__setup)||{humans:list.length,game:null,running:false};
  var n=list.length, g=su.game, running=!!su.running;
  var step = running?4 : (!n?1 : (!g?3 : 4));
  var lis=document.querySelectorAll("#setupSteps li");
  for(var i=0;i<lis.length;i++){
    var k=i+1;
    lis[i].className = k<step?"done" : (k===step?"on":"");
  }
  var hintEl=document.getElementById("setupHint"), goEl=document.getElementById("setupGo");
  if(!hintEl||!goEl) return;
  var need4=(g==="mahjong"||g==="bridge");
  var txt="", go=null, label="";
  if(running){ txt="\u724c\u5c40\u9032\u884c\u4e2d \u2014 "+(GAME_LABEL[g]||"")+"\uff0c\u5207\u5230\u300c3 \u00b7 \u724c\u684c\u300d\u770b\u724c";
    label="\u56de\u724c\u684c \u2192"; go=function(){ setView(3); }; }
  else if(!n){ txt="\u7b49\u5bb6\u4eba\u7528\u624b\u6a5f\u6383\u4e0a\u9762\u7684 QR \u2014 \u6383\u5b8c\u540d\u5b57\u6703\u51fa\u73fe\u5728\u9019\u4e00\u5217"; }
  else if(!g){ txt=n+" \u4eba\u5165\u5ea7\u3002\u7528 \u25b2\u25bc \u6392\u597d\u5ea7\u4f4d\uff0c\u7136\u5f8c\u9ede\u4e0b\u9762\u7684\u904a\u6232\u5361"; }
  else {
    var fill = need4 ? Math.max(0,4-n) : 0;
    txt=(GAME_LABEL[g]||"")+" \u5df2\u9078\u3002"+n+" \u4eba\u5165\u5ea7"
      +(fill?"\uff0c\u7f3a\u7684 "+fill+" \u5bb6\u7531\u96fb\u8166\u88dc\u4f4d":"")+"\u3002";
    if(g==="bridge"){ label="\u958b\u59cb\u6a4b\u724c"; go=function(){ api("/api/br/start"); }; }
    else if(g==="mahjong"){ label="\u958b\u59cb\u9ebb\u5c07"; go=function(){ api("/api/mj/start",{base:30,tai:10}); }; }
    else { label="\u53bb\u8a2d\u5b9a\u7c4c\u78bc \u2192"; go=function(){ setView(2); }; }
    if(g!=="poker") txt+="\u8981\u6539\u5e95\u53f0\u3001\u7c4c\u78bc\u9019\u4e9b\u8a2d\u5b9a\uff0c\u5207\u5230\u300c2 \u00b7 \u8a2d\u5b9a\u300d\u3002";
  }
  hintEl.textContent=txt;
  if(host&&go){ goEl.classList.remove("hidden"); goEl.textContent=label; goEl.onclick=go; }
  else goEl.classList.add("hidden");
}
const joinUrl2=location.origin+"/join";
document.getElementById("joinUrl2").textContent=joinUrl2;
try{ new QRCode(document.getElementById("qr2"),{text:joinUrl2,width:190,height:190}); }
catch(e){ document.getElementById("qr2").innerHTML='<div style="font-size:.8rem;color:#a3542e">No internet for QR lib — type the URL below into each phone.</div>'; }
function pEsc(t){ return String(t).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function renderPortal(){
  const list=(S&&S.roster&&S.roster.length)? S.roster : ((S&&S.players)||[]).filter(function(p){return !p.isAI;});
  const SEATN=["N \u5317","E \u6771","S \u5357","W \u897F"];
  const host=(typeof IS_HOST!=="undefined")&&IS_HOST;
  document.getElementById("portalList").innerHTML= list.length
    ? list.map(function(p,i){
        return '<li>'
          +'<span class="seatNo">'+(i+1)+'</span>'
          +(p.avatar?'<span class="av" style="background-image:url('+p.avatar+')"></span>':'\u{1F4F1}')
          +' '+pEsc(p.name)
          +(i<4?' <span class="seatTag">'+SEATN[i]+'</span>':'')
          +(p.connected===false?' <span class="badge off">offline</span>':'')
          +(host?' <span class="seatMove">'
              +'<button onclick="seatMove(&#39;'+p.id+'&#39;,&#39;up&#39;)" '+(i===0?'disabled':'')+'>\u25b2</button>'
              +'<button onclick="seatMove(&#39;'+p.id+'&#39;,&#39;down&#39;)" '+(i===list.length-1?'disabled':'')+'>\u25bc</button>'
            +'</span>':'')
          +(host?' <button class="kick" onclick="portalKick(&#39;'+p.id+'&#39;)">\u79fb\u9664 remove</button>':'')
          +'</li>'; }).join("")
    : '<li style="color:var(--mut)">Waiting for phones\u2026</li>';
  renderSetup(list, host);
  var hint=document.getElementById("portalSeatHint");
  if(hint) hint.textContent = list.length
    ? (host? "\u5165\u5ea7\u3001\u6392\u5e8f\u3001\u8acb\u4eba\u4e0b\u684c \u2014 \u5168\u90e8\u5728\u9019\u4e00\u5c64\u505a\uff0c\u4e0d\u7528\u9032\u904a\u6232"
             : "\u8981\u79fb\u9664\u4eba\uff0c\u8acb\u5728\u5927\u87a2\u5e55\u7684\u5927\u5ef3\u64cd\u4f5c")
    : "";
  const g=(typeof GAME==="undefined")?null:GAME;
  document.getElementById("gcPoker").classList.toggle("on",g==="poker");
  document.getElementById("gcMahjong").classList.toggle("on",g==="mahjong");
  document.getElementById("gcPokerLive").classList.toggle("hidden",g!=="poker");
  document.getElementById("gcMahjongLive").classList.toggle("hidden",g!=="mahjong");
  document.getElementById("gcBridge").classList.toggle("on",g==="bridge");
  document.getElementById("gcBridgeLive").classList.toggle("hidden",g!=="bridge");
  document.getElementById("portalSub").textContent =
    g==="poker" ? "德州撲克進行中 — 切到 3 · 牌桌繼續"
    : g==="mahjong" ? "台灣麻將進行中 — 切到 3 · 牌桌繼續"
    : g==="bridge" ? "橋牌進行中 — 切到 3 · 牌桌繼續"
    : "手機掃碼入座 — 全家同一個入口，在這裡選遊戲";
}
`;


/* ===== BRIDGE 橋牌 ===== */
const BRIDGE_CSS=`
.brTable{display:grid;grid-template-columns:1fr 1.35fr 1fr;grid-template-rows:auto minmax(140px,1fr) auto;gap:8px;
background:radial-gradient(ellipse at 50% 50%,var(--felt) 0%,var(--felt-deep) 100%);border:8px solid var(--rail);
border-radius:20px;padding:12px;box-shadow:inset 0 0 55px rgba(0,0,0,.32);}
.brSeat{background:#fff;border:1px solid var(--line);border-radius:12px;padding:7px 9px;box-shadow:0 2px 8px rgba(0,0,0,.22);align-self:center;min-width:0;}
.brSeat.turn{border-color:var(--gold);box-shadow:0 0 0 3px var(--gold),0 2px 8px rgba(0,0,0,.22);}
.brSeat.top{grid-column:2;grid-row:1;} .brSeat.bottom{grid-column:2;grid-row:3;}
.brSeat.left{grid-column:1;grid-row:2;} .brSeat.right{grid-column:3;grid-row:2;}
.brSeat .hd{display:flex;gap:6px;align-items:center;font-size:.85rem;font-weight:700;flex-wrap:wrap;}
.brSeat .hd .rt{margin-left:auto;font-size:.72rem;color:var(--mut);font-weight:600;}
.brSeat .dh{display:flex;gap:2px;flex-wrap:wrap;margin-top:5px;}
.brSeat .dh .brSuitRow{flex-basis:100%;}
.brCenter{grid-column:2;grid-row:2;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#eef2ec;text-align:center;gap:4px;}
.brTrick{display:grid;grid-template-columns:repeat(3,auto);grid-template-rows:repeat(3,auto);gap:3px;justify-items:center;align-items:center;min-height:120px;}
.brTrick .tN{grid-column:2;grid-row:1;} .brTrick .tS{grid-column:2;grid-row:3;}
.brTrick .tW{grid-column:1;grid-row:2;} .brTrick .tE{grid-column:3;grid-row:2;}
.brTrick .tM{grid-column:2;grid-row:2;font-size:.7rem;color:#bfd6c6;}
.brTrick .meSlot{outline:2px dashed var(--felt);outline-offset:3px;border-radius:8px;}
.badge.dec{background:#8a5a18;} .badge.dum{background:#4a6b8a;} .badge.vul{background:#b02c22;}
.badge.seat{background:var(--felt);}
table.auc{border-collapse:collapse;font-size:.86rem;background:#fff;border:1px solid var(--line);border-radius:10px;overflow:hidden;}
table.auc th{background:#6c757d;color:#fff;padding:5px 12px;font-weight:600;}
table.auc th.dl{background:var(--gold);color:#3d2f10;}
table.auc td{padding:4px 12px;border-bottom:1px solid var(--line);text-align:center;min-width:52px;}
table.auc td.cur{background:#fff8ea;font-weight:700;}
.redS{color:var(--red-suit);}
table.rub{border-collapse:collapse;font-size:.85rem;background:#fff;border:1px solid var(--line);width:100%;}
table.rub th{background:#6c757d;color:#fff;padding:6px 9px;text-align:left;font-weight:600;}
table.rub td{padding:5px 9px;border-bottom:1px solid var(--line);}
table.rub tr.ln td{border-bottom:3px solid var(--ink);}
.brBox{background:#fff;border:1px solid var(--line);border-radius:13px;padding:11px 14px;}
.brGrid{display:grid;grid-template-columns:1fr 300px;gap:12px;align-items:start;margin-top:10px;}
@media(max-width:820px){.brGrid{grid-template-columns:1fr;}}
.bidGrid{display:grid;grid-template-columns:repeat(5,1fr);gap:4px;}
.bidGrid button{padding:11px 2px;border:1px solid var(--line);background:#fff;border-radius:8px;font-size:.9rem;font-weight:700;cursor:pointer;color:var(--ink);}
.bidGrid button.off{opacity:.25;cursor:not-allowed;}
.bidRow{display:flex;gap:7px;margin-top:8px;}
.bidRow button{flex:1;padding:13px 4px;border:0;border-radius:11px;font-size:.95rem;font-weight:700;cursor:pointer;}
.bidRow .bPass{background:#eee7d8;color:var(--ink);} .bidRow .bDbl{background:var(--warn);color:#fff;}
.bidRow .bRdbl{background:#b02c22;color:#fff;} .bidRow button:disabled{opacity:.3;}
.brHand{display:flex;gap:3px;flex-wrap:wrap;padding:6px 0;}
.brHand .card{cursor:default;transition:.12s;}
.brHand.live .card.ok{cursor:pointer;box-shadow:0 0 0 2px var(--ok),0 1px 3px rgba(0,0,0,.35);}
.brHand.live .card.ok:hover{transform:translateY(-7px);}
.brHand .card.no{opacity:.4;}
.brSuitRow{display:flex;gap:3px;align-items:center;margin-bottom:3px;flex-wrap:wrap;}
.brSuitRow .sl{width:18px;font-size:1rem;font-weight:700;flex:none;}
.brTurnLn{font-weight:700;color:var(--gold);min-height:1.3em;}
.brNote{font-size:.78rem;color:var(--mut);}
.brResult{background:#fff8ea;border:2px solid var(--gold);border-radius:12px;padding:12px 14px;margin-top:10px;}
.brResult h4{font-size:1.05rem;margin-bottom:6px;}
.brResult table{width:100%;border-collapse:collapse;font-size:.85rem;}
.brResult td{padding:3px 6px;border-bottom:1px solid var(--line);}
.brResult td.n{text-align:right;font-weight:700;}
`;

/* ================= HOST (TV) PAGE ================= */
const HOST_HTML=`<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>盧家遊樂園 · Lu Family Portal</title>
<style>${CSS}${PORTAL_CSS}${BRIDGE_CSS}
.qrBox #qr,.qrBox #qr3,.qrBox #qr4{display:flex;justify-content:center;margin:8px 0;}
.wrap{max-width:1100px;margin:0 auto;padding:18px 16px;}
.card{width:55px;height:79px;font-size:1.3rem;border-radius:7px;}
.card .s{font-size:1.2rem;}
.card.sm{width:43px;height:60px;font-size:1.05rem;}
.card.sm .s{font-size:.92rem;}
h1{font-size:1.7rem;} .sub{color:var(--mut);font-size:.85rem;margin:2px 0 14px;}
.lobbyGrid{display:grid;grid-template-columns:270px 1fr;gap:24px;align-items:start;}
@media(max-width:700px){.lobbyGrid{grid-template-columns:1fr;}}
.qrBox{background:#fff;border:1px solid var(--line);border-radius:14px;padding:16px;text-align:center;}
.qrBox #qr{display:flex;justify-content:center;margin:8px 0;}
.qrBox .url{font-size:1.05rem;font-weight:700;word-break:break-all;}
.pl{list-style:none;} .pl li{padding:10px 4px;border-bottom:1px solid var(--line);font-size:1rem;display:flex;gap:8px;align-items:center;}
.opts{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0;}
.pill{display:flex;border:1px solid var(--line);border-radius:8px;overflow:hidden;}
.pill button{border:0;background:#fff;padding:8px 13px;font-size:.85rem;cursor:pointer;color:var(--mut);}
.pill button.on{background:var(--felt);color:#fff;}
.startBtn{padding:13px 30px;border:0;border-radius:10px;background:var(--felt);color:#fff;font-size:1.05rem;font-weight:700;cursor:pointer;}
.bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px;}
.bar .tag{font-size:.75rem;color:var(--mut);margin-right:auto;}
.tableWrap{position:relative;width:100%;padding-bottom:56%;margin-top:4px;}
.felt{position:absolute;inset:10% 5%;background:radial-gradient(ellipse at 50% 30%,var(--felt) 0%,var(--felt-deep) 100%);
border:9px solid var(--rail);border-radius:50%/50%;box-shadow:inset 0 0 60px rgba(0,0,0,.3),0 4px 14px rgba(0,0,0,.25);}
.feltRing{position:absolute;inset:13% 8%;border:2px solid rgba(255,255,255,.12);border-radius:50%/50%;}
.center{position:absolute;left:50%;top:47%;transform:translate(-50%,-50%);text-align:center;color:#eef2ec;width:56%;z-index:6;}
.nextBtn{margin:10px auto 0;display:inline-block;padding:11px 32px;border:0;border-radius:10px;background:var(--gold);color:#3d2f10;font-weight:700;font-size:1rem;cursor:pointer;box-shadow:0 3px 10px rgba(0,0,0,.3);}
.stage{font-size:.72rem;letter-spacing:.2em;text-transform:uppercase;color:#bfd6c6;}
.board{display:flex;gap:7px;justify-content:center;margin:8px 0 6px;min-height:66px;}
.pot{font-size:1.05rem;} .pot b{color:var(--gold);}
.banner{margin-top:6px;font-size:.95rem;min-height:1.3em;color:#f4e6c8;}
.log{font-size:.68rem;color:#c9d8cd;margin-top:4px;min-height:1em;}
.seatAbs{position:absolute;transform:translate(-50%,-50%);width:160px;background:#fff;border:1px solid var(--line);
border-radius:13px;padding:8px 9px;box-shadow:0 3px 10px rgba(0,0,0,.18);}
.seatAbs.turn{border-color:var(--gold);box-shadow:0 0 0 3px var(--gold),0 3px 10px rgba(0,0,0,.2);}
.seatAbs.out{opacity:.55;}
.seatAbs .nm{font-weight:700;font-size:.84rem;display:flex;gap:5px;align-items:center;flex-wrap:wrap;}
.seatAbs .chips{font-size:.82rem;color:var(--mut);}
.seatAbs .betAmt{font-size:.74rem;color:var(--warn);min-height:1em;}
.seatAbs .hole{display:flex;gap:4px;margin-top:5px;min-height:52px;}
.seatAbs .hn{font-size:.68rem;color:var(--ok);min-height:.9em;}
.kick{border:1px solid #c98484;background:#fbeeee;color:#8c2f2f;border-radius:6px;font-size:.62rem;padding:2px 6px;cursor:pointer;margin-left:auto;}
.av{width:26px;height:26px;border-radius:50%;background:#e4ddc9 center/cover no-repeat;display:inline-block;border:1px solid var(--line);flex:none;}
@media(max-width:760px){.tableWrap{padding-bottom:135%;}.seatAbs{width:120px;padding:6px;}.center{width:72%;}
.card{width:36px;height:52px;font-size:.9rem;}.card.sm{width:30px;height:44px;font-size:.8rem;}}
.panel{position:fixed;inset:0;background:rgba(30,32,28,.5);z-index:55;display:flex;align-items:center;justify-content:center;}
.panelIn{background:var(--cream);border-radius:16px;width:92%;max-width:640px;padding:20px;max-height:80vh;overflow:auto;}
.closeRow{margin-top:14px;text-align:center;}
.miniBtn{border:1px solid var(--line);background:#fff;border-radius:7px;padding:5px 10px;font-size:.75rem;cursor:pointer;}
/* ---- portal & mahjong (host) ---- */
.gameCards{display:flex;gap:18px;flex-wrap:wrap;margin:16px 0;}
.gameCard{flex:1;min-width:220px;background:#fff;border:2px solid var(--line);border-radius:16px;padding:26px 20px;text-align:center;cursor:pointer;transition:.15s;}
.gameCard:hover{border-color:var(--gold);transform:translateY(-2px);}
.gameCard .big{font-size:2.4rem;}
.gameCard h2{font-size:1.35rem;margin:8px 0 4px;}
.gameCard .gcsub{color:var(--mut);font-size:.8rem;}
.mtile{display:inline-flex;flex-direction:column;align-items:center;justify-content:center;width:36px;height:50px;background:#fdfcf7;border:1px solid #cfc7b2;border-radius:5px;font-weight:700;box-shadow:0 1px 2px rgba(0,0,0,.2);flex:none;}
.mtile .mn{font-size:.95rem;line-height:1.1;}
.mtile .ms{font-size:.7rem;line-height:1.05;}
.mtile .mh{font-size:1.15rem;}
.mtile.sm{width:27px;height:38px;border-radius:4px;}
.mtile.sm .mn{font-size:.7rem;} .mtile.sm .ms{font-size:.54rem;} .mtile.sm .mh{font-size:.85rem;}
.mtile.wan{color:#a33c2f;} .mtile.tong{color:#23558c;} .mtile.tiao{color:#2e6e3e;}
.mtile.zhong{color:#b02c22;} .mtile.fa{color:#1e6b3c;} .mtile.bai{color:#7a8391;}
.mtile.wind{color:#23261f;}
.mtile.flo{background:#f7e9c8;color:#8a5a18;border-color:#dcb96a;}
.mtile.back{background:repeating-linear-gradient(45deg,#3f6e58 0 6px,#35604c 6px 12px);border-color:#2c5240;}
.mtile{overflow:hidden;padding:0;}
.mtile svg{display:block;width:100%;height:100%;}
.mtile.hot{outline:3px solid var(--gold);}
.mjRow{background:#fff;border:1px solid var(--line);border-radius:13px;padding:9px 12px;margin-bottom:9px;}
.mjRow.turn{border-color:var(--gold);box-shadow:0 0 0 2px var(--gold);}
.mjRow .hd{display:flex;gap:8px;align-items:center;font-size:.95rem;font-weight:700;flex-wrap:wrap;}
.windb{background:var(--felt);color:#fff;border-radius:6px;padding:1px 8px;font-size:.78rem;}
.mjRow .sc{margin-left:auto;font-size:.95rem;}
.mjRow .bd{display:flex;gap:16px;margin-top:7px;flex-wrap:wrap;align-items:flex-start;}
.mjRow .grp .lb{font-size:.6rem;color:var(--mut);letter-spacing:.14em;margin-bottom:3px;}
.tstrip{display:flex;gap:3px;flex-wrap:wrap;max-width:560px;}
.mjTop{background:radial-gradient(ellipse at 50% 20%,var(--felt) 0%,var(--felt-deep) 100%);border:5px solid var(--rail);border-radius:16px;color:#eef2ec;padding:12px 16px;margin-bottom:12px;text-align:center;box-shadow:inset 0 0 30px rgba(0,0,0,.25);}
.mjTop .bn{font-size:1.1rem;color:#f4e6c8;min-height:1.4em;}
.mjTop .lg{font-size:.7rem;color:#c9d8cd;margin-top:3px;min-height:1em;}
.mjWinTable{width:100%;border-collapse:collapse;font-size:.92rem;margin-top:8px;}
.mjWinTable th{background:#6c757d;color:#fff;text-align:left;padding:7px 9px;font-weight:600;}
.mjWinTable td{padding:6px 9px;border-bottom:1px solid var(--line);}
 .mjTable{display:grid;grid-template-columns:1fr 1.25fr 1fr;grid-template-rows:auto minmax(120px,1fr) auto;gap:8px;background:radial-gradient(ellipse at 50% 50%,var(--felt) 0%,var(--felt-deep) 100%);border:8px solid var(--rail);border-radius:20px;padding:12px;box-shadow:inset 0 0 55px rgba(0,0,0,.32);}
.mjSeat{background:#fff;border:1px solid var(--line);border-radius:12px;padding:7px 9px;box-shadow:0 2px 8px rgba(0,0,0,.22);align-self:center;min-width:0;}
.mjSeat.turn{border-color:var(--gold);box-shadow:0 0 0 3px var(--gold),0 2px 8px rgba(0,0,0,.22);}
.mjSeat.top{grid-column:2;grid-row:1;} .mjSeat.bottom{grid-column:2;grid-row:3;}
.mjSeat.left{grid-column:1;grid-row:2;} .mjSeat.right{grid-column:3;grid-row:2;}
.mjSeat .hd{display:flex;gap:6px;align-items:center;font-size:.85rem;font-weight:700;flex-wrap:wrap;}
.mjSeat .hd .sc{margin-left:auto;} .mjSeat .lb{font-size:.56rem;color:var(--mut);letter-spacing:.12em;margin:5px 0 2px;}
.mjSeat .tstrip{display:flex;gap:2px;flex-wrap:wrap;}
.backStrip{display:inline-flex;align-items:center;gap:2px;}
.backBar{display:inline-block;width:9px;height:26px;border-radius:2px;flex:none;background:repeating-linear-gradient(45deg,#3f6e58 0 4px,#35604c 4px 8px);border:1px solid #2c5240;}
.backNum{margin-left:6px;font-size:.68rem;color:var(--mut);font-weight:700;}
.mjCenter{grid-column:2;grid-row:2;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#eef2ec;text-align:center;gap:3px;}
/* ---- layer toggle ---- */
.layerBar{display:flex;gap:9px;align-items:center;margin:0 0 12px;flex-wrap:wrap;}
.layerBar .lbl{font-size:.72rem;letter-spacing:.14em;text-transform:uppercase;color:var(--mut);}
.lpill{display:flex;border:1px solid var(--line);border-radius:8px;overflow:hidden;}
.lpill button{border:0;background:#fff;padding:8px 14px;font-size:.85rem;cursor:pointer;color:var(--mut);}
.lpill button.on{background:var(--felt);color:#fff;}
.lpill button:disabled{opacity:.4;cursor:not-allowed;}
.layerBar .peek{font-size:.72rem;color:var(--warn);}
</style></head><body><div class="wrap">

<div class="layerBar">
  <span class="lbl">畫面 View</span>
  <div class="lpill">
    <button id="L1" onclick="setView(1)">1 · 大廳</button>
    <button id="L2" onclick="setView(2)">2 · 設定</button>
    <button id="L3" onclick="setView(3)">3 · 牌桌</button>
  </div>
  <button class="miniBtn" onclick="setView(0)">Auto</button>
  <span class="peek hidden" id="peekLbl">手動檢視中 — 牌局照常進行</span>
</div>

<div id="portal">${PORTAL_BODY}</div>

<div id="lobby">
  <h1 class="disp">Family Hold'em <button class="tbtn" style="vertical-align:middle" onclick="api('/api/portal',{game:null})">← 回大廳</button></h1>
  <div class="sub">Fixed-limit 10/20 · blinds 5/10 · phones = private cards, this screen = the table</div>
  <div class="lobbyGrid">
    <div class="qrBox">
      <div style="font-size:.8rem;color:var(--mut)">Scan to join</div>
      <div id="qr"></div>
      <div class="url" id="joinUrl"></div>
    </div>
    <div>
      <h3 class="disp">Players joined <span style="font-size:.72rem;color:var(--mut);font-weight:400">— 入座與移除都在 1 · 大廳</span></h3>
      <ul class="pl" id="lobbyList"><li style="color:var(--mut)">Waiting for phones…</li></ul>
      <div class="opts">
        <div class="pill" id="pillMode">
          <button data-v="fl" class="on">Fixed-limit (easiest)</button><button data-v="nl">Choose your bets</button>
        </div>
        <div class="pill" id="pillBlinds">
          <button data-v="5" class="on">Blinds 5/10</button><button data-v="10">10/20</button><button data-v="25">25/50</button>
        </div>
      </div>
      <div class="opts">
        <div class="pill" id="pillStack">
          <button data-v="500">500</button><button data-v="1000" class="on">1000</button><button data-v="2000">2000</button>
        </div>
        <div class="pill" id="pillAI">
          <button data-v="0" class="on">0 AI</button><button data-v="1">1 AI</button><button data-v="2">2 AI</button><button data-v="3">3 AI</button><button data-v="4">4 AI</button>
        </div>
        <div class="pill" id="pillSkill">
          <button data-v="beg">AI: Beginner</button><button data-v="int" class="on">Intermediate</button><button data-v="adv">Advanced</button>
        </div>
      </div>
      <button class="startBtn" onclick="startGame()">Start the session</button>
      <div class="sub" style="margin-top:10px">Need 2–5 total. Empty seats can be filled with AI.</div>
    </div>
  </div>
</div>

<div id="game" class="hidden">
  <div class="bar">
    <span class="tag" id="tagLine"></span>
    <button class="tbtn on" id="btnPace" onclick="api('/api/pace')">Pace: Relaxed</button>
    <button class="tbtn" id="btnReveal" onclick="api('/api/reveal')">Teaching reveal: Off</button>
    <button class="tbtn" onclick="openStats()">Standings</button>
    <button class="tbtn" onclick="if(confirm('Start a new session? Players stay seated — chips and stats reset when you press Start.'))api('/api/reset')">New session</button>
  </div>
  <div class="tableWrap" id="tableWrap">
    <div class="felt"></div>
    <div class="feltRing"></div>
    <div class="center">
      <div class="stage" id="stageLbl"></div>
      <div class="board" id="board"></div>
      <div class="pot">Pot <b id="potLbl">0</b></div>
      <div class="banner" id="banner"></div>
      <div class="log" id="log"></div>
      <button class="nextBtn hidden" id="nextBtn" onclick="api('/api/next')">Next hand →</button>
    </div>
  </div>
</div>

<div id="mjLobby" class="hidden">
  <h1 class="disp">台灣麻將 · 十六張 <button class="tbtn" style="vertical-align:middle" onclick="api('/api/portal',{game:null})">← 回大廳</button></h1>
  <div class="sub">前 4 位入座（依加入順序），不足 4 人由電腦補位 · 家規：無莊家加成、無連莊</div>
  <div class="lobbyGrid">
    <div class="qrBox">
      <div style="font-size:.8rem;color:var(--mut)">Scan to join · 掃碼入座</div>
      <div id="qr3"></div>
    </div>
    <div>
      <h3 class="disp">入座名單</h3>
      <ul class="pl" id="mjList"><li style="color:var(--mut)">Waiting for phones…</li></ul>
      <div class="opts">
        <div class="pill" id="pillBase">
          <button data-v="10">底 10</button><button data-v="20">底 20</button><button data-v="30" class="on">底 30</button><button data-v="50">底 50</button>
        </div>
        <div class="pill" id="pillTai">
          <button data-v="5">每台 5</button><button data-v="10" class="on">每台 10</button><button data-v="20">每台 20</button>
        </div>
      </div>
      <button class="startBtn" onclick="mjStart()">開局</button>
      <div class="sub" style="margin-top:10px">胡牌 = 底 + 台數 × 每台 · 放炮者付 / 自摸三家付</div>
    </div>
  </div>
</div>

<div id="mjGame" class="hidden">
  <div class="bar">
    <span class="tag" id="mjTag"></span>
    <button class="tbtn on" id="mjPace" onclick="api('/api/pace')">節奏：慢</button>
    <button class="tbtn" onclick="if(confirm('結束整場回設定？分數會清空。'))api('/api/mj/reset')">結束牌局</button>
    <button class="tbtn" onclick="if(confirm('回到遊戲大廳？'))api('/api/mj/reset',{portal:true})">回大廳</button>
  </div>
  <div class="mjTop">
    <div class="bn" id="mjBanner"></div>
    <div class="lg" id="mjLog"></div>
    <button class="nextBtn hidden" id="mjNextBtn" onclick="api('/api/mj/next')">下一局 →</button>
  </div>
  <div id="mjSeats"></div>
  <div id="mjWinBox" class="hidden" style="background:#fff;border:1px solid var(--line);border-radius:13px;padding:14px 16px;margin-top:4px;"></div>
</div>


<div id="brLobby" class="hidden">
  <h1 class="disp">橋牌 Bridge · 合約橋牌 <button class="tbtn" style="vertical-align:middle" onclick="api('/api/portal',{game:null})">← 回大廳</button></h1>
  <div class="sub">叫牌／加倍／13 墩／局盤 Rubber 計分全照橋牌規則。<b>盧家桌規：每個人打自己的牌，不攤明手</b> —— 四家的牌全程不公開，人不在才由電腦代打。前 4 位入座，不足由電腦高手補位。</div>
  <div class="lobbyGrid">
    <div class="qrBox">
      <div style="font-size:.8rem;color:var(--mut)">Scan to join · 掃碼入座</div>
      <div id="qr4"></div>
    </div>
    <div>
      <h3 class="disp">入座名單 · 座位依加入順序 N → E → S → W</h3>
      <ul class="pl" id="brList"><li style="color:var(--mut)">Waiting for phones…</li></ul>
      <button class="startBtn" onclick="api('/api/br/start')">開局 Deal</button>
      <div class="sub" style="margin-top:10px">N/S 一組、E/W 一組。電腦叫牌用 SAYC（五張高花、15-17 無王、Stayman、轉移叫、Blackwood），打牌用蒙地卡羅雙明手搜尋。</div>
    </div>
  </div>
</div>

<div id="brGame" class="hidden">
  <div class="bar">
    <span class="tag" id="brTag"></span>
    <button class="tbtn on" id="brPace" onclick="api('/api/pace')">節奏：慢</button>
    <button class="tbtn" onclick="if(confirm('結算目前這個局盤？未完成局盤依規則加 300／100，然後開始新的局盤。'))api('/api/br/endrubber')">結算局盤 End rubber</button>
    <button class="tbtn" onclick="if(confirm('結束整場回設定？分數會清空。'))api('/api/br/reset')">結束牌局</button>
    <button class="tbtn" onclick="if(confirm('回到遊戲大廳？'))api('/api/br/reset',{portal:true})">回大廳</button>
  </div>
  <div class="mjTop">
    <div class="bn" id="brBanner"></div>
    <div class="lg" id="brLog"></div>
    <button class="nextBtn hidden" id="brNextBtn" onclick="api('/api/br/next')">下一副 Next deal →</button>
  </div>
  <div class="brTable" id="brTableBox"></div>
  <div class="brGrid">
    <div class="brBox">
      <div style="font-size:.7rem;letter-spacing:.14em;color:var(--mut);margin-bottom:6px">叫牌紀錄 AUCTION</div>
      <div id="brAuction"></div>
      <div id="brResultBox"></div>
    </div>
    <div class="brBox">
      <div style="font-size:.7rem;letter-spacing:.14em;color:var(--mut);margin-bottom:6px">局盤計分表 RUBBER SCORE</div>
      <div id="brScore"></div>
    </div>
  </div>
</div>

<div class="panel hidden" id="statsPanel" onclick="if(event.target===this)closeStats()">
  <div class="panelIn">
    <h3 class="disp">Session standings</h3>
    <table class="st"><thead><tr><th>Player</th><th>Chips</th><th>Net</th><th>Hands won</th><th></th></tr></thead>
    <tbody id="statsBody"></tbody></table>
    <div class="closeRow"><button class="tbtn" onclick="closeStats()">Close</button>
      <button class="tbtn" onclick="if(confirm('Full reset: remove ALL players (everyone rescans the QR). Continue?')){api('/api/reset',{full:true});closeStats();}">Full reset</button></div>
  </div>
</div>

</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>
const IS_HOST=true;   // 這是大螢幕（大廳），只有這裡可以請人下桌
function portalKick(id){
  const p=((S&&S.roster)||[]).filter(function(x){return x.id===id;})[0];
  const nm=p? p.name : "這位玩家";
  if(!confirm("把 "+nm+" 從牌桌移除？")) return;
  api("/api/kick",{id:id});
}
const SUITS=["♠","♥","♦","♣"],RN={11:"J",12:"Q",13:"K",14:"A"};
const rN=r=>RN[r]||String(r);
const cardHTML=(c,cls="")=>{const red=(c.s===1||c.s===2);
 return '<div class="card '+cls+(red?' red':'')+'"><span>'+rN(c.r)+'</span><span class="s">'+SUITS[c.s]+'</span></div>';};
const joinUrl=location.origin+"/join";
document.getElementById("joinUrl").textContent=joinUrl;
try{ new QRCode(document.getElementById("qr"),{text:joinUrl,width:190,height:190}); }
catch(e){ document.getElementById("qr").innerHTML='<div style="font-size:.8rem;color:#a3542e">No internet for QR lib — type the URL below into each phone.</div>'; }
try{ new QRCode(document.getElementById("qr4"),{text:joinUrl,width:190,height:190}); }catch(e){}
document.querySelectorAll(".pill").forEach(p=>p.addEventListener("click",e=>{
 const b=e.target.closest("button"); if(!b)return;
 p.querySelectorAll("button").forEach(x=>x.classList.remove("on")); b.classList.add("on");}));
const pv=id=>document.querySelector("#"+id+" button.on").dataset.v;
function api(u,b){return fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b||{})}).then(r=>r.json()).then(j=>{if(j.error)alert(j.error);return j;});}
function startGame(){ api("/api/start",{stack:parseInt(pv("pillStack")),ai:parseInt(pv("pillAI")),
  mode:pv("pillMode"),blinds:pv("pillBlinds"),skill:pv("pillSkill")}); }

let S=null,GAME=null,es=null,esRetry=null;
let VIEW=0, lastAuto=0;   // VIEW 0 = auto-follow the server
function openES(){
  if(es){ try{ es.close(); }catch(e){} }
  es=new EventSource("/events");
  es.onerror=function(){ if(esRetry) return;
    esRetry=setTimeout(function(){ esRetry=null; openES(); },2000); };
  es.onmessage=e=>{ const d=JSON.parse(e.data); GAME=d.game; S=d.pub;
    window.__roster=(d.pub&&d.pub.roster)||[]; window.__code=d.code; window.__setup=d.setup; render(); };
}
openES();
setInterval(function(){ if(!es||es.readyState===2) openES(); },5000);
document.addEventListener("visibilitychange",function(){ if(!document.hidden&&(!es||es.readyState===2)) openES(); });
function setView(n){ VIEW=n; render(); }
function autoLayer(){
  if(GAME===null||GAME===undefined) return 1;
  if(GAME==="mahjong") return (S&&S.phase==="play")?3:1;   // 選了還沒開 → 留在大廳
  if(GAME==="bridge")  return (S&&S.phase==="play")?3:1;
  return (S&&S.phase==="lobby")?1:3;
}
function render(){
  const noGame=(GAME===null||GAME===undefined), mjOn=(GAME==="mahjong"), brOn=(GAME==="bridge");
  const auto=autoLayer();
  if(auto!==lastAuto){ lastAuto=auto; VIEW=0; }   // real state change wins over a manual peek
  let L=VIEW||auto;
  if(noGame) L=1;                                  // no game picked -> only layer 1 exists
  if(L===3&&!mjOn&&S&&S.phase==="lobby") L=2;      // no table dealt yet
  if(L===3&&mjOn&&S&&S.phase!=="play") L=2;
  if(L===3&&brOn&&S&&S.phase!=="play") L=2;
  const l3ok=(!noGame)&&((mjOn||brOn)? S.phase==="play" : S.phase!=="lobby");
  ["L1","L2","L3"].forEach((id,k)=>{ const b=document.getElementById(id);
    b.classList.toggle("on",L===k+1); b.disabled=(k>0&&noGame)||(k===2&&!l3ok); });
  document.getElementById("peekLbl").classList.toggle("hidden",L===auto);
  document.getElementById("portal").classList.toggle("hidden",L!==1);
  document.getElementById("lobby").classList.toggle("hidden",!(L===2&&!mjOn&&!brOn&&!noGame));
  document.getElementById("game").classList.toggle("hidden",!(L===3&&!mjOn&&!brOn&&!noGame));
  document.getElementById("mjLobby").classList.toggle("hidden",!(L===2&&mjOn));
  document.getElementById("mjGame").classList.toggle("hidden",!(L===3&&mjOn));
  document.getElementById("brLobby").classList.toggle("hidden",!(L===2&&brOn));
  document.getElementById("brGame").classList.toggle("hidden",!(L===3&&brOn));
  if(L===1){ renderPortal(); return; }
  if(brOn){ renderBRHost(L); return; }
  if(mjOn){ renderMJ(); return; }
  if(L===2){
    const ul=document.getElementById("lobbyList");
    ul.innerHTML=S.players.length? S.players.map(p=>'<li>'+(p.avatar?'<span class="av" style="background-image:url('+p.avatar+')"></span>':'📱')+' '+esc(p.name)
      +(p.connected?'':' <span class="badge off">offline</span>')
      +'</li>').join("")
      :'<li style="color:var(--mut)">Waiting for phones…</li>';
    return;
  }
  const stages=["PRE-FLOP","FLOP","TURN","RIVER","SHOWDOWN"];
  document.getElementById("stageLbl").textContent=stages[S.stage]||"";
  let bh=S.board.map(c=>cardHTML(c)).join("");
  for(let k=S.board.length;k<5;k++) bh+='<div class="card slot"></div>';
  document.getElementById("board").innerHTML=bh;
  document.getElementById("potLbl").textContent=S.pot;
  document.getElementById("banner").textContent=S.banner;
  document.getElementById("log").textContent=S.log.slice(1,4).join("  ·  ");
  document.getElementById("nextBtn").classList.toggle("hidden",!S.handOver);
  document.getElementById("tagLine").textContent=
    (S.mode==="nl"?"NO-LIMIT":"FIXED-LIMIT "+S.bbA+"/"+(2*S.bbA))+" · BLINDS "+S.sbA+"/"+S.bbA
    +(S.players.some(p=>p.isAI)?" · AI: "+({beg:"BEGINNER",int:"INTERMEDIATE",adv:"ADVANCED"}[S.aiLevel]||"INTERMEDIATE"):"");
  const bp=document.getElementById("btnPace");
  bp.textContent="Pace: "+(S.pace>1?"Relaxed":"Normal"); bp.classList.toggle("on",S.pace>1);
  const br=document.getElementById("btnReveal");
  br.textContent="Teaching reveal: "+(S.revealAll?"On":"Off"); br.classList.toggle("on",S.revealAll);
  document.querySelectorAll("#tableWrap .seatAbs").forEach(e=>e.remove());
  const wrap=document.getElementById("tableWrap");
  const n=S.players.length;
  S.players.forEach((p,i)=>{
    const d=document.createElement("div");
    d.className="seatAbs"+(i===S.turn&&!S.handOver&&p.inHand&&!p.folded?" turn":"")+((!p.inHand||p.folded||p.removed)?" out":"");
    const pos=seatPos(i,n);
    d.style.left=pos.x+"%"; d.style.top=pos.y+"%";
    const b=[];
    if(i===S.dealer)b.push('<span class="badge d">D</span>');
    if(i===S.sb&&S.stage===0)b.push('<span class="badge">SB</span>');
    if(i===S.bb&&S.stage===0)b.push('<span class="badge">BB</span>');
    if(p.isAI)b.push('<span class="badge ai">AI</span>');
    if(p.removed)b.push('<span class="badge off">LEFT</span>');
    else if(!p.connected)b.push('<span class="badge off">offline</span>');
    if(p.folded&&!p.removed)b.push('<span class="badge fold">FOLD</span>');
    else if(p.allIn)b.push('<span class="badge allin">ALL-IN</span>');
    if(p.won&&S.handOver)b.push('<span class="badge win">WIN</span>');
    let kick="";
    if(!p.isAI&&!p.connected&&!p.removed)
      kick='<button class="kick" onclick="if(confirm(\\'Remove this player from the table?\\'))api(\\'/api/kick\\',{id:\\''+p.id+'\\'})">Kick</button>';
    let cards="";
    if(p.inHand&&!p.folded){
      cards=p.hole? p.hole.map(c=>cardHTML(c,"sm")).join("")
        :'<div class="card sm back"></div><div class="card sm back"></div>';
    }
    d.innerHTML='<div class="nm">'+(p.avatar?'<span class="av" style="background-image:url('+p.avatar+')"></span>':'')+esc(p.name)+' '+b.join(" ")+kick+'</div>'
      +'<div class="chips">🪙 '+p.chips+'</div>'
      +'<div class="betAmt">'+(p.bet>0?"bet "+p.bet:"")+'</div>'
      +'<div class="hole">'+cards+'</div>'
      +'<div class="hn">'+(p.showName||"")+'</div>';
    wrap.appendChild(d);
  });
}
function seatPos(i,n){
  const th=(90+i*360/n)*Math.PI/180;
  return {x:50+42*Math.cos(th), y:50+45*Math.sin(th)};
}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function openStats(){
  const tb=document.getElementById("statsBody"); tb.innerHTML="";
  S.players.forEach(p=>{
    tb.innerHTML+='<tr><td>'+p.name+(p.isAI?' 🤖':'')+'</td><td>'+p.chips+'</td>'
     +'<td class="'+(p.net>=0?'pos':'neg')+'">'+(p.net>=0?'+':'')+p.net+'</td>'
     +'<td>'+p.handsWon+'</td>'
     +'<td>'+(p.chips===0?'<button class="miniBtn" onclick="api(\\'/api/rebuy\\',{id:\\''+p.id+'\\'})">Rebuy</button>':'')+'</td></tr>';
  });
  document.getElementById("statsPanel").classList.remove("hidden");
}
function closeStats(){document.getElementById("statsPanel").classList.add("hidden");}

/* ---- bridge (host) ---- */
const BST=["\u2663","\u2666","\u2665","\u2660","NT"], BSE=["N","E","S","W"];
const BSEZH=["\u5317 N","\u6771 E","\u5357 S","\u897F W"];
function bStrainHTML(st){ const t=BST[st]; return (st===1||st===2)?'<span class="redS">'+t+'</span>':t; }
function bCallHTML(c){
  if(c.t==="P") return "Pass";
  if(c.t==="X") return '<b style="color:var(--warn)">X</b>';
  if(c.t==="XX") return '<b style="color:#b02c22">XX</b>';
  return c.lvl+bStrainHTML(c.str);
}
function bContractHTML(c){
  if(!c) return "\u2014";
  return c.lvl+bStrainHTML(c.str)+(c.dbl===1?' <b style="color:var(--warn)">X</b>':c.dbl===2?' <b style="color:#b02c22">XX</b>':"")
    +' <span style="font-size:.8rem;color:var(--mut)">by '+BSE[c.declarer]+'</span>';
}
function brAuctionHTML(b){
  const cells=[]; for(let i=0;i<b.dealer;i++) cells.push(null);
  b.auction.forEach(c=>cells.push(c));
  let h='<table class="auc"><thead><tr>'+BSE.map((x,i)=>'<th'+(i===b.dealer?' class="dl"':'')+'>'+x+(i===b.dealer?' \u25b6':'')+'</th>').join("")+'</tr></thead><tbody>';
  const rows=Math.max(1,Math.ceil(cells.length/4));
  for(let r=0;r<rows;r++){ h+='<tr>';
    for(let k=0;k<4;k++){ const c=cells[r*4+k];
      const isCur=(b.stage==="auction"&&(r*4+k)===cells.length&&((r*4+k)%4)===b.turn);
      h+='<td'+(isCur?' class="cur"':'')+'>'+(c?bCallHTML(c):(isCur?'\u2026':''))+'</td>'; }
    h+='</tr>'; }
  h+='</tbody></table>';
  if(b.contract) h+='<div style="margin-top:8px;font-size:1.15rem;font-weight:700">\u5b9a\u7d04 Contract: '+bContractHTML(b.contract)+'</div>';
  return h;
}
function brScoreHTML(b){
  const R=b.rub, N=["N/S","E/W"];
  let h='<table class="rub"><thead><tr><th></th><th>N/S</th><th>E/W</th></tr></thead><tbody>';
  h+='<tr><td>\u7dda\u4e0a Above</td><td>'+R.above[0]+'</td><td>'+R.above[1]+'</td></tr>';
  h+='<tr class="ln"><td>\u7dda\u4e0b Below</td><td>'+R.below[0]+'</td><td>'+R.below[1]+'</td></tr>';
  h+='<tr><td>\u76e4\u6578 Games</td><td>'+R.games[0]+'</td><td>'+R.games[1]+'</td></tr>';
  h+='<tr><td><b>\u7e3d\u5206 Total</b></td><td><b>'+R.total[0]+'</b></td><td><b>'+R.total[1]+'</b></td></tr>';
  h+='<tr><td>\u5c40\u76e4 Rubbers</td><td>'+R.rubbers[0]+'</td><td>'+R.rubbers[1]+'</td></tr>';
  h+='</tbody></table>';
  if(R.hist&&R.hist.length){
    h+='<div style="margin-top:8px;font-size:.72rem;color:var(--mut)">\u6700\u8fd1\u5404\u526f</div>';
    h+='<div style="font-size:.76rem;line-height:1.6">'+R.hist.slice(0,6).map(function(x){
      return '#'+x.board+' '+x.contract+' '+(x.res>=0?('+'+x.res):x.res); }).join('<br>')+'</div>';
  }
  return h;
}
function brResultHTML(b){
  if(!b.handOver||!b.result) return "";
  const r=b.result;
  if(r.passedOut) return '<div class="brResult"><h4>\u56db\u5bb6\u5168 Pass \u2014 \u91cd\u767c\uff5cPassed out</h4></div>';
  let h='<div class="brResult"><h4>'+r.contract+' \u2014 '+(r.made?(r.res===0?'\u525b\u597d\u6210\u7d04 made exactly':'\u6210\u7d04 +'+r.res):'\u5012 '+(-r.res)+' \u58a9 down '+(-r.res))
    +'　('+r.won+'/'+r.need+' \u58a9)</h4><table>';
  r.lines.forEach(function(x){ h+='<tr><td>'+x.k+'</td><td class="n">'+(x.side===0?'N/S':'E/W')+' +'+x.v+'</td></tr>'; });
  if(r.gameWon!==null&&r.gameWon!==undefined) h+='<tr><td><b>\u2605 '+(r.gameWon===0?'N/S':'E/W')+' \u62ff\u4e0b\u4e00\u76e4 GAME</b></td><td class="n"></td></tr>';
  if(r.rubberWon!==null&&r.rubberWon!==undefined) h+='<tr><td><b>\u2605\u2605 '+(r.rubberWon===0?'N/S':'E/W')+' \u8d0f\u5f97\u5c40\u76e4 RUBBER</b></td><td class="n">+'+r.rubBonus+'</td></tr>';
  h+='</table></div>';
  return h;
}
function brSeatBox(b,s,cls){
  const st=b.seats[s]; if(!st) return "";
  const turn=(b.stage!=="over"&&b.turn===s&&!b.handOver);
  const badges=(s===b.declarer?'<span class="badge dec">\u838a\u5bb6 DECL</span>':"")
    +(b.vuln[s%2]?'<span class="badge vul">VUL</span>':"")
    +(st.auto?'<span class="badge ai">\u4ee3\u6253</span>':(st.isAI?'<span class="badge ai">AI</span>':""))
    +(st.connected?"":'<span class="badge off">off</span>');
  // CIO 2026-08-23\uff1a\u4eba\u4e0d\u5728\u5c31\u8b93\u96fb\u8166\u63a5\u624b\uff0c\u8ab0\u6309\u90fd\u7b97
  const autoBtn = st.isAI ? "" :
    (' <button class="miniBtn" onclick="api(\\'/api/br/auto\\',{seat:'+s+'})">'+(st.auto?'\u9084\u539f':'\u4ee3\u6253')+'</button>');
  let h='<div class="brSeat '+cls+(turn?' turn':'')+'"><div class="hd"><span class="badge seat">'+BSEZH[s]+'</span>'
    +(st.avatar?'<span class="av" style="background-image:url('+st.avatar+')"></span>':"")
    +esc(st.name)+badges+autoBtn+'<span class="rt">'+st.cards+' \u5f35</span></div>';
  if(st.hand){
    h+='<div class="dh">';
    [0,1,2,3].forEach(function(su){
      const cs=st.hand.filter(function(c){return c.s===su;}).sort(function(a,b2){return b2.r-a.r;});
      if(!cs.length) return;
      h+='<div class="brSuitRow"><span class="sl'+((su===1||su===2)?' redS':'')+'">'+["\u2660","\u2665","\u2666","\u2663"][su]+'</span>'
        +cs.map(function(c){return cardHTML(c,"sm");}).join("")+'</div>';
    });
    h+='</div>';
  }
  return h+'</div>';
}
function renderBRHost(L){
  const b=S;
  if(L===2){
    const ul=document.getElementById("brList");
    const hs=(window.__roster||[]);
    ul.innerHTML= hs.length? hs.map(function(p,i){ return '<li>'+(p.avatar?'<span class="av" style="background-image:url('+p.avatar+')"></span>':'\ud83d\udcf1')
        +' <b>'+(i<4?BSE[i]:"\u2014")+'</b> '+esc(p.name)+(p.connected===false?' <span class="badge off">offline</span>':'')
        +' <button class="kick" onclick="if(confirm(\\'Remove this player?\\'))api(\\'/api/kick\\',{id:\\''+p.id+'\\'})">remove</button></li>'; }).join("")
      : '<li style="color:var(--mut)">Waiting for phones\u2026</li>';
    return;
  }
  document.getElementById("brTag").innerHTML='\u7b2c '+b.board+' \u526f \u00b7 \u767c\u724c '+BSE[b.dealer]
    +' \u00b7 '+bContractHTML(b.contract)
    +' \u00b7 \u58a9\u6578 N/S <b>'+b.tricks[0]+'</b> \u2013 E/W <b>'+b.tricks[1]+'</b>'
    +' \u00b7 \u5df2\u6253 '+b.played+'/13';
  document.getElementById("brBanner").textContent=b.banner||"";
  document.getElementById("brLog").textContent=(b.log||[]).slice(1,4).join("　·　");
  document.getElementById("brPace").textContent="\u7bc0\u594f\uff1a"+(b.pace===1?"\u5feb":"\u6162");
  document.getElementById("brPace").classList.toggle("on",b.pace!==1);
  document.getElementById("brNextBtn").classList.toggle("hidden",!b.handOver);
  let tbl="";
  tbl+=brSeatBox(b,0,"top");
  tbl+=brSeatBox(b,3,"left");
  tbl+=brSeatBox(b,1,"right");
  tbl+=brSeatBox(b,2,"bottom");
  const pos=["tN","tE","tS","tW"];
  let mid='<div class="brCenter">';
  if(b.stage==="auction"){
    mid+='<div style="font-size:1.15rem;font-weight:700">\u53eb\u724c\u4e2d AUCTION</div>'
      +'<div style="font-size:.9rem">\u8f2a\u5230 <b>'+BSE[b.turn]+'</b></div>';
  } else {
    const show=(b.trick&&b.trick.length)?b.trick:(b.lastTrick?b.lastTrick.cards:[]);
    const isLast=(!b.trick||!b.trick.length)&&b.lastTrick;
    mid+='<div class="brTrick">';
    [0,1,2,3].forEach(function(s){
      const x=show.filter(function(y){return y.seat===s;})[0];
      mid+='<div class="'+pos[s]+'">'+(x?cardHTML(x.card,""):'<div class="card slot"></div>')+'</div>';
    });
    mid+='<div class="tM">'+(isLast?('\u4e0a\u4e00\u58a9<br>'+BSE[b.lastTrick.win]+' \u8d0f'):'')+'</div></div>';
  }
  mid+='</div>';
  document.getElementById("brTableBox").innerHTML=tbl+mid;
  document.getElementById("brAuction").innerHTML=brAuctionHTML(b);
  document.getElementById("brResultBox").innerHTML=brResultHTML(b);
  document.getElementById("brScore").innerHTML=brScoreHTML(b);
}

/* ---- portal + mahjong (host) ---- */
try{ new QRCode(document.getElementById("qr3"),{text:joinUrl,width:150,height:150}); }catch(e){}
${PORTAL_JS}
const MJN=["一","二","三","四","五","六","七","八","九"],MJH=["東","南","西","北","中","發","白"],MJF=["春","夏","秋","冬","梅","蘭","菊","竹"];
function _dots(n){var L={1:[[17,24,7]],2:[[17,14,5.2],[17,34,5.2]],3:[[9,12,5],[17,24,5],[25,36,5]],4:[[11,14,5],[23,14,5],[11,34,5],[23,34,5]],5:[[11,13,4.6],[23,13,4.6],[17,24,4.6],[11,35,4.6],[23,35,4.6]],6:[[11,12,4.3],[23,12,4.3],[11,24,4.3],[23,24,4.3],[11,36,4.3],[23,36,4.3]],7:[[9,11,3.9],[17,11,3.9],[25,11,3.9],[13,24,3.9],[21,24,3.9],[13,37,3.9],[21,37,3.9]],8:[[9,11,3.7],[17,11,3.7],[25,11,3.7],[9,24,3.7],[25,24,3.7],[9,37,3.7],[17,37,3.7],[25,37,3.7]],9:[[9,11,3.7],[17,11,3.7],[25,11,3.7],[9,24,3.7],[17,24,3.7],[25,24,3.7],[9,37,3.7],[17,37,3.7],[25,37,3.7]]};return L[n]||L[1];}
function _bamboo(n){
  var G="#2f7d3e", B="#1c6fb0", R="#a3282a";
  var L={
    2:[[17,15,G],[17,33,G]],
    3:[[17,13,G],[10,34,G],[24,34,G]],
    4:[[11,15,G],[23,15,B],[11,33,B],[23,33,G]],
    5:[[10,13,G],[24,13,G],[17,24,R],[10,35,G],[24,35,G]],
    6:[[9,15,G],[17,15,B],[25,15,G],[9,33,G],[17,33,B],[25,33,G]],
    7:[[17,10,R],[9,26,G],[17,26,B],[25,26,G],[9,39,G],[17,39,B],[25,39,G]],
    8:[[8,14,G],[15,14,G],[22,14,G],[29,14,G],[8,34,B],[15,34,B],[22,34,B],[29,34,B]],
    9:[[9,12,G],[17,12,B],[25,12,G],[9,24,G],[17,24,B],[25,24,G],[9,36,G],[17,36,B],[25,36,G]]
  };
  return L[n]||L[2];
}
/* 一根竹：直桿 + 兩端的節。h 是這一列可以用的高度 */
function _stick(x,y,col,h){
  var half=h/2;
  return '<rect x="'+(x-2)+'" y="'+(y-half)+'" width="4" height="'+h+'" rx="2" fill="'+col+'"/>'
       + '<rect x="'+(x-3.2)+'" y="'+(y-half+h*0.30)+'" width="6.4" height="1.6" rx="0.8" fill="'+col+'" opacity="0.85"/>'
       + '<rect x="'+(x-3.2)+'" y="'+(y+half-h*0.30-1.6)+'" width="6.4" height="1.6" rx="0.8" fill="'+col+'" opacity="0.85"/>';
}
function tsvg(t){
  var s='<svg viewBox="0 0 34 48" width="100%" height="100%">';
  function tx(str,y,fill,size){return '<text x="17" y="'+y+'" text-anchor="middle" font-family="serif" font-weight="700" font-size="'+size+'" fill="'+fill+'">'+str+'</text>';}
  if(t<9){ s+=tx(MJN[t],20,"#a3282a",16)+tx("萬",43,"#a3282a",15); }
  else if(t<18){ var n=t-8; if(n===1){ s+='<circle cx="17" cy="24" r="10" fill="none" stroke="#1c6fb0" stroke-width="2.2"/><circle cx="17" cy="24" r="6" fill="none" stroke="#a3282a" stroke-width="2"/><circle cx="17" cy="24" r="2.6" fill="#2f7d3e"/>'; } else _dots(n).forEach(function(p){ s+='<circle cx="'+p[0]+'" cy="'+p[1]+'" r="'+p[2]+'" fill="#fff" stroke="#1c6fb0" stroke-width="1.5"/><circle cx="'+p[0]+'" cy="'+p[1]+'" r="'+(p[2]*0.42)+'" fill="#a3282a"/>'; }); }
  else if(t<27){ var m=t-17; if(m===1){ s+='<ellipse cx="17" cy="27" rx="6" ry="8" fill="#2f7d3e"/><circle cx="17" cy="17" r="4.4" fill="#2f7d3e"/><path d="M17 12 L22 9 L18.5 15 Z" fill="#a3282a"/><circle cx="18.6" cy="16" r="1" fill="#fff"/>'; } else { var bb=_bamboo(m); var bh=(m>=9)?9:((m>=7)?10:(m>=6?13:15)); bb.forEach(function(p){ s+=_stick(p[0],p[1],p[2],bh); }); } }
  else if(t<31){ s+=tx(["東","南","西","北"][t-27],31,"#25324a",20); }
  else if(t===31){ s+=tx("中",31,"#b02c22",21); }
  else if(t===32){ s+=tx("發",31,"#1e7a3c",21); }
  else if(t===33){ s+='<rect x="6" y="9" width="22" height="30" rx="3" fill="none" stroke="#1c6fb0" stroke-width="2.4"/>'; }
  else { var fi=t-34; var col=fi<4?"#c8611c":"#2f7d3e"; s+=tx(MJF[fi],32,col,19)+'<text x="5" y="11" font-family="sans-serif" font-size="8" fill="'+col+'">'+((fi%4)+1)+'</text>'; }
  return s+'</svg>';
}
function mtile(t,sm,extra){
  var c=(sm?"mtile sm":"mtile")+(extra||"");
  if(t===null||t===undefined) return '<div class="'+c+' back"></div>';
  return '<div class="'+c+'">'+tsvg(t)+'</div>';
}
function mjStart(){ api("/api/mj/start",{base:parseInt(pv("pillBase")),tai:parseInt(pv("pillTai"))}); }
function mjAuto(s){ api("/api/mj/auto",{seat:s}); }
function meldHTML(m){
  let h='<span style="display:inline-flex;gap:2px;margin-right:8px">';
  (m.tiles||[]).forEach(function(t,i){ h+=mtile(m.t==="angang"&&(i===0||i===3)?null:t,true); });
  return h+'</span>';
}
function backs(n){ let h='<span class="backStrip">'; for(let k=0;k<n;k++) h+='<i class="backBar"></i>'; return h+'<b class="backNum">'+n+'</b></span>'; }
function renderMJ(){
  if(S.phase!=="play"){
    const ul=document.getElementById("mjList");
    const r=S.roster||[];
    ul.innerHTML=r.length? r.map((p,i)=>'<li>'+(p.avatar?'<span class="av" style="background-image:url('+p.avatar+')"></span>':'📱')+' '+esc(p.name)
      +(i<4?' <span class="badge win">入座</span>':' <span class="badge">觀戰</span>')
      +(p.connected?'':' <span class="badge off">offline</span>')+'</li>').join("")
      :'<li style="color:var(--mut)">Waiting for phones…</li>';
    return;
  }
  document.getElementById("mjTag").textContent="第"+S.handCount+"局 · 底"+S.base+" 每台"+S.taiVal+" · 剩 "+S.left+" 張"
    +((S.spectators&&S.spectators.length)?" · 觀戰："+S.spectators.join("、"):"");
  document.getElementById("mjBanner").textContent=S.banner||"";
  document.getElementById("mjLog").textContent=(S.log||[]).slice(1,4).join("  ·  ");
  document.getElementById("mjNextBtn").classList.toggle("hidden",!S.handOver);
  const bp=document.getElementById("mjPace");
  bp.textContent="節奏："+(S.pace>1?"慢":"快"); bp.classList.toggle("on",S.pace>1);
  const box=document.getElementById("mjSeats"); box.className="mjTable";
  const sideCls=["bottom","right","top","left"];
  function mjSeatPanel(q,s){
    const turn=(s===S.turn&&!S.handOver);
    let bdg="";
    if(q.isAI) bdg+=' <span class="badge ai">AI</span>';
    if(q.auto) bdg+=' <span class="badge allin">代打</span>';
    if(!q.connected&&!q.isAI) bdg+=' <span class="badge off">offline</span>';
    if(S.winInfo&&S.winInfo.seat===s) bdg+=' <span class="badge win">胡</span>';
    const scc=q.score>=0?'pos':'neg';
    const autoBtn=q.isAI?'':(' <button class="miniBtn" onclick="mjAuto('+s+')">'+(q.auto?'還原':'代打')+'</button>');
    let hand = q.hand ? q.hand.map(function(t){return mtile(t,true);}).join("") : backs(q.nHand);
    let disc=q.discards.map(function(t,i){
      const hot=S.pendingTile&&S.pendingTile.from===s&&i===q.discards.length-1;
      return mtile(t,true,hot?' hot':'');
    }).join("");
    return '<div class="mjSeat '+sideCls[s]+(turn?' turn':'')+'">'
      +'<div class="hd"><span class="windb">'+q.wind+'</span>'
      +(q.avatar?'<span class="av" style="background-image:url('+q.avatar+')"></span>':'')
      +esc(q.name)+bdg+autoBtn
      +'<span class="sc '+scc+'">'+(q.score>=0?'+':'')+q.score+'點</span></div>'
      +(q.flowers.length?'<div class="lb">花</div><div class="tstrip">'+q.flowers.map(function(t){return mtile(t,true);}).join("")+'</div>':'')
      +(q.melds.length?'<div class="lb">副露</div><div class="tstrip">'+q.melds.map(meldHTML).join("")+'</div>':'')
      +'<div class="lb">手牌</div><div class="tstrip">'+hand+'</div>'
      +'<div class="lb">捨牌</div><div class="tstrip">'+(disc||'<span style="color:var(--mut);font-size:.7rem">—</span>')+'</div>'
      +'</div>';
  }
  const turnNm=(S.turn>=0&&S.seats[S.turn])?S.seats[S.turn].name:"";
  const centerHTML='<div class="mjCenter"><div style="font-size:1.8rem">🀄</div>'
    +'<div style="font-size:1rem;font-weight:700">第'+S.handCount+'局</div>'
    +'<div style="font-size:.8rem;color:#bfd6c6">剩 '+S.left+' 張</div>'
    +(S.handOver?'<div style="font-size:.85rem;color:#f4e6c8">本局結束</div>':'<div style="font-size:.9rem;color:#f4e6c8">輪到 '+esc(turnNm)+'</div>')
    +'</div>';
  box.innerHTML=mjSeatPanel(S.seats[0],0)+mjSeatPanel(S.seats[1],1)+mjSeatPanel(S.seats[2],2)+mjSeatPanel(S.seats[3],3)+centerHTML;
  const wb=document.getElementById("mjWinBox");
  if(S.handOver&&S.winInfo){
    const w=S.winInfo;
    let wh='<h3 class="disp">'+esc(w.name)+(w.baxian?' 八仙過海！':(w.rob?' 搶槓胡！':(w.selfDrawn?' 自摸！':' 胡牌！')))
      +' — '+w.tai+'台 · '+w.total+'點 '+(w.payer?'（'+esc(w.payer)+' 放炮）':'（三家各付'+w.total+'）')+'</h3>';
    wh+='<div style="display:flex;gap:3px;flex-wrap:wrap;margin:8px 0;align-items:flex-end">';
    (w.melds||[]).forEach(function(m){wh+=meldHTML(m);});
    (w.tiles||[]).forEach(function(t,i){
      const hot=(i===w.tiles.length-1&&t===w.winTile);
      wh+=mtile(t,false).replace('class="mtile','class="mtile'+(hot?' hot':''));
    });
    (w.flowers||[]).forEach(function(t){wh+=mtile(t,true);});
    wh+='</div><table class="mjWinTable"><thead><tr><th>台種</th><th>台</th></tr></thead><tbody>';
    w.taiList.forEach(function(x){wh+='<tr><td>'+x[0]+'</td><td>'+x[1]+'</td></tr>';});
    wh+='<tr><td><b>合計</b></td><td><b>'+w.tai+'台 → 底'+S.base+'＋'+w.tai+'×'+S.taiVal+' = '+w.total+'點</b></td></tr></tbody></table>';
    wb.innerHTML=wh; wb.classList.remove("hidden");
  } else if(S.handOver&&S.drawGame){
    wb.innerHTML='<h3 class="disp">流局 — 沒人胡，這局不計分。</h3>'; wb.classList.remove("hidden");
  } else wb.classList.add("hidden");
}
</script></body></html>`;

/* ================= PLAYER (PHONE) PAGE ================= */
const PLAYER_HTML=`<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"><title>盧家遊樂園 — 我的牌</title>
<style>${CSS}${PORTAL_CSS}${BRIDGE_CSS}
.wrap{max-width:440px;margin:0 auto;padding:16px 14px 30px;}
body.br .wrap{max-width:620px;}
h1{font-size:1.3rem;} .sub{color:var(--mut);font-size:.78rem;margin:2px 0 16px;}
input[type=text]{width:100%;padding:13px;border:1px solid var(--line);border-radius:10px;font-size:1.05rem;background:#fff;}
.joinBtn{margin-top:12px;width:100%;padding:14px;border:0;border-radius:10px;background:var(--felt);color:#fff;font-size:1.05rem;font-weight:700;cursor:pointer;}
.statusCard{background:#fff;border:1px solid var(--line);border-radius:14px;padding:10px 14px;margin-bottom:10px;}
.statusCard .row{display:flex;justify-content:space-between;align-items:center;font-size:.86rem;padding:3px 0;}
.av{width:36px;height:36px;border-radius:50%;background:#e4ddc9 center/cover no-repeat;display:inline-flex;align-items:center;justify-content:center;font-size:1.05rem;cursor:pointer;border:1px solid var(--line);flex:none;}
.boardArea{background:radial-gradient(ellipse at 50% 20%,var(--felt) 0%,var(--felt-deep) 100%);
border:5px solid var(--rail);border-radius:18px;padding:14px 10px;color:#eef2ec;text-align:center;box-shadow:inset 0 0 30px rgba(0,0,0,.25);margin-bottom:10px;}
.boardArea .lbl{font-size:.66rem;letter-spacing:.18em;text-transform:uppercase;color:#bfd6c6;}
.boardRow{display:flex;gap:5px;justify-content:center;margin:10px 0 4px;min-height:66px;}
.myArea{background:#fff;border:1px solid var(--line);border-radius:16px;padding:12px 10px 10px;text-align:center;margin-top:10px;}
.myArea .lbl{font-size:.66rem;letter-spacing:.18em;text-transform:uppercase;color:var(--mut);}
.hole{display:flex;gap:10px;justify-content:center;margin-top:8px;}
.turnBanner{font-size:1.05rem;font-weight:700;color:var(--gold);min-height:1.4em;margin-top:6px;}
.waiting{color:#c9d8cd;font-size:.85rem;min-height:1.4em;margin-top:4px;}
.coach{background:#fff;border-left:4px solid var(--ok);border-radius:0 10px 10px 0;padding:10px 12px;font-size:.85rem;color:var(--ink);margin:12px 0;line-height:1.45;}
.btns{display:flex;gap:8px;margin-top:12px;}
.btns button{flex:1;padding:16px 4px;border:0;border-radius:12px;font-size:1rem;font-weight:700;cursor:pointer;}
.bFold{background:#eee7d8;color:var(--ink);} .bCall{background:var(--felt);color:#fff;} .bRaise{background:var(--gold);color:#3d2f10;}
.btns button:disabled{opacity:.35;}
.raiseRow{display:flex;gap:7px;margin-top:9px;flex-wrap:wrap;}
.raiseRow button{flex:1;min-width:70px;padding:13px 4px;border:0;border-radius:12px;background:var(--gold);color:#3d2f10;font-size:.9rem;font-weight:700;cursor:pointer;}
.editBtn{border:0;background:none;cursor:pointer;font-size:.95rem;color:var(--mut);padding:0 4px;}
.bar{display:flex;gap:8px;margin:12px 0;}
.pubLine{font-size:.8rem;color:var(--mut);text-align:center;margin-top:10px;min-height:1.2em;}
.boardMini{display:flex;gap:4px;justify-content:center;margin-top:8px;}
/* ---- portal + mahjong (phone) ---- */
body.mj .wrap{max-width:980px;}
.windb{background:var(--felt);color:#fff;border-radius:6px;padding:1px 8px;font-size:.78rem;}
.mtile{display:inline-flex;flex-direction:column;align-items:center;justify-content:center;width:38px;height:54px;background:#fdfcf7;border:1px solid #cfc7b2;border-radius:5px;font-weight:700;box-shadow:0 1px 2px rgba(0,0,0,.2);flex:none;}
.mtile .mn{font-size:.95rem;line-height:1.1;}
.mtile .ms{font-size:.7rem;line-height:1.05;}
.mtile .mh{font-size:1.2rem;}
.mtile.sm{width:26px;height:37px;border-radius:4px;}
.mtile.sm .mn{font-size:.68rem;} .mtile.sm .ms{font-size:.52rem;} .mtile.sm .mh{font-size:.82rem;}
.mtile.wan{color:#a33c2f;} .mtile.tong{color:#23558c;} .mtile.tiao{color:#2e6e3e;}
.mtile.zhong{color:#b02c22;} .mtile.fa{color:#1e6b3c;} .mtile.bai{color:#7a8391;}
.mtile.wind{color:#23261f;}
.mtile.flo{background:#f7e9c8;color:#8a5a18;border-color:#dcb96a;}
.mtile.back{background:repeating-linear-gradient(45deg,#3f6e58 0 6px,#35604c 6px 12px);border-color:#2c5240;}
.mtile{overflow:hidden;padding:0;}
.mtile svg{display:block;width:100%;height:100%;}
#mjPlay .topbar{display:flex;gap:10px;align-items:center;font-size:.88rem;flex-wrap:wrap;background:#fff;border:1px solid var(--line);border-radius:10px;padding:7px 11px;margin-bottom:8px;}
#mjPlay .topbar .sc{font-weight:700;}
#mjPlay .bannerLn{color:var(--mut);font-size:.78rem;flex-basis:100%;min-height:1em;}
.rack{display:flex;gap:3px;flex-wrap:nowrap;overflow-x:auto;padding:12px 4px 4px;align-items:flex-end;}
.rack .mtile{width:42px;height:58px;cursor:pointer;}
.rack .mtile.sel{transform:translateY(-9px);outline:3px solid var(--gold);}
.rack .mtile.pick{transform:translateY(-6px);outline:3px solid var(--felt);}
.mjTidyBar{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:7px;}
.tdBtn{border:1px solid var(--line);background:#fff;border-radius:8px;padding:7px 11px;font-size:.8rem;cursor:pointer;color:var(--ink);}
.tdBtn.on{background:#2f7d3e;color:#fff;border-color:#2f7d3e;font-weight:700;}
.tdBtn.go{background:var(--gold);border-color:var(--gold);color:#3d2f10;font-weight:700;}
.tdNote{font-size:.72rem;color:var(--mut);}
.mjGrp{display:inline-block;vertical-align:top;border:1px solid var(--line);border-radius:10px;
background:#fbf8ef;padding:2px 5px 5px;margin:0 6px 6px 0;}
.mjGrpHd{display:flex;align-items:center;gap:6px;font-size:.66rem;color:var(--mut);letter-spacing:.1em;padding:2px 2px 0;}
.mjGrpHd button{margin-left:auto;border:0;background:none;color:#b45050;font-size:.85rem;cursor:pointer;line-height:1;}
#mjGroupBox{display:flex;flex-wrap:wrap;}
.rack .gap{width:14px;flex:none;}
.actRow{display:flex;gap:7px;margin:8px 0;flex-wrap:wrap;}
.actRow button{padding:12px 18px;border:0;border-radius:11px;font-size:1rem;font-weight:700;cursor:pointer;background:#eee7d8;color:var(--ink);}
.actRow .bHu{background:#b02c22;color:#fff;}
.actRow .bGo{background:var(--felt);color:#fff;}
.actRow button:disabled{opacity:.35;}
.claimBar{background:#fff8ea;border:2px solid var(--gold);border-radius:12px;padding:10px 12px;margin:8px 0;}
.claimBar .ttl{font-weight:700;font-size:.92rem;margin-bottom:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.mMini{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px;font-size:.72rem;color:var(--mut);}
.waitsLn{font-size:.82rem;color:var(--ok);margin-top:5px;min-height:1.1em;font-weight:600;}
#mjPlay.rot{position:fixed;top:0;left:0;width:100vh;height:100vw;transform:translateX(100vw) rotate(90deg);transform-origin:top left;overflow:auto;background:var(--cream);padding:8px 12px;z-index:60;}
/* ---- bottom layer toggle (phone) ---- */
body{padding-bottom:74px;}
#pBar{position:fixed;left:0;right:0;bottom:0;z-index:70;background:var(--cream);
border-top:1px solid var(--line);padding:8px 10px calc(8px + env(safe-area-inset-bottom));
display:flex;gap:8px;align-items:center;justify-content:center;box-shadow:0 -3px 12px rgba(0,0,0,.10);}
#pBar .lpill{display:flex;border:1px solid var(--line);border-radius:9px;overflow:hidden;flex:1;max-width:330px;}
#pBar .lpill button{flex:1;border:0;background:#fff;padding:11px 4px;font-size:.86rem;cursor:pointer;color:var(--mut);}
#pBar .lpill button.on{background:var(--felt);color:#fff;font-weight:700;}
#pBar .lpill button:disabled{opacity:.35;}
#pBar .auto{border:1px solid var(--line);background:#fff;border-radius:9px;padding:11px 12px;font-size:.78rem;color:var(--mut);}
/* ---- advanced coach ---- */
.cRow{display:flex;gap:8px;font-size:.82rem;padding:3px 0;border-bottom:1px dashed var(--line);}
.cRow:last-of-type{border-bottom:0;}
.cRow .k{color:var(--mut);min-width:74px;flex:none;letter-spacing:.03em;}
.cRow .v{color:var(--ink);font-weight:600;}
.cVer{margin-top:9px;font-size:1.02rem;font-weight:800;letter-spacing:.02em;}
.cVer.good{color:#1e6b3c;} .cVer.ok{color:#8a5a18;} .cVer.bad{color:#8c2f2f;}
.cWhy{margin-top:3px;font-size:.8rem;color:var(--mut);line-height:1.45;}
.eqBar{height:7px;border-radius:4px;background:#e4ddc9;overflow:hidden;margin:7px 0 2px;}
.eqBar i{display:block;height:100%;background:var(--felt);}
</style></head><body><div class="wrap">

<div id="join">
  <h1 class="disp">加入盧家遊樂園</h1>
  <div class="sub">你的牌只在這支手機上 · 撲克 + 台灣麻將同一個座位</div>
  <input type="text" id="nm" placeholder="Your name" maxlength="14">
  <button class="joinBtn" onclick="join()">Sit down</button>
  <div class="sub" id="joinErr" style="color:var(--warn);margin-top:10px"></div>
  <button class="tbtn hidden" id="clearSeatBtn" style="margin-top:8px"
    onclick="clearSeat()">This phone has a saved seat — clear it</button>
</div>

<div id="play" class="hidden">
  <div class="statusCard">
    <div class="row">
      <span style="display:flex;align-items:center;gap:9px">
        <span class="av" id="myAv" onclick="pickAv()" title="Tap to set your photo">👤</span>
        <b id="myName"></b> <button class="editBtn" onclick="rename()" title="Change name">✎</button>
      </span>
      <span id="myChips"></span>
    </div>
    <div class="row"><span style="color:var(--mut)">Bet this hand</span><span id="myHandBet"></span></div>
  </div>

  <div class="boardArea">
    <div class="lbl" id="boardLbl">Community cards</div>
    <div class="boardRow" id="boardMini"></div>
    <div class="turnBanner hidden" id="turnBanner">YOUR TURN</div>
    <div class="waiting" id="waitLine"></div>
  </div>

  <div class="coach hidden" id="coachBox"></div>

  <div class="myArea">
    <div class="lbl">Your hole cards</div>
    <div class="hole" id="myHole"></div>
  </div>

  <div class="btns">
    <button class="bFold" id="bFold" onclick="act('fold')">Fold</button>
    <button class="bCall" id="bCall" onclick="act('call')">Check</button>
    <button class="bRaise" id="bRaise" onclick="act('raise')">Raise</button>
  </div>
  <div class="raiseRow" id="raiseRow"></div>
  <div class="bar">
    <button class="tbtn" id="btnCoach" onclick="cycleCoach()">Coach</button>
    <button class="tbtn" onclick="transfer()">Send chips</button>
    <button class="tbtn" style="color:#8c2f2f" onclick="leaveTable()">Leave table</button>
  </div>
  <div class="pubLine" id="pubLine"></div>
  <input type="file" id="avFile" accept="image/*" class="hidden">
</div>

<div id="portalWait" class="hidden">${PORTAL_BODY}</div>

<div id="pSeat" class="hidden">
  <h1 class="disp">我的座位</h1>
  <div class="sub">名字、照片、教練程度 — 隨時可改，牌局照常進行</div>
  <div class="statusCard">
    <div class="row">
      <span style="display:flex;align-items:center;gap:9px">
        <span class="av" id="sAv" onclick="pickAv()" title="Tap to set your photo">👤</span>
        <b id="sName"></b> <button class="editBtn" onclick="rename()">✎</button>
      </span>
      <span id="sChips" style="color:var(--mut)"></span>
    </div>
  </div>
  <div class="bar" style="margin-top:10px;flex-wrap:wrap">
    <button class="tbtn" id="btnCoach2" onclick="cycleCoach()">Coach</button>
    <button class="tbtn" onclick="transfer()">Send chips</button>
    <button class="tbtn" style="color:#8c2f2f" onclick="leaveTable()">Leave table 離座</button>
  </div>
  <div class="sub" id="sHint" style="margin-top:10px"></div>
</div>

<div id="mjPlay" class="hidden">
  <button id="rotBtn" class="tbtn" style="width:100%;margin-bottom:8px;background:var(--gold);border-color:var(--gold);color:#3d2f10;font-weight:700" onclick="toggleRot()">🔄 切換橫向／直向</button>
  <div class="topbar">
    <b id="mjMyName"></b><span class="windb" id="mjMyWind"></span>
    <span class="sc" id="mjMyScore"></span>
    <span id="mjLeft" style="color:var(--mut)"></span>
    <span id="mjTurnLn" style="color:var(--gold);font-weight:700"></span>
    <span class="bannerLn" id="mjBannerLn"></span>
  </div>
  <div id="mjClaimBar" class="claimBar hidden"></div>
  <div id="mjActs" class="actRow hidden"></div>
  <div class="myArea" style="text-align:left">
    <div class="mjTidyBar" id="mjTidyBar"></div>
    <div class="lbl" id="mjRackLbl">手牌</div>
    <div id="mjGroupBox"></div>
    <div class="rack" id="mjRack"></div>
    <div class="waitsLn" id="mjWaits"></div>
    <div class="mMini" id="mjMine"></div>
  </div>
</div>


<div id="brPlay" class="hidden">
  <div class="topbar" style="display:flex;gap:10px;align-items:center;font-size:.88rem;flex-wrap:wrap;background:#fff;border:1px solid var(--line);border-radius:10px;padding:7px 11px;margin-bottom:8px;">
    <b id="brMySeat"></b><span id="brMyRole" style="color:var(--mut)"></span>
    <span id="brMyContract"></span>
    <span id="brMyTricks" style="margin-left:auto"></span>
    <span class="brTurnLn" id="brMyTurn" style="flex-basis:100%"></span>
    <span class="brNote" id="brMyBanner" style="flex-basis:100%"></span>
  </div>
  <div id="brBidBox" class="brBox hidden" style="margin-bottom:9px"></div>
  <div id="brTrickBox" class="brBox hidden" style="margin-bottom:9px"></div>
  <div class="myArea" style="text-align:left">
    <div class="lbl" id="brHandLbl">我的牌 MY HAND</div>
    <div id="brMyHand"></div>
  </div>
  <div class="bar" style="flex-wrap:wrap;margin-top:10px">
    <button class="tbtn" id="brAutoBtn" onclick="brAuto()">電腦代打 Auto</button>
    <button class="tbtn" style="color:#8c2f2f" onclick="leaveTable()">離座 Leave</button>
  </div>
  <div class="brNote" id="brHint" style="margin-top:8px"></div>
</div>
</div>

<div id="pBar" class="hidden">
  <div class="lpill">
    <button id="P1" onclick="pView(1)">1 · 大廳</button>
    <button id="P2" onclick="pView(2)">2 · 座位</button>
    <button id="P3" onclick="pView(3)">3 · 牌桌</button>
  </div>
  <button class="auto" onclick="pView(0)">Auto</button>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>
const SUITS=["♠","♥","♦","♣"],RN={11:"J",12:"Q",13:"K",14:"A"};
const rN=r=>RN[r]||String(r);
const cardHTML=(c,cls="")=>{const red=(c.s===1||c.s===2);
 return '<div class="card '+cls+(red?' red':'')+'"><span>'+rN(c.r)+'</span><span class="s">'+SUITS[c.s]+'</span></div>';};
const IS_HOST=false;  // 手機只看，不能移除別人
let token=localStorage.getItem("pk_token")||null, myName=localStorage.getItem("pk_name")||"";
let S=null, ME=null, coachOn=true, es=null, wasMyTurn=false;
let GAME=null, MJME=null, mjSel=null, rackTiles=[], wasClaim=false, BRME=null;

async function join(){
  const nm=document.getElementById("nm").value.trim();
  const r=await fetch("/api/join",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({name:nm,token})}).then(x=>x.json());
  if(r.error){document.getElementById("joinErr").textContent=r.error;return;}
  token=r.token; myName=r.name;
  localStorage.setItem("pk_token",token); localStorage.setItem("pk_name",myName);
  connect();
}
/* ---- stay-online: reconnect after app switch / screen lock ---- */
let esRetry=null, wakeLock=null;
async function keepAwake(){
  try{ if("wakeLock" in navigator && (!wakeLock||wakeLock.released))
    wakeLock=await navigator.wakeLock.request("screen"); }catch(e){}
}
function esDead(){ return !es || es.readyState===2; }
function reconnect(){ if(!token) return; if(!esDead()) return; openES(); }
document.addEventListener("visibilitychange",function(){ if(!document.hidden){ reconnect(); keepAwake(); } });
window.addEventListener("pageshow",reconnect);
window.addEventListener("focus",reconnect);
window.addEventListener("online",reconnect);
setInterval(reconnect,5000);

function connect(){
  document.getElementById("join").classList.add("hidden");
  openES(); keepAwake();
}
function openES(){
  if(es){ try{ es.close(); }catch(e){} }
  es=new EventSource("/events?token="+token);
  es.onerror=function(){ if(esRetry) return;
    esRetry=setTimeout(function(){ esRetry=null; openES(); },2000); };
  es.onmessage=e=>{const d=JSON.parse(e.data); GAME=d.game; S=d.pub; MEIN=d.me;
    window.__code=d.code; window.__setup=d.setup; pRender(); };
}
let PV=0, pLastAuto="", MEIN=null;
function pView(n){ PV=n; pRender(); }
function coachLvl(){ return localStorage.getItem("pk_coach")||"adv"; }
function cycleCoach(){
  const order=["adv","basic","off"], i=order.indexOf(coachLvl());
  localStorage.setItem("pk_coach",order[(i+1)%3]); pRender();
}
function coachLabel(){ return "Coach: "+({adv:"進階 Advanced",basic:"教學 Basic",off:"Off"}[coachLvl()]); }
function pRender(){
  if(!S) return;
  const noGame=(GAME===null||GAME===undefined);
  const auto=noGame?1:3;
  const akey=(GAME||"none")+"|"+auto;
  if(akey!==pLastAuto){ pLastAuto=akey; PV=0; }   // game starts/ends/changes -> snap back
  let L=PV||auto;
  if(noGame&&L===3) L=1;
  document.body.classList.toggle("mj",GAME==="mahjong"&&L===3);
  document.getElementById("pBar").classList.remove("hidden");
  ["P1","P2","P3"].forEach(function(id,k){ const b=document.getElementById(id);
    b.classList.toggle("on",L===k+1); b.disabled=(k===2&&noGame); });
  document.getElementById("portalWait").classList.toggle("hidden",L!==1);
  document.getElementById("pSeat").classList.toggle("hidden",L!==2);
  document.getElementById("play").classList.toggle("hidden",!(L===3&&GAME==="poker"));
  document.getElementById("mjPlay").classList.toggle("hidden",!(L===3&&GAME==="mahjong"));
  document.getElementById("brPlay").classList.toggle("hidden",!(L===3&&GAME==="bridge"));
  document.body.classList.toggle("br",GAME==="bridge"&&L===3);
  document.getElementById("btnCoach").textContent=coachLabel();
  renderPortal(); paintSeat();
  if(GAME==="poker"){
    if(!MEIN){ document.getElementById("waitLine").textContent="You've been removed from the table.";
      document.getElementById("pubLine").textContent="Ask the host to end the session if you want to rejoin."; return; }
    ME=MEIN; if(L===3) paint();
  } else if(GAME==="bridge"){
    BRME=MEIN;
    if(L===3) brPaint();
  } else if(GAME==="mahjong"){
    MJME=MEIN;
    if(!MJME||!MJME.myTurn) mjSel=null;
    if(localStorage.getItem("mj_rot")==="1") document.getElementById("mjPlay").classList.add("rot");
    if(L===3) mjPaint();
  }
}
function paintSeat(){
  document.getElementById("sName").textContent=myName||"";
  let chips="", av=null;
  if(GAME==="poker"&&ME&&S.players&&S.players[ME.seat]){
    const p=S.players[ME.seat]; chips="🪙 "+p.chips; av=p.avatar;
  } else if(GAME==="mahjong"&&MJME){ chips="分數 "+(MJME.score||0); }
  document.getElementById("sChips").textContent=chips;
  const a=document.getElementById("sAv");
  if(av){ a.style.backgroundImage="url("+av+")"; a.textContent=""; }
  document.getElementById("btnCoach2").textContent=coachLabel();
  document.getElementById("sHint").textContent=
    coachLvl()==="adv" ? "進階教練：勝率、賠率、outs、位置、SPR — 每一步都給數字和理由。"
    : coachLvl()==="basic" ? "教學模式：一句話白話建議，適合新手。"
    : "教練已關閉。";
}
function transfer(){
  if(!S||!ME) return;
  const others=S.players.map((p,idx)=>({p,idx})).filter(x=>x.idx!==ME.seat&&!x.p.removed);
  if(!others.length) return alert("No one to send chips to.");
  const list=others.map((x,k)=>(k+1)+") "+x.p.name+" ("+x.p.chips+")").join("\\n");
  const pick=parseInt(prompt("Send chips to:\\n"+list+"\\n\\nEnter a number:"));
  if(!pick||pick<1||pick>others.length) return;
  const me=S.players[ME.seat];
  const amt=parseInt(prompt("Amount to send to "+others[pick-1].p.name+" (you have "+me.chips+"):"));
  if(!amt||amt<=0) return;
  fetch("/api/transfer",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({token,toId:others[pick-1].p.id,amount:amt})})
    .then(r=>r.json()).then(j=>{if(j.error)alert(j.error);});
}
function rename(){
  if(!S||!ME) return;
  const cur=S.players[ME.seat]?S.players[ME.seat].name:"";
  const nm=prompt("New name:",cur);
  if(!nm||!nm.trim()) return;
  fetch("/api/rename",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({token,name:nm.trim()})}).then(r=>r.json()).then(j=>{
      if(j.error)alert(j.error); else localStorage.setItem("pk_name",j.name); });
}
function act(a,to){
  fetch("/api/action",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({token,action:a,to})}).then(r=>r.json()).then(j=>{if(j.error)alert(j.error);});
}
function pesc(t){ return String(t).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function advHTML(a){
  let eq=0; a.rows.forEach(function(r){ if(r[0]==="Equity") eq=parseInt(r[1],10)||0; });
  let h='<div class="eqBar"><i style="width:'+Math.max(2,Math.min(100,eq))+'%"></i></div>';
  a.rows.forEach(function(r){
    h+='<div class="cRow"><span class="k">'+pesc(r[0])+'</span><span class="v">'+pesc(r[1])+'</span></div>'; });
  h+='<div class="cVer '+pesc(a.tone)+'">'+pesc(a.verdict)+'</div>';
  h+='<div class="cWhy">'+pesc(a.why)+'</div>';
  return h;
}
function paint(){
  if(!S||!ME) return;
  const p=S.players[ME.seat];
  document.getElementById("myName").textContent=p.name;
  document.getElementById("myChips").textContent="🪙 "+p.chips+(p.folded?"  ·  folded":p.allIn?"  ·  all-in":"");
  document.getElementById("myHandBet").textContent=p.handBet||0;
  const av=document.getElementById("myAv");
  if(p.avatar){ av.style.backgroundImage="url("+p.avatar+")"; av.textContent=""; }
  document.getElementById("myHole").innerHTML=
    (ME.hole&&ME.hole.length)? ME.hole.map(c=>cardHTML(c,"xl")).join("")
    :'<div class="card xl back"></div><div class="card xl back"></div>';
  const stages=["Pre-flop","Flop","Turn","River","Showdown"];
  document.getElementById("boardLbl").textContent= S.phase==="play" ? (stages[S.stage]+" · pot "+S.pot) : "Community cards";
  let bh=S.board.map(c=>cardHTML(c)).join("");
  for(let k=S.board.length;k<5;k++) bh+='<div class="card slot"></div>';
  document.getElementById("boardMini").innerHTML=bh;
  const my=ME.yourTurn;
  document.getElementById("turnBanner").classList.toggle("hidden",!my);
  document.getElementById("waitLine").textContent= my? "" :
    (S.handOver? "Hand finished — watch the big screen."
     : (S.turn>=0&&S.players[S.turn]? "Waiting for "+S.players[S.turn].name+"…":""));
  if(my&&!wasMyTurn&&navigator.vibrate) navigator.vibrate([120,60,120]);
  wasMyTurn=my;
  const A=ME.actions;
  document.getElementById("bFold").disabled=!(A&&A.canFold);
  const bC=document.getElementById("bCall");
  bC.disabled=!A; bC.textContent=A?A.callLabel:"Check";
  const bR=document.getElementById("bRaise");
  const rr=document.getElementById("raiseRow");
  if(A&&A.raises&&A.raises.length){
    bR.classList.add("hidden");
    rr.innerHTML=A.raises.map(o=>'<button onclick="act(\\'raise\\','+o.to+')">'+o.label+'</button>').join("");
  } else {
    bR.classList.remove("hidden"); rr.innerHTML="";
    bR.disabled=!(A&&A.canRaise); bR.textContent=A?A.raiseLabel:"Raise";
  }
  const cb=document.getElementById("coachBox");
  const lvl=coachLvl();
  const live=!p.folded&&S.phase==="play"&&!S.handOver;
  if(!live||lvl==="off"){ cb.classList.add("hidden"); }
  else if(lvl==="adv"&&ME.coachAdv){ cb.classList.remove("hidden"); cb.innerHTML=advHTML(ME.coachAdv); }
  else if(ME.coach){ cb.classList.remove("hidden"); cb.textContent=ME.coach; }
  else cb.classList.add("hidden");
  document.getElementById("btnCoach").textContent=coachLabel();
  document.getElementById("pubLine").textContent=S.banner||"";
}
function leaveTable(){
  if(!confirm("Leave the table and free your seat? Your chips leave with you.")) return;
  fetch("/api/leave",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({token})}).catch(()=>{}).finally(()=>{ clearSeat(); });
}
function clearSeat(){
  localStorage.removeItem("pk_token"); localStorage.removeItem("pk_name");
  token=null; myName=""; S=null; ME=null;
  if(es){ try{es.close();}catch(e){} es=null; }
  document.getElementById("play").classList.add("hidden");
  document.getElementById("join").classList.remove("hidden");
  document.getElementById("clearSeatBtn").classList.add("hidden");
  document.getElementById("joinErr").textContent="";
}
function pickAv(){ document.getElementById("avFile").click(); }
document.getElementById("avFile").addEventListener("change",function(){
  const f=this.files[0]; if(!f) return; this.value="";
  const img=new Image();
  img.onload=function(){
    const c=document.createElement("canvas"); c.width=96; c.height=96;
    const x=c.getContext("2d");
    const s=Math.min(img.width,img.height);
    x.drawImage(img,(img.width-s)/2,(img.height-s)/2,s,s,0,0,96,96);
    const data=c.toDataURL("image/jpeg",0.65);
    URL.revokeObjectURL(img.src);
    fetch("/api/avatar",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({token,img:data})}).then(r=>r.json()).then(j=>{if(j.error)alert(j.error);});
  };
  img.onerror=function(){ alert("Could not read that photo."); };
  img.src=URL.createObjectURL(f);
});

/* ---- bridge (phone) ---- */
const BST=["\u2663","\u2666","\u2665","\u2660","NT"], BSE=["N","E","S","W"], BSU=["\u2660","\u2665","\u2666","\u2663"];
const BSEZH=["\u5317 North","\u6771 East","\u5357 South","\u897F West"];
function bStrainHTML(st){ const t=BST[st]; return (st===1||st===2)?'<span class="redS">'+t+'</span>':t; }
function bCallHTML(c){ if(c.t==="P") return "Pass"; if(c.t==="X") return "X"; if(c.t==="XX") return "XX";
  return c.lvl+bStrainHTML(c.str); }
function bContractHTML(c){ if(!c) return "\u2014";
  return c.lvl+bStrainHTML(c.str)+(c.dbl===1?" X":c.dbl===2?" XX":"")+" by "+BSE[c.declarer]; }
function cid(c){ return c.s*13+(c.r-2); }
function brCall(call){ api("/api/br/call",{token:token,call:call}); }
function brPlayCard(id){ api("/api/br/play",{token:token,card:id}); }
function brAuto(){ if(BRME&&BRME.seat>=0) api("/api/br/auto",{seat:BRME.seat}); }
function brBidBoxHTML(me){
  const c=me.calls; if(!c) return "";
  let h='<div style="font-size:.7rem;letter-spacing:.14em;color:var(--mut);margin-bottom:6px">\u53eb\u724c BIDDING BOX</div><div class="bidGrid">';
  for(var l=1;l<=7;l++) for(var st=0;st<5;st++){
    var v=l*5+st, ok=c.bids.indexOf(v)>=0;
    h+='<button class="'+(ok?'':'off')+'" '+(ok?'onclick="brCall({t:\\'B\\',lvl:'+l+',str:'+st+'})"':'disabled')+'>'+l+bStrainHTML(st)+'</button>';
  }
  h+='</div><div class="bidRow"><button class="bPass" onclick="brCall({t:\\'P\\'})">Pass</button>'
   +'<button class="bDbl"'+(c.dbl?'':' disabled')+' onclick="brCall({t:\\'X\\'})">X \u52a0\u500d</button>'
   +'<button class="bRdbl"'+(c.rdbl?'':' disabled')+' onclick="brCall({t:\\'XX\\'})">XX \u518d\u52a0\u500d</button></div>';
  return h;
}
function brHandHTML(cards,legal,live){
  const set={}; (legal||[]).forEach(function(c){ set[cid(c)]=1; });
  let h='<div class="brHand'+(live?' live':'')+'">';
  [0,1,2,3].forEach(function(su){
    const cs=cards.filter(function(c){return c.s===su;}).sort(function(a,b){return b.r-a.r;});
    if(!cs.length) return;
    h+='<div class="brSuitRow" style="flex-basis:100%"><span class="sl'+((su===1||su===2)?' redS':'')+'">'+BSU[su]+'</span>';
    h+=cs.map(function(c){ const id=cid(c); const ok=live&&set[id];
      return '<span '+(ok?'onclick="brPlayCard('+id+')"':'')+'>'+cardHTML(c,ok?"ok":(live?"no":""))+'</span>'; }).join("");
    h+='</div>';
  });
  return h+'</div>';
}
function brTrickHTML(b,me){
  const show=(b.trick&&b.trick.length)?b.trick:(b.lastTrick?b.lastTrick.cards:[]);
  const isLast=(!b.trick||!b.trick.length)&&b.lastTrick;
  // \u8ddf\u5927\u87a2\u5e55\u4e00\u6a21\u4e00\u6a23\u7684\u56fa\u5b9a\u65b9\u4f4d\uff1aN \u4e0a\u3001E \u53f3\u3001S \u4e0b\u3001W \u5de6\u3002
  // \u624b\u6a5f\u4e0d\u518d\u628a\u81ea\u5df1\u8f49\u5230\u4e0b\u9762 \u2014\u2014 \u4e00\u8f49\uff0c\u5de6\u53f3\u5169\u5bb6\u5c31\u8ddf\u96fb\u8996\u4e0a\u5c0d\u8abf\uff0c\u770b\u8d77\u4f86\u50cf\u93e1\u50cf\u3002
  const pos=["tN","tE","tS","tW"];
  let h='<div style="font-size:.7rem;letter-spacing:.14em;color:var(--mut);margin-bottom:4px">'
    +(isLast?"\u4e0a\u4e00\u58a9 LAST TRICK \u2014 "+BSE[b.lastTrick.win]+" \u8d0f":"\u9019\u4e00\u58a9 THIS TRICK")
    +'　\u5df2\u6253 '+b.played+'/13</div><div class="brTrick" style="min-height:150px">';
  [0,1,2,3].forEach(function(s){
    const mine=(s===me.seat);
    const x=show.filter(function(y){return y.seat===s;})[0];
    h+='<div class="'+pos[s]+(mine?' meSlot':'')+'" style="text-align:center">'
      +'<div style="font-size:.6rem;'+(mine?'color:var(--felt);font-weight:700':'color:var(--mut)')+'">'
      +BSE[s]+(mine?' \u4f60':'')+'</div>'
      +(x?cardHTML(x.card,"sm"):'<div class="card sm slot" style="border-color:#cfc7b2"></div>')+'</div>';
  });
  return h+'</div>';
}
function brPaint(){
  const b=S, me=BRME;
  const seatEl=document.getElementById("brMySeat");
  if(!me||me.seat<0){ seatEl.textContent="\u4f60\u4e0d\u5728\u9019\u5834\u724c\u5c40\u88e1";
    document.getElementById("brMyHand").innerHTML="";
    document.getElementById("brBidBox").classList.add("hidden");
    document.getElementById("brHint").textContent="\u4e0b\u4e00\u5834\u958b\u5c40\u6642\u5c31\u6703\u6392\u5230\u4f60\u3002";
    return; }
  seatEl.textContent=BSEZH[me.seat];
  document.getElementById("brMyRole").textContent =
    me.isDeclarer? "\u838a\u5bb6 Declarer" : me.isDummy? "\u838a\u5bb6\u540c\u4f34 Partner" :
    (b.contract? "\u9632\u5b88 Defender" : "");
  document.getElementById("brMyContract").innerHTML = b.contract? ("\u5b9a\u7d04 "+bContractHTML(b.contract)) : "\u53eb\u724c\u4e2d";
  document.getElementById("brMyTricks").innerHTML = "N/S <b>"+b.tricks[0]+"</b> \u2013 E/W <b>"+b.tricks[1]+"</b>";
  document.getElementById("brMyBanner").textContent=b.banner||"";
  const bid=document.getElementById("brBidBox");
  const turnLn=document.getElementById("brMyTurn");
  document.getElementById("brAutoBtn").textContent = me.auto? "\u6062\u5fa9\u81ea\u5df1\u6253 Take back" : "\u96fb\u8166\u4ee3\u6253 Auto";
  if(b.handOver){
    turnLn.textContent="\u9019\u526f\u7d50\u675f \u2014 \u770b\u5927\u87a2\u5e55\u7684\u8a08\u5206\uff0c\u4e3b\u6a5f\u6309\u300c\u4e0b\u4e00\u526f\u300d";
    bid.classList.add("hidden");
    document.getElementById("brTrickBox").classList.add("hidden");
    document.getElementById("brMyHand").innerHTML=brHandHTML(me.hand,[],false);
    document.getElementById("brHint").textContent="";
    return;
  }
  if(b.stage==="auction"){
    if(me.myTurn){ turnLn.textContent="\u8f2a\u5230\u4f60\u53eb\u724c \u2014 YOUR CALL";
      bid.innerHTML=brBidBoxHTML(me); bid.classList.remove("hidden"); }
    else { turnLn.textContent="\u7b49 "+BSE[b.turn]+" \u53eb\u724c\u2026"; bid.classList.add("hidden"); }
    document.getElementById("brTrickBox").classList.add("hidden");
    document.getElementById("brMyHand").innerHTML=brHandHTML(me.hand,[],false);
    document.getElementById("brHint").textContent="\u53eb\u724c\u898f\u5247\uff1a\u53ea\u80fd\u53eb\u6bd4\u4e0a\u4e00\u500b\u9ad8\u7684\u5b9a\u7d04\uff1b\u53ea\u80fd\u52a0\u500d\u5c0d\u624b\u7684\u5b9a\u7d04\uff1b\u4e09\u5bb6 Pass \u5c31\u5b9a\u7d04\u3002";
    return;
  }
  bid.classList.add("hidden");
  const live=!!me.myTurn;
  const tb=document.getElementById("brTrickBox");
  tb.classList.remove("hidden"); tb.innerHTML=brTrickHTML(b,me);
  document.getElementById("brHandLbl").textContent = "\u6211\u7684\u724c MY HAND";
  document.getElementById("brMyHand").innerHTML=brHandHTML(me.hand,live?me.legal:[],live);
  turnLn.textContent = live ? "\u8f2a\u5230\u4f60\u51fa\u724c \u2014 YOUR CARD"
    : ("\u7b49 "+BSE[b.turn]+" \u51fa\u724c\u2026");
  document.getElementById("brHint").textContent = live
    ? "\u5fc5\u9808\u8ddf\u82b1\u8272\uff1b\u6c92\u6709\u8a72\u82b1\u8272\u624d\u53ef\u4ee5\u51fa\u5225\u7684\u3002"
    : (b.lastTrick? ("\u4e0a\u4e00\u58a9 "+BSE[b.lastTrick.win]+" \u8d0f"):"");
}

/* ---- portal + mahjong (phone) ---- */
const MJN=["一","二","三","四","五","六","七","八","九"],MJH=["東","南","西","北","中","發","白"],MJF=["春","夏","秋","冬","梅","蘭","菊","竹"];
function mjNm(t){ if(t<9)return MJN[t]+"萬"; if(t<18)return MJN[t-9]+"筒"; if(t<27)return MJN[t-18]+"條"; if(t<34)return MJH[t-27]; return MJF[t-34]; }
function _dots(n){var L={1:[[17,24,7]],2:[[17,14,5.2],[17,34,5.2]],3:[[9,12,5],[17,24,5],[25,36,5]],4:[[11,14,5],[23,14,5],[11,34,5],[23,34,5]],5:[[11,13,4.6],[23,13,4.6],[17,24,4.6],[11,35,4.6],[23,35,4.6]],6:[[11,12,4.3],[23,12,4.3],[11,24,4.3],[23,24,4.3],[11,36,4.3],[23,36,4.3]],7:[[9,11,3.9],[17,11,3.9],[25,11,3.9],[13,24,3.9],[21,24,3.9],[13,37,3.9],[21,37,3.9]],8:[[9,11,3.7],[17,11,3.7],[25,11,3.7],[9,24,3.7],[25,24,3.7],[9,37,3.7],[17,37,3.7],[25,37,3.7]],9:[[9,11,3.7],[17,11,3.7],[25,11,3.7],[9,24,3.7],[17,24,3.7],[25,24,3.7],[9,37,3.7],[17,37,3.7],[25,37,3.7]]};return L[n]||L[1];}
function _bamboo(n){
  var G="#2f7d3e", B="#1c6fb0", R="#a3282a";
  var L={
    2:[[17,15,G],[17,33,G]],
    3:[[17,13,G],[10,34,G],[24,34,G]],
    4:[[11,15,G],[23,15,B],[11,33,B],[23,33,G]],
    5:[[10,13,G],[24,13,G],[17,24,R],[10,35,G],[24,35,G]],
    6:[[9,15,G],[17,15,B],[25,15,G],[9,33,G],[17,33,B],[25,33,G]],
    7:[[17,10,R],[9,26,G],[17,26,B],[25,26,G],[9,39,G],[17,39,B],[25,39,G]],
    8:[[8,14,G],[15,14,G],[22,14,G],[29,14,G],[8,34,B],[15,34,B],[22,34,B],[29,34,B]],
    9:[[9,12,G],[17,12,B],[25,12,G],[9,24,G],[17,24,B],[25,24,G],[9,36,G],[17,36,B],[25,36,G]]
  };
  return L[n]||L[2];
}
/* 一根竹：直桿 + 兩端的節。h 是這一列可以用的高度 */
function _stick(x,y,col,h){
  var half=h/2;
  return '<rect x="'+(x-2)+'" y="'+(y-half)+'" width="4" height="'+h+'" rx="2" fill="'+col+'"/>'
       + '<rect x="'+(x-3.2)+'" y="'+(y-half+h*0.30)+'" width="6.4" height="1.6" rx="0.8" fill="'+col+'" opacity="0.85"/>'
       + '<rect x="'+(x-3.2)+'" y="'+(y+half-h*0.30-1.6)+'" width="6.4" height="1.6" rx="0.8" fill="'+col+'" opacity="0.85"/>';
}
function tsvg(t){
  var s='<svg viewBox="0 0 34 48" width="100%" height="100%">';
  function tx(str,y,fill,size){return '<text x="17" y="'+y+'" text-anchor="middle" font-family="serif" font-weight="700" font-size="'+size+'" fill="'+fill+'">'+str+'</text>';}
  if(t<9){ s+=tx(MJN[t],20,"#a3282a",16)+tx("萬",43,"#a3282a",15); }
  else if(t<18){ var n=t-8; if(n===1){ s+='<circle cx="17" cy="24" r="10" fill="none" stroke="#1c6fb0" stroke-width="2.2"/><circle cx="17" cy="24" r="6" fill="none" stroke="#a3282a" stroke-width="2"/><circle cx="17" cy="24" r="2.6" fill="#2f7d3e"/>'; } else _dots(n).forEach(function(p){ s+='<circle cx="'+p[0]+'" cy="'+p[1]+'" r="'+p[2]+'" fill="#fff" stroke="#1c6fb0" stroke-width="1.5"/><circle cx="'+p[0]+'" cy="'+p[1]+'" r="'+(p[2]*0.42)+'" fill="#a3282a"/>'; }); }
  else if(t<27){ var m=t-17; if(m===1){ s+='<ellipse cx="17" cy="27" rx="6" ry="8" fill="#2f7d3e"/><circle cx="17" cy="17" r="4.4" fill="#2f7d3e"/><path d="M17 12 L22 9 L18.5 15 Z" fill="#a3282a"/><circle cx="18.6" cy="16" r="1" fill="#fff"/>'; } else { var bb=_bamboo(m); var bh=(m>=9)?9:((m>=7)?10:(m>=6?13:15)); bb.forEach(function(p){ s+=_stick(p[0],p[1],p[2],bh); }); } }
  else if(t<31){ s+=tx(["東","南","西","北"][t-27],31,"#25324a",20); }
  else if(t===31){ s+=tx("中",31,"#b02c22",21); }
  else if(t===32){ s+=tx("發",31,"#1e7a3c",21); }
  else if(t===33){ s+='<rect x="6" y="9" width="22" height="30" rx="3" fill="none" stroke="#1c6fb0" stroke-width="2.4"/>'; }
  else { var fi=t-34; var col=fi<4?"#c8611c":"#2f7d3e"; s+=tx(MJF[fi],32,col,19)+'<text x="5" y="11" font-family="sans-serif" font-size="8" fill="'+col+'">'+((fi%4)+1)+'</text>'; }
  return s+'</svg>';
}
function mtile(t,sm,extra){
  var c=(sm?"mtile sm":"mtile")+(extra||"");
  if(t===null||t===undefined) return '<div class="'+c+' back"></div>';
  return '<div class="'+c+'">'+tsvg(t)+'</div>';
}
function api(u,b){ return fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},
  body:JSON.stringify(b||{})}).then(function(r){return r.json();}).then(function(j){ if(j.error) alert(j.error); return j; }); }
${PORTAL_JS}
function mjPost(u,b){ b.token=token;
  fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)})
    .then(function(r){return r.json();}).then(function(j){ if(j.error) alert(j.error); });
}
function toggleRot(){ var e=document.getElementById("mjPlay"); var on=!e.classList.contains("rot"); e.classList.toggle("rot",on); localStorage.setItem("mj_rot",on?"1":"0"); }
function mjPick(i){
  if(mjTidy) return;                       // 理牌模式只選牌，不出牌
  if(!MJME||!MJME.myTurn){ mjSel=null; return; }
  if(mjSel===i){ mjDoDiscard(); return; }
  mjSel=i; mjPaint();
}
function mjDoDiscard(){
  if(mjSel===null||!MJME||!MJME.myTurn) return;
  const t=rackTiles[mjSel]; mjSel=null;
  mjPost("/api/mj/discard",{tile:t});
}
function mjSelfWin(){ mjPost("/api/mj/self",{action:"win"}); }
function mjAG(t){ mjPost("/api/mj/self",{action:"angang",tile:t}); }
function mjJG(t){ mjPost("/api/mj/self",{action:"jiagang",tile:t}); }
function mjClaimW(){ mjPost("/api/mj/claim",{resp:{t:"win"}}); }
function mjClaimP(){ mjPost("/api/mj/claim",{resp:{t:"pong"}}); }
function mjClaimG(){ mjPost("/api/mj/claim",{resp:{t:"gang"}}); }
function mjClaimC(a,b){ mjPost("/api/mj/claim",{resp:{t:"chi",a:a,b:b}}); }
function mjClaimPass(){ mjPost("/api/mj/claim",{resp:{t:"pass"}}); }
let mjCdTimer=null;
function mjCdTick(){
  const el=document.getElementById("mjCd");
  if(!el||!S||!S.claimUntil){ return; }
  const s=Math.max(0,Math.ceil((S.claimUntil-Date.now())/1000));
  el.textContent="⏱ "+s+"s";
}

/* ───────── 麻將理牌：自己分組 + 教練自動分組 ─────────
   分組完全是這支手機上的整理，伺服器不知道，也不影響任何規則。
   教練那一份是伺服器算的，但只算你自己的牌。                      */
let mjGroups = [];                 // [[tile,tile,...], ...]
let mjTidy = false;                // 理牌模式：可以複選，不會打出去
let mjMulti = new Set();           // 理牌模式下選起來的位置
let mjCoach = localStorage.getItem("mj_coach")==="1";
let mjCoachSig = "", mjCoachSh = null;

function mjHandSig(){
  if(!MJME) return "";
  const h=(MJME.hand||[]).slice();
  if(MJME.drawn!==null&&MJME.drawn!==undefined) h.push(MJME.drawn);
  return h.slice().sort(function(a,b){return a-b;}).join(",");
}
function mjAskCoach(force){
  if(!MJME||MJME.spectator) return;
  const sig=mjHandSig();
  if(!sig) return;
  if(!force && (!mjCoach || sig===mjCoachSig)) return;
  mjCoachSig=sig;
  fetch("/api/mj/groups",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({token:token})}).then(function(r){return r.json();}).then(function(j){
      if(!j||!j.ok){ if(force&&j&&j.error) alert(j.error); return; }
      mjGroups=(j.groups||[]).map(function(g){ return g.tiles.slice(); });
      mjCoachSh=(typeof j.shanten==="number")?j.shanten:null;
      mjMulti.clear(); mjPaint();
    });
}
function mjToggleCoach(){
  mjCoach=!mjCoach; localStorage.setItem("mj_coach",mjCoach?"1":"0");
  if(mjCoach){ mjCoachSig=""; mjAskCoach(true); }
  else { mjGroups=[]; mjCoachSh=null; mjPaint(); }
}
function mjToggleTidy(){ mjTidy=!mjTidy; mjMulti.clear(); mjSel=null; mjPaint(); }
function mjMakeGroup(){
  if(mjMulti.size<2) return alert("至少選兩張才分得成一組");
  const picked=[...mjMulti].map(function(i){ return rackTiles[i]; }).filter(function(t){return t!==undefined;});
  mjGroups=mjGroups.map(function(g){ return g.filter(function(t){ return picked.indexOf(t)<0; }); })
                   .filter(function(g){ return g.length; });
  mjGroups.push(picked.slice().sort(function(a,b){return a-b;}));
  mjMulti.clear(); mjPaint();
}
function mjClearGroups(){ mjGroups=[]; mjMulti.clear(); mjCoachSh=null; mjPaint(); }
function mjDropGroup(gi){ mjGroups.splice(gi,1); mjPaint(); }
function mjGroupLabel(g){
  if(g.length===3){
    if(g[0]===g[1]&&g[1]===g[2]) return "刻子";
    const a=g.slice().sort(function(x,y){return x-y;});
    if(a[0]<27&&a[1]===a[0]+1&&a[2]===a[0]+2) return "順子";
    return "";
  }
  if(g.length===2) return (g[0]===g[1])?"對子":"搭子";
  if(g.length===4&&g[0]===g[3]) return "槓";
  return "";
}
/* 把手牌照「分組先、散牌後」排出來，回傳顯示順序的牌陣 */
function mjLayout(hand){
  const pool=hand.slice();
  const out=[], strips=[];
  mjGroups.forEach(function(g,gi){
    const take=[];
    for(const t of g){ const k=pool.indexOf(t); if(k>=0){ pool.splice(k,1); take.push(t); } }
    if(take.length) strips.push({gi:gi,tiles:take});
  });
  strips.forEach(function(st){ st.from=out.length; st.tiles.forEach(function(t){ out.push(t); }); });
  const looseFrom=out.length;
  pool.sort(function(a,b){return a-b;}).forEach(function(t){ out.push(t); });
  return {order:out, strips:strips, looseFrom:looseFrom};
}
function mjTapTile(i){
  if(mjTidy){
    if(mjMulti.has(i)) mjMulti.delete(i); else mjMulti.add(i);
    mjPaint(); return;
  }
  mjPick(i);
}
function mjRenderTidyBar(){
  const bar=document.getElementById("mjTidyBar");
  if(!bar) return;
  if(!MJME||MJME.spectator||S.handOver){ bar.innerHTML=""; return; }
  let h='<button class="tdBtn'+(mjCoach?" on":"")+'" onclick="mjToggleCoach()">教練 '+(mjCoach?"✓":"Coach")+'</button>'
      + '<button class="tdBtn" onclick="mjAskCoach(true)">幫我理一次</button>'
      + '<button class="tdBtn'+(mjTidy?" on":"")+'" onclick="mjToggleTidy()">'+(mjTidy?"理牌中 ✓":"自己分組")+'</button>';
  if(mjTidy){
    h+='<button class="tdBtn go" onclick="mjMakeGroup()">分成一組 ('+mjMulti.size+')</button>';
  }
  if(mjGroups.length) h+='<button class="tdBtn" onclick="mjClearGroups()">清除分組</button>';
  if(mjCoachSh!==null&&mjCoach) h+='<span class="tdNote">'+(mjCoachSh<=0?"聽牌了！":("還差 "+mjCoachSh+" 步聽牌"))+'</span>';
  if(mjTidy) h+='<span class="tdNote">理牌模式：點牌只會選起來，不會打出去</span>';
  bar.innerHTML=h;
}
function mjPaint(){
  if(!S) return;
  if(!MJME||MJME.spectator){
    document.getElementById("mjMyName").textContent=myName;
    document.getElementById("mjMyWind").textContent="觀戰";
    document.getElementById("mjMyScore").textContent="";
    document.getElementById("mjLeft").textContent="剩 "+S.left+" 張";
    document.getElementById("mjTurnLn").textContent="";
    document.getElementById("mjBannerLn").textContent=(S.banner||"")+" · 看電視大螢幕";
    document.getElementById("mjClaimBar").classList.add("hidden");
    document.getElementById("mjActs").classList.add("hidden");
    document.getElementById("mjRack").innerHTML="";
    document.getElementById("mjGroupBox").innerHTML="";
    document.getElementById("mjTidyBar").innerHTML="";
    document.getElementById("mjWaits").textContent="";
    document.getElementById("mjMine").innerHTML="";
    return;
  }
  const seat=S.seats[MJME.seat]||{};
  document.getElementById("mjMyName").textContent=seat.name||myName;
  document.getElementById("mjMyWind").textContent=MJME.wind;
  const sc=MJME.score||0;
  const scEl=document.getElementById("mjMyScore");
  scEl.textContent=(sc>=0?"+":"")+sc+"點"; scEl.className="sc "+(sc>=0?"pos":"neg");
  document.getElementById("mjLeft").textContent="剩 "+S.left+" 張";
  document.getElementById("mjTurnLn").textContent=
    S.handOver? "本局結束 — 看電視" : (MJME.myTurn? "輪到你！" : (MJME.claim? "" : (S.turn>=0&&S.seats[S.turn]? "等 "+S.seats[S.turn].name+"…":"")));
  document.getElementById("mjBannerLn").textContent=S.banner||"";
  // claim bar
  const cb=document.getElementById("mjClaimBar");
  if(MJME.claim&&!S.handOver){
    const c=MJME.claim;
    let h='<div class="ttl">'+(c.kind==="rob"?"有人加槓 — 你可以搶槓胡！":"上家打出 ")+(c.kind==="rob"?"":mtile(c.tile,true))+' <span id="mjCd"></span></div><div class="actRow" style="margin:0">';
    if(c.win) h+='<button class="bHu" onclick="mjClaimW()">胡！</button>';
    if(c.pong) h+='<button class="bGo" onclick="mjClaimP()">碰</button>';
    if(c.gang) h+='<button class="bGo" onclick="mjClaimG()">槓</button>';
    (c.chi||[]).forEach(function(pr){
      h+='<button class="bGo" onclick="mjClaimC('+pr[0]+','+pr[1]+')">吃 '+mjNm(pr[0])+mjNm(pr[1])+'</button>';
    });
    h+='<button onclick="mjClaimPass()">過</button></div>';
    cb.innerHTML=h; cb.classList.remove("hidden");
    if(!wasClaim&&navigator.vibrate) navigator.vibrate([120,60,120]);
    wasClaim=true;
    if(!mjCdTimer) mjCdTimer=setInterval(mjCdTick,400);
    mjCdTick();
  } else { cb.classList.add("hidden"); wasClaim=false; }
  // self actions
  const ar=document.getElementById("mjActs");
  if(MJME.myTurn&&!S.handOver){
    let h="";
    if(MJME.canWin) h+='<button class="bHu" onclick="mjSelfWin()">自摸胡！</button>';
    (MJME.angang||[]).forEach(function(t){ h+='<button class="bGo" onclick="mjAG('+t+')">暗槓 '+mjNm(t)+'</button>'; });
    (MJME.jiagang||[]).forEach(function(t){ h+='<button class="bGo" onclick="mjJG('+t+')">加槓 '+mjNm(t)+'</button>'; });
    h+='<button class="bGo" '+(mjSel===null?'disabled':'')+' onclick="mjDoDiscard()">打出</button>';
    ar.innerHTML=h; ar.classList.remove("hidden");
  } else { ar.classList.add("hidden"); }
  if(MJME.myTurn&&!wasMyTurn&&navigator.vibrate) navigator.vibrate([120,60,120]);
  wasMyTurn=MJME.myTurn;
  // rack
  if(mjCoach) mjAskCoach(false);
  const lay=mjLayout((MJME.hand||[]).slice());
  rackTiles=lay.order.slice();
  function tileHTML(t,i){
    const cls=(mjSel===i?" sel":"")+(mjMulti.has(i)?" pick":"");
    return mtile(t,false,cls).replace('<div class="','<div onclick="mjTapTile('+i+')" class="');
  }
  let gh="";
  lay.strips.forEach(function(st){
    const lb=mjGroupLabel(st.tiles);
    gh+='<div class="mjGrp"><div class="mjGrpHd">'+(lb||"一組")+'<button onclick="mjDropGroup('+st.gi+')">×</button></div>'
      +'<div class="rack" style="padding:4px 2px">'
      +st.tiles.map(function(t,k){ return tileHTML(t,st.from+k); }).join("")+'</div></div>';
  });
  document.getElementById("mjGroupBox").innerHTML=gh;
  let rh="";
  for(let i=lay.looseFrom;i<lay.order.length;i++) rh+=tileHTML(lay.order[i],i);
  if(MJME.drawn!==null&&MJME.drawn!==undefined){
    const di=rackTiles.length;
    rackTiles.push(MJME.drawn);
    rh+='<span class="gap"></span>'+tileHTML(MJME.drawn,di);
  }
  document.getElementById("mjRack").innerHTML=rh;
  mjRenderTidyBar();
  document.getElementById("mjRackLbl").textContent= mjTidy? "手牌 — 理牌模式（點選要放同一組的牌）"
    : (MJME.myTurn?(MJME.mustDiscard?"手牌 — 吃/碰後請出一張（點兩下打出）":"手牌 — 點兩下打出"):"手牌");
  // waits
  const w=MJME.waits||[];
  document.getElementById("mjWaits").textContent=(w.length&&w.length<=9)?("聽："+w.map(mjNm).join("、")):"";
  // melds + flowers
  let mm="";
  (MJME.melds||[]).forEach(function(m){
    mm+='<span style="display:inline-flex;gap:2px">'+(m.tiles||[]).map(function(t,i){
      return mtile(m.t==="angang"&&(i===0||i===3)?null:t,true);
    }).join("")+'</span>';
  });
  if((MJME.flowers||[]).length) mm+='<span>花：</span>'+MJME.flowers.map(function(t){return mtile(t,true);}).join("");
  document.getElementById("mjMine").innerHTML=mm;
}
if(token){ // try resume
  document.getElementById("clearSeatBtn").classList.remove("hidden");
  fetch("/api/join",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({token})}).then(r=>r.json()).then(r=>{
      if(r.token){token=r.token;connect();}
      else document.getElementById("joinErr").textContent="Saved seat not found — join fresh below, or clear the saved seat.";
    }).catch(()=>{});
}
</script></body></html>`;

/* ================= START ================= */
let activePort=PORT;
server.on("error",err=>{
  if(err.code==="EADDRINUSE"&&activePort<PORT+10){
    console.log("  Port "+activePort+" is busy (an old server may still be running) — trying "+(activePort+1)+"…");
    activePort++;
    setTimeout(()=>server.listen(activePort,"0.0.0.0"),300);
  } else {
    console.log("\n  Could not start: "+err.message);
    console.log("  Tip: close old server windows, or run:  taskkill /F /IM node.exe\n");
    process.exit(1);
  }
});
// ============================================================
// 大老二 Big Two — 掛在同一個 http server 上
// express 只負責 /dalaoer，socket.io 只攔 /socket.io/，
// 入口原本的 SSE（/events）完全不受影響。
// ============================================================
const express = require("express");
const { Server: IOServer } = require("socket.io");
const { attach } = require("./dalaoer/src/server");
const big2 = express();
const io = new IOServer(server);
attach(big2, io, { mount: "/dalaoer" });

if(!process.env.MJ_TEST) server.listen(activePort,"0.0.0.0");
server.on("listening",()=>{
  const list=allIPs(); const ip=list.length?list[0].ip:"localhost";
  console.log("\n  LU FAMILY GAME PORTAL — Poker + Taiwan Mahjong + Bridge");
  console.log("  ─────────────────────────────────────");
  console.log("  TV / host screen :  http://"+ip+":"+activePort+"/");
  console.log("  Phones join at   :  http://"+ip+":"+activePort+"/join   (QR shown on TV)");
  console.log("  ─────────────────────────────────────");
  if(activePort!==PORT) console.log("  NOTE: port "+PORT+" was busy — using "+activePort+". An old server may still be running; close it or run: taskkill /F /IM node.exe");
  if(list.length>1){
    console.log("  Other addresses on this machine (use one of these if phones can't connect):");
    list.slice(1).forEach(x=>{
      const vpn=/vpn|nord|tap|tun|virtual|vmware|vbox|hyper|wsl|zerotier|tailscale|docker/i.test(x.name)
        ||x.ip.startsWith("10.5.0.")||x.ip.startsWith("100.")||x.ip.startsWith("25.");
      console.log("    http://"+x.ip+":"+activePort+"/   ["+x.name+"]"+(vpn?"  ← VPN/virtual — phones can NOT reach this":""));
    });
    console.log("  ─────────────────────────────────────");
  }
  console.log("  Checklist if a phone shows a blank page:");
  console.log("   1. Phone + PC on the SAME Wi-Fi (no VPN on either)");
  console.log("   2. Windows Firewall: allow Node.js on Private networks");
  console.log("   3. Open the 192.168.x.x address on the TV — the QR follows it");
  console.log("  Ctrl+C to stop.\n");
});

/* ================= MJ SELF-TEST (MJ_TEST=<hands> node lu_family_portal.js) ================= */
if(process.env.MJ_TEST){
  G.game="mahjong";
  for(let k=0;k<4;k++) G.players.push({id:"t"+k,token:null,isAI:true,name:"測試"+(k+1),chips:0,start:0,
    handsWon:0,hole:[],folded:false,allIn:false,bet:0,total:0,need:false,inHand:false,won:false,
    showName:"",connected:true,avatar:null,wagered:0,mjScore:0});
  M.seats=[0,1,2,3].map(pi=>({pi,hand:[],melds:[],flowers:[],discards:[],drawn:null,auto:false}));
  M.base=30; M.taiVal=10; M.starter=-1; M.handCount=0;
  const target=parseInt(process.env.MJ_TEST)||50;
  let done=0,wins=0,draws=0,zimo=0,taiSum=0,maxTai=0,gangs=0;
  MJ_TEST_HOOK=()=>{
    done++;
    if(M.winInfo){
      wins++; taiSum+=M.winInfo.tai; if(M.winInfo.tai>maxTai)maxTai=M.winInfo.tai;
      if(M.winInfo.selfDrawn) zimo++;
      const sum=G.players.reduce((s,p)=>s+(p.mjScore||0),0);
      if(sum!==0){ console.error("FAIL: score sum "+sum+" (hand "+done+")"); process.exit(1); }
      if(!M.winInfo.baxian){
        const st=M.seats[M.winInfo.seat];
        const n=M.winInfo.tiles.length+3*st.melds.length;
        if(n!==17){ console.error("FAIL: winner tile count "+n+" (hand "+done+")"); console.error(JSON.stringify(M.winInfo.tiles),JSON.stringify(st.melds)); process.exit(1); }
      }
      if(M.winInfo.tai>0&&M.winInfo.taiList.reduce((a,x)=>a+x[1],0)!==M.winInfo.tai){
        console.error("FAIL: tai list mismatch"); process.exit(1); }
    } else draws++;
    M.seats.forEach((st,s)=>{ if(!M.winInfo||M.winInfo.seat!==s){
      const exp=16-3*st.melds.length;
      const got=st.hand.length+(st.drawn!==null?1:0);
      if(got!==exp&&got!==exp+1){ console.error("FAIL: seat "+s+" hand "+got+" expected "+exp+" (hand "+done+")"); process.exit(1); }
    }});
    gangs+=M.seats.reduce((a,st)=>a+st.melds.filter(m=>m.t!=="chi"&&m.t!=="pong").length,0);
    if(done<target) setImmediate(mjNewHand);
    else{
      console.log("SIM OK — "+done+" hands | wins "+wins+" ("+zimo+" zimo) | draws "+draws
        +" | avg tai "+(wins?(taiSum/wins).toFixed(2):"0")+" | max tai "+maxTai+" | gangs "+gangs);
      console.log("Final scores: "+M.seats.map((st,s)=>seatName(s)+" "+(seatP(s).mjScore>=0?"+":"")+seatP(s).mjScore).join(" | "));
      process.exit(0);
    }
  };
  mjNewHand();
}
