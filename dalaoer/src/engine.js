'use strict';
/**
 * 大老二 (Big Two) — 規則引擎
 * 純邏輯，無任何 I/O。可單獨測試。
 *
 * 牌的表示：整數 0..51
 *   rank = Math.floor(id / 4)   0..12  對應 3,4,5,6,7,8,9,10,J,Q,K,A,2
 *   suit = id % 4               0..3   對應 梅花, 方塊, 紅心, 黑桃 (由小到大)
 * 因此 id 本身就是單張大小的比較值：id 越大牌越大。
 *   梅花3 = 0，黑桃2 = 51
 */

const RANK_NAMES = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
const SUIT_NAMES = ['梅花', '方塊', '紅心', '黑桃'];
const SUIT_SYMBOLS = ['♣', '♦', '♥', '♠'];

const CLUB_THREE = 0;   // 梅花3
const SPADE_TWO = 51;   // 黑桃2

const rankOf = (c) => Math.floor(c / 4);
const suitOf = (c) => c % 4;
const cardName = (c) => SUIT_SYMBOLS[suitOf(c)] + RANK_NAMES[rankOf(c)];
const cardsName = (cs) => cs.map(cardName).join(' ');

/** 牌型代碼。同張數之間用 category 先比，再比 tiebreak。 */
const TYPE = {
  SINGLE: 'SINGLE',
  PAIR: 'PAIR',
  TRIPLE: 'TRIPLE',
  FIVE: 'FIVE',
};

/** 五張牌型的層級（越大越強） */
const FIVE_CAT = {
  STRAIGHT: 1,        // 順子
  FLUSH: 2,           // 同花
  FULL_HOUSE: 3,      // 葫蘆
  FOUR_KIND: 4,       // 鐵支
  STRAIGHT_FLUSH: 5,  // 同花順
};

const FIVE_CAT_NAMES = {
  1: '順子', 2: '同花', 3: '葫蘆', 4: '鐵支', 5: '同花順',
};

/**
 * CIO 定案（v1.5）：以下三件事不再是開關，而是規則本身。
 *   §C 梅花3 只決定誰先出，第一手不必包含梅花3
 *   §F 順子階梯 A2345 最小 … TJQKA 最大，JQKA2 不成順
 *   §G 同花先按點數由大到小逐張比，五張點數全同才比花色
 */
const DEFAULT_RULES = {};

/**
 * 順子階梯（§F）。索引就是強度，越後面越大。
 * 每一列是「由小到大」的 rank 序列，最後一個是有效最大張。
 */
const STRAIGHT_LADDER = [
  [11, 12, 0, 1, 2],      // A 2 3 4 5   最小，有效高張 = 5
  [12, 0, 1, 2, 3],       // 2 3 4 5 6   有效高張 = 6
  [0, 1, 2, 3, 4],        // 3 4 5 6 7
  [1, 2, 3, 4, 5],        // 4 5 6 7 8
  [2, 3, 4, 5, 6],        // 5 6 7 8 9
  [3, 4, 5, 6, 7],        // 6 7 8 9 10
  [4, 5, 6, 7, 8],        // 7 8 9 10 J
  [5, 6, 7, 8, 9],        // 8 9 10 J Q
  [6, 7, 8, 9, 10],       // 9 10 J Q K
  [7, 8, 9, 10, 11],      // 10 J Q K A  最大
];

// ---------------------------------------------------------------------------
// 牌型辨識
// ---------------------------------------------------------------------------

/**
 * 辨識一組牌的牌型。
 * @returns {null | {type, category, tiebreak, size, label}}  不合法回傳 null
 */
function identify(cards, rules = DEFAULT_RULES) {
  if (!Array.isArray(cards) || cards.length === 0) return null;
  const uniq = new Set(cards);
  if (uniq.size !== cards.length) return null;
  if (cards.some((c) => !Number.isInteger(c) || c < 0 || c > 51)) return null;

  const sorted = [...cards].sort((a, b) => a - b);
  const ranks = sorted.map(rankOf);
  const suits = sorted.map(suitOf);

  if (sorted.length === 1) {
    return { type: TYPE.SINGLE, category: 0, tiebreak: sorted[0], size: 1, label: '單張' };
  }

  if (sorted.length === 2) {
    if (ranks[0] !== ranks[1]) return null;
    // §D 先比點數，同點數才比對子裡最大的那張花色。
    // sorted[1] 已經是兩張裡的最大張，rank*4+suit 剛好就是這個順序。
    return { type: TYPE.PAIR, category: 0, tiebreak: sorted[1], size: 2, label: '對子' };
  }

  if (sorted.length === 3) {
    if (ranks[0] !== ranks[1] || ranks[1] !== ranks[2]) return null;
    // §D 三條只看點數；同點數的三條不可能同時存在（每個點數只有四張）
    return { type: TYPE.TRIPLE, category: 0, tiebreak: ranks[0], size: 3, label: '三條' };
  }

  if (sorted.length === 5) return identifyFive(sorted, ranks, suits, rules);

  return null; // 4 張、6 張以上皆不合法
}

