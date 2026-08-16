'use strict';
/**
 * 端對端測試：伺服器與客戶端跑在同一個 node 行程裡。
 * （背景執行伺服器會把工具卡住，所以一律 in-process — 規範 §13.2）
 *
 *   node test/e2e_inproc.js
 */

// 測試時把電腦的思考延遲調快。這裡自己設，才不用在指令列前面加環境變數
// （Windows 的 cmd 不吃 VAR=x cmd 那種寫法）。
if (process.env.DALAOER_BOT_DELAY === undefined) process.env.DALAOER_BOT_DELAY = '0.05';

const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const ioc = require('socket.io-client');
const { attach, rooms } = require('../src/server');
const E = require('../src/engine');

const PORT = 4321;
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
}

function connect() {
  return new Promise((res, rej) => {
    const c = ioc(`http://localhost:${PORT}`, { transports: ['websocket'], forceNew: true });
    c.__states = [];
    c.on('state', (s) => { c.__states.push(s); c.__last = s; });
    c.on('seating', (s) => { c.__seating = s; });
    c.on('lobby', (s) => { c.__lobby = s; });
    c.on('toast', (m) => { (c.__toasts = c.__toasts || []).push(m); });
    c.on('connect', () => res(c));
    c.on('connect_error', rej);
  });
}

