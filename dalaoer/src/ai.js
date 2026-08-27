'use strict';
/**
 * 大老二 AI — 「最強」電腦玩家
 *
 * 核心想法：
 *  1. 手牌拆解 (decompose)：把 13 張拆成最少的出牌手數，同時保留強牌型。
 *  2. 記牌 (card counting)：追蹤已出的牌，判斷自己的牌是否已「無敵」。
 *  3. 控場判斷 (control)：無敵手數 >= 剩餘手數時，開始一路清光。
 *  4. 危險偵測：任一對手 <= 2 張時，全力封鎖，不惜拆牌。
 */

const E = require('./engine');
const { rankOf, suitOf, identify, beats, legalPlays, allMelds } = E;

// ---------------------------------------------------------------------------
// 手牌拆解
// ---------------------------------------------------------------------------

const CAT_VALUE = { 5: 100, 4: 90, 3: 40, 2: 30, 1: 25 }; // 同花順/鐵支/葫蘆/同花/順子

/**
 * 把手牌拆成一組出牌單位（melds）。目標：手數少、強牌型多、爛單張少。
 * 使用有限寬度的束搜尋 (beam search)。
 */
function decompose(hand, rules = E.DEFAULT_RULES) {
  const start = { remain: [...hand].sort((a, b) => a - b), melds: [] };
  let beam = [start];
  const BEAM_WIDTH = 6;
  const MAX_FIVES = 3;

  for (let depth = 0; depth < MAX_FIVES; depth++) {
    const next = [];
    for (const state of beam) {
      next.push(state); // 選擇不再抽五張牌型
      if (state.remain.length < 5) continue;
      const fives = allMelds(state.remain, 5, rules);
      // 只考慮最有價值的幾個
      fives.sort((a, b) =>
        (CAT_VALUE[b.meld.category] - CAT_VALUE[a.meld.category]) || (b.meld.tiebreak - a.meld.tiebreak));
      for (const f of fives.slice(0, BEAM_WIDTH)) {
        const used = new Set(f.cards);
        next.push({
          remain: state.remain.filter((c) => !used.has(c)),
          melds: [...state.melds, f],
        });
      }
    }
    // 去重 + 取分數最高的幾個
    const seen = new Set();
    const dedup = [];
    for (const s of next) {
      const key = s.melds.map((m) => m.cards.join(',')).sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      dedup.push(s);
    }
    dedup.sort((a, b) => scorePartition(finishPartition(b, rules)) - scorePartition(finishPartition(a, rules)));
    beam = dedup.slice(0, BEAM_WIDTH);
  }

  const finished = beam.map((s) => finishPartition(s, rules));
  finished.sort((a, b) => scorePartition(b) - scorePartition(a));
  return finished[0];
}

/** 把剩下的牌用 三條 > 對子 > 單張 收尾 */
function finishPartition(state, rules) {
  if (state.__done) return state.__done;
  let remain = [...state.remain];
  const melds = [...state.melds];

  for (const size of [3, 2]) {
    let changed = true;
    while (changed) {
      changed = false;
      const cands = allMelds(remain, size, rules);
      if (!cands.length) break;
      // 取點數最小的，把大牌留著當單張控場
      cands.sort((a, b) => a.meld.tiebreak - b.meld.tiebreak);
      const pick = cands[0];
      const used = new Set(pick.cards);
      remain = remain.filter((c) => !used.has(c));
      melds.push(pick);
      changed = true;
    }
  }
  for (const c of remain) melds.push({ cards: [c], meld: identify([c], rules) });

  const result = { melds, hands: melds.length };
  state.__done = result;
  return result;
}

/** 分數：手數越少越好，強牌型加分，大單張加分 */
function scorePartition(p) {
  let s = -p.melds.length * 10;
  for (const m of p.melds) {
    if (m.meld.size === 5) s += CAT_VALUE[m.meld.category] / 10;
    if (m.meld.size === 1) {
      const r = rankOf(m.cards[0]);
      if (r >= 11) s += 3;        // A、2 當單張很有價值
      else if (r <= 3) s -= 2;    // 3、4、5、6 爛單張
    }
  }
  return s;
}

// ---------------------------------------------------------------------------
// 記牌與無敵判斷
// ---------------------------------------------------------------------------

/** 尚未現身的牌（不在我手上、也還沒被打出去） */
function unseenCards(myHand, playedCards) {
  const known = new Set([...myHand, ...playedCards]);
  const out = [];
  for (let c = 0; c < 52; c++) if (!known.has(c)) out.push(c);
  return out;
}

