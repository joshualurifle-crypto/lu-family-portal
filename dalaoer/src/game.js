'use strict';
/**
 * 大老二 單局狀態機
 * 支援：標準玩法 + 盧家玩法（開局換牌、對賭）
 *
 * 階段流程
 *   SWAP_SELECT  盧家玩法：四家各自蓋牌（同時進行）
 *   SWAP_PICK    依蓋牌張數由多到少輪流抽回（同張數猜拳）
 *   BET_DECLARE  是否有人宣告對賭（同時進行）
 *   BET_RESPOND  其餘三家表態，須全數同意
 *   PLAYING      正式出牌
 *   FINISHED     結算
 */

const E = require('./engine');

const PHASE = {
  SWAP_SELECT: 'SWAP_SELECT',
  SWAP_DICE: 'SWAP_DICE',                     // §N 蓋牌張數相同 → 當眾擲骰子
  SWAP_PICK: 'SWAP_PICK',
  BET_DECLARE: 'BET_DECLARE',
  BET_RESPOND: 'BET_RESPOND',
  PLAYING: 'PLAYING',
  PROVISIONAL_FINISH: 'PROVISIONAL_FINISH',   // §P 有人出完，但還沒三家確認
  FINISHED: 'FINISHED',
};

const DEFAULT_OPTIONS = {
  luMode: false,          // 盧家玩法（換牌 + 對賭）
  strictMode: true,       // 嚴格模式：自動擋掉不合法出牌
  pointValue: 5,          // 一分多少錢
  // §I 沒有任何倒數。玩家想想多久都可以；真的不在了，
  //    其他還在線上的人「全體同意」才能換電腦或收掉這一局。
  maxDiscard: 13,         // 換牌階段最多蓋幾張
  betWinMultiplier: 3,    // 對賭成功，三家各付幾倍
  betLoseMultiplier: 10,  // 對賭失敗，賭家付贏家幾倍
  blankMultiplier: 2,     // 整局一張都沒出過（白板），賠雙倍
  rules: E.DEFAULT_RULES,
};

class Game {
  /**
   * @param {string[]} playerNames 四個名字
   * @param {object} options
   * @param {function} rng
   */
  constructor(playerNames, options = {}, rng = Math.random) {
    this.players = playerNames.slice(0, 4);
    this.opt = { ...DEFAULT_OPTIONS, ...options };
    this.rng = rng;
    this.log = [];

    this.hands = E.deal(rng);
    this.playedCards = [];
    // 誰 PASS 掉了什麼（電腦取樣時用來倒推別人手上有沒有）
    this.passLog = [[], [], [], []];
    this.history = [];          // 這一局出過的每一手：{seat, cards, label, trick}
    this.trickNo = 1;
    this.current = null;        // 場上最後一手 (identify 結果)
    this.currentCards = [];
    this.lastPlayerSeat = null;
    this.trickWonBy = null;     // §B2 上一墩是誰贏的（桌面留著給大家看）
    this.passed = [false, false, false, false];
    this.turn = null;
    this.isFirstPlay = true;
    this.winner = null;
    this.settlement = null;

    // 換牌階段
    this.discards = [null, null, null, null];   // 每家蓋出的牌
    this.pool = [];                             // {owner, card, taken}
    this.pickOrder = [];
    this.pickIndex = 0;
    this.picksRemaining = 0;
    this.rpsResults = null;

    // 對賭
    this.bet = null;   // {declarer, responses:{seat:bool}, accepted:bool|null}

    // 抓牌（寬鬆模式）：最後一手的快照。沒有倒數，只由事件關閉（§O）
    this.challenge = null;   // {seat, cards, legal, snapshot}

    // §P 出完牌只是「暫定結束」，要三家都確認才算數
    this.provisional = null; // {winner, confirmed:{seat:true}}

    this.phase = this.opt.luMode ? PHASE.SWAP_SELECT : PHASE.BET_DECLARE;
    if (!this.opt.luMode) this._skipBetPhase();
  }

