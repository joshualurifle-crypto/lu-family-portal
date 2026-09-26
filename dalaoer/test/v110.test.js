'use strict';
/**
 * v1.10 回歸測試：張數不夠自動跳過（CIO 2026-09-27，規則 A）
 *
 *   node test/v110.test.js
 */

const { Game, PHASE } = require('../src/game');
const E = require('../src/engine');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
}

const R = { 3: 0, 4: 1, 5: 2, 6: 3, 7: 4, 8: 5, 9: 6, 10: 7, J: 8, Q: 9, K: 10, A: 11, 2: 12 };
const C = (r, s) => R[r] * 4 + s;

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

const filler = (n, from) => Array.from({ length: n }, (_, i) => from + i);

console.log('\n一、對子：只剩一張的人自動跳過');
{
  const g = rig([
    [C(5, 0), C(5, 1), C(9, 0)],
    [C('K', 0)],                       // 乙只剩一張
    filler(6, 20),
    filler(6, 30),
  ]);
  const r = g.play(0, [C(5, 0), C(5, 1)]);
  ok('甲出對子成功', r.ok, JSON.stringify(r));
  ok('乙被自動跳過，輪到丙', g.turn === 2, `turn=${g.turn}`);
  ok('乙標記為不出', g.passed[1] === true);
  ok('記錄寫明自動不出', g.log.some((l) => l.includes('乙') && l.includes('自動不出')));
  ok('乙手上的牌沒動', g.hands[1].length === 1);
}

console.log('\n二、順子：四張以下全部跳過（炸彈也要五張）');
{
  const g = rig([
    [C(3, 0), C(4, 1), C(5, 2), C(6, 3), C(7, 0), C('A', 0)],
    [C('K', 0), C('K', 1), C('K', 2), C('K', 3)],   // 四張 K：湊不成鐵支（鐵支要五張）
    [C(2, 0), C(2, 1), C(2, 2)],
    filler(8, 10),
  ]);
  const r = g.play(0, [C(3, 0), C(4, 1), C(5, 2), C(6, 3), C(7, 0)]);
  ok('甲出順子成功', r.ok, JSON.stringify(r));
  ok('乙（四張）跳過', g.passed[1] === true);
  ok('丙（三張）跳過', g.passed[2] === true);
  ok('輪到丁', g.turn === 3, `turn=${g.turn}`);
}

console.log('\n三、張數夠就一定要自己決定——不看牌面大小');
{
  const g = rig([
    [C(2, 0), C(2, 3), C(9, 0)],
    [C(3, 0), C(3, 1)],                // 兩張、小對子：壓不過，但張數夠 → 不自動跳
    filler(6, 20),
    filler(6, 30),
  ]);
  g.play(0, [C(2, 0), C(2, 3)]);
  ok('乙張數夠，輪到乙自己決定', g.turn === 1, `turn=${g.turn}`);
  ok('乙沒有被標記不出', g.passed[1] === false);
}
{
  const g = rig([
    [C(5, 0), C(5, 1), C(9, 0)],
    [C(8, 0), C(8, 1), C(8, 2), C(8, 3), C(4, 0)],  // 五張鐵支可以炸對子
    filler(6, 20),
    filler(6, 30),
  ]);
  g.play(0, [C(5, 0), C(5, 1)]);
  ok('手上五張（可炸）不跳過', g.turn === 1 && !g.passed[1]);
}

console.log('\n四、單張永遠不會自動跳過');
{
  const g = rig([
    [C(5, 0), C(9, 0)],
    [C('K', 0)],
    filler(6, 20),
    filler(6, 30),
  ]);
  g.play(0, [C(5, 0)]);
  ok('只剩一張面對單張，照樣輪到他', g.turn === 1 && !g.passed[1]);
}

console.log('\n五、三家都不夠 → 出牌的人直接贏這一墩');
{
  const g = rig([
    [C(3, 0), C(4, 1), C(5, 2), C(6, 3), C(7, 0), C('A', 0)],
    [C('K', 0)],
    [C(2, 0), C(2, 1)],
    [C(9, 0), C(9, 1), C(9, 2)],
  ]);
  g.play(0, [C(3, 0), C(4, 1), C(5, 2), C(6, 3), C(7, 0)]);
  ok('回到甲', g.turn === 0, `turn=${g.turn}`);
  ok('新的一墩（甲自由開牌）', g.isNewRound());
  ok('桌上那手留著給大家看（§B2）', g.trickWonBy === 0);
}

console.log('\n六、開牌那一手不會被跳過');
{
  const g = rig([
    [C(3, 0), C(4, 1), C(5, 2), C(6, 3), C(7, 0), C('A', 0), C('Q', 1)],
    [C('K', 0)],
    [C(2, 0), C(2, 1)],
    [C(9, 0), C(9, 1), C(9, 2)],
  ]);
  g.play(0, [C(3, 0), C(4, 1), C(5, 2), C(6, 3), C(7, 0)]);
  const r = g.play(0, [C('A', 0)]);
  ok('甲開單張成功', r.ok, JSON.stringify(r));
  ok('乙（一張）面對單張，輪到乙', g.turn === 1);
}

console.log('\n七、被跳過之後手上張數又不變，下一墩照常');
{
  const g = rig([
    [C(5, 0), C(5, 1), C(6, 0), C(6, 1), C('A', 3)],
    [C('K', 0)],
    filler(6, 20),
    filler(6, 30),
  ]);
  g.play(0, [C(5, 0), C(5, 1)]);
  ok('第一輪乙被跳過', g.passed[1]);
  g.pass(2); g.pass(3);
  ok('甲贏這一墩', g.turn === 0 && g.isNewRound());
  g.play(0, [C('A', 3)]);
  ok('甲出單張後輪到乙（不再被跳過）', g.turn === 1 && !g.passed[1]);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