/** 這個牌型是否已無人能壓（對五張牌型用保守近似） */
function isUnbeatable(meld, unseen, rules = E.DEFAULT_RULES) {
  const size = meld.size;
  if (size === 1) return !unseen.some((c) => c > meld.tiebreak);
  if (size === 2 || size === 3) {
    const cands = allMelds(unseen, size, rules);
    return !cands.some((c) => beats(c.meld, meld));
  }
  // 五張：只認同花順與鐵支為近似無敵（列舉 unseen 的五張組合過慢）
  if (meld.category === E.FIVE_CAT.STRAIGHT_FLUSH) {
    return !unseen.some((c) => c > meld.tiebreak && rankOf(c) >= 11);
  }
  if (meld.category === E.FIVE_CAT.FOUR_KIND) {
    // 只有更大的鐵支或同花順能壓
    const byRank = new Map();
    for (const c of unseen) byRank.set(rankOf(c), (byRank.get(rankOf(c)) || 0) + 1);
    for (const [r, n] of byRank) if (n === 4 && r > meld.tiebreak) return false;
    return meld.tiebreak >= 10; // K 以上的鐵支視為近似無敵
  }
  return false;
}

// ---------------------------------------------------------------------------
// 出牌決策
// ---------------------------------------------------------------------------

/**
 * @param {object} ctx
 *   hand           我的手牌
 *   current        場上最後一手 (identify 結果) 或 null (我開牌)
 *   playedCards    所有已打出的牌
 *   opponentCounts 其他三家剩餘張數 [n,n,n]
 *   isFirstPlay    是否為本局第一手（梅花3 只決定誰先出，不限制出什麼）
 *   rules
 * @returns {{action:'play', cards:number[]} | {action:'pass'}}
 */
function choosePlayHeuristic(ctx) {
  const { hand, current, playedCards = [], opponentCounts = [], isFirstPlay = false } = ctx;
  const rules = ctx.rules || E.DEFAULT_RULES;
  const unseen = unseenCards(hand, playedCards);
  const danger = opponentCounts.length ? Math.min(...opponentCounts) : 13;
  const partition = decompose(hand, rules);

  // 1. 一手打完就贏 → 直接打
  if (!current || true) {
    const whole = identify([...hand].sort((a, b) => a - b), rules);
    if (whole && (!current || beats(whole, current))) {
      if (!isFirstPlay || hand.includes(E.CLUB_THREE)) return { action: 'play', cards: [...hand] };
    }
  }

  if (!current) return leadPlay({ hand, partition, unseen, danger, isFirstPlay, rules });

  const options = legalPlays(hand, current, rules);
  if (!options.length) return { action: 'pass' };

  // 2. 打完這手就只剩一張且那張無敵 → 打
  for (const o of options) {
    if (hand.length - o.cards.length === 1) {
      const left = hand.find((c) => !o.cards.includes(c));
      if (isUnbeatable(identify([left], rules), unseen, rules)) {
        return { action: 'play', cards: o.cards };
      }
    }
  }

  // 3. 評估每個選項的成本
  const partitionKeys = new Set(partition.melds.map((m) => m.cards.join(',')));
  const scored = options.map((o) => {
    const key = [...o.cards].sort((a, b) => a - b).join(',');
    const inPartition = partitionKeys.has(key);
    const after = decompose(hand.filter((c) => !o.cards.includes(c)), rules);
    let cost = after.melds.length * 10;         // 出完之後還要幾手
    if (!inPartition) cost += 8;                 // 拆牌懲罰
    cost += o.meld.tiebreak / 60;                // 同條件下出小的
    if (o.cards.includes(E.SPADE_TWO) && danger > 2) cost += 25; // 黑桃2 留著
    if (o.meld.size === 5 && o.meld.category >= E.FIVE_CAT.FOUR_KIND && danger > 2) cost += 20;
    return { ...o, cost, inPartition };
  });
  scored.sort((a, b) => a.cost - b.cost);
  const best = scored[0];

  // 4. 危險狀態：有人剩 <= 2 張，一定要壓（拆牌也認了）
  if (danger <= 2) return { action: 'play', cards: best.cards };

  // 5. 我快贏了（<=5 張）→ 積極
  if (hand.length <= 5) return { action: 'play', cards: best.cards };

  // 6. 一般情況：手數不變才出，否則 pass 留實力
  const baseHands = partition.melds.length;
  const afterHands = decompose(hand.filter((c) => !best.cards.includes(c)), rules).melds.length;
  if (afterHands < baseHands || best.inPartition) return { action: 'play', cards: best.cards };
  if (best.meld.tiebreak < 28 && best.meld.size <= 2) return { action: 'play', cards: best.cards };
  return { action: 'pass' };
}