  _skipBetPhase() {
    // 標準玩法沒有對賭，直接開打
    this.phase = PHASE.PLAYING;
    this.turn = this._clubThreeHolder();
  }

  _clubThreeHolder() {
    return this.hands.findIndex((h) => h.includes(E.CLUB_THREE));
  }

  // -------------------------------------------------------------------------
  // 換牌階段
  // -------------------------------------------------------------------------

  /** 某家蓋牌。全部四家都交出後自動進入 SWAP_PICK。 */
  submitDiscards(seat, cards) {
    if (this.phase !== PHASE.SWAP_SELECT) return { ok: false, reason: '現在不是換牌階段' };
    if (this.discards[seat]) return { ok: false, reason: '你已經蓋過牌了' };
    const handSet = new Set(this.hands[seat]);
    if (!cards.every((c) => handSet.has(c))) return { ok: false, reason: '蓋的牌不在你手上' };
    if (new Set(cards).size !== cards.length) return { ok: false, reason: '有重複的牌' };
    if (cards.length > this.opt.maxDiscard) return { ok: false, reason: `最多只能蓋 ${this.opt.maxDiscard} 張` };

    this.discards[seat] = [...cards];
    this.hands[seat] = this.hands[seat].filter((c) => !cards.includes(c));
    this.log.push(`${this.players[seat]} 蓋了 ${cards.length} 張`);

    if (this.discards.every((d) => d !== null)) this._buildPool();
    return { ok: true };
  }

  _buildPool() {
    this.pool = [];
    for (let seat = 0; seat < 4; seat++) {
      for (const card of this.discards[seat]) {
        this.pool.push({ owner: seat, card, taken: false });
      }
    }
    // §L 交出來的那一刻洗一次，位置就固定了，之後不再洗。
    // 洗完連本人都認不出哪張是哪張。
    this._shufflePoolWithinOwners();

    this.diceRolls = {};        // {seat: 點數}
    this.diceNeeded = [];       // 還要擲的人
    this._resolvePickOrder();
  }

  /** 蓋的張數一樣多的人，要當眾擲骰子分先後（§N） */
  _tiedGroups() {
    const counts = [0, 1, 2, 3].map((s) => this.discards[s].length);
    const groups = new Map();
    for (let s = 0; s < 4; s++) {
      if (counts[s] === 0) continue;
      const bucket = groups.get(counts[s]) || [];
      bucket.push(s);
      groups.set(counts[s], bucket);
    }
    return [...groups.values()].filter((g) => g.length > 1);
  }

  _resolvePickOrder() {
    const counts = [0, 1, 2, 3].map((s) => this.discards[s].length);

    // 還有哪些人沒擲，或擲出來還是平手？
    const needRoll = [];
    for (const group of this._tiedGroups()) {
      const rolled = group.filter((s) => this.diceRolls[s] !== undefined);
      if (rolled.length < group.length) {
        needRoll.push(...group.filter((s) => this.diceRolls[s] === undefined));
        continue;
      }
      // 全擲完了，看看有沒有人點數一樣 → 只有那幾個人重擲
      const byValue = new Map();
      for (const s of group) {
        const v = this.diceRolls[s];
        byValue.set(v, [...(byValue.get(v) || []), s]);
      }
      for (const same of byValue.values()) {
        if (same.length > 1) {
          same.forEach((s) => { delete this.diceRolls[s]; });
          needRoll.push(...same);
        }
      }
    }

    if (needRoll.length) {
      this.diceNeeded = needRoll;
      this.phase = PHASE.SWAP_DICE;
      return;
    }

    this.diceNeeded = [];
    this.pickOrder = [0, 1, 2, 3]
      .filter((s) => counts[s] > 0)
      .sort((a, b) => counts[b] - counts[a] || (this.diceRolls[b] || 0) - (this.diceRolls[a] || 0));

    this.pickIndex = 0;
    if (!this.pickOrder.length) return this._finishSwap();
    this.picksRemaining = this.discards[this.pickOrder[0]].length;
    this.phase = PHASE.SWAP_PICK;
  }

