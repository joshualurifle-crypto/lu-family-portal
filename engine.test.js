'use strict';
const E = require('../src/engine');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; console.log(`  ✗ ${name}: ${e.message}`); }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || ''} expected ${b}, got ${a}`);
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }

// 造牌：rank 用 '3'..'2'，suit 用 0=梅 1=方 2=紅 3=黑
const C = (rank, suit) => E.RANK_NAMES.indexOf(String(rank)) * 4 + suit;

console.log('--- 牌型辨識 ---');
t('梅花3 = 0', () => eq(C(3, 0), 0));
t('黑桃2 = 51', () => eq(C(2, 3), 51));
t('單張', () => eq(E.identify([C(5, 1)]).type, 'SINGLE'));
t('對子', () => eq(E.identify([C(5, 1), C(5, 3)]).type, 'PAIR'));
t('非對子回傳 null', () => eq(E.identify([C(5, 1), C(6, 3)]), null));
t('三條', () => eq(E.identify([C(9, 0), C(9, 1), C(9, 2)]).type, 'TRIPLE'));
t('四張不合法', () => eq(E.identify([C(9, 0), C(9, 1), C(9, 2), C(9, 3)]), null));
t('順子', () => eq(E.identify([C(3, 0), C(4, 1), C(5, 2), C(6, 3), C(7, 0)]).label, '順子'));
t('同花', () => eq(E.identify([C(3, 2), C(5, 2), C(9, 2), C('J', 2), C('K', 2)]).label, '同花'));
t('葫蘆', () => eq(E.identify([C(8, 0), C(8, 1), C(8, 2), C('K', 0), C('K', 3)]).label, '葫蘆'));
t('鐵支', () => eq(E.identify([C(7, 0), C(7, 1), C(7, 2), C(7, 3), C(2, 0)]).label, '鐵支'));
t('同花順', () => eq(E.identify([C(9, 3), C(10, 3), C('J', 3), C('Q', 3), C('K', 3)]).label, '同花順'));
// §F CIO 順子階梯：A2345 最小，TJQKA 最大，JQKA2 不成順
t('T04 J-Q-K-A-2 不成順', () =>
  eq(E.identify([C('J', 0), C('Q', 1), C('K', 2), C('A', 3), C(2, 0)]), null));
t('T02 A-2-3-4-5 成順', () =>
  eq(E.identify([C('A', 0), C(2, 1), C(3, 2), C(4, 3), C(5, 0)]).label, '順子'));
t('T03 2-3-4-5-6 成順', () =>
  eq(E.identify([C(2, 0), C(3, 1), C(4, 2), C(5, 3), C(6, 0)]).label, '順子'));
t('T05 10-J-Q-K-A 成順', () =>
  eq(E.identify([C(10, 0), C('J', 1), C('Q', 2), C('K', 3), C('A', 0)]).label, '順子'));
t('雜牌五張 = null', () =>
  eq(E.identify([C(3, 0), C(5, 1), C(8, 2), C('J', 3), C('K', 0)]), null));
t('重複牌 = null', () => eq(E.identify([5, 5]), null));

console.log('--- 比大小 ---');
const id = (cs) => E.identify(cs);
t('單張比點數', () => ok(E.beats(id([C(5, 0)]), id([C(4, 3)]))));
t('同點比花色 黑桃>紅心', () => ok(E.beats(id([C(5, 3)]), id([C(5, 2)]))));
t('2 最大', () => ok(E.beats(id([C(2, 0)]), id([C('A', 3)]))));
t('黑桃2 最大', () => ok(!E.beats(id([C(2, 2)]), id([C(2, 3)]))));
t('對子比最大張', () => ok(E.beats(id([C(9, 2), C(9, 3)]), id([C(9, 0), C(9, 1)]))));
t('張數不同不可比', () => ok(!E.beats(id([C(9, 2), C(9, 3)]), id([C(4, 0)]))));
t('三條不可壓五張', () =>
  ok(!E.beats(id([C(2, 0), C(2, 1), C(2, 2)]),
    id([C(3, 0), C(4, 1), C(5, 2), C(6, 3), C(7, 0)]))));
t('同花 > 順子', () =>
  ok(E.beats(id([C(3, 2), C(5, 2), C(9, 2), C('J', 2), C('K', 2)]),
    id([C(9, 0), C(10, 1), C('J', 2), C('Q', 3), C('K', 0)]))));
t('葫蘆 > 同花', () =>
  ok(E.beats(id([C(4, 0), C(4, 1), C(4, 2), C(5, 0), C(5, 1)]),
    id([C(3, 3), C(5, 3), C(9, 3), C('J', 3), C('A', 3)]))));
t('鐵支 > 葫蘆', () =>
  ok(E.beats(id([C(3, 0), C(3, 1), C(3, 2), C(3, 3), C(4, 0)]),
    id([C(2, 0), C(2, 1), C(2, 2), C('A', 0), C('A', 1)]))));
t('同花順 > 鐵支', () =>
  ok(E.beats(id([C(3, 3), C(4, 3), C(5, 3), C(6, 3), C(7, 3)]),
    id([C(2, 0), C(2, 1), C(2, 2), C(2, 3), C(3, 0)]))));
// §G CIO：同花先按點數由大到小逐張比，花色只在五張點數全同時才用
t('T09 同花比點數，花色不能翻盤', () => {
  const clubs = id([C('A', 0), C('J', 0), C(9, 0), C(6, 0), C(4, 0)]);
  const hearts = id([C('A', 2), C(10, 2), C(8, 2), C(7, 2), C(3, 2)]);
  ok(E.beats(clubs, hearts));          // A=A，然後 J>10
  ok(!E.beats(hearts, clubs));         // 紅心比較大也救不了
});
t('T10 五張點數全同才比花色', () => {
  const clubs = id([C('A', 0), C('J', 0), C(9, 0), C(6, 0), C(4, 0)]);
  const hearts = id([C('A', 2), C('J', 2), C(9, 2), C(6, 2), C(4, 2)]);
  ok(E.beats(hearts, clubs));
  ok(!E.beats(clubs, hearts));
});

console.log('--- 發牌 ---');
t('發牌 4×13 且無重複', () => {
  const hands = E.deal();
  eq(hands.length, 4);
  hands.forEach((h) => eq(h.length, 13));
  eq(new Set(hands.flat()).size, 52);
});
t('梅花3 一定在某人手上', () => {
  const hands = E.deal();
  ok(hands.some((h) => h.includes(0)));
});

console.log('--- 合法性檢查 ---');
// §C CIO：梅花3 只決定誰先出，第一手不必包含梅花3
t('T01 第一手可以不含梅花3', () => {
  const r = E.validatePlay({
    hand: [0, 1, 2, 8], cards: [8], current: null,
    isNewRound: true,
  });
  eq(r.ok, true);
});
t('第一手含梅花3 通過', () => {
  const r = E.validatePlay({
    hand: [0, 1, 2, 8], cards: [0], current: null,
    isNewRound: true, isFirstPlayOfGame: true,
  });
  eq(r.ok, true);
});
t('牌不夠大被擋', () => {
  const r = E.validatePlay({
    hand: [4], cards: [4], current: id([8]),
    isNewRound: false, isFirstPlayOfGame: false,
  });
  eq(r.ok, false);
  eq(r.reason, '牌不夠大');
});
t('張數不對被擋', () => {
  const r = E.validatePlay({
    hand: [4, 5], cards: [4, 5], current: id([8]),
    isNewRound: false, isFirstPlayOfGame: false,
  });
  eq(r.ok, false);
});
t('不在手上被擋', () => {
  const r = E.validatePlay({
    hand: [4], cards: [9], current: null,
    isNewRound: true, isFirstPlayOfGame: false,
  });
  eq(r.ok, false);
});

console.log('--- legalPlays ---');
t('新一輪列出所有牌型', () => {
  const hand = [C(3, 0), C(3, 1), C(4, 0), C(5, 0), C(6, 0), C(7, 0)];
  const plays = E.legalPlays(hand, null);
  ok(plays.some((p) => p.meld.size === 1));
  ok(plays.some((p) => p.meld.size === 2));
  ok(plays.some((p) => p.meld.label === '同花順' || p.meld.label === '順子'));
});
t('無法壓過時回傳空陣列', () => {
  const hand = [C(3, 0), C(4, 0)];
  eq(E.legalPlays(hand, id([C(2, 3)])).length, 0);
});

console.log(`\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail ? 1 : 0);
