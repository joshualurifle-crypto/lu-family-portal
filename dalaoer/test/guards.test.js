'use strict';
/**
 * 伺服器層的防護測試（IND DIR 提出的兩個缺陷）
 *
 *   node test/guards.test.js
 *
 * 1. 凍結期間伺服器必須擋掉所有遊戲動作
 * 2. 沒打完的一局，不能被 startGame / nextGame 直接抹掉
 * 3. 座位確認階段有人斷線，要有明確定義的走法，而且不能讓發牌爆掉
 */

// 測試時把電腦的思考延遲調快。這裡自己設，才不用在指令列前面加環境變數
// （Windows 的 cmd 不吃 VAR=x cmd 那種寫法）。
if (process.env.DALAOER_BOT_DELAY === undefined) process.env.DALAOER_BOT_DELAY = '0.05';

const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const ioc = require('socket.io-client');
const { attach, rooms } = require('../src/server');

const PORT = 4323;
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect() {
  return new Promise((res, rej) => {
    const c = ioc(`http://localhost:${PORT}`, { transports: ['websocket'], forceNew: true });
    c.on('state', (s) => { c.__last = s; });
    c.on('seating', (s) => { c.__seating = s; });
    c.on('connect', () => res(c));
    c.on('connect_error', rej);
  });
}

const emit = (c, ev, payload) => new Promise((res) => {
  if (payload === undefined) c.emit(ev, null, res); else c.emit(ev, payload, res);
});