  /** 自己按下「擲骰子」。點數大的先抽。 */
  rollDice(seat) {
    if (this.phase !== PHASE.SWAP_DICE) return { ok: false, reason: '現在不用擲骰子' };
    if (!this.diceNeeded.includes(seat)) return { ok: false, reason: '不用你擲' };
    const value = 1 + Math.floor(this.rng() * 6);
    this.diceRolls[seat] = value;
    this.log.push(`${this.players[seat]} 擲出 ${value} 點`);
    this._resolvePickOrder();
    return { ok: true, value };
  }

  _shufflePoolWithinOwners() {
    for (let seat = 0; seat < 4; seat++) {
      const idx = this.pool.map((p, i) => (p.owner === seat ? i : -1)).filter((i) => i >= 0);
      const cards = idx.map((i) => this.pool[i].card);
      for (let i = cards.length - 1; i > 0; i--) {
        const j = Math.floor(this.rng() * (i + 1));
        [cards[i], cards[j]] = [cards[j], cards[i]];
      }
      idx.forEach((i, k) => { this.pool[i].card = cards[k]; });
    }
  }

  /** 目前輪到誰抽牌 */
  currentPicker() {
    return this.phase === PHASE.SWAP_PICK ? this.pickOrder[this.pickIndex] : null;
  }

  /**
   * 這位玩家現在可以抽哪些位置。
   * 規則：優先抽別人的；只有在別人的牌都被抽光時，才准抽回自己蓋的。
   */
  availablePicks(seat) {
    const free = this.pool.map((p, i) => ({ ...p, i })).filter((p) => !p.taken);
    const others = free.filter((p) => p.owner !== seat);
    return (others.length ? others : free).map((p) => p.i);
  }

  /** 抽一張（poolIndex 由 availablePicks 提供） */
  pickCard(seat, poolIndex) {
    if (this.phase !== PHASE.SWAP_PICK) return { ok: false, reason: '現在不是抽牌階段' };
    if (this.currentPicker() !== seat) return { ok: false, reason: '還沒輪到你' };
    if (!this.availablePicks(seat).includes(poolIndex)) {
      return { ok: false, reason: '這張不能抽（要先抽別人蓋的牌）' };
    }
    const slot = this.pool[poolIndex];
    slot.taken = true;
    slot.takenBy = seat;
    this.hands[seat].push(slot.card);
    this.hands[seat].sort((a, b) => a - b);
    this.picksRemaining--;

    if (this.picksRemaining === 0) {
      this.pickIndex++;
      if (this.pickIndex >= this.pickOrder.length) this._finishSwap();
      else this.picksRemaining = this.discards[this.pickOrder[this.pickIndex]].length;
    }
    return { ok: true, card: slot.card };
  }

  _finishSwap() {
    this.log.push('換牌完成');
    this.phase = PHASE.BET_DECLARE;
    this.bet = { declarer: null, responses: {}, accepted: null };
  }

  // -------------------------------------------------------------------------
  // 對賭
  // -------------------------------------------------------------------------

  declareBet(seat) {
    if (this.phase !== PHASE.BET_DECLARE) return { ok: false, reason: '現在不能宣告對賭' };
    if (this.bet.declarer !== null) return { ok: false, reason: '已經有人宣告了' };
    this.bet.declarer = seat;
    this.phase = PHASE.BET_RESPOND;
    this.log.push(`${this.players[seat]} 宣告對賭！`);
    return { ok: true };
  }

  /** 沒有人要宣告 → 直接開打 */
  skipBet() {
    if (this.phase !== PHASE.BET_DECLARE) return { ok: false, reason: '階段不符' };
    this._startPlaying();
    return { ok: true };
  }