function emit(c, ev, payload) {
  return new Promise((res) => {
    if (payload === undefined) c.emit(ev, null, res);
    else c.emit(ev, payload, res);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 回到座位畫面。
 * 打完了就直接 nextGame；還在打就要走全體同意的 END 提案 —— 伺服器不准偷跑。
 */
async function backToSeating(c) {
  c.__seating = null;
  const r = await emit(c, 'nextGame');
  if (!r.ok) await emit(c, 'propose', { kind: 'END' });
  await until(() => c.__seating, '座位畫面');
}

async function until(fn, label, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(30);
  }
  throw new Error(`逾時：${label}`);
}

async function main() {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);
  attach(app, io, { mount: '/' });
  await new Promise((r) => server.listen(PORT, r));
  console.log(`\n伺服器啟動於 ${PORT}\n`);

  // =========================================================================
  console.log('一、座位確認擋在發牌前面（規範 §5.2）');
  // =========================================================================
  const a = await connect();
  const created = await emit(a, 'createRoom', { name: '甲' });
  ok('開房成功', created.ok, JSON.stringify(created));
  ok('拿到重連用的 token', typeof created.token === 'string' && created.token.length > 0);
  const code = created.code;

  await emit(a, 'setOptions', { luMode: false, strictMode: true });
  const started = await emit(a, 'startGame');
  ok('按下開始', started.ok);
  await until(() => a.__seating, '座位畫面');
  ok('先出現座位畫面', !!a.__seating);
  ok('這時候一張牌都還沒發', a.__states.length === 0);
  ok('空位由電腦補滿', a.__seating.seats.filter((s) => s && s.isBot).length === 3);

  const before = a.__seating.seats.map((s) => s.name).join();
  const moved = await emit(a, 'moveSeat', { seat: 0, direction: 'right' });
  ok('◀ ▶ 可以換位子', moved.ok);
  await until(() => a.__seating.seats.map((s) => s.name).join() !== before, '座位順序改變');
  ok('座位順序真的變了', a.__seating.seats.map((s) => s.name).join() !== before);

  const confirmed = await emit(a, 'confirmSeats');
  ok('確認座位', confirmed.ok);
  await until(() => a.__last, '發牌');
  ok('確認之後才發牌', !!a.__last);
  ok('每家十三張', a.__last.counts.every((n) => n === 13));
  ok('標準玩法直接進入出牌', a.__last.phase === 'PLAYING', a.__last.phase);

  // =========================================================================
  console.log('\n二、一整局跑到結算');
  // =========================================================================
  const room = rooms.get(code);
  const mySeat = a.__last.seat;
  let guard = 0;
  while (a.__last.phase !== 'FINISHED' && guard++ < 4000) {
    // §P 有人出完了 → 我這一家要按確認結束
    if (a.__last.phase === 'PROVISIONAL_FINISH') {
      const p = a.__last.provisional;
      if (p.winner !== mySeat && !p.confirmed.includes(mySeat)) {
        await emit(a, 'confirmFinish');
      }
      await sleep(50);
      continue;
    }
    if (a.__last.turn !== mySeat) { await sleep(40); continue; }
    const s = a.__last;
    const plays = E.legalPlays(s.hand, s.isNewRound ? null : room.game.current);
    // §C 第一手不再需要含梅花3
    const legal = plays;
    let r;
    if (legal.length) {
      legal.sort((x, y) => x.meld.size - y.meld.size || x.meld.tiebreak - y.meld.tiebreak);
      r = await emit(a, 'play', { cards: legal[0].cards });
    } else {
      r = await emit(a, 'pass');
    }
    if (r && !r.ok) console.log('    [debug] 動作被拒:', JSON.stringify(r), 'isNewRound=', s.isNewRound, 'isFirstPlay=', s.isFirstPlay, 'turn=', s.turn, 'seat=', mySeat);
    await sleep(50);
  }
  ok('一局打完了', a.__last.phase === 'FINISHED', `guard=${guard} phase=${a.__last.phase}`);
  const st = a.__last.settlement;
  ok('有結算資料', !!st);
  ok('金額加總為零', st && st.money.reduce((x, y) => x + y, 0) === 0, st && JSON.stringify(st.money));
  ok('贏家手上沒牌', st && st.points[st.winner] === 0);
  ok('本次牌局有累計帳', !!a.__last.ledger && a.__last.ledger.totals.length === 4);

  // =========================================================================
  console.log('\n三、下一局會再回到座位確認');
  // =========================================================================
  await backToSeating(a);
  await until(() => a.__seating, '再次出現座位畫面');
  ok('每一局開打前都要再確認座位', !!a.__seating);
  await emit(a, 'confirmSeats');
  await until(() => a.__last.phase !== 'FINISHED', '新的一局');
  ok('確認後開新局', a.__last.phase === 'PLAYING');

  // =========================================================================
  console.log('\n四、斷線 → 凍結；帶 token 回來 → 原位繼續（規範 §5.3）');
  // =========================================================================
  // 局中不能直接重開，要先讓大家同意收掉（伺服器會擋 nextGame）
  await backToSeating(a);

  const b = await connect();
  const joined = await emit(b, 'joinRoom', { code, name: '乙' });
  ok('乙加入（真人擠掉一個電腦）', joined.ok, JSON.stringify(joined));
  const tokenB = joined.token;
  const seatB = joined.seat;

  a.__seating = null;
  await emit(a, 'confirmSeats');
  await until(() => b.__last && b.__last.counts.every((n) => n === 13), '乙拿到牌');
  ok('乙也在牌局裡', !!b.__last);

  b.disconnect();
  await until(() => a.__last && a.__last.paused, '凍結');
  ok('牌局凍結了', !!a.__last.paused);
  ok('凍結時指名是誰掉線', a.__last.paused.name === '乙', JSON.stringify(a.__last.paused));

  const handBefore = JSON.stringify(a.__last.hand);
  const turnBefore = a.__last.turn;
  await sleep(900);
  ok('凍結期間電腦不會動', a.__last.turn === turnBefore);
  ok('凍結期間手牌不變', JSON.stringify(a.__last.hand) === handBefore);

  const b2 = await connect();
  const back = await emit(b2, 'joinRoom', { code, name: '乙', token: tokenB });
  ok('帶 token 回來', back.ok);
  ok('認得是同一個人', back.resumed === true, JSON.stringify(back));
  ok('回到原本的位子', back.seat === seatB, `${back.seat} vs ${seatB}`);
  await until(() => a.__last && !a.__last.paused, '解凍');
  ok('牌局繼續', !a.__last.paused);
  ok('回來以後手牌沒被動過', JSON.stringify(a.__last.hand) === handBefore);

  // =========================================================================
  console.log('\n五、換電腦要全體同意（CIO 定案，已無倒數）');
  // =========================================================================
  b2.disconnect();
  await until(() => a.__last && a.__last.paused, '再次凍結');
  const gone = a.__last.paused.seat;

  // 桌上只剩甲一個真人 → 沒有別人要表態，提案直接通過
  const hatch = await emit(a, 'propose', { kind: 'BOT', target: gone });
  ok('可以提議換電腦', hatch.ok, JSON.stringify(hatch));
  await until(() => a.__last && !a.__last.paused, '解凍');
  ok('通過之後就繼續', !a.__last.paused);
  ok('那個位子變成電腦', a.__last.seats[gone].isBot);
  ok('沒有任何倒數逼人做決定', a.__last.options.turnSeconds === undefined);

  // 一個人不同意就作廢。真人要在局間才進得來，所以先回座位畫面。
  await backToSeating(a);

  const e1 = await connect();
  const ej = await emit(e1, 'joinRoom', { code, name: '戊' });
  ok('局間可以加入第二個真人', ej.ok, JSON.stringify(ej));

  a.__seating = null;
  await emit(a, 'confirmSeats');
  await until(() => a.__last && a.__last.counts.every((n) => n === 13), '發牌');

  const prop = await emit(a, 'propose', { kind: 'END' });
  ok('提案送出，等其他真人表態', prop.ok && prop.pending === true, JSON.stringify(prop));
  await until(() => e1.__last && e1.__last.proposal, '提案傳到戊');
  ok('提案內容大家都看得到', e1.__last.proposal.kind === 'END');

  const no = await emit(e1, 'vote', { agree: false });
  ok('一個人不同意，提案就作廢', no.ok && no.passed === false, JSON.stringify(no));
  await sleep(200);
  ok('提案消失，牌局照常', !a.__last.proposal && a.__last.phase === 'PLAYING',
    JSON.stringify({ p: a.__last.proposal, ph: a.__last.phase }));
  e1.disconnect();

  // =========================================================================
  console.log('\n六、對賭視窗沒有倒數，誰都可以按開始（ruling 5、13）');
  // =========================================================================
  const c = await connect();
  const cr = await emit(c, 'createRoom', { name: '丙' });
  await emit(c, 'setOptions', { luMode: true, strictMode: true });
  await emit(c, 'startGame');
  await until(() => c.__seating, '座位畫面');
  await emit(c, 'confirmSeats');
  await until(() => c.__last, '發牌');
  ok('盧家玩法從換牌開始', c.__last.phase === 'SWAP_SELECT', c.__last.phase);

  await emit(c, 'discard', { cards: [] });
  await until(() => ['BET_DECLARE', 'BET_RESPOND', 'PLAYING'].includes(c.__last.phase),
    '換牌結束', 20000);

  // 電腦可能宣告對賭，而且三家裡的另外兩家都是電腦——牠們表態完
  // 就把對賭解決掉了，真人根本輪不到。那是合法分支，不是視窗自己過期。
  await sleep(2500);
  if (c.__last.phase === 'PLAYING') {
    ok('進入出牌一定是因為有人宣告過對賭，不是視窗自己過期',
      !!c.__last.bet && c.__last.bet.declarer !== null,
      JSON.stringify(c.__last.bet));
  } else {
    ok('視窗沒有自己過期', true);
  }

  if (c.__last.phase === 'BET_DECLARE') {
    const go = await emit(c, 'declareBet', { declare: false });
    ok('任何一家按開始就開打', go.ok, JSON.stringify(go));
    await until(() => c.__last.phase === 'PLAYING', '進入出牌');
    ok('進入出牌階段', c.__last.phase === 'PLAYING');
  } else if (c.__last.phase === 'BET_RESPOND') {
    const resp = await emit(c, 'respondBet', { accept: false });
    ok('一家不同意就取消', resp.ok, JSON.stringify(resp));
    await until(() => c.__last.phase === 'PLAYING', '取消後開打');
    ok('取消後直接開打', c.__last.phase === 'PLAYING');
    ok('沒有攤牌', !c.__last.revealedSeat);
  } else {
    // 電腦之間就把對賭處理完了
    ok('對賭已由電腦之間解決，流程繼續', c.__last.phase === 'PLAYING', c.__last.phase);
  }

  // =========================================================================
  console.log('\n七、抓牌走完一趟（規範 §8.2）');
  // =========================================================================
  const d1 = await connect();
  const dr = await emit(d1, 'createRoom', { name: '丁' });
  const code3 = dr.code;
  await emit(d1, 'setOptions', { luMode: false, strictMode: false });
  await emit(d1, 'startGame');
  await until(() => d1.__seating, '座位畫面');
  await emit(d1, 'confirmSeats');
  await until(() => d1.__last && d1.__last.counts.every((n) => n === 13), '發牌');

  const room3 = rooms.get(code3);
  const seatD = d1.__last.seat;
  await until(() => d1.__last.turn === seatD || d1.__last.phase === 'FINISHED', '輪到丁', 20000);

  if (d1.__last.turn === seatD) {
    // §C 第一手不含梅花3 已經合法了，所以改用「兩張不同點數」硬出：
    // 根本不成牌型，寬鬆模式應該放行，然後被抓
    const hand = d1.__last.hand;
    const first = hand[0];
    const second = hand.find((c) => Math.floor(c / 4) !== Math.floor(first / 4));
    const bad = [first, second];
    const g3 = room3.game;
    const r = await emit(d1, 'play', { cards: bad });
    // 電腦是用 setTimeout 排程的，所以這裡要在牠們動之前把時限抓下來
    const win = g3.challenge && { ...g3.challenge };
    ok('寬鬆模式放行了不成牌型的一手', r.ok, JSON.stringify(r));
    ok('抓牌時限開著', !!win);
    ok('時限指向出牌的人', win && win.seat === seatD, `${win && win.seat} vs ${seatD}`);
    ok('伺服器心裡知道這手不合法', win && win.legal === false);

    const chaser = (seatD + 1) % 4;
    const handLenBefore = g3.hands[seatD].length;
    const cr3 = g3.challengePlay(chaser);
    ok('伺服器直接判定，不用投票', cr3.ok, JSON.stringify(cr3));
    ok('不成牌型 → 抓成立', cr3.upheld === true, JSON.stringify(cr3));
    ok('牌退回去了', g3.hands[seatD].length === handLenBefore + bad.length);
    ok('輪回原出牌者重出', g3.turn === seatD);

    // 對外的狀態不能洩漏判定結果
    await sleep(60);
    const w2 = d1.__last.challengeWindow;
    ok('對外的時限不洩漏判定結果', !w2 || w2.legal === undefined);
  } else {
    ok('（本局丁沒拿到開牌權，抓牌已由單元測試覆蓋）', true);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  [a, b, b2, c, d1].forEach((s) => { try { s.disconnect(); } catch (e) { /* ignore */ } });
  io.close();
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('\n測試爆了：', e.message);
  console.error(e.stack);
  process.exit(1);
});
