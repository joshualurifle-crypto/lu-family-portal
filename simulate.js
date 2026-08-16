'use strict';
/** AI 自我對戰模擬：驗證流程不會卡死、出牌全合法、結算金額歸零。 */

const { Game, PHASE } = require('../src/game');
const AI = require('../src/ai');
const E = require('../src/engine');

function playOneGame(opts, rng) {
  const g = new Game(['電腦A', '電腦B', '電腦C', '電腦D'], opts, rng);
  let guard = 0;

  while (g.phase !== PHASE.FINISHED) {
    if (guard++ > 4000) throw new Error(`卡死於 ${g.phase}`);

    if (g.phase === PHASE.SWAP_SELECT) {
      for (let s = 0; s < 4; s++) {
        if (!g.discards[s]) {
          const d = AI.chooseDiscards(g.hands[s]);
          const r = g.submitDiscards(s, d);
          if (!r.ok) throw new Error(`蓋牌失敗: ${r.reason}`);
        }
      }
      continue;
    }

    if (g.phase === PHASE.SWAP_DICE) {
      // §N 每個要擲的人自己擲
      g.diceNeeded.slice().forEach((seat) => g.rollDice(seat));
      continue;
    }

    if (g.phase === PHASE.SWAP_PICK) {
      const seat = g.currentPicker();
      const avail = g.availablePicks(seat);
      const r = g.pickCard(seat, avail[AI.choosePickIndex(avail, rng)]);
      if (!r.ok) throw new Error(`抽牌失敗: ${r.reason}`);
      continue;
    }

    if (g.phase === PHASE.BET_DECLARE) {
      let declared = false;
      for (let s = 0; s < 4; s++) {
        if (AI.shouldDeclareBet(g.hands[s])) { g.declareBet(s); declared = true; break; }
      }
      if (!declared) g.skipBet();
      continue;
    }

    if (g.phase === PHASE.BET_RESPOND) {
      for (let s = 0; s < 4; s++) {
        if (s === g.bet.declarer) continue;
        if (g.phase !== PHASE.BET_RESPOND) break;
        g.respondBet(s, AI.shouldAcceptBet(g.hands[s]));
      }
      continue;
    }

    if (g.phase === PHASE.PLAYING) {
      const seat = g.turn;
      const decision = AI.choosePlay({
        hand: g.hands[seat],
        current: g.current,
        playedCards: g.playedCards,
        opponentCounts: g.hands.map((h, i) => (i === seat ? Infinity : h.length)).filter((n) => n !== Infinity),
        isFirstPlay: g.isFirstPlay,
        rules: g.opt.rules,
      });
      const r = decision.action === 'pass' ? g.pass(seat) : g.play(seat, decision.cards);
      if (!r.ok) {
        // AI 不該出錯；出錯就用保底動作，並記錄
        let done = false;
        if (!g.isNewRound()) done = g.pass(seat).ok;
        if (!done) {
          const plays = E.legalPlays(g.hands[seat], g.current, g.opt.rules);
          plays.sort((a, b) => a.meld.size - b.meld.size || a.cards[0] - b.cards[0]);
          if (plays.length) done = g.play(seat, plays[0].cards).ok;
        }
        if (!done) throw new Error(`AI 動作失敗且無保底: ${r.reason} (座位 ${seat})`);
        stats.fallbacks++;
      }
      continue;
    }
    if (g.phase === PHASE.PROVISIONAL_FINISH) {
      // §P 三家各自決定：該抓就抓，否則確認結束
      for (const seat of g.pendingConfirmers()) {
        const suspicious = !g.opt.strictMode && g.challenge && g.challenge.seat !== seat
          && AI.shouldChallenge(g.challenge, g.opt.rules);
        if (suspicious) { g.challengePlay(seat); break; }
        g.confirmFinish(seat);
        if (g.phase !== PHASE.PROVISIONAL_FINISH) break;
      }
      continue;
    }

    throw new Error(`未知階段 ${g.phase}`);
  }
  return g;
}

// 可重現的亂數
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const stats = { fallbacks: 0 };