function identifyFive(sorted, ranks, suits, rules) {
  const isFlush = suits.every((s) => s === suits[0]);
  const str = straightInfo(sorted, ranks);
  const isStraight = str !== null;

  // 依點數分組
  const counts = new Map();
  for (const r of ranks) counts.set(r, (counts.get(r) || 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  if (isStraight && isFlush) {
    return {
      // §F 同花順跟順子用同一套階梯
      type: TYPE.FIVE, category: FIVE_CAT.STRAIGHT_FLUSH,
      tiebreak: 0, key: [str.step, str.highCard], size: 5, label: '同花順',
    };
  }
  if (groups[0][1] === 4) {
    return {
      type: TYPE.FIVE, category: FIVE_CAT.FOUR_KIND,
      tiebreak: groups[0][0], size: 5, label: '鐵支',
    };
  }
  if (groups[0][1] === 3 && groups[1] && groups[1][1] === 2) {
    return {
      type: TYPE.FIVE, category: FIVE_CAT.FULL_HOUSE,
      tiebreak: groups[0][0], size: 5, label: '葫蘆',
    };
  }
  if (isFlush) {
    // §G 由大到小逐張比點數；五張點數完全一樣，才輪到花色。
    // key 是 [r1,r2,r3,r4,r5, suit]，用陣列比較，不壓成單一數字。
    const desc = [...ranks].sort((a, b) => b - a);
    return {
      type: TYPE.FIVE, category: FIVE_CAT.FLUSH,
      tiebreak: 0, key: [...desc, suits[0]], size: 5, label: '同花',
    };
  }
  if (isStraight) {
    return {
      type: TYPE.FIVE, category: FIVE_CAT.STRAIGHT,
      tiebreak: 0, key: [str.step, str.highCard], size: 5, label: '順子',
    };
  }
  return null;
}

/**
 * 判斷五張是否成順，回傳「用來比大小的最大張」的 card id；不成順回傳 null。
 * 預設 (straightUsesGameOrder) 照本局序 3,4,...,K,A,2 連續，不繞回。
 * 關閉時額外承認 A-2-3-4-5 與 2-3-4-5-6。
 */
/**
 * 比對 §F 的順子階梯。
 * @returns null（不成順）或 { step, highCard }
 *   step     階梯索引，越大越強
 *   highCard 有效最大張的 card id，同階梯時用它的花色分高下
 */
function straightInfo(sorted, ranks) {
  const set = new Set(ranks);
  if (set.size !== 5) return null;

  for (let step = 0; step < STRAIGHT_LADDER.length; step++) {
    const seq = STRAIGHT_LADDER[step];
    if (!seq.every((r) => set.has(r))) continue;
    const highRank = seq[seq.length - 1];
    const highCard = sorted.filter((c) => rankOf(c) === highRank).pop();
    return { step, highCard };
  }
  return null;   // JQKA2 之類的組合就掉在這裡
}

// ---------------------------------------------------------------------------
// 比大小
// ---------------------------------------------------------------------------

/** challenger 是否大得過 current（兩者皆為 identify() 的結果） */
/** 逐項比較兩個 key 陣列：>0 表示 a 大 */
function compareKey(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] === undefined ? -Infinity : a[i];
    const y = b[i] === undefined ? -Infinity : b[i];
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** challenger 是否大得過 current（兩者皆為 identify() 的結果） */
function beats(challenger, current) {
  if (!challenger) return false;
  if (!current) return true;
  if (challenger.size !== current.size) return false; // 張數必須相同
  if (challenger.type === TYPE.FIVE) {
    if (challenger.category !== current.category) return challenger.category > current.category;
    // 順子、同花順、同花用 key 陣列；葫蘆、鐵支只比一個點數
    if (challenger.key && current.key) return compareKey(challenger.key, current.key) > 0;
    return challenger.tiebreak > current.tiebreak;
  }
  return challenger.tiebreak > current.tiebreak;
}

// ---------------------------------------------------------------------------
// 發牌
// ---------------------------------------------------------------------------

function shuffledDeck(rng = Math.random) {
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function deal(rng = Math.random) {
  const deck = shuffledDeck(rng);
  const hands = [[], [], [], []];
  for (let i = 0; i < 52; i++) hands[i % 4].push(deck[i]);
  return hands.map((h) => h.sort((a, b) => a - b));
}

// ---------------------------------------------------------------------------
// 出牌合法性（供「嚴格模式」使用）
// ---------------------------------------------------------------------------

/**
 * 檢查一次出牌是否合法。
 * @param {object} ctx { hand, cards, current, isNewRound, rules }
 * @returns {{ok:true, meld} | {ok:false, reason:string}}
 */
function validatePlay({ hand, cards, current, isNewRound, rules = DEFAULT_RULES }) {
  const handSet = new Set(hand);
  if (!Array.isArray(cards) || cards.length === 0) return { ok: false, reason: '你沒有選牌' };
  if (!cards.every((c) => handSet.has(c))) return { ok: false, reason: '出的牌不在你手上' };
  // 同一張牌送兩次是資料壞掉，不是規則爭議 —— 寬鬆模式也一樣擋
  if (new Set(cards).size !== cards.length) return { ok: false, reason: '有重複的牌' };

  const meld = identify(cards, rules);
  if (!meld) return { ok: false, reason: '不是合法的牌型' };

  // §C 梅花3 只決定「誰先出」，第一手不必包含梅花3。
  // 原本的 V-3（第一手必須含梅花3）已由 CIO 取消。
  if (isNewRound) return { ok: true, meld };

  if (meld.size !== current.size) {
    return { ok: false, reason: `必須出 ${current.size} 張` };
  }
  if (!beats(meld, current)) {
    return { ok: false, reason: '牌不夠大' };
  }
  return { ok: true, meld };
}

// ---------------------------------------------------------------------------
// 找出手上所有能壓過 current 的組合（AI 與 UI 提示共用）
// ---------------------------------------------------------------------------

function combinations(arr, k) {
  const out = [];
  const pick = (start, acc) => {
    if (acc.length === k) { out.push([...acc]); return; }
    for (let i = start; i < arr.length; i++) {
      acc.push(arr[i]);
      pick(i + 1, acc);
      acc.pop();
    }
  };
  pick(0, []);
  return out;
}

/** 列出手牌中所有合法的 n 張牌型（n = 1,2,3,5） */
function allMelds(hand, size, rules = DEFAULT_RULES) {
  const out = [];
  if (size === 1) {
    for (const c of hand) out.push({ cards: [c], meld: identify([c], rules) });
    return out;
  }
  if (size === 2 || size === 3) {
    const byRank = new Map();
    for (const c of hand) {
      const r = rankOf(c);
      if (!byRank.has(r)) byRank.set(r, []);
      byRank.get(r).push(c);
    }
    for (const group of byRank.values()) {
      if (group.length < size) continue;
      for (const combo of combinations(group, size)) {
        const m = identify(combo, rules);
        if (m) out.push({ cards: combo, meld: m });
      }
    }
    return out;
  }
  if (size === 5) {
    if (hand.length > 22) return out; // 安全閥，正常手牌 <=13
    for (const combo of combinations([...hand].sort((a, b) => a - b), 5)) {
      const m = identify(combo, rules);
      if (m) out.push({ cards: combo, meld: m });
    }
    return out;
  }
  return out;
}

/** 所有能壓過 current 的出法；current 為 null 時代表新一輪，回傳所有合法牌型 */
function legalPlays(hand, current, rules = DEFAULT_RULES) {
  const sizes = current ? [current.size] : [1, 2, 3, 5];
  const out = [];
  for (const s of sizes) {
    for (const cand of allMelds(hand, s, rules)) {
      if (!current || beats(cand.meld, current)) out.push(cand);
    }
  }
  return out;
}

module.exports = {
  RANK_NAMES, SUIT_NAMES, SUIT_SYMBOLS, CLUB_THREE, SPADE_TWO,
  TYPE, FIVE_CAT, FIVE_CAT_NAMES, DEFAULT_RULES,
  rankOf, suitOf, cardName, cardsName,
  identify, beats, compareKey, straightInfo, STRAIGHT_LADDER, deal, shuffledDeck,
  validatePlay, legalPlays, allMelds, combinations,
};
