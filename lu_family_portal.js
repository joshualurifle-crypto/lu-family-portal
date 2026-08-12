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
  if(G.players[n].isAI) later(900,()=>aiAct(n));
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
  setTimeout(()=>{ if(M.claimSeq===cs&&M.seq===sq&&M.pending){
    M.pending.claims.forEach(c=>{ if(!c.resp) c.resp={t:"pass"}; });
    resolveClaims();
  }},M.claimUntil-Date.now());
  broadcast();
  return true;
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
  setTimeout(()=>{ if(M.claimSeq===cs&&M.seq===sq&&M.pending){
    M.pending.claims.forEach(c=>{ if(!c.resp) c.resp={t:"pass"}; });
    resolveClaims();
  }},M.claimUntil-Date.now());
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

/* ---------- mahjong state for clients ---------- */
function mjPublicState(){
  return {
    phase:M.phase, banner:M.banner, log:M.log, handOver:M.handOver, drawGame:M.drawGame,
    base:M.base, taiVal:M.taiVal, left:liveLeft(), turn:M.turn, starter:M.starter,
    pace:G.pace, handCount:M.handCount, claimUntil:M.pending?M.claimUntil:0,
    pendingTile:M.pending?{tile:M.pending.tile,from:M.pending.from,kind:M.pending.kind}:null,
    winInfo:M.winInfo,
    roster:G.players.filter(p=>!p.isAI&&!p.removed).map(p=>({name:p.name,avatar:p.avatar||null,connected:!!p.connected})),
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

/* ================= STATE BROADCAST (SSE) ================= */
let clients=[]; // {res, token|null(host)}
const KA_MS=20000;      // SSE heartbeat
const GRACE_MS=90000;   // stay "online" this long after a phone drops (app switch / screen lock)
function publicState(){
  return {
    phase:G.phase, stage:G.stage, board:G.board, pot:potTotal(),
    dealer:G.dealer, sb:G.sb, bb:G.bb, turn:G.turn,
    banner:G.banner, log:G.log, handOver:G.handOver, revealAll:G.revealAll, stack:G.stack,
    mode:G.mode, sbA:G.sbA, bbA:G.bbA, pace:G.pace, aiLevel:G.aiLevel,
    players:G.players.map((p,i)=>({
      id:p.id, name:p.name, isAI:p.isAI, chips:p.chips, bet:p.bet,
      folded:p.folded, allIn:p.allIn, inHand:p.inHand, won:p.won,
      handsWon:p.handsWon, net:p.chips-p.start, connected:p.isAI?true:p.connected, removed:!!p.removed,
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
  else payload={ game:G.game, pub:publicState(), me: c.token? privateFor(c.token):null };
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

  if(path==="/"){ res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"}); return res.end(HOST_HTML); }
  if(path==="/join"){ res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"}); return res.end(PLAYER_HTML); }

  if(path==="/events"){
    res.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-cache",
      "Connection":"keep-alive","X-Accel-Buffering":"no"});
    const token=url.searchParams.get("token")||null;
    const c={res,token};
    clients.push(c);
    const p=G.players.find(x=>x.token===token);
    if(p){ if(p.offTimer){ clearTimeout(p.offTimer); p.offTimer=null; } p.connected=true; }
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
    if(G.game==="mahjong"&&M.phase==="play"){
      const s=M.seats.findIndex(st=>st.pi===i);
      if(s>=0&&!M.handOver&&!seatP(s).isAI&&!M.seats[s].auto){
        M.seats[s].auto=true; mjBanner(seatName(s)+" 改由電腦代打。"); broadcast(); mjResumeAuto(s);
      }
      return json(res,{ok:1});
    }
    removeSeat(i,"was removed from the table");
    return json(res,{ok:1});
  }

  if(req.method==="POST"&&path==="/api/leave"){
    const b=await body(req);
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

  /* ---------- portal ---------- */
  if(req.method==="POST"&&path==="/api/portal"){
    const b=await body(req);
    const busy=(G.game==="poker"&&G.phase==="play")||(G.game==="mahjong"&&M.phase==="play"&&!M.handOver);
    if(busy) return json(res,{error:"牌局進行中 — 先結束目前這局再換遊戲。"},400);
    G.game=(b.game==="poker"||b.game==="mahjong")?b.game:null;
    if(G.game!=="mahjong"&&M.phase==="play"){ M.phase="idle"; M.seq++; M.claimSeq++; }
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
  <h1 class="disp">盧家遊樂園 · Lu Family Game Portal</h1>
  <div class="sub" id="portalSub"></div>
  <div class="lobbyGrid">
    <div class="qrBox">
      <div style="font-size:.8rem;color:var(--mut)">Scan to join · 掃碼入座</div>
      <div id="qr2"></div>
      <div class="url" id="joinUrl2"></div>
    </div>
    <div>
      <h3 class="disp">已入座 Players</h3>
      <ul class="pl" id="portalList"></ul>
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
      </div>
    </div>
  </div>
`;
const PORTAL_JS=`
const joinUrl2=location.origin+"/join";
document.getElementById("joinUrl2").textContent=joinUrl2;
try{ new QRCode(document.getElementById("qr2"),{text:joinUrl2,width:190,height:190}); }
catch(e){ document.getElementById("qr2").innerHTML='<div style="font-size:.8rem;color:#a3542e">No internet for QR lib — type the URL below into each phone.</div>'; }
function pEsc(t){ return String(t).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function renderPortal(){
  const list=(S&&S.roster&&S.roster.length)? S.roster : ((S&&S.players)||[]).filter(function(p){return !p.isAI;});
  document.getElementById("portalList").innerHTML= list.length
    ? list.map(function(p){ return '<li>'+(p.avatar?'<span class="av" style="background-image:url('+p.avatar+')"></span>':'\u{1F4F1}')
        +' '+pEsc(p.name)+(p.connected===false?' <span class="badge off">offline</span>':'')+'</li>'; }).join("")
    : '<li style="color:var(--mut)">Waiting for phones\u2026</li>';
  const g=(typeof GAME==="undefined")?null:GAME;
  document.getElementById("gcPoker").classList.toggle("on",g==="poker");
  document.getElementById("gcMahjong").classList.toggle("on",g==="mahjong");
  document.getElementById("gcPokerLive").classList.toggle("hidden",g!=="poker");
  document.getElementById("gcMahjongLive").classList.toggle("hidden",g!=="mahjong");
  document.getElementById("portalSub").textContent =
    g==="poker" ? "德州撲克進行中 — 切到 3 · 牌桌繼續"
    : g==="mahjong" ? "台灣麻將進行中 — 切到 3 · 牌桌繼續"
    : "手機掃碼入座 — 全家同一個入口，在這裡選遊戲";
}
`;

/* ================= HOST (TV) PAGE ================= */
const HOST_HTML=`<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>盧家遊樂園 · Lu Family Portal</title>
<style>${CSS}${PORTAL_CSS}
.qrBox #qr,.qrBox #qr3{display:flex;justify-content:center;margin:8px 0;}
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
      <h3 class="disp">Players joined</h3>
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
const SUITS=["♠","♥","♦","♣"],RN={11:"J",12:"Q",13:"K",14:"A"};
const rN=r=>RN[r]||String(r);
const cardHTML=(c,cls="")=>{const red=(c.s===1||c.s===2);
 return '<div class="card '+cls+(red?' red':'')+'"><span>'+rN(c.r)+'</span><span class="s">'+SUITS[c.s]+'</span></div>';};
const joinUrl=location.origin+"/join";
document.getElementById("joinUrl").textContent=joinUrl;
try{ new QRCode(document.getElementById("qr"),{text:joinUrl,width:190,height:190}); }
catch(e){ document.getElementById("qr").innerHTML='<div style="font-size:.8rem;color:#a3542e">No internet for QR lib — type the URL below into each phone.</div>'; }
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
  es.onmessage=e=>{ const d=JSON.parse(e.data); GAME=d.game; S=d.pub; render(); };
}
openES();
setInterval(function(){ if(!es||es.readyState===2) openES(); },5000);
document.addEventListener("visibilitychange",function(){ if(!document.hidden&&(!es||es.readyState===2)) openES(); });
function setView(n){ VIEW=n; render(); }
function autoLayer(){
  if(GAME===null||GAME===undefined) return 1;
  if(GAME==="mahjong") return (S&&S.phase==="play")?3:2;
  return (S&&S.phase==="lobby")?2:3;
}
function render(){
  const noGame=(GAME===null||GAME===undefined), mjOn=(GAME==="mahjong");
  const auto=autoLayer();
  if(auto!==lastAuto){ lastAuto=auto; VIEW=0; }   // real state change wins over a manual peek
  let L=VIEW||auto;
  if(noGame) L=1;                                  // no game picked -> only layer 1 exists
  if(L===3&&!mjOn&&S&&S.phase==="lobby") L=2;      // no table dealt yet
  if(L===3&&mjOn&&S&&S.phase!=="play") L=2;
  const l3ok=(!noGame)&&(mjOn? S.phase==="play" : S.phase!=="lobby");
  ["L1","L2","L3"].forEach((id,k)=>{ const b=document.getElementById(id);
    b.classList.toggle("on",L===k+1); b.disabled=(k>0&&noGame)||(k===2&&!l3ok); });
  document.getElementById("peekLbl").classList.toggle("hidden",L===auto);
  document.getElementById("portal").classList.toggle("hidden",L!==1);
  document.getElementById("lobby").classList.toggle("hidden",!(L===2&&!mjOn&&!noGame));
  document.getElementById("game").classList.toggle("hidden",!(L===3&&!mjOn&&!noGame));
  document.getElementById("mjLobby").classList.toggle("hidden",!(L===2&&mjOn));
  document.getElementById("mjGame").classList.toggle("hidden",!(L===3&&mjOn));
  if(L===1){ renderPortal(); return; }
  if(mjOn){ renderMJ(); return; }
  if(L===2){
    const ul=document.getElementById("lobbyList");
    ul.innerHTML=S.players.length? S.players.map(p=>'<li>'+(p.avatar?'<span class="av" style="background-image:url('+p.avatar+')"></span>':'📱')+' '+esc(p.name)
      +(p.connected?'':' <span class="badge off">offline</span>')
      +' <button class="kick" onclick="if(confirm(\\'Remove this player?\\'))api(\\'/api/kick\\',{id:\\''+p.id+'\\'})">remove</button></li>').join("")
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
/* ---- portal + mahjong (host) ---- */
try{ new QRCode(document.getElementById("qr3"),{text:joinUrl,width:150,height:150}); }catch(e){}
${PORTAL_JS}
const MJN=["一","二","三","四","五","六","七","八","九"],MJH=["東","南","西","北","中","發","白"],MJF=["春","夏","秋","冬","梅","蘭","菊","竹"];
function _dots(n){var L={1:[[17,24,7]],2:[[17,14,5.2],[17,34,5.2]],3:[[9,12,5],[17,24,5],[25,36,5]],4:[[11,14,5],[23,14,5],[11,34,5],[23,34,5]],5:[[11,13,4.6],[23,13,4.6],[17,24,4.6],[11,35,4.6],[23,35,4.6]],6:[[11,12,4.3],[23,12,4.3],[11,24,4.3],[23,24,4.3],[11,36,4.3],[23,36,4.3]],7:[[9,11,3.9],[17,11,3.9],[25,11,3.9],[13,24,3.9],[21,24,3.9],[13,37,3.9],[21,37,3.9]],8:[[9,11,3.7],[17,11,3.7],[25,11,3.7],[9,24,3.7],[25,24,3.7],[9,37,3.7],[17,37,3.7],[25,37,3.7]],9:[[9,11,3.7],[17,11,3.7],[25,11,3.7],[9,24,3.7],[17,24,3.7],[25,24,3.7],[9,37,3.7],[17,37,3.7],[25,37,3.7]]};return L[n]||L[1];}
function tsvg(t){
  var s='<svg viewBox="0 0 34 48" width="100%" height="100%">';
  function tx(str,y,fill,size){return '<text x="17" y="'+y+'" text-anchor="middle" font-family="serif" font-weight="700" font-size="'+size+'" fill="'+fill+'">'+str+'</text>';}
  if(t<9){ s+=tx(MJN[t],20,"#a3282a",16)+tx("萬",43,"#a3282a",15); }
  else if(t<18){ var n=t-8; if(n===1){ s+='<circle cx="17" cy="24" r="10" fill="none" stroke="#1c6fb0" stroke-width="2.2"/><circle cx="17" cy="24" r="6" fill="none" stroke="#a3282a" stroke-width="2"/><circle cx="17" cy="24" r="2.6" fill="#2f7d3e"/>'; } else _dots(n).forEach(function(p){ s+='<circle cx="'+p[0]+'" cy="'+p[1]+'" r="'+p[2]+'" fill="#fff" stroke="#1c6fb0" stroke-width="1.5"/><circle cx="'+p[0]+'" cy="'+p[1]+'" r="'+(p[2]*0.42)+'" fill="#a3282a"/>'; }); }
  else if(t<27){ var m=t-17; if(m===1){ s+='<ellipse cx="17" cy="27" rx="6" ry="8" fill="#2f7d3e"/><circle cx="17" cy="17" r="4.4" fill="#2f7d3e"/><path d="M17 12 L22 9 L18.5 15 Z" fill="#a3282a"/><circle cx="18.6" cy="16" r="1" fill="#fff"/>'; } else _dots(m).forEach(function(p){ var h=p[2]*2.7; s+='<rect x="'+(p[0]-2)+'" y="'+(p[1]-h/2)+'" width="4" height="'+h+'" rx="2" fill="#2f7d3e"/><rect x="'+(p[0]-2)+'" y="'+(p[1]-1)+'" width="4" height="2" fill="#14501f"/>'; }); }
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
function backs(n){ let h=""; for(let k=0;k<n;k++) h+=mtile(null,true); return h; }
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
<style>${CSS}${PORTAL_CSS}
.wrap{max-width:440px;margin:0 auto;padding:16px 14px 30px;}
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
    <div class="lbl" id="mjRackLbl">手牌</div>
    <div class="rack" id="mjRack"></div>
    <div class="waitsLn" id="mjWaits"></div>
    <div class="mMini" id="mjMine"></div>
  </div>
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
let token=localStorage.getItem("pk_token")||null, myName=localStorage.getItem("pk_name")||"";
let S=null, ME=null, coachOn=true, es=null, wasMyTurn=false;
let GAME=null, MJME=null, mjSel=null, rackTiles=[], wasClaim=false;

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
  es.onmessage=e=>{const d=JSON.parse(e.data); GAME=d.game; S=d.pub; MEIN=d.me; pRender(); };
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
  document.getElementById("btnCoach").textContent=coachLabel();
  renderPortal(); paintSeat();
  if(GAME==="poker"){
    if(!MEIN){ document.getElementById("waitLine").textContent="You've been removed from the table.";
      document.getElementById("pubLine").textContent="Ask the host to end the session if you want to rejoin."; return; }
    ME=MEIN; if(L===3) paint();
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
/* ---- portal + mahjong (phone) ---- */
const MJN=["一","二","三","四","五","六","七","八","九"],MJH=["東","南","西","北","中","發","白"],MJF=["春","夏","秋","冬","梅","蘭","菊","竹"];
function mjNm(t){ if(t<9)return MJN[t]+"萬"; if(t<18)return MJN[t-9]+"筒"; if(t<27)return MJN[t-18]+"條"; if(t<34)return MJH[t-27]; return MJF[t-34]; }
function _dots(n){var L={1:[[17,24,7]],2:[[17,14,5.2],[17,34,5.2]],3:[[9,12,5],[17,24,5],[25,36,5]],4:[[11,14,5],[23,14,5],[11,34,5],[23,34,5]],5:[[11,13,4.6],[23,13,4.6],[17,24,4.6],[11,35,4.6],[23,35,4.6]],6:[[11,12,4.3],[23,12,4.3],[11,24,4.3],[23,24,4.3],[11,36,4.3],[23,36,4.3]],7:[[9,11,3.9],[17,11,3.9],[25,11,3.9],[13,24,3.9],[21,24,3.9],[13,37,3.9],[21,37,3.9]],8:[[9,11,3.7],[17,11,3.7],[25,11,3.7],[9,24,3.7],[25,24,3.7],[9,37,3.7],[17,37,3.7],[25,37,3.7]],9:[[9,11,3.7],[17,11,3.7],[25,11,3.7],[9,24,3.7],[17,24,3.7],[25,24,3.7],[9,37,3.7],[17,37,3.7],[25,37,3.7]]};return L[n]||L[1];}
function tsvg(t){
  var s='<svg viewBox="0 0 34 48" width="100%" height="100%">';
  function tx(str,y,fill,size){return '<text x="17" y="'+y+'" text-anchor="middle" font-family="serif" font-weight="700" font-size="'+size+'" fill="'+fill+'">'+str+'</text>';}
  if(t<9){ s+=tx(MJN[t],20,"#a3282a",16)+tx("萬",43,"#a3282a",15); }
  else if(t<18){ var n=t-8; if(n===1){ s+='<circle cx="17" cy="24" r="10" fill="none" stroke="#1c6fb0" stroke-width="2.2"/><circle cx="17" cy="24" r="6" fill="none" stroke="#a3282a" stroke-width="2"/><circle cx="17" cy="24" r="2.6" fill="#2f7d3e"/>'; } else _dots(n).forEach(function(p){ s+='<circle cx="'+p[0]+'" cy="'+p[1]+'" r="'+p[2]+'" fill="#fff" stroke="#1c6fb0" stroke-width="1.5"/><circle cx="'+p[0]+'" cy="'+p[1]+'" r="'+(p[2]*0.42)+'" fill="#a3282a"/>'; }); }
  else if(t<27){ var m=t-17; if(m===1){ s+='<ellipse cx="17" cy="27" rx="6" ry="8" fill="#2f7d3e"/><circle cx="17" cy="17" r="4.4" fill="#2f7d3e"/><path d="M17 12 L22 9 L18.5 15 Z" fill="#a3282a"/><circle cx="18.6" cy="16" r="1" fill="#fff"/>'; } else _dots(m).forEach(function(p){ var h=p[2]*2.7; s+='<rect x="'+(p[0]-2)+'" y="'+(p[1]-h/2)+'" width="4" height="'+h+'" rx="2" fill="#2f7d3e"/><rect x="'+(p[0]-2)+'" y="'+(p[1]-1)+'" width="4" height="2" fill="#14501f"/>'; }); }
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
  rackTiles=(MJME.hand||[]).slice();
  let rh="";
  rackTiles.forEach(function(t,i){
    rh+=mtile(t,false,(mjSel===i?" sel":"")).replace('<div class="','<div onclick="mjPick('+i+')" class="');
  });
  if(MJME.drawn!==null&&MJME.drawn!==undefined){
    const di=rackTiles.length;
    rackTiles.push(MJME.drawn);
    rh+='<span class="gap"></span>'+mtile(MJME.drawn,false,(mjSel===di?" sel":"")).replace('<div class="','<div onclick="mjPick('+di+')" class="');
  }
  document.getElementById("mjRack").innerHTML=rh;
  document.getElementById("mjRackLbl").textContent=MJME.myTurn?(MJME.mustDiscard?"手牌 — 吃/碰後請出一張（點兩下打出）":"手牌 — 點兩下打出"):"手牌";
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
if(!process.env.MJ_TEST) server.listen(activePort,"0.0.0.0");
server.on("listening",()=>{
  const list=allIPs(); const ip=list.length?list[0].ip:"localhost";
  console.log("\n  LU FAMILY GAME PORTAL — Poker + Taiwan Mahjong");
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