/** 我開牌（新的一輪） */
function leadPlay({ hand, partition, unseen, danger, isFirstPlay, rules }) {
  const melds = [...partition.melds];

  // §C 第一手不再需要含梅花3。不過持梅花3 的人開牌時，
  // 順手把它帶出去仍然划算——它是全場最小的一張，留著只會變成累贅。
  if (isFirstPlay) {
    const withThree = melds.filter((m) => m.cards.includes(E.CLUB_THREE));
    if (withThree.length) {
      withThree.sort((a, b) => b.meld.size - a.meld.size); // 順便清掉最多牌
      return { action: 'play', cards: withThree[0].cards };
    }
    return { action: 'play', cards: [E.CLUB_THREE] };
  }

  // 控場：無敵手數 >= 總手數 → 一路清光，從無敵的大牌開始砸
  const unbeatableCount = melds.filter((m) => isUnbeatable(m.meld, unseen, rules)).length;
  if (unbeatableCount >= melds.length) {
    melds.sort((a, b) => b.meld.size - a.meld.size);
    return { action: 'play', cards: melds[0].cards };
  }

  // ── 封鎖：有人只剩 1~2 張 ────────────────────────────────────────────
  // 這是大老二殘局最值錢的一條。剩 1 張的人只能出單張，剩 2 張的人最多出對子，
  // 而炸彈要五張——所以我開一手「張數比他多」的牌，他 100% 接不上，
  // 主動權還是留在我這邊。有這種牌就一定要出，比出「大牌」有用得多。
  if (danger <= 2) {
    const blocking = melds.filter((m) => m.meld.size > danger);
    if (blocking.length) {
      // 張數夠就好，優先花掉最便宜的那一手，大牌留著
      blocking.sort((a, b) => a.meld.size - b.meld.size
        || strengthOf(a.meld) - strengthOf(b.meld));
      return { action: 'play', cards: blocking[0].cards };
    }
    // 沒有那種牌型，退而求其次：出他壓不過的大牌
    const strong = melds.filter((m) => isUnbeatable(m.meld, unseen, rules));
    if (strong.length) {
      strong.sort((a, b) => a.meld.size - b.meld.size);
      return { action: 'play', cards: strong[0].cards };
    }
  }

  // 一般：先倒張數多、點數小的（順子/葫蘆優先，清得快）
  melds.sort((a, b) => {
    if (b.meld.size !== a.meld.size) return b.meld.size - a.meld.size;
    return a.meld.tiebreak - b.meld.tiebreak;
  });
  const small = melds.filter((m) => !m.cards.includes(E.SPADE_TWO));
  return { action: 'play', cards: (small[0] || melds[0]).cards };
}

// ---------------------------------------------------------------------------
// 盧家玩法：換牌階段
// ---------------------------------------------------------------------------

/**
 * 決定要蓋幾張、蓋哪幾張。策略：丟掉拆解後最沒用的孤張。
 *
 * CIO 規則：梅花3 永遠不蓋。它決定誰先開牌 —— 拿著它等於握有這一局的先手，
 * 高手不會把主動權丟進換牌堆裡。
 */
function chooseDiscards(hand, maxCount = 8, rules = E.DEFAULT_RULES) {
  const keep = (c) => c !== E.CLUB_THREE;
  const partition = decompose(hand, rules);
  const singles = partition.melds
    .filter((m) => m.meld.size === 1)
    .map((m) => m.cards[0])
    .filter(keep)
    .sort((a, b) => a - b);

  // 只丟 10 以下的孤張；若孤張太少，補丟最小的對子拆牌
  const junk = singles.filter((c) => rankOf(c) <= 7); // 3..10
  let picks = junk.slice(0, maxCount);
  if (picks.length < 2) {
    const lowest = [...hand].filter(keep).sort((a, b) => a - b).slice(0, 3);
    picks = [...new Set([...picks, ...lowest])].slice(0, maxCount);
  }
  return picks.filter(keep);
}

/** 從公共牌堆抽牌時的偏好（牌都是蓋著的，只能挑「誰丟的」）——一律隨機 */
function choosePickIndex(available, rng = Math.random) {
  return Math.floor(rng() * available.length);
}

// ---------------------------------------------------------------------------
// 盧家玩法：對賭
// ---------------------------------------------------------------------------

/** 手牌強度 0..100 */
function handStrength(hand, rules = E.DEFAULT_RULES) {
  const p = decompose(hand, rules);
  let s = 100 - p.melds.length * 9;
  if (hand.includes(E.SPADE_TWO)) s += 12;
  const twos = hand.filter((c) => rankOf(c) === 12).length;
  s += twos * 5;
  const bombs = p.melds.filter((m) => m.meld.size === 5 && m.meld.category >= 4).length;
  s += bombs * 10;
  const junk = hand.filter((c) => rankOf(c) <= 2).length;
  s -= junk * 2;
  return Math.max(0, Math.min(100, s));
}

/**
 * 要不要主動宣告對賭？
 * 數學上：贏拿三倍、輸賠十倍，而且手牌要攤開讓三家針對你。
 * 粗算大約要有 5 成以上勝率才划算（一般基準只有 25%），所以門檻很高。
 */
function shouldDeclareBet(hand, rules = E.DEFAULT_RULES) {
  const p = decompose(hand, rules);
  const strength = handStrength(hand, rules);
  const hasBomb = p.melds.some((m) => m.meld.size === 5 && m.meld.category >= E.FIVE_CAT.FOUR_KIND);
  if (strength < 70) return false;                      // 便宜的預篩，省得每副都跑推演
  let wp = 0.25;
  try { wp = module.exports.winProbability(hand, rules, 140); } catch (e) { /* 退回下面的門檻 */ }
  // 攤牌之後三家會針對你打，實際勝率會比推演出來的低一截，所以門檻拉高。
  return wp >= 0.55 && p.melds.length <= 6 && (hand.includes(E.SPADE_TWO) || hasBomb);
}