function run(label, opts, n) {
  const wins = [0, 0, 0, 0];
  const totals = [0, 0, 0, 0];
  let turns = 0, bets = 0, betWins = 0, swaps = 0;
  const t0 = Date.now();

  for (let i = 0; i < n; i++) {
    const g = playOneGame(opts, mulberry32(i * 7919 + 13));
    const s = g.settlement;
    wins[s.winner]++;
    s.money.forEach((m, k) => { totals[k] += m; });
    turns += g.playedCards.length;
    if (s.bet) { bets++; if (s.bet.result === 'WIN') betWins++; }
    if (opts.luMode) swaps++;

    // 不變量檢查
    const sum = s.money.reduce((a, b) => a + b, 0);
    if (Math.abs(sum) > 1e-9) throw new Error(`金額不平衡: ${sum}`);
    if (s.points[s.winner] !== 0) throw new Error('贏家還有牌');
    if (g.playedCards.length + g.hands.flat().length !== 52) throw new Error('牌數對不上');
    if (new Set([...g.playedCards, ...g.hands.flat()]).size !== 52) throw new Error('有重複的牌');
  }

  const ms = Date.now() - t0;
  console.log(`\n【${label}】${n} 局，耗時 ${ms}ms（每局 ${(ms / n).toFixed(1)}ms）`);
  console.log(`  勝場分布: ${wins.join(' / ')}`);
  console.log(`  淨輸贏  : ${totals.map((t) => (t >= 0 ? '+' : '') + t).join(' / ')}`);
  if (bets) console.log(`  對賭    : 成立 ${bets} 次，賭家贏 ${betWins} 次`);
  console.log(`  保底動作: ${stats.fallbacks} 次`);
}

console.log('=== 大老二 AI 自我對戰驗證 ===');
run('標準玩法', { luMode: false, pointValue: 5 }, 300);
stats.fallbacks = 0;
run('盧家玩法（換牌＋對賭）', { luMode: true, pointValue: 5 }, 300);

console.log('\n=== AI 強度對照：強 AI vs 隨機出牌 ===');
(function strengthTest() {
  let smartWins = 0;
  const N = 200;
  for (let i = 0; i < N; i++) {
    const rng = mulberry32(i * 104729 + 7);
    const g = new Game(['強AI', '隨機B', '隨機C', '隨機D'], { luMode: false }, rng);
    // §I 沒有 autoAct 了，保底自己寫：能不出就不出，否則出最小的合法牌
    const fallback = (seat) => {
      if (!g.isNewRound() && g.pass(seat).ok) return;
      const ps = E.legalPlays(g.hands[seat], g.current);
      ps.sort((a, b) => a.meld.size - b.meld.size || a.cards[0] - b.cards[0]);
      if (ps.length) g.play(seat, ps[0].cards);
    };

    let guard = 0;
    while (g.phase !== PHASE.FINISHED && guard++ < 3000) {
      if (g.phase === PHASE.PROVISIONAL_FINISH) {
        g.pendingConfirmers().forEach((s) => g.confirmFinish(s));
        continue;
      }
      const seat = g.turn;
      if (seat === 0) {
        const d = AI.choosePlay({
          hand: g.hands[0], current: g.current, playedCards: g.playedCards,
          opponentCounts: [g.hands[1].length, g.hands[2].length, g.hands[3].length],
          isFirstPlay: g.isFirstPlay,
        });
        const r = d.action === 'pass' ? g.pass(0) : g.play(0, d.cards);
        if (!r.ok) fallback(0);
      } else {
        // §C 第一手不再需要含梅花3
        const plays = E.legalPlays(g.hands[seat], g.current);
        if (!plays.length) { g.pass(seat); continue; }
        const pick = plays[Math.floor(rng() * plays.length)];
        const r = g.play(seat, pick.cards);
        if (!r.ok) fallback(seat);
      }
    }
    if (g.settlement && g.settlement.winner === 0) smartWins++;
  }
  console.log(`  強 AI 勝率: ${(smartWins / N * 100).toFixed(1)}%（隨機基準 25%）`);
})();