async function until(fn, label, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(30); }
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
  console.log('一、凍結期間，伺服器要擋掉所有遊戲動作');
  // =========================================================================
  const a = await connect();
  const made = await emit(a, 'createRoom', { name: '甲' });
  const code = made.code;
  await emit(a, 'setOptions', { luMode: false, strictMode: true });

  await emit(a, 'startGame');
  await until(() => a.__seating, '座位畫面');

  const b = await connect();
  const bj = await emit(b, 'joinRoom', { code, name: '乙' });
  ok('乙入座', bj.ok, JSON.stringify(bj));

  a.__seating = null;
  await emit(a, 'confirmSeats');
  await until(() => a.__last && a.__last.counts.every((n) => n === 13), '發牌');

  const room = rooms.get(code);
  b.disconnect();
  await until(() => a.__last && a.__last.paused, '凍結');
  ok('牌局凍結了', !!a.__last.paused);

  // 凍結時，就算輪到甲，也不該打得動
  const handBefore = JSON.stringify(room.game.hands);
  const turnBefore = room.game.turn;
  const phaseBefore = room.game.phase;

  const tryPlay = await emit(a, 'play', { cards: [a.__last.hand[0]] });
  ok('凍結時 play 被擋下', tryPlay && tryPlay.ok === false, JSON.stringify(tryPlay));

  const tryPass = await emit(a, 'pass');
  ok('凍結時 pass 被擋下', tryPass && tryPass.ok === false, JSON.stringify(tryPass));

  const tryChallenge = await emit(a, 'challenge');
  ok('凍結時 challenge 被擋下', tryChallenge && tryChallenge.ok === false,
    JSON.stringify(tryChallenge));

  ok('凍結期間手牌完全沒動', JSON.stringify(room.game.hands) === handBefore);
  ok('凍結期間輪次沒動', room.game.turn === turnBefore);
  ok('凍結期間階段沒動', room.game.phase === phaseBefore);

  // 但提案與投票必須還能用，否則整桌永遠卡死
  const prop = await emit(a, 'propose', { kind: 'BOT', target: a.__last.paused.seat });
  ok('凍結時仍然可以提案', prop && prop.ok === true, JSON.stringify(prop));
  await until(() => a.__last && !a.__last.paused, '解凍');
  ok('提案通過後解凍', !a.__last.paused);

  // =========================================================================
  console.log('\n二、沒打完的一局，不能被直接抹掉');
  // =========================================================================
  ok('現在確實有一局在進行', room.game && room.game.phase !== 'FINISHED');

  const gameRef = room.game;
  const resetTry = await emit(a, 'startGame');
  ok('打到一半 startGame 被擋下', resetTry && resetTry.ok === false, JSON.stringify(resetTry));

  const nextTry = await emit(a, 'nextGame');
  ok('打到一半 nextGame 被擋下', nextTry && nextTry.ok === false, JSON.stringify(nextTry));

  ok('牌局物件沒有被換掉', room.game === gameRef);
  ok('手牌還在', room.game.hands.some((h) => h.length > 0));

  // 要收掉這一局，只能走全體同意
  const endProp = await emit(a, 'propose', { kind: 'END' });
  ok('可以提議結束這一局', endProp && endProp.ok === true, JSON.stringify(endProp));
  await sleep(200);
  ok('全體同意後牌局才被收掉', room.game === null,
    room.game ? room.game.phase : 'null');
  ok('收掉的一局不留任何金額',
    Object.values(room.ledger).every((v) => v === 0) || !Object.keys(room.ledger).length,
    JSON.stringify(room.ledger));

  // =========================================================================
  console.log('\n三、座位確認階段有人斷線');
  // =========================================================================
  const c = await connect();
  const cm = await emit(c, 'createRoom', { name: '丙' });
  const code3 = cm.code;
  await emit(c, 'setOptions', { luMode: false, strictMode: true });
  await emit(c, 'startGame');
  await until(() => c.__seating, '座位畫面');

  const d = await connect();
  const dj = await emit(d, 'joinRoom', { code3: undefined, code: code3, name: '丁' });
  ok('丁在座位階段入座', dj.ok, JSON.stringify(dj));
  const room3 = rooms.get(code3);
  const seatD = dj.seat;

  d.disconnect();
  await sleep(300);
  ok('座位沒有被刪成空的', room3.seats[seatD] !== null,
    JSON.stringify(room3.seats.map((s) => (s ? s.name : null))));
  ok('那個位子交給電腦', room3.seats[seatD] && room3.seats[seatD].isBot === true);
  ok('四個位子都還在', room3.seats.every((s) => s !== null));
  ok('本人的 token 留著，還能要回去', !!room3.seats[seatD].token);

  c.__last = null;
  const confirmed = await emit(c, 'confirmSeats');
  ok('確認座位不會爆掉', confirmed && confirmed.ok === true, JSON.stringify(confirmed));
  await until(() => c.__last, '發牌');
  ok('照樣發出四家十三張', c.__last.counts.every((n) => n === 13),
    JSON.stringify(c.__last.counts));

  // =========================================================================
  console.log('\n四、排座位時，每個人都要知道自己現在坐哪');
  // =========================================================================
  const e = await connect();
  const em = await emit(e, 'createRoom', { name: 'LU' });
  const code4 = em.code;
  await emit(e, 'startGame');
  await until(() => e.__seating, '座位畫面');

  ok('座位畫面有帶自己的座位號', e.__seating.seat !== undefined,
    JSON.stringify(Object.keys(e.__seating)));
  const myName = e.__seating.seats[e.__seating.seat].name;
  ok('自己的座位號指向自己', myName === 'LU', `seat=${e.__seating.seat} name=${myName}`);

  // 把別人挪來挪去，自己的座位號要跟著更新
  for (const target of [0, 1, 2, 3]) {
    await emit(e, 'moveSeat', { seat: target, direction: 'right' });
    await sleep(120);
    const s4 = e.__seating;
    const who = s4.seats[s4.seat] ? s4.seats[s4.seat].name : null;
    if (who !== 'LU') {
      ok(`挪動座位 ${target} 之後仍然指向自己`, false,
        `seat=${s4.seat} 指向 ${who}，座位表 ${JSON.stringify(s4.seats.map((x) => x && x.name))}`);
      break;
    }
  }
  const fin = e.__seating;
  ok('連挪四次之後「你」還是貼在 LU 身上',
    fin.seats[fin.seat] && fin.seats[fin.seat].name === 'LU',
    `seat=${fin.seat} 座位表 ${JSON.stringify(fin.seats.map((x) => x && x.name))}`);
  e.disconnect();

  console.log(`\n${pass} passed, ${fail} failed\n`);
  [a, b, c, d].forEach((s) => { try { s.disconnect(); } catch (e) { /* ignore */ } });
  io.close();
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('\n測試爆了：', e.message);
  console.error(e.stack);
  process.exit(1);
});