/**
 * 別人宣告對賭，我要不要答應？
 *
 * 答應的好處：他攤牌，三家看得到他的每一張，而且他輸要賠十倍。
 * 答應的壞處：他贏的話，我要付三倍。
 * 所以真正要問的是「我擋不擋得住他」——手上有沒有黑桃2、炸彈、
 * 還有推演出來的自身勝率。
 */
function shouldAcceptBet(hand, rules = E.DEFAULT_RULES) {
  const p = decompose(hand, rules);
  const hasBomb = p.melds.some((m) => m.meld.size === 5 && m.meld.category >= E.FIVE_CAT.FOUR_KIND);
  if (hand.includes(E.SPADE_TWO) || hasBomb) return true;   // 有煞車，賭他倒
  let wp = 0.25;
  try { wp = module.exports.winProbability(hand, rules, 100); } catch (e) { wp = handStrength(hand, rules) / 200; }
  return wp >= 0.30;
}

/** 對外的出牌決策：優先用蒙地卡羅高手，資訊不足或出錯時退回啟發式 */
function choosePlay(ctx) {
  try { return module.exports.choosePlayMC(ctx); }
  catch (err) { return choosePlayHeuristic(ctx); }
}

module.exports = {
  decompose, scorePartition, unseenCards, isUnbeatable,
  choosePlay, choosePlayHeuristic, chooseDiscards, choosePickIndex,
  handStrength, shouldDeclareBet, shouldAcceptBet,
};

// ---------------------------------------------------------------------------
// 該不該抓（§O、§K）
// ---------------------------------------------------------------------------

/**
 * 電腦要不要抓上一手。
 *
 * §K 資訊防火牆：這裡只准看「那一手打出來的牌」和「當時桌上要壓的那一手」，
 * 兩者在當下都是公開的。不准碰 challenge.legal、不准碰別人的手牌、
 * 不准碰蓋起來的換牌。電腦跟真人一樣，是自己重算一次規則。
 */
function shouldChallenge(challenge, rules) {
  if (!challenge) return false;
  const { cards, priorCurrent, priorIsNewRound } = challenge;

  const meld = E.identify(cards, rules);
  if (!meld) return true;                       // 根本不成牌型
  if (priorIsNewRound || !priorCurrent) return false;   // 開牌，怎麼出都行
  if (meld.size !== priorCurrent.size) return true;     // 張數不對
  if (!E.beats(meld, priorCurrent)) return true;        // 壓不過
  return false;
}

module.exports.shouldChallenge = shouldChallenge;

// ═══════════════════════════════════════════════════════════════════════════
//  進階電腦玩家 — 完全資訊蒙地卡羅 (PIMC)
//
//  跟橋牌那邊的高手是同一套技術：
//    1. 取樣：把「還沒現身的牌」依照每家剩幾張，隨機發成一個可能的牌局。
//       同時用「他剛剛 PASS 掉什麼」倒推 —— 壓得過卻不壓，通常代表他沒有。
//    2. 推演：每個候選出法，各在這些假想牌局裡打到底，用真實的結算公式算輸贏。
//    3. 決策：取平均期望值最高的一手。看到的是整盤的錢，不是眼前這一墩。
//
//  推演用「快速拆解 + 照拆解出牌」的策略，四家對稱，所以比較出來的優劣可信；
//  同時夠快，一次決策幾百盤推演只要幾十毫秒。
// ═══════════════════════════════════════════════════════════════════════════

const MC = {
  samples:  parseInt(process.env.DL_MC_SAMPLES || '80', 10),
  maxCands: parseInt(process.env.DL_MC_CANDS   || '12', 10),
  budgetMs: parseInt(process.env.DL_THINK      || '250', 10),
  followProb: parseFloat(process.env.DL_MC_FOLLOW || '1'),   // 推演時「壓得過就壓」的機率
  engageAt: parseInt(process.env.DL_MC_ENGAGE || '52', 10),   // 全桌剩幾張以內才推演（52 = 全程都推）
  margin:   parseFloat(process.env.DL_MC_MARGIN || '0.4'),    // 要贏啟發式多少才敢改
};

const LADDER = [
  [11, 12, 0, 1, 2], [12, 0, 1, 2, 3], [0, 1, 2, 3, 4], [1, 2, 3, 4, 5],
  [2, 3, 4, 5, 6], [3, 4, 5, 6, 7], [4, 5, 6, 7, 8], [5, 6, 7, 8, 9],
  [6, 7, 8, 9, 10], [7, 8, 9, 10, 11],
];