  respondBet(seat, accept) {
    if (this.phase !== PHASE.BET_RESPOND) return { ok: false, reason: '現在不是表態階段' };
    if (seat === this.bet.declarer) return { ok: false, reason: '賭家不用表態' };
    this.bet.responses[seat] = !!accept;

    if (!accept) {
      this.bet.accepted = false;
      this.log.push(`${this.players[seat]} 不同意，對賭取消`);
      this._startPlaying();
      return { ok: true, resolved: true, accepted: false };
    }
    if (Object.keys(this.bet.responses).length === 3) {
      this.bet.accepted = true;
      this.log.push('三家全部同意，對賭成立，賭家攤牌！');
      this._startPlaying();
      return { ok: true, resolved: true, accepted: true };
    }
    return { ok: true, resolved: false };
  }

  /** 對賭成立時，賭家的手牌對所有人公開 */
  revealedSeat() {
    return this.bet && this.bet.accepted ? this.bet.declarer : null;
  }

  _startPlaying() {
    this.phase = PHASE.PLAYING;
    this.turn = this._clubThreeHolder();
    this.log.push(`${this.players[this.turn]} 持梅花3，先出`);
  }

  // -------------------------------------------------------------------------
  // 出牌
  // -------------------------------------------------------------------------

  isNewRound() {
    return this.current === null;
  }

  play(seat, cards) {
    if (this.phase !== PHASE.PLAYING) return { ok: false, reason: '現在不是出牌階段' };
    if (this.turn !== seat) return { ok: false, reason: '還沒輪到你' };

    const check = E.validatePlay({
      hand: this.hands[seat],
      cards,
      current: this.current,
      isNewRound: this.isNewRound(),
      rules: this.opt.rules,
    });

    // 寬鬆模式只擋「牌不在手上」這種硬錯誤，牌型與大小交給玩家自己抓
    if (!check.ok) {
      // 這幾種是資料壞掉，不是「牌型對不對」的爭議，寬鬆模式也照擋
      const HARD = ['出的牌不在你手上', '有重複的牌', '你沒有選牌'];
      const hardError = HARD.includes(check.reason);
      if (this.opt.strictMode || hardError) return { ok: false, reason: check.reason };
    }

    const meld = check.meld || E.identify(cards, this.opt.rules) || {
      type: 'FREE', category: 0, tiebreak: Math.max(...cards), size: cards.length, label: '自訂',
    };

    // 出牌前先存檔：這一手若被抓，要還原到這個時間點
    const snapshot = this._snapshot();

    this.hands[seat] = this.hands[seat].filter((c) => !cards.includes(c));
    this.playedCards.push(...cards);
    this.current = meld;
    this.currentCards = [...cards];
    this.lastPlayerSeat = seat;
    this.trickWonBy = null;
    this.isFirstPlay = false;
    this.history.push({ seat, cards: [...cards], label: meld.label, trick: this.trickNo });
    this.passed = [false, false, false, false];
    this.log.push(`${this.players[seat]} 出 ${E.cardsName(cards)}（${meld.label}）`);

    // 新的一手蓋掉舊的抓牌時限；寬鬆模式下每一手都可以被抓
    if (this.opt.strictMode) {
      this.challenge = null;
    } else {
      this.challenge = {
        seat,
        cards: [...cards],
        legal: check.ok,
        reason: check.ok ? null : check.reason,
        // 出這手的當下，桌上要壓的是哪一手。當時就是公開的，
        // 所以電腦拿來判斷該不該抓，不算偷看（§K）。
        priorCurrent: snapshot.current,
        priorIsNewRound: snapshot.current === null,
        snapshot,
      };
    }

    // §P 出完最後一張只是「暫定結束」，要三家都按確認才算數
    if (this.hands[seat].length === 0) {
      this.phase = PHASE.PROVISIONAL_FINISH;
      this.provisional = { winner: seat, confirmed: {} };
      this.log.push(`${this.players[seat]} 出完了，等其他三家確認`);
      return { ok: true, meld, provisional: true };
    }
    this._advanceTurn();
    return { ok: true, meld };
  }

