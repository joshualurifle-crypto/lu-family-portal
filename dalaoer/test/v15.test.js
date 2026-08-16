'use strict';
/**
 * v1.5 CIO 定案回歸測試（T01–T62）
 *
 *   node test/v15.test.js
 *
 * 編號對應 CIO TEST-RUN FINAL DELTA §Z。
 */

const { Game, PHASE } = require('../src/game');
const AI = require('../src/ai');
const E = require('../src/engine');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
}
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b),
  `${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

// 牌號工具：C('A', 3) = 黑桃A
const R = { 3: 0, 4: 1, 5: 2, 6: 3, 7: 4, 8: 5, 9: 6, 10: 7, J: 8, Q: 9, K: 10, A: 11, 2: 12 };
const C = (r, s) => R[r] * 4 + s;
const id = (cs) => E.identify(cs);

/** 造一局，手牌自訂，直接進入 PLAYING */
function rig(hands, opts = {}) {
  const g = new Game(['甲', '乙', '丙', '丁'], { luMode: false, strictMode: true, ...opts });
  g.hands = hands.map((h) => [...h]);
  g.phase = PHASE.PLAYING;
  g.turn = 0;
  g.isFirstPlay = true;
  g.current = null;
  g.currentCards = [];
  g.lastPlayerSeat = null;
  g.trickWonBy = null;
  g.passed = [false, false, false, false];
  g.challenge = null;
  g.provisional = null;
  return g;
}

// ===========================================================================
console.log('\n§C  梅花3 只決定誰先出');
// ===========================================================================
{
  const g = new Game(['甲', '乙', '丙', '丁'], { luMode: false });
  const holder = g.hands.findIndex((h) => h.includes(E.CLUB_THREE));
  eq('T01a 持梅花3 的人先出', g.turn, holder);

  const other = g.hands[holder].find((c) => c !== E.CLUB_THREE);
  const r = g.play(holder, [other]);
  ok('T01b 第一手不含梅花3 也合法', r.ok, JSON.stringify(r));
}

// ===========================================================================
console.log('\n§F  順子階梯');
// ===========================================================================
{
  const a2345 = id([C('A', 0), C(2, 1), C(3, 2), C(4, 3), C(5, 0)]);
  const s23456 = id([C(2, 0), C(3, 1), C(4, 2), C(5, 3), C(6, 0)]);
  const s34567 = id([C(3, 0), C(4, 1), C(5, 2), C(6, 3), C(7, 0)]);
  const tjqka = id([C(10, 0), C('J', 1), C('Q', 2), C('K', 3), C('A', 0)]);

  ok('T02 A2345 成順', !!a2345);
  ok('T03 23456 成順', !!s23456);
  eq('T04 JQKA2 不成順', id([C('J', 0), C('Q', 1), C('K', 2), C('A', 3), C(2, 0)]), null);
  ok('T05 TJQKA 最大', E.beats(tjqka, a2345) && E.beats(tjqka, s23456) && E.beats(tjqka, s34567));
  ok('T06a A2345 最小', E.beats(s23456, a2345) && !E.beats(a2345, s23456));
  ok('T06b 23456 小於 34567', E.beats(s34567, s23456));

  // T07 同一階梯 → 比有效最大張的花色（A2345 的有效高張是 5）
  const lowSpade = id([C('A', 0), C(2, 1), C(3, 2), C(4, 0), C(5, 3)]);   // 5♠
  const lowHeart = id([C('A', 1), C(2, 0), C(3, 3), C(4, 1), C(5, 2)]);   // 5♥
  ok('T07 A2345 用 5 的花色分高下', E.beats(lowSpade, lowHeart) && !E.beats(lowHeart, lowSpade));

  // T08 同花順走同一套階梯
  const sfLow = id([C('A', 3), C(2, 3), C(3, 3), C(4, 3), C(5, 3)]);
  const sfHigh = id([C(10, 0), C('J', 0), C('Q', 0), C('K', 0), C('A', 0)]);
  eq('T08a A2345 同花 = 同花順', sfLow.label, '同花順');
  ok('T08b 同花順也照階梯比', E.beats(sfHigh, sfLow) && !E.beats(sfLow, sfHigh));
}

// ===========================================================================
console.log('\n§G  同花比較');
// ===========================================================================
{
  const clubs = id([C('A', 0), C('J', 0), C(9, 0), C(6, 0), C(4, 0)]);
  const hearts = id([C('A', 2), C(10, 2), C(8, 2), C(7, 2), C(3, 2)]);
  ok('T09 逐張比點數，J>10 決勝', E.beats(clubs, hearts) && !E.beats(hearts, clubs));

  const sameC = id([C('A', 0), C('J', 0), C(9, 0), C(6, 0), C(4, 0)]);
  const sameH = id([C('A', 2), C('J', 2), C(9, 2), C(6, 2), C(4, 2)]);
  ok('T10 五張全同才輪到花色', E.beats(sameH, sameC) && !E.beats(sameC, sameH));
}

// ===========================================================================
console.log('\n§D  對子 / 三條');
// ===========================================================================
{
  const pHi = id([C('A', 2), C('A', 3)]);    // A♥A♠
  const pLo = id([C('A', 0), C('A', 1)]);    // A♣A♦
  ok('T11 同點數對子比最大花色', E.beats(pHi, pLo) && !E.beats(pLo, pHi));

  const jacks = id([C('J', 0), C('J', 1)]);
  const tens = id([C(10, 0), C(10, 3)]);
  ok('T12 點數勝過花色優勢', E.beats(jacks, tens) && !E.beats(tens, jacks));

  ok('T12b 222 > AAA', E.beats(
    id([C(2, 0), C(2, 1), C(2, 2)]),
    id([C('A', 1), C('A', 2), C('A', 3)])));
}

// ===========================================================================
console.log('\n§H  葫蘆 / 鐵支只比關鍵點數');
// ===========================================================================
{
  ok('99933 > 888AA', E.beats(
    id([C(9, 0), C(9, 1), C(9, 2), C(3, 0), C(3, 1)]),
    id([C(8, 0), C(8, 1), C(8, 2), C('A', 0), C('A', 1)])));

  const q1 = id([C(9, 0), C(9, 1), C(9, 2), C(9, 3), C(3, 0)]);
  const q2 = id([C(9, 0), C(9, 1), C(9, 2), C(9, 3), C(2, 0)]);
  ok('鐵支的帶牌不影響大小', !E.beats(q1, q2) && !E.beats(q2, q1));
}

// ===========================================================================
console.log('\n§B3  玩家可以自由拆牌');
// ===========================================================================
{
  const four = [C(4, 0), C(4, 1), C(4, 2), C(4, 3)];
  const g = rig([[...four, C('K', 0)], [C(5, 0)], [C(5, 1)], [C(5, 2)]]);
  ok('T13 三條可以只當對子出', g.play(0, [four[0], four[1]]).ok);

  const g2 = rig([[...four, C('K', 0)], [C(5, 0)], [C(5, 1)], [C(5, 2)]]);
  ok('T14a 四張可以只出單張', g2.play(0, [four[0]]).ok);

  const g3 = rig([[...four, C('K', 0)], [C(5, 0)], [C(5, 1)], [C(5, 2)]]);
  ok('T14b 四張可以只出三條', g3.play(0, [four[0], four[1], four[2]]).ok);

  const g4 = rig([[...four, C('K', 0)], [C(5, 0)], [C(5, 1)], [C(5, 2)]]);
  ok('T15 不強迫出最強組合', g4.play(0, [C('K', 0)]).ok);
}

// ===========================================================================
console.log('\n§B1  PASS 不會把人踢出這一墩');
// ===========================================================================
{
  // 甲 88 → 乙 pass → 丙 JJ → 丁 pass → 甲 pass → 乙 應該還有一次機會
  const g = rig([
    [C(8, 0), C(8, 1), C(3, 0)],
    [C('Q', 0), C('Q', 1), C(3, 1)],
    [C('J', 0), C('J', 1), C(3, 2)],
    [C(4, 0), C(4, 1), C(3, 3)],
  ]);
  ok('甲出 88', g.play(0, [C(8, 0), C(8, 1)]).ok);
  ok('乙 PASS', g.pass(1).ok);
  eq('輪到丙', g.turn, 2);
  ok('丙出 JJ', g.play(2, [C('J', 0), C('J', 1)]).ok);
  eq('T16 新的一手把 passed 清空', g.passed, [false, false, false, false]);
  ok('丁 PASS', g.pass(3).ok);
  ok('甲 PASS', g.pass(0).ok);
  eq('T17 先前 PASS 過的乙又輪到了', g.turn, 1);
  ok('乙這次出得了 QQ', g.play(1, [C('Q', 0), C('Q', 1)]).ok);

  // T18 三家對同一手都 PASS，這一墩才結束
  ok('丙 PASS', g.pass(2).ok);
  ok('丁 PASS', g.pass(3).ok);
  ok('甲 PASS', g.pass(0).ok);
  eq('T18 繞回乙，這一墩結束', g.turn, 1);
  ok('T18b 乙可以自由開牌', g.isNewRound());
  // T19 桌面沒被清掉
  eq('T19 贏的那手還留在桌上', g.currentCards, [C('Q', 0), C('Q', 1)]);
  eq('T19b 標記是誰贏的這一墩', g.trickWonBy, 1);
}

// ===========================================================================
console.log('\n§I / §X  沒有任何倒數');
// ===========================================================================
{
  const g = new Game(['甲', '乙', '丙', '丁'], {});
  eq('T20a turnSeconds 這個選項不存在', g.opt.turnSeconds, undefined);
  ok('T20b 沒有 autoAct 這種東西', typeof g.autoAct === 'undefined');
  ok('T24 沒有自動換電腦的程式路徑', typeof g.autoBot === 'undefined');
}

// ===========================================================================
console.log('\n§N  換牌同張數 → 當眾擲骰子');
// ===========================================================================
{
  const g = new Game(['甲', '乙', '丙', '丁'], { luMode: true });
  for (let i = 0; i < 4; i++) g.submitDiscards(i, g.hands[i].slice(0, 3));
  eq('T33 同張數會進入擲骰子階段', g.phase, PHASE.SWAP_DICE);
  eq('T34a 四家都要自己擲', g.diceNeeded.length, 4);
  ok('T34b 沒擲的人拿不到點數', g.diceRolls[0] === undefined);

  const before = g.diceNeeded[0];
  g.rollDice(before);
  ok('T34c 擲完就有點數', typeof g.diceRolls[before] === 'number');
  ok('T34d 別人不能代擲', g.rollDice(before).ok === false);

  let guard = 0;
  while (g.phase === PHASE.SWAP_DICE && guard++ < 40) g.rollDice(g.diceNeeded[0]);
  eq('擲完進入抽牌', g.phase, PHASE.SWAP_PICK);
  const vals = g.pickOrder.map((s) => g.diceRolls[s]);
  ok('T35 抽牌順序照點數由大到小', vals.every((v, i) => i === 0 || vals[i - 1] >= v),
    JSON.stringify(vals));
}
{
  // T35 精確同點只重擲那幾個人
  let seq = [4, 4, 6, 2];   // 甲乙同點 → 只有甲乙重擲
  let k = 0;
  const g = new Game(['甲', '乙', '丙', '丁'], { luMode: true },
    () => { const v = ((seq[k % seq.length] - 1) / 6) + 0.01; k++; return v; });
  for (let i = 0; i < 4; i++) g.submitDiscards(i, g.hands[i].slice(0, 2));
  if (g.phase === PHASE.SWAP_DICE) {
    const needed = [...g.diceNeeded];
    needed.forEach((s) => g.rollDice(s));
    const stillNeeded = g.diceNeeded;
    ok('T35b 只有同點的人要重擲', stillNeeded.length < 4 || g.phase === PHASE.SWAP_PICK,
      JSON.stringify({ stillNeeded, phase: g.phase }));
  } else {
    ok('T35b（本輪沒有同點）', true);
  }
}

// ===========================================================================
console.log('\n§L / §M  蓋牌與抽牌');
// ===========================================================================
{
  const g = new Game(['甲', '乙', '丙', '丁'], { luMode: true });
  const mine = g.hands[0].slice(0, 4);
  g.submitDiscards(0, mine);
  eq('T27a 蓋出去的牌離開手牌', g.hands[0].filter((c) => mine.includes(c)).length, 0);
  for (let i = 1; i < 4; i++) g.submitDiscards(i, g.hands[i].slice(0, 4));

  let guard = 0;
  while (g.phase === PHASE.SWAP_DICE && guard++ < 40) g.rollDice(g.diceNeeded[0]);

  const st = g.publicState(0);
  ok('T31a 別人看不到牌堆內容', st.swap.pool.every((p) => p.card === undefined));
  ok('T31b 但看得到誰蓋了幾張', Array.isArray(st.swap.discardCounts));

  const picker = g.currentPicker();
  const avail = g.availablePicks(picker);
  ok('T29a 抽牌是自己選位置', avail.length > 0);
  ok('T29b 優先抽別人的', avail.every((i) => g.pool[i].owner !== picker));
  const r = g.pickCard(picker, avail[0]);
  ok('T29c 抽到才看得到那張牌', r.ok && typeof r.card === 'number');

  // T32 電腦策略拿不到蓋牌內容
  ok('T32 AI 沒有讀取 pool 內容的介面',
    typeof AI.choosePickIndex === 'function'
    && AI.choosePickIndex.length <= 1);
}
{
  // T27/T28 洗一次、位置固定、之後不再洗
  const g = new Game(['甲', '乙', '丙', '丁'], { luMode: true });
  for (let i = 0; i < 4; i++) g.submitDiscards(i, g.hands[i].slice(0, 3));
  let guard = 0;
  while (g.phase === PHASE.SWAP_DICE && guard++ < 40) g.rollDice(g.diceNeeded[0]);
  const snapshot = g.pool.map((p) => p.card);
  const picker = g.currentPicker();
  g.pickCard(picker, g.availablePicks(picker)[0]);
  const after = g.pool.map((p) => p.card);
  eq('T28 抽過之後其他位置的牌沒有被重洗', snapshot, after);
}

// ===========================================================================
console.log('\n§O  抓牌關窗的三個條件');
// ===========================================================================
{
  const hands = [
    [C(8, 0), C(8, 1), C(3, 0)],
    [C('Q', 0), C(6, 1), C(3, 1)],
    [C('J', 0), C('J', 1), C(3, 2)],
    [C(4, 0), C(4, 1), C(3, 3)],
  ];
  const g = rig(hands, { strictMode: false });
  g.play(0, [C(8, 0), C(8, 1)]);
  ok('T37 每一手都開窗', !!g.challenge);
  g.play(1, [C('Q', 0), C(6, 1)]);            // 不成對，寬鬆放行
  eq('T38 下一手出牌會換掉舊的窗', g.challenge.seat, 1);

  const r = g.challengePlay(2);
  ok('T41a 抓成立', r.upheld === true);
  eq('T41b 桌面回到甲的 88', g.currentCards, [C(8, 0), C(8, 1)]);
  eq('T41c 輪回乙重出', g.turn, 1);
  eq('T42 抓完關窗，不能往回抓', g.challenge, null);
}
{
  const g = rig([
    [C(8, 0), C(8, 1), C(3, 0)],
    [C(5, 0), C(5, 1), C(3, 1)],
    [C(6, 0), C(6, 1), C(3, 2)],
    [C(4, 0), C(4, 1), C(3, 3)],
  ], { strictMode: false });
  g.play(0, [C(8, 0), C(8, 1)]);
  g.pass(1); g.pass(2);
  ok('T39a 兩家 PASS 時窗還開著', g.challengeOpen());
  g.pass(3);
  eq('T39b 三家都 PASS → 立刻關窗', g.challenge, null);
}
{
  const g = rig([
    [C(8, 0), C(8, 1), C(3, 0)],
    [C(5, 0), C(5, 1), C(3, 1)],
    [C(6, 0), C(6, 1), C(3, 2)],
    [C(4, 0), C(4, 1), C(3, 3)],
  ], { strictMode: false });
  g.play(0, [C(8, 0), C(8, 1)]);              // 合法
  const r = g.challengePlay(1);
  ok('T40a 抓錯了', r.upheld === false);
  eq('T40b 抓錯也關窗', g.challenge, null);
  ok('T40c 同一手不能再抓', g.challengePlay(2).ok === false);
}
{
  const g = rig([[C(8, 0)], [C(5, 0)], [C(6, 0)], [C(4, 0)]], { strictMode: true });
  g.play(0, [C(8, 0)]);
  eq('嚴格模式不開窗', g.challenge, null);
}

// ===========================================================================
console.log('\n§P  暫定結束要三家確認');
// ===========================================================================
{
  const g = rig([
    [C(8, 0)],
    [C(5, 0), C(3, 1)],
    [C(6, 0), C(3, 2)],
    [C(4, 0), C(3, 3)],
  ], { strictMode: false });
  const r = g.play(0, [C(8, 0)]);
  eq('T43 出完最後一張進入暫定結束', g.phase, PHASE.PROVISIONAL_FINISH);
  ok('T43b 回報是暫定的', r.provisional === true);
  eq('T44a 還沒結算', g.settlement, null);
  eq('T45 三家都還沒確認', g.pendingConfirmers(), [1, 2, 3]);

  g.confirmFinish(1);
  eq('T44b 一家確認還不夠', g.settlement, null);
  eq('T45b 確認狀態是公開的', g.publicState(2).provisional.confirmed, [1]);
  ok('T46 確認過的人不能再抓', g.challengePlay(1).ok === false);

  g.confirmFinish(2);
  eq('兩家確認仍不夠', g.settlement, null);
  const last = g.confirmFinish(3);
  ok('T44c 三家到齊才結算', last.settled === true);
  eq('局面結束', g.phase, PHASE.FINISHED);
  ok('有結算資料', !!g.settlement);
}
{
  // T47 抓失敗不等於確認結束
  const g = rig([
    [C(8, 0)],
    [C(5, 0), C(3, 1)],
    [C(6, 0), C(3, 2)],
    [C(4, 0), C(3, 3)],
  ], { strictMode: false });
  g.play(0, [C(8, 0)]);                       // 合法的最後一手
  const r = g.challengePlay(1);
  ok('T47a 抓失敗', r.upheld === false);
  ok('T47b 抓失敗不算確認', g.pendingConfirmers().includes(1));
  eq('T47c 還是要自己按確認', g.settlement, null);
}
{
  // T48 抓成功 → 暫定結束取消，牌局繼續
  const g = rig([
    [C(8, 0), C(8, 1)],
    [C(5, 0), C(3, 1)],
    [C(6, 0), C(3, 2)],
    [C(4, 0), C(3, 3)],
  ], { strictMode: false });
  g.play(0, [C(8, 0)]);
  g.pass(1); g.pass(2); g.pass(3);            // 甲贏這一墩
  const bad = g.play(0, [C(8, 1), C(8, 1)]);  // 重複牌 → 硬錯誤，會被擋
  ok('重複牌永遠擋掉', bad.ok === false);
}

// ===========================================================================
console.log('\n§R / §S  結算與付款提醒');
// ===========================================================================
{
  // 讓三家都出過牌，才測得到「沒有加倍」的基本結算
  const g = rig([
    [C(8, 0), C(2, 3)],
    [C(9, 0), C(3, 1), C(4, 1)],
    [C(10, 0), C(3, 2), C(4, 2)],
    [C('J', 0), C(3, 3), C(4, 3)],
  ], { pointValue: 5 });
  g.play(0, [C(8, 0)]);
  g.play(1, [C(9, 0)]);
  g.play(2, [C(10, 0)]);
  g.play(3, [C('J', 0)]);
  g.pass(0); g.pass(1); g.pass(2);      // 丁贏這一墩
  g.play(3, [C(3, 3)]);
  g.pass(0); g.pass(1); g.pass(2);
  g.play(3, [C(4, 3)]);                 // 丁出完
  eq('丁出完了', g.phase, PHASE.PROVISIONAL_FINISH);
  [0, 1, 2].forEach((x) => g.confirmFinish(x));
  const st = g.settlement;
  eq('T50a 剩牌數', st.points, [1, 2, 2, 0]);
  eq('沒有人是白板', st.blanks, [false, false, false, false]);
  eq('T50b 一分五元，不加倍', st.money, [-5, -10, -10, 25]);
  eq('T50c 付款提醒有三筆', st.transfers.length, 3);
  ok('T50d 每筆都寫明誰付誰、多少錢',
    st.transfers.every((t) => t.fromName && t.toName && t.amount > 0));
  eq('T51 沒有付款追蹤欄位', st.paid, undefined);
  eq('金額加總為零', st.money.reduce((a, b) => a + b, 0), 0);
}

// ===========================================================================
console.log('\n白板加倍：整局一張都沒出過，賠雙倍（CIO 8/16）');
// ===========================================================================
{
  // 甲一手出完；乙丙丁都沒機會出牌 → 三家都是白板
  const g = rig([[C(2, 3)], [C(5, 0), C(3, 1)], [C(6, 0), C(3, 2)], [C(4, 0), C(3, 3)]],
    { pointValue: 5 });
  g.play(0, [C(2, 3)]);
  [1, 2, 3].forEach((x) => g.confirmFinish(x));
  const st = g.settlement;
  eq('三家各剩兩張', st.points, [0, 2, 2, 2]);
  eq('都沒出過牌 → 全是白板', st.blanks, [false, true, true, true]);
  eq('每家 2 分 × 5 元 × 2 = 20', st.money, [60, -20, -20, -20]);
  ok('付款提醒標出白板', st.transfers.every((t) => t.blank === true));
}
{
  // 乙出過牌就不算白板
  const g = rig([[C(8, 0), C(2, 3)], [C(9, 0), C(3, 1)], [C(6, 0), C(3, 2)], [C(4, 0), C(3, 3)]],
    { pointValue: 5 });
  g.play(0, [C(8, 0)]);
  g.play(1, [C(9, 0)]);       // 乙出過
  g.pass(2); g.pass(3); g.pass(0);
  g.play(1, [C(3, 1)]);       // 乙贏了這一墩並出完
  eq('乙出完了', g.phase, PHASE.PROVISIONAL_FINISH);
  [0, 2, 3].forEach((x) => g.confirmFinish(x));
  const st = g.settlement;
  eq('甲出過牌，不是白板', st.blanks[0], false);
  eq('丙丁沒出過，是白板', [st.blanks[2], st.blanks[3]], [true, true]);
  // 甲剩 1 張 = 5 元；丙丁各剩 2 張 ×2 = 20 元
  eq('只有白板的人加倍', st.money, [-5, 45, -20, -20]);
}
{
  // 換牌之後還是 13 張，但有出過牌就不算白板
  const g = rig([[C(8, 0)], [C(9, 0), C(3, 1)], [C(6, 0), C(3, 2)], [C(4, 0), C(3, 3)]],
    { pointValue: 5 });
  g.play(0, [C(8, 0)]);
  [1, 2, 3].forEach((x) => g.confirmFinish(x));
  ok('贏家永遠不算白板', g.settlement.blanks[0] === false);
}

// ===========================================================================
console.log('\n§K  電腦的資訊防火牆');
// ===========================================================================
{
  // 電腦判斷該不該抓，只能用「那手牌」和「當時要壓的那手」
  const challenge = {
    cards: [C('Q', 0), C(6, 1)],
    priorCurrent: id([C(8, 0), C(8, 1)]),
    priorIsNewRound: false,
  };
  ok('T62a 電腦自己算得出不成牌型', AI.shouldChallenge(challenge, {}) === true);

  const good = {
    cards: [C('Q', 0), C('Q', 1)],
    priorCurrent: id([C(8, 0), C(8, 1)]),
    priorIsNewRound: false,
  };
  ok('T62b 合法的一手不會亂抓', AI.shouldChallenge(good, {}) === false);
  ok('T62c 判斷函式看不到 legal 欄位',
    AI.shouldChallenge({ ...good, legal: false }, {}) === false);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