function byRank(cards) {
  const m = new Map();
  for (const c of cards) {
    const r = rankOf(c);
    if (!m.has(r)) m.set(r, []);
    m.get(r).push(c);
  }
  return m;
}

/** 從手上挑一組五張（順子 → 葫蘆 → 同花 → 鐵支）。找不到回 null。 */
function pickFive(cards, rules) {
  const ranks = byRank(cards);
  // 順子：從最小的階梯開始，先把爛牌清掉
  for (const seq of LADDER) {
    if (!seq.every((r) => ranks.has(r))) continue;
    const pick = seq.map((r) => ranks.get(r)[0]);
    const meld = identify([...pick].sort((a, b) => a - b), rules);
    if (meld) return { cards: [...pick].sort((a, b) => a - b), meld };
  }
  // 葫蘆
  const triples = [...ranks.entries()].filter(([, cs]) => cs.length >= 3).map(([r]) => r).sort((a, b) => a - b);
  const pairs = [...ranks.entries()].filter(([, cs]) => cs.length >= 2).map(([r]) => r).sort((a, b) => a - b);
  for (const t of triples) {
    const p = pairs.find((x) => x !== t);
    if (p === undefined) continue;
    const pick = [...ranks.get(t).slice(0, 3), ...ranks.get(p).slice(0, 2)].sort((a, b) => a - b);
    const meld = identify(pick, rules);
    if (meld) return { cards: pick, meld };
  }
  // 同花
  const bySuit = [[], [], [], []];
  for (const c of cards) bySuit[suitOf(c)].push(c);
  for (const s of bySuit) {
    if (s.length < 5) continue;
    const pick = [...s].sort((a, b) => a - b).slice(0, 5);
    const meld = identify(pick, rules);
    if (meld) return { cards: pick, meld };
  }
  // 鐵支（＋最小的墊張）
  for (const [r, cs] of ranks) {
    if (cs.length < 4) continue;
    const kicker = cards.find((c) => rankOf(c) !== r);
    if (kicker === undefined) continue;
    const pick = [...cs.slice(0, 4), kicker].sort((a, b) => a - b);
    const meld = identify(pick, rules);
    if (meld) return { cards: pick, meld };
  }
  return null;
}

/**
 * 便宜版拆解：推演時用，不做束搜尋。
 * 抽五張牌型的順序會影響結果，所以兩種順序都跑一次，取「手數比較少」的那個。
 * 手數＝要幾輪才出得完，是大老二最重要的一個數字。
 */
function partitionOnce(hand, fivesFirst, rules) {
  let remain = [...hand].sort((a, b) => a - b);
  const melds = [];
  const takeGroups = () => {
    for (const size of [3, 2]) {
      for (;;) {
        const ranks = byRank(remain);
        let best = null;
        for (const [r, cs] of ranks) { if (cs.length < size) continue; if (best === null || r < best) best = r; }
        if (best === null) break;
        const pick = ranks.get(best).slice(0, size);
        const meld = identify(pick, rules);
        const used = new Set(pick);
        remain = remain.filter((c) => !used.has(c));
        if (meld) melds.push({ cards: pick, meld });
      }
    }
  };
  const takeFives = () => {
    for (let k = 0; k < 2 && remain.length >= 5; k++) {
      const f = pickFive(remain, rules);
      if (!f) break;
      const used = new Set(f.cards);
      remain = remain.filter((c) => !used.has(c));
      melds.push(f);
    }
  };
  if (fivesFirst) { takeFives(); takeGroups(); } else { takeGroups(); takeFives(); }
  for (const c of remain) melds.push({ cards: [c], meld: identify([c], rules) });
  return melds;
}

function quickPartition(hand, rules = E.DEFAULT_RULES) {
  const a = partitionOnce(hand, true, rules);
  const b = partitionOnce(hand, false, rules);
  return (b.length < a.length) ? b : a;
}

/**
 * 一手牌的「強度」——用來排序，數字越大越難得。
 * 直接用 meld.tiebreak 不行：順子跟同花的 tiebreak 是 0（它們用 key 陣列比），
 * 那會讓推演誤以為順子是最爛的一手，一開局就把它倒出去。
 */
function strengthOf(m) {
  if (!m) return 0;
  if (m.size === 1 || m.size === 2) return m.tiebreak;              // 0..51
  if (m.size === 3) return m.tiebreak * 4 + 3;
  const base = 60 + (m.category || 0) * 24;
  const key = m.key ? (m.key[1] !== undefined ? m.key[1] : m.key[0]) : (m.tiebreak || 0) * 4;
  return base + key / 4;
}

