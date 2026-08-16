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
function choosePlay(ctx) {
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

  // 有人快贏了 → 出大的卡住對手
  if (danger <= 2) {
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

/** 決定要蓋幾張、蓋哪幾張。策略：丟掉拆解後最沒用的孤張。 */
function chooseDiscards(hand, maxCount = 8, rules = E.DEFAULT_RULES) {
  const partition = decompose(hand, rules);
  const singles = partition.melds
    .filter((m) => m.meld.size === 1)
    .map((m) => m.cards[0])
    .sort((a, b) => a - b);

  // 只丟 10 以下的孤張；若孤張太少，補丟最小的對子拆牌
  const junk = singles.filter((c) => rankOf(c) <= 7); // 3..10
  let picks = junk.slice(0, maxCount);
  if (picks.length < 2) {
    const lowest = [...hand].sort((a, b) => a - b).slice(0, 3);
    picks = [...new Set([...picks, ...lowest])].slice(0, maxCount);
  }
  return picks;
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
  return strength >= 76 && p.melds.length <= 5 && (hand.includes(E.SPADE_TWO) || hasBomb);
}

/** 別人宣告對賭，我要不要答應？ */
function shouldAcceptBet(hand, rules = E.DEFAULT_RULES) {
  return handStrength(hand, rules) >= 45;
}

module.exports = {
  decompose, scorePartition, unseenCards, isUnbeatable,
  choosePlay, chooseDiscards, choosePickIndex,
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