  pass(seat) {
    if (this.phase !== PHASE.PLAYING) return { ok: false, reason: '現在不是出牌階段' };
    if (this.turn !== seat) return { ok: false, reason: '還沒輪到你' };
    if (this.isNewRound()) return { ok: false, reason: '你開牌，不能 PASS' };

    this.passed[seat] = true;
    if (this.current) {
      (this.passLog[seat] = this.passLog[seat] || []).push({
        size: this.current.size,
        tiebreak: this.current.tiebreak || 0,
        tiebreakCard: this.current.size === 1 ? this.current.tiebreak : null,
        rank: this.current.size === 2 ? Math.floor((this.current.tiebreak || 0) / 4) : null,
      });
    }
    this.log.push(`${this.players[seat]} PASS`);
    this._advanceTurn();
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // 抓牌（只在寬鬆模式）
  // -------------------------------------------------------------------------

  /** 出牌前的完整狀態快照，抓成立時用來還原 */
  _snapshot() {
    return {
      hands: this.hands.map((h) => [...h]),
      playedCards: [...this.playedCards],
      passLog: (this.passLog || [[], [], [], []]).map((a) => a.map((x) => ({ ...x }))),
      history: this.history.map((h) => ({ ...h, cards: [...h.cards] })),
      trickNo: this.trickNo,
      current: this.current,
      currentCards: [...this.currentCards],
      lastPlayerSeat: this.lastPlayerSeat,
      trickWonBy: this.trickWonBy,
      history: this.history.slice(-12),
      waiting: this.waitingOn(),
      trickNo: this.trickNo,
      dice: this.phase === PHASE.SWAP_DICE || Object.keys(this.diceRolls || {}).length
        ? { rolls: { ...(this.diceRolls || {}) }, needed: [...(this.diceNeeded || [])] }
        : null,
      passed: [...this.passed],
      turn: this.turn,
      isFirstPlay: this.isFirstPlay,
      logLength: this.log.length,
      phase: this.phase,
      winner: this.winner,
      trickWonBy: this.trickWonBy,
      settlement: this.settlement,
      provisional: this.provisional && {
        winner: this.provisional.winner,
        confirmed: { ...this.provisional.confirmed },
      },
    };
  }

  _restore(snap) {
    this.hands = snap.hands.map((h) => [...h]);
    this.playedCards = [...snap.playedCards];
    this.passLog = (snap.passLog || [[], [], [], []]).map((a) => a.map((x) => ({ ...x })));
    this.history = snap.history.map((h) => ({ ...h, cards: [...h.cards] }));
    this.trickNo = snap.trickNo;
    this.current = snap.current;
    this.currentCards = [...snap.currentCards];
    this.lastPlayerSeat = snap.lastPlayerSeat;
    this.trickWonBy = snap.trickWonBy;
    this.passed = [...snap.passed];
    this.turn = snap.turn;
    this.isFirstPlay = snap.isFirstPlay;
    this.log.length = snap.logLength;
    this.phase = snap.phase;
    this.winner = snap.winner;
    this.settlement = snap.settlement;
    this.provisional = snap.provisional
      ? { winner: snap.provisional.winner, confirmed: { ...snap.provisional.confirmed } }
      : null;
    this.__settled = false;
  }

  /** 抓牌時限是否還開著 */
  /**
   * 抓牌時限是否還開著。沒有倒數（§I 全面取消計時），
   * 只由三件事關掉：下一手出牌、三家都 PASS、抓失敗。
   */
  challengeOpen() {
    if (!this.challenge) return false;
    return this.phase === PHASE.PLAYING || this.phase === PHASE.PROVISIONAL_FINISH;
  }

  /**
   * 抓上一手牌。伺服器直接依規則判定，不投票、不討論。
   * 抓對 → 那手退回、之後的 PASS 一併作廢、由原出牌者重出
   * 抓錯 → 什麼都不會發生，也不罰
   */
  challengePlay(seat) {
    if (!this.challengeOpen()) return { ok: false, reason: '現在沒有可以抓的牌' };
    if (this.opt.strictMode) return { ok: false, reason: '嚴格模式不需要抓牌' };
    if (seat === this.challenge.seat) return { ok: false, reason: '不能抓自己' };
    // §P 已經按過「確認結束」的人不能再回頭抓
    if (this.provisional && this.provisional.confirmed[seat]) {
      return { ok: false, reason: '你已經確認結束了' };
    }

    const c = this.challenge;
    const who = this.players[c.seat];
    const chaser = this.players[seat];

    if (c.legal) {
      // §O 抓錯就關窗，同一手不能被抓第二次
      this.challenge = null;
      this.log.push(`${chaser} 抓 ${who}，但那手是合法的，不能再抓`);
      return { ok: true, upheld: false, reason: '那手牌沒有問題' };
    }

    const wasProvisional = this.phase === PHASE.PROVISIONAL_FINISH;
    this._restore(c.snapshot);
    this.challenge = null;
    this.provisional = null;
    this.log.push(`${chaser} 抓到了：${who} 的 ${E.cardsName(c.cards)} 不合法（${c.reason}），退回重出`);
    return {
      ok: true, upheld: true, reason: c.reason,
      offender: c.seat, cancelledFinish: wasProvisional,
    };
  }

  /**
   * 換下一家。
   *
   * §B1 PASS 只對「當下這一手」有效。每有人出新的一手，
   *     passed 就整排清空，先前 PASS 過的人會再輪到。
   *     一墩結束的唯一條件是：繞回最後出牌的那個人，
   *     也就是其他三家都對「同一手」PASS 過了。
   *
   * §B2 一墩結束時不清桌面。贏的那手要留著給大家看，
   *     等贏家出下一手才被蓋掉。
   */
  _advanceTurn() {
    let next = (this.turn + 1) % 4;
    let guard = 0;
    while (this.hands[next].length === 0 && guard++ < 4) next = (next + 1) % 4;

    if (next === this.lastPlayerSeat) {
      this.current = null;          // 贏家可以自由開牌
      this.trickWonBy = next;       // 但桌上那手還留著（§B2）
      this.passed = [false, false, false, false];
      // §O 三家都 PASS 了，這一手就定案，抓不動了
      if (this.challenge) {
        this.log.push('三家都不出，這一手定案');
        this.challenge = null;
      }
      this.log.push(`${this.players[next]} 贏了這一墩，重新開牌`);
      this.trickNo++;
    }
    this.turn = next;
  }

  // -------------------------------------------------------------------------
  // 暫定結束（§P）
  // -------------------------------------------------------------------------

  /**
   * 現在在等誰、等他做什麼。
   * 每個階段都要答得出來，不然玩家只會看到畫面不動、不知道卡在哪。
   * @returns {{seats:number[], what:string}}
   */
  waitingOn() {
    switch (this.phase) {
      case PHASE.SWAP_SELECT: {
        const seats = [];
        for (let i = 0; i < 4; i++) if (!this.discards[i]) seats.push(i);
        return { seats, what: '蓋牌' };
      }
      case PHASE.SWAP_DICE:
        return { seats: [...(this.diceNeeded || [])], what: '擲骰子' };
      case PHASE.SWAP_PICK: {
        const p = this.currentPicker();
        return { seats: p === null ? [] : [p], what: '抽牌' };
      }
      case PHASE.BET_DECLARE:
        return { seats: [0, 1, 2, 3], what: '決定要不要對賭' };
      case PHASE.BET_RESPOND: {
        const seats = [];
        for (let i = 0; i < 4; i++) {
          if (i !== this.bet.declarer && this.bet.responses[i] === undefined) seats.push(i);
        }
        return { seats, what: '對賭表態' };
      }
      case PHASE.PLAYING:
        return { seats: this.turn === null ? [] : [this.turn], what: '出牌' };
      case PHASE.PROVISIONAL_FINISH:
        return { seats: this.pendingConfirmers(), what: '確認結束' };
      default:
        return { seats: [], what: '' };
    }
  }

  /** 用來塞進錯誤訊息，讓人知道現在到底在等什麼 */
  waitingText() {
    const w = this.waitingOn();
    if (!w.seats.length) return '';
    const names = w.seats.map((i) => this.players[i]).join('、');
    return `現在等 ${names} ${w.what}`;
  }

  /** 還沒表態的三家 */
  pendingConfirmers() {
    if (!this.provisional) return [];
    const out = [];
    for (let i = 0; i < 4; i++) {
      if (i !== this.provisional.winner && !this.provisional.confirmed[i]) out.push(i);
    }
    return out;
  }

  /**
   * 確認結束。三家都按過才真的結算。
   * 按下去就鎖住——之後不能再抓（§P）。
   */
  confirmFinish(seat) {
    if (this.phase !== PHASE.PROVISIONAL_FINISH) return { ok: false, reason: '現在沒有要確認的牌局' };
    if (seat === this.provisional.winner) return { ok: false, reason: '你是贏家，不用確認' };
    if (this.provisional.confirmed[seat]) return { ok: false, reason: '你已經確認過了' };

    this.provisional.confirmed[seat] = true;
    this.log.push(`${this.players[seat]} 確認結束`);

    if (this.pendingConfirmers().length === 0) {
      this.winner = this.provisional.winner;
      this.challenge = null;
      this.phase = PHASE.PLAYING;   // _settle 會把它推到 FINISHED
      this._settle();
      this.provisional = null;
      return { ok: true, settled: true };
    }
    return { ok: true, settled: false, waiting: this.pendingConfirmers() };
  }

  // -------------------------------------------------------------------------
  // 結算
  // -------------------------------------------------------------------------

  /**
   * 一張都沒出過的人，賠雙倍（CIO 8/16）。
   * 判斷方式是「這一局的出牌紀錄裡完全沒有他」，
   * 不是看剩幾張——盧家玩法換完牌一樣是 13 張，但那不代表他沒出過。
   */
  _neverPlayed(seat) {
    return !this.history.some((h) => h.seat === seat);
  }

  _settle() {
    this.phase = PHASE.FINISHED;
    const rate = this.opt.pointValue;
    const points = this.hands.map((h) => h.length);
    const blanks = [0, 1, 2, 3].map((s) => s !== this.winner && this._neverPlayed(s));
    const money = [0, 0, 0, 0];
    const betAccepted = this.bet && this.bet.accepted;
    const declarer = betAccepted ? this.bet.declarer : null;
    const w = this.winner;

    if (betAccepted && declarer === w) {
      // 對賭成功：三家各付「自己分數 × 倍率」給賭家
      const m = this.opt.betWinMultiplier;
      for (let s = 0; s < 4; s++) {
        if (s === w) continue;
        const amt = points[s] * rate * m * (blanks[s] ? this.opt.blankMultiplier : 1);
        money[s] -= amt;
        money[w] += amt;
      }
    } else {
      // 一般結算：每個輸家付「自己分數 × 一分金額」給贏家
      // 對賭失敗時，賭家那一份放大十倍，其餘兩家照算
      for (let s = 0; s < 4; s++) {
        if (s === w) continue;
        const mult = (betAccepted && s === declarer) ? this.opt.betLoseMultiplier : 1;
        const amt = points[s] * rate * mult * (blanks[s] ? this.opt.blankMultiplier : 1);
        money[s] -= amt;
        money[w] += amt;
      }
    }

    // §S 誰付誰、多少錢。純提醒，不追蹤付款。
    const transfers = [];
    for (let sSeat = 0; sSeat < 4; sSeat++) {
      if (sSeat === w || money[sSeat] >= 0) continue;
      transfers.push({
        from: sSeat, fromName: this.players[sSeat],
        to: w, toName: this.players[w],
        amount: -money[sSeat],
        cards: points[sSeat],
        blank: !!blanks[sSeat],      // 一張都沒出過，賠雙倍
      });
    }

    this.settlement = {
      winner: w,
      points,
      money,
      rate,
      transfers,
      blanks,
      bet: betAccepted
        ? { declarer, result: declarer === w ? 'WIN' : 'LOSE',
            multiplier: declarer === w ? this.opt.betWinMultiplier : this.opt.betLoseMultiplier }
        : null,
      remainingHands: this.hands.map((h) => [...h]),
    };
    this.log.push(`${this.players[w]} 贏了！`);
  }

  // -------------------------------------------------------------------------
  // 對外狀態（依座位遮蔽別人的手牌）
  // -------------------------------------------------------------------------

  publicState(forSeat) {
    const revealed = this.revealedSeat();
    return {
      phase: this.phase,
      players: this.players,
      counts: this.hands.map((h) => h.length),
      hand: forSeat != null ? [...this.hands[forSeat]] : [],
      revealedSeat: revealed,
      revealedHand: revealed != null ? [...this.hands[revealed]] : null,
      turn: this.turn,
      currentCards: [...this.currentCards],
      currentLabel: this.current ? this.current.label : null,
      lastPlayerSeat: this.lastPlayerSeat,
      trickWonBy: this.trickWonBy,
      history: this.history.slice(-12),
      waiting: this.waitingOn(),
      trickNo: this.trickNo,
      dice: this.phase === PHASE.SWAP_DICE || Object.keys(this.diceRolls || {}).length
        ? { rolls: { ...(this.diceRolls || {}) }, needed: [...(this.diceNeeded || [])] }
        : null,
      passed: [...this.passed],
      isFirstPlay: this.isFirstPlay,
      isNewRound: this.isNewRound(),
      bet: this.bet ? { declarer: this.bet.declarer, accepted: this.bet.accepted,
                        responded: Object.keys(this.bet.responses).map(Number) } : null,
      swap: this.phase === PHASE.SWAP_SELECT || this.phase === PHASE.SWAP_PICK ? {
        submitted: this.discards.map((d) => d !== null),
        discardCounts: this.discards.map((d) => (d ? d.length : 0)),
        pool: this.pool.map((p, i) => ({ i, owner: p.owner, taken: p.taken, takenBy: p.takenBy })),
        picker: this.currentPicker(),
        picksRemaining: this.picksRemaining,
        available: forSeat != null && this.currentPicker() === forSeat ? this.availablePicks(forSeat) : [],
      } : null,
      challengeWindow: this.challengeOpen() ? {
        playSeat: this.challenge.seat,
        cards: [...this.challenge.cards],
      } : null,
      trickWonBy: this.trickWonBy,
      history: this.history.slice(-12),
      waiting: this.waitingOn(),
      trickNo: this.trickNo,
      dice: (this.phase === PHASE.SWAP_DICE || Object.keys(this.diceRolls || {}).length)
        ? { rolls: { ...(this.diceRolls || {}) }, needed: [...(this.diceNeeded || [])] }
        : null,
      provisional: this.provisional ? {
        winner: this.provisional.winner,
        confirmed: Object.keys(this.provisional.confirmed).map(Number),
        waiting: this.pendingConfirmers(),
      } : null,
      settlement: this.settlement,
      options: {
        luMode: this.opt.luMode, strictMode: this.opt.strictMode,
        pointValue: this.opt.pointValue,
      },
    };
  }
}

module.exports = { Game, PHASE, DEFAULT_OPTIONS };