function rolloutPick(parts, current, rng, rules, myCards, minOppCards) {
  if (!parts.length) return null;
  if (parts.length === 1) {                       // 只剩一手：能出就出
    return (!current || beats(parts[0].meld, current)) ? parts[0] : null;
  }
  if (!current) {
    // 開牌：先倒張數多的（一次清五張遠比一張一張丟快），同張數再挑點數小的。
    // 有人只剩 1~2 張時，改出「張數比他多」的牌 —— 他一定接不上。
    let best = null, bestKey = null;
    for (const m of parts) {
      if (m.meld.size === 1 && m.cards[0] === E.SPADE_TWO && parts.length > 1) continue;  // 控場牌留著
      const block = (minOppCards <= 2 && m.meld.size > minOppCards) ? 1 : 0;
      const key = [block, m.meld.size, -strengthOf(m.meld)];
      if (!bestKey || key[0] > bestKey[0]
        || (key[0] === bestKey[0] && key[1] > bestKey[1])
        || (key[0] === bestKey[0] && key[1] === bestKey[1] && key[2] > bestKey[2])) {
        bestKey = key; best = m;
      }
    }
    return best || parts[0];
  }
  let best = null, bestScore = Infinity;
  for (const m of parts) {
    if (!beats(m.meld, current)) continue;
    const sc = strengthOf(m.meld);
    if (sc < bestScore) { bestScore = sc; best = m; }
  }

  // 拆牌：拆解裡沒有現成的一手壓得過，但手上其實有便宜的牌可以拿下這一墩。
  // 一直 PASS 等於把主動權送人，真人高手不會這樣打。只拆便宜的（J 以下），
  // 而且只在對方出的是單張、對子時才拆——為了一墩拆掉五張牌型是虧的。
  if (!best && current.size <= 2) {
    for (const m of parts) {
      if (m.meld.size <= current.size) continue;
      for (const c of m.cards) {
        if (current.size === 1) {
          const one = identify([c], rules);
          if (one && beats(one, current) && strengthOf(one) <= 34) {
            const sc = strengthOf(one);
            if (sc < bestScore) { bestScore = sc; best = { cards: [c], meld: one, __split: m }; }
          }
        }
      }
      if (current.size === 2 && m.meld.size >= 3 && m.meld.size !== 5) {
        const two = identify(m.cards.slice(0, 2).sort((a, b) => a - b), rules);
        if (two && beats(two, current) && strengthOf(two) <= 38) {
          const sc = strengthOf(two);
          if (sc < bestScore) { bestScore = sc; best = { cards: m.cards.slice(0, 2), meld: two, __split: m }; }
        }
      }
    }
  }
  if (!best) return null;

  // 壓不壓？只有「用炸彈去換一墩小牌」這種明顯虧本的事才忍住。
  if (minOppCards <= 3 || myCards <= 6) return best;
  if (best.meld.size >= 5 && best.meld.category >= E.FIVE_CAT.FOUR_KIND) return rng() < 0.2 ? best : null;
  if (best.cards.length === 1 && best.cards[0] === E.SPADE_TWO) return rng() < 0.25 ? best : null;
  return rng() < MC.followProb ? best : null;
}

/**
 * 把一個假想牌局打到底，回傳「我」的期望金額（以張數計，跟 _settle 同一套）。
 *   贏：三家各賠自己剩的張數（一張都沒出過的賠雙倍）
 *   輸：自己賠自己剩的張數（同樣可能雙倍）
 */
function rollout(hands, parts, turn, current, passesInARow, lastPlayer, mySeat, played, rng, rules) {
  const counts = hands.map((h) => h.length);
  const everPlayed = played.slice();
  let cur = current, pir = passesInARow, lp = lastPlayer, t = turn;

  for (let step = 0; step < 400; step++) {
    let minOpp = 99;
    for (let s = 0; s < 4; s++) if (s !== t && counts[s] < minOpp) minOpp = counts[s];
    const pick = rolloutPick(parts[t], cur, rng, rules, counts[t], minOpp);
    if (pick) {
      if (pick.__split) {
        const src = pick.__split;
        const used = new Set(pick.cards);
        const left = src.cards.filter((c) => !used.has(c));
        parts[t] = parts[t].filter((m) => m !== src);
        for (const c of left) parts[t].push({ cards: [c], meld: identify([c], rules) });
      } else {
        parts[t] = parts[t].filter((m) => m !== pick);
      }
      counts[t] -= pick.cards.length;
      everPlayed[t] = true;
      cur = pick.meld; lp = t; pir = 0;
      if (counts[t] <= 0) return settleValue(counts, everPlayed, t, mySeat);
    } else {
      if (!cur) {                     // 開牌卻沒得出 = 手上空了
        return settleValue(counts, everPlayed, t, mySeat);
      }
      pir++;
      if (pir >= 3) { cur = null; t = lp; pir = 0; continue; }
    }
    t = (t + 1) % 4;
  }
  // 推演卡住（理論上不會）：當作沒人贏，用剩牌數估個大概
  const me = counts[mySeat];
  const others = counts.reduce((a, n, i) => a + (i === mySeat ? 0 : n), 0);
  return (others / 3) - me;
}

function settleValue(counts, everPlayed, winner, mySeat) {
  const pts = (s) => Math.max(0, counts[s]) * (everPlayed[s] ? 1 : 2);
  if (winner === mySeat) {
    let sum = 0;
    for (let s = 0; s < 4; s++) if (s !== mySeat) sum += pts(s);
    return sum;
  }
  return -pts(mySeat);
}

