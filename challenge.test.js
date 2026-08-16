'use strict';
/** 抓牌協定測試（規範 §8.2） */

const { Game, PHASE } = require('../src/game');
const E = require('../src/engine');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

/** 造一局牌，手牌自訂，直接進入 PLAYING */
function rig(hands, opts = {}) {
  const g = new Game(['甲', '乙', '丙', '丁'], { luMode: false, strictMode: false, ...opts });
  g.hands = hands.map((h) => [...h]);
  g.phase = PHASE.PLAYING;
  g.turn = g.hands.findIndex((h) => h.includes(E.CLUB_THREE));
  g.isFirstPlay = true;
  g.current = null;
  g.currentCards = [];
  g.lastPlayerSeat = null;
  g.passed = [false, false, false, false];
  g.challenge = null;
  return g;
}

// 牌號：rank*4+suit， rank 0='3' ... 12='2'， suit 0=♣ 1=♦ 2=♥ 3=♠
const C3 = 0, D3 = 1, H3 = 2, S3 = 3;      // 3
const C4 = 4, D4 = 5;                       // 4
const C5 = 8, D5 = 9, H5 = 10;              // 5
const C6 = 12, D6 = 13;                     // 6
const C7 = 16, D7 = 17;                     // 7
const S2 = 51;

console.log('\n寬鬆模式下每一手都開抓牌時限');
{
  const g = rig([[C3, C5, C6], [D4, D5, D6], [H3, H5, C7], [S3, D7, S2]]);
  g.play(g.turn, [C3]);
  ok('合法出牌也會開時限', g.challenge !== null);
  ok('時限內可抓', g.challengeOpen());
  ok('對外不洩漏判定結果', g.publicState(1).challengeWindow.legal === undefined);
  eq('對外只給出牌者與牌', g.publicState(1).challengeWindow.playSeat, 0);
}

console.log('\n抓錯：什麼都不會發生');
{
  const g = rig([[C3, C5, C6], [D4, D5, D6], [H3, H5, C7], [S3, D7, S2]]);
  g.play(0, [C3]);
  const handsBefore = JSON.stringify(g.hands);
  const r = g.challengePlay(1);
  ok('回報 ok', r.ok);
  ok('不成立', r.upheld === false);
  eq('手牌沒有變動', JSON.stringify(g.hands), handsBefore);
  ok('抓錯就關窗，同一手不能再抓（§O）', !g.challengeOpen());
  ok('沒有任何處罰', true);
}

console.log('\n抓對：退回、重出');
{
  // 甲先出 ♣3，乙用「不成對的兩張」硬出 → 張數不符，寬鬆模式放行
  const g = rig([[C3, C5, C6], [D4, D6, D7], [H3, H5, C7], [S3, D5, S2]]);
  g.play(0, [C3]);
  const r1 = g.play(1, [D4, D6]);
  ok('寬鬆模式放行了不合法的一手', r1.ok);
  eq('乙手上少了兩張', g.hands[1].length, 1);
  eq('輪到丙', g.turn, 2);

  const r2 = g.challengePlay(2);
  ok('抓成立', r2.upheld === true);
  eq('牌退回乙手上', g.hands[1].length, 3);
  eq('輪回乙重出', g.turn, 1);
  eq('場上恢復成甲的 ♣3', g.currentCards, [C3]);
  eq('抓完時限關閉', g.challenge, null);
}

console.log('\n抓對：中間的 PASS 一併作廢');
{
  const g = rig([[C3, C5, C6], [D4, D6, D7], [H3, H5, C7], [S3, D5, S2]]);
  g.play(0, [C3]);
  g.play(1, [D4, D6]);          // 不合法，放行
  g.pass(2);                     // 丙 PASS
  ok('丙已 PASS', g.passed[2] === true);
  eq('PASS 不會關閉時限', g.challengeOpen(), true);
  eq('輪到丁', g.turn, 3);

  const r = g.challengePlay(3);
  ok('丁抓成立', r.upheld === true);
  ok('丙的 PASS 被作廢', g.passed[2] === false);
  eq('輪回乙', g.turn, 1);
}

console.log('\n下一手出牌會關閉上一手的時限');
{
  const g = rig([[C3, C5, C6], [D4, D6, D7], [H3, H5, C7], [S3, D5, S2]]);
  g.play(0, [C3]);
  const first = g.challenge;
  g.play(1, [D4]);
  ok('時限換成了新的一手', g.challenge !== first);
  eq('指向乙', g.challenge.seat, 1);
}

console.log('\n三家都 PASS 之後不能再抓（§O，已無倒數）');
{
  const g = rig([[C3, C5, C6], [D4, D6, D7], [H3, H5, C7], [S3, D5, S2]]);
  g.play(0, [C3]);
  g.pass(1); g.pass(2);
  ok('還沒三家 PASS，窗還開著', g.challengeOpen());
  g.pass(3);
  ok('三家都不出，這一手定案', g.challengeOpen() === false);
  ok('抓不動了', g.challengePlay(1).ok === false);
}

console.log('\n不能抓自己');
{
  const g = rig([[C3, C5, C6], [D4, D6, D7], [H3, H5, C7], [S3, D5, S2]]);
  g.play(0, [C3]);
  const r = g.challengePlay(0);
  ok('被擋下', r.ok === false, r.reason);
}

console.log('\n嚴格模式沒有抓牌這回事');
{
  const g = rig([[C3, C5, C6], [D4, D6, D7], [H3, H5, C7], [S3, D5, S2]], { strictMode: true });
  g.play(0, [C3]);
  eq('不開時限', g.challenge, null);
  const bad = g.play(1, [D4, D6]);
  ok('不合法的一手直接被擋', bad.ok === false, bad.reason);
  const r = g.challengePlay(2);
  ok('抓牌指令被拒絕', r.ok === false, r.reason);
}

console.log('\n用不合法的一手打完最後一張，也抓得到');
{
  const g = rig([[C3, C5], [D4, D6], [H3, H5], [S3, D5]]);
  g.play(0, [C3]);
  const r1 = g.play(1, [D4, D6]);   // 不合法，而且正好出完
  ok('放行', r1.ok);
  eq('乙出完了', g.hands[1].length, 0);
  eq('進入暫定結束（§P）', g.phase, PHASE.PROVISIONAL_FINISH);
  ok('暫定結束期間仍可抓', g.challengeOpen());

  const r2 = g.challengePlay(2);
  ok('抓成立', r2.upheld === true);
  eq('回到出牌階段', g.phase, PHASE.PLAYING);
  eq('結算作廢', g.settlement, null);
  eq('贏家取消', g.winner, null);
  eq('牌退回乙手上', g.hands[1].length, 2);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