/**
 * 取樣：把還沒現身的牌發給另外三家。
 * 用「他 PASS 掉什麼」倒推 —— 壓得過卻不壓，通常代表他手上沒有。
 * 留一點寬容度（高手本來就會扣著牌不出），所以只擋明顯矛盾的樣本。
 */
function sampleLayout(mySeat, myHand, counts, unseen, passInfo, rules, rng) {
  const need = [];
  for (let s = 0; s < 4; s++) need[s] = (s === mySeat) ? 0 : counts[s];
  if (need.reduce((a, b) => a + b, 0) !== unseen.length) return null;

  for (let attempt = 0; attempt < 24; attempt++) {
    const pool = [...unseen];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const hands = [[], [], [], []];
    hands[mySeat] = [...myHand];
    let k = 0;
    for (let s = 0; s < 4; s++) {
      if (s === mySeat) continue;
      hands[s] = pool.slice(k, k + need[s]).sort((a, b) => a - b);
      k += need[s];
    }
    if (attempt >= 20) return hands;              // 放棄挑剔，先給一個
    let bad = 0;
    for (let s = 0; s < 4; s++) {
      if (s === mySeat) continue;
      const declined = passInfo[s];
      if (!declined || !declined.length) continue;
      for (const d of declined) {
        if (d.size === 1) {
          if (hands[s].some((c) => c > d.tiebreakCard)) { bad++; break; }
        } else if (d.size === 2) {
          const r = byRank(hands[s]);
          let hit = false;
          for (const [rank, cs] of r) if (cs.length >= 2 && rank > d.rank) { hit = true; break; }
          if (hit) { bad++; break; }
        }
      }
    }
    if (bad <= 1) return hands;                    // 容許一次「扣牌不出」
  }
  return null;
}

/** 候選出法：合法的牌 + （可以的話）PASS，去重、留最有代表性的幾個 */
function candidateMoves(hand, current, isNewRound, rules) {
  const opts = legalPlays(hand, current, rules)
    .map((o) => ({ cards: [...o.cards].sort((a, b) => a - b), meld: o.meld }));
  // 同「張數 + 牌型」只留點數最小與最大的兩個代表
  const buckets = new Map();
  for (const o of opts) {
    const key = o.meld.size + ':' + (o.meld.category || 0);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(o);
  }
  const picked = [];
  for (const arr of buckets.values()) {
    arr.sort((a, b) => (a.meld.tiebreak || 0) - (b.meld.tiebreak || 0) || a.cards[0] - b.cards[0]);
    picked.push(arr[0]);
    if (arr.length > 1) picked.push(arr[arr.length - 1]);
    if (arr.length > 3) picked.push(arr[Math.floor(arr.length / 2)]);
  }
  const seen = new Set();
  const out = [];
  for (const o of picked) {
    const k = o.cards.join(',');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ action: 'play', cards: o.cards, meld: o.meld });
  }
  // 一手出完就贏 —— 一定要在候選裡
  const whole = identify([...hand].sort((a, b) => a - b), rules);
  if (whole && (!current || beats(whole, current))) {
    const k = [...hand].sort((a, b) => a - b).join(',');
    if (!seen.has(k)) out.unshift({ action: 'play', cards: [...hand].sort((a, b) => a - b), meld: whole });
  }
  if (!isNewRound) out.push({ action: 'pass', cards: [] });
  return out.slice(0, MC.maxCands + 1);
}

/**
 * 進階出牌決策。
 * @param {object} ctx  同 choosePlay，另外可帶
 *   seat, counts[4], passInfo[4], passesInARow, lastPlayerSeat
 */
function choosePlayMC(ctx) {
  const rules = ctx.rules || E.DEFAULT_RULES;
  const rng = ctx.rng || Math.random;
  const hand = [...ctx.hand].sort((a, b) => a - b);
  const current = ctx.current || null;
  const isNewRound = !current;
  const mySeat = ctx.seat != null ? ctx.seat : 0;

  const cands = candidateMoves(hand, current, isNewRound, rules);
  if (!cands.length) return { action: 'pass' };
  if (cands.length === 1) {
    return cands[0].action === 'pass' ? { action: 'pass' } : { action: 'play', cards: cands[0].cards };
  }

  // 一手打完就贏：不必推演
  if (cands[0].action === 'play' && cands[0].cards.length === hand.length) {
    return { action: 'play', cards: cands[0].cards };
  }

  const counts = ctx.counts || [];
  const played = ctx.playedCards || [];
  const passInfo = ctx.passInfo || [[], [], [], []];
  const everPlayed = ctx.everPlayed || [true, true, true, true];
  const unseen = unseenCards(hand, played);
  const totalNeed = counts.reduce((a, n, i) => a + (i === mySeat ? 0 : n), 0);

  // 資訊不足（舊呼叫端）→ 退回啟發式
  if (counts.length !== 4 || totalNeed !== unseen.length) return choosePlayHeuristic(ctx);

  // 開局階段未知太多，取樣出來的牌局跟真的差很遠，推演只會加雜訊；
  // 這時候相信規劃型的啟發式。等牌打得差不多、可能性收斂了，推演才真的看得準。
  const cardsLeft = counts.reduce((a, b) => a + b, 0);
  const base = choosePlayHeuristic(ctx);
  if (cardsLeft > MC.engageAt) return base;

  // 啟發式選的那一手一定要在候選裡，這樣「推演比較」才是公平的比較
  const baseKey = base.action === 'pass' ? 'PASS' : [...base.cards].sort((a, b) => a - b).join(',');
  let baseIdx = cands.findIndex((c) => (c.action === 'pass' ? 'PASS' : c.cards.join(',')) === baseKey);
  if (baseIdx < 0 && base.action === 'play') {
    const meld = identify([...base.cards].sort((a, b) => a - b), rules);
    if (meld) { cands.push({ action: 'play', cards: [...base.cards].sort((a, b) => a - b), meld }); baseIdx = cands.length - 1; }
  }
  if (baseIdx < 0) baseIdx = 0;

  const totals = cands.map(() => 0);
  let done = 0;
  const t0 = Date.now();
  for (let k = 0; k < MC.samples; k++) {
    const layout = sampleLayout(mySeat, hand, counts, unseen, passInfo, rules, rng);
    if (!layout) break;
    const baseParts = layout.map((h) => quickPartition(h, rules));
    for (let ci = 0; ci < cands.length; ci++) {
      const c = cands[ci];
      const hands = layout.map((h) => [...h]);
      const parts = baseParts.map((p) => p.slice());
      let cur = current, pir = ctx.passesInARow || 0, lp = ctx.lastPlayerSeat;
      const ep = everPlayed.slice();
      if (c.action === 'play') {
        const used = new Set(c.cards);
        hands[mySeat] = hands[mySeat].filter((x) => !used.has(x));
        parts[mySeat] = quickPartition(hands[mySeat], rules);
        cur = c.meld; lp = mySeat; pir = 0; ep[mySeat] = true;
        if (!hands[mySeat].length) {
          totals[ci] += settleValue(hands.map((h) => h.length), ep, mySeat, mySeat);
          continue;
        }
      } else {
        pir++;
      }
      let startTurn = (mySeat + 1) % 4;
      if (c.action === 'pass' && pir >= 3) {          // 我這一 PASS 收掉了這一輪
        cur = null; pir = 0;
        startTurn = (lp == null) ? (mySeat + 1) % 4 : lp;
      }
      totals[ci] += rollout(hands, parts, startTurn, cur, pir, lp == null ? mySeat : lp,
        mySeat, ep, rng, rules);
    }
    done++;
    if (Date.now() - t0 > MC.budgetMs && done >= 8) break;
  }
  if (done < 8) return base;

  // 只有推演的優勢夠明顯，才推翻啟發式的規劃。推演本身有雜訊，
  // 拿它去覆蓋一個本來就不錯的計畫，反而會變弱。
  let bi = baseIdx;
  for (let i = 0; i < cands.length; i++) {
    if (i === baseIdx) continue;
    if (totals[i] > totals[bi] + MC.margin * done) bi = i;
  }
  const best = cands[bi];
  return best.action === 'pass' ? { action: 'pass' } : { action: 'play', cards: best.cards };
}

/** 用蒙地卡羅估這副牌的勝率（開局用，還沒有任何公開資訊） */
function winProbability(hand, rules = E.DEFAULT_RULES, sims = 120, rng = Math.random) {
  const mine = [...hand].sort((a, b) => a - b);
  const unseen = unseenCards(mine, []);
  let wins = 0, n = 0;
  const t0 = Date.now();
  for (let k = 0; k < sims; k++) {
    const pool = [...unseen];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const hands = [mine, pool.slice(0, 13).sort((a, b) => a - b),
      pool.slice(13, 26).sort((a, b) => a - b), pool.slice(26, 39).sort((a, b) => a - b)];
    const parts = hands.map((h) => quickPartition(h, rules));
    const lead = hands.findIndex((h) => h.includes(E.CLUB_THREE));
    const v = rollout(hands.map((h) => [...h]), parts, lead < 0 ? 0 : lead, null, 0,
      lead < 0 ? 0 : lead, 0, [false, false, false, false], rng, rules);
    if (v > 0) wins++;
    n++;
    if (Date.now() - t0 > 400 && n >= 30) break;
  }
  return n ? wins / n : 0.25;
}

module.exports.quickPartition = quickPartition;
module.exports.choosePlayMC = choosePlayMC;
module.exports.winProbability = winProbability;
module.exports.MC = MC;

module.exports.__rolloutPick = rolloutPick;
module.exports.__strengthOf = strengthOf;
