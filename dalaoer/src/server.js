'use strict';
/**
 * 大老二 連線伺服器（Express + Socket.IO）
 *
 * 可獨立執行：      node src/server.js
 * 也可掛進盧家遊戲入口： const { attach } = require('./dalaoer/src/server');
 *                       attach(app, io);   // 見 README
 */

const path = require('path');
const express = require('express');
const { Game, PHASE, DEFAULT_OPTIONS } = require('./game');
const AI = require('./ai');
const E = require('./engine');

const BOT_NAMES = ['電腦小明', '電腦小華', '電腦阿龍', '電腦阿美'];
// 電腦思考時間，讓節奏像真人。測試時可用 DALAOER_BOT_DELAY=0 加速。
const DELAY_SCALE = process.env.DALAOER_BOT_DELAY !== undefined
  ? Number(process.env.DALAOER_BOT_DELAY) : 1;
const BOT_DELAY = { min: 700 * DELAY_SCALE, max: 1600 * DELAY_SCALE };

// §I 斷線之後的「等候時間」。時間到不會自動做任何事 —— 它只是桌上共同的預期，
//    在場的人可以無限延長。要真的動別人的位子，還是得全體同意。
const HOLD_MS = 5 * 60 * 1000;        // CIO：給 3~5 分鐘回來
const HOLD_EXTEND_MS = 5 * 60 * 1000;

const rooms = new Map();

// ---------------------------------------------------------------------------
// 房間
// ---------------------------------------------------------------------------

// 公開上線之後，一定會有整桌人直接關掉分頁的情況。
// 這種房間如果留著，rooms 會越積越多，記憶體只進不出。
const ROOM_IDLE_MS = Number(process.env.DALAOER_ROOM_IDLE_MS || 2 * 60 * 60 * 1000);

function sweepRooms(now = Date.now()) {
  let removed = 0;
  for (const [code, room] of rooms) {
    const anyone = room.seats.some((s) => s && !s.isBot && s.socketId);
    if (anyone) { room.lastSeen = now; continue; }
    if (now - (room.lastSeen || 0) > ROOM_IDLE_MS) {
      room.clearTimers();
      rooms.delete(code);
      removed++;
    }
  }
  return removed;
}

function makeToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function makeCode() {
  let code;
  do {
    code = Math.random().toString(36).slice(2, 6).toUpperCase().replace(/[O0I1]/g, 'A');
  } while (rooms.has(code));
  return code;
}

class Room {
  constructor(code, io) {
    this.code = code;
    this.io = io;
    this.seats = [null, null, null, null];  // {socketId, name, isBot}
    this.hostSeat = 0;
    this.options = { ...DEFAULT_OPTIONS };
    this.game = null;
    this.botTimer = null;
    this.declareResponses = {};             // 對賭宣告階段：誰已表態不賭
    this.stage = 'LOBBY';                   // LOBBY | SEATING | GAME
    this.paused = null;                     // {seat, name} 有人斷線就凍結
    this.sessionStart = Date.now();         // 本次牌局的起點（§9.4 一次性，不跨重開）
    this.lastSeen = Date.now();             // 最後一次有真人在線的時間
    this.ledger = {};                       // { 玩家名稱: 累計金額 }
    this.history = [];                      // 本次牌局每局摘要
  }

  /** 一次牌局最長 24 小時，超過就整個歸零 */
  rollSessionIfStale() {
    if (Date.now() - this.sessionStart > 24 * 60 * 60 * 1000) {
      this.sessionStart = Date.now();
      this.ledger = {};
      this.history = [];
    }
  }

  // --- 座位 ---
  seatOf(socketId) {
    return this.seats.findIndex((s) => s && s.socketId === socketId);
  }

  addPlayer(socketId, name, token) {
    // 帶著舊 token 回來 → 回到原本的位子，不佔新座
    // §J 本人回來就把位子要回去，不必經過任何人同意，
    //    打到一半也可以。電腦已經做掉的動作照算。
    if (token) {
      const back = this.seats.findIndex((s) => s && s.token === token);
      if (back >= 0) {
        const wasBot = this.seats[back].isBot;
        this.seats[back].socketId = socketId;
        this.seats[back].isBot = false;
        this.seats[back].name = this.seats[back].realName || name || this.seats[back].name;
        this.seats[back].botFor = null;
        if (this.proposal && (this.proposal.target === back)) {
          this.proposal = null;   // 人回來了，提案沒意義了
        }
        this.resumeIfWhole();
        return { seat: back, token, resumed: true, reclaimedFromBot: wasBot };
      }
    }
    let idx = this.seats.findIndex((s) => s === null);
    // 沒有空位時，真人可以把電腦擠掉——但牌局進行中不行
    const handInProgress = this.stage === 'GAME' && this.game && this.game.phase !== PHASE.FINISHED;
    if (idx === -1 && !handInProgress) {
      idx = this.seats.findIndex((s) => s && s.isBot);
    }
    if (idx === -1) return { seat: -1 };
    const fresh = makeToken();
    this.seats[idx] = { socketId, name: name || `玩家${idx + 1}`, isBot: false, token: fresh };
    if (this.seats.filter((s) => s && !s.isBot).length === 1) this.hostSeat = idx;
    return { seat: idx, token: fresh, resumed: false };
  }

  /** 有人斷線：牌局原地凍結，等他回來（規範 §5.3） */
  removePlayer(socketId) {
    const idx = this.seatOf(socketId);
    if (idx === -1) return;

    if (this.game && this.game.phase !== PHASE.FINISHED) {
      this.seats[idx].socketId = null;      // 位子留著，token 留著

      // §Q + CIO 2026-08-23：牌局照打，打到「真的輪到他」才停下來等。
      //   以前是一斷線就整桌凍結；現在只有他手上真的有待辦動作時才等。
      //   這一條同時套用在入口的撲克／麻將／橋牌，四個遊戲行為一致。
      if (!this._holdIfSomeoneAway()) {
        // 還沒輪到他 —— 牌局照打，等打到他那一手再停
        this.broadcastLobby();
        this.broadcastState();
        this.driveBots();
        return;
      }
      this.broadcastLobby();
      this.broadcastState();
      return;
    }

    // 座位確認階段有人離開：位子留著、交給電腦，token 也留著。
    // 這時候還沒發牌，沒有人的牌會受影響，所以不需要任何人同意。
    // 之所以不能直接把位子刪掉，是因為刪掉之後發牌會少一家。
    if (this.stage === 'SEATING') {
      const prev = this.seats[idx];
      this.seats[idx] = {
        socketId: null,
        name: `${prev.realName || prev.name}(電腦代打)`,
        realName: prev.realName || prev.name,
        isBot: true,
        token: prev.token,
      };
      if (idx === this.hostSeat) {
        const next = this.seats.findIndex((s) => s && !s.isBot);
        if (next >= 0) this.hostSeat = next;
      }
      if (this.activeHumans().length === 0) { rooms.delete(this.code); return; }
      this.broadcastLobby();
      this.broadcastSeating();
      return;
    }

    this.seats[idx] = null;
    if (idx === this.hostSeat) {
      const next = this.seats.findIndex((s) => s && !s.isBot);
      if (next >= 0) this.hostSeat = next;
    }
    if (this.seats.every((s) => s === null || s.isBot)) rooms.delete(this.code);
  }

  /**
   * 凍結：等他回來。
   *
   * §I 還是沒有「時間到就自動動你的位子」這回事 —— 時間到什麼都不會發生。
   * 這裡只多一個「還要等他多久」的顯示，讓桌上的人有個共同的預期，
   * 而且任何在場的人都可以按「再等 5 分鐘」把它往後推（多等一點永遠是安全的，
   * 所以不用投票）。等候時間到了，畫面只是把兩個提案標亮，決定權還是在大家手上。
   */
  pause(seat) {
    if (this.paused) return;
    this.paused = {
      seat,
      name: this.seats[seat].name,
      since: Date.now(),
      until: Date.now() + HOLD_MS,
      extends: 0,
    };
    this.clearTimers();
    this.io.to(this.code).emit('toast',
      `${this.seats[seat].name} 斷線了，牌局暫停 — 先等 ${Math.round(HOLD_MS / 60000)} 分鐘`);
  }

  /** 再多等他一會兒。任何在場的真人都可以按，不需要表決。 */
  extendHold(bySeat) {
    if (!this.paused) return { ok: false, reason: '現在沒有人斷線' };
    const now = Date.now();
    const base = Math.max(now, this.paused.until || now);
    this.paused.until = base + HOLD_EXTEND_MS;
    this.paused.extends = (this.paused.extends || 0) + 1;
    const who = this.seats[bySeat] ? this.seats[bySeat].name : '有人';
    this.io.to(this.code).emit('toast',
      `${who} 把等候時間延長 ${Math.round(HOLD_EXTEND_MS / 60000)} 分鐘`);
    this.broadcastState();
    this.broadcastLobby();
    return { ok: true, until: this.paused.until };
  }

  // -------------------------------------------------------------------------
  // 全體同意（CIO 定案）
  //
  // 沒有倒數了，所以也沒有「等夠久就可以動別人」這回事。
  // 想把某個位子換成電腦，或想收掉這一局，都要在線上的其他真人「全部同意」。
  // 一個人不同意就作廢，而且不再問第二次。
  // -------------------------------------------------------------------------

  /**
   * 這一局還沒打完嗎？
   * 只有「沒有在進行的牌局」才可以重新排座位、重新發牌。
   * 要中途收掉，唯一的路是全體同意的 END 提案。
   */
  handInProgress() {
    return !!this.game && this.game.phase !== PHASE.FINISHED;
  }

  /** 現在還在線上的真人座位 */
  activeHumans() {
    this.__touch();
    const out = [];
    for (let i = 0; i < 4; i++) {
      const st = this.seats[i];
      if (st && !st.isBot && st.socketId) out.push(i);
    }
    if (out.length) this.lastSeen = Date.now();
    return out;
  }

  __touch() { /* activeHumans 會更新 lastSeen，這裡留個掛勾 */ }

  /**
   * 發起一個提案。
   * @param {number} by 發起人座位
   * @param {'BOT'|'END'} kind BOT=換電腦，END=收掉這一局
   * @param {number} target BOT 專用：要換掉哪個位子
   */
  propose(by, kind, target) {
    if (this.proposal) return { ok: false, reason: '已經有一個提案在等大家表態' };
    if (kind === 'BOT') {
      if (target === undefined || !this.seats[target]) return { ok: false, reason: '沒有這個位子' };
      if (this.seats[target].isBot) return { ok: false, reason: '那個位子已經是電腦了' };
      if (target === by) return { ok: false, reason: '不能把自己換成電腦' };
    }

    // 提案人以外、還在線上的真人才要表態
    const voters = this.activeHumans().filter((s) => s !== by && s !== target);
    this.proposal = {
      kind, by, target,
      byName: this.seats[by].name,
      targetName: target !== undefined && this.seats[target] ? this.seats[target].name : null,
      voters,
      votes: { [by]: true },
    };
    this.io.to(this.code).emit('toast', kind === 'BOT'
      ? `${this.seats[by].name} 提議把 ${this.seats[target].name} 換成電腦`
      : `${this.seats[by].name} 提議結束這一局`);

    if (!voters.length) return this._settleProposal();
    this.broadcastState();
    return { ok: true, pending: true };
  }

  vote(seat, agree) {
    if (!this.proposal) return { ok: false, reason: '現在沒有提案' };
    if (!this.proposal.voters.includes(seat)) return { ok: false, reason: '你不用表態' };
    if (this.proposal.votes[seat] !== undefined) return { ok: false, reason: '你已經表態過了' };
    this.proposal.votes[seat] = !!agree;

    if (!agree) {
      const who = this.seats[seat].name;
      this.io.to(this.code).emit('toast', `${who} 不同意，提案作廢`);
      this.proposal = null;
      this.broadcastState();
      return { ok: true, passed: false };
    }
    const answered = this.proposal.voters.every((v) => this.proposal.votes[v] !== undefined);
    if (!answered) { this.broadcastState(); return { ok: true, pending: true }; }
    return this._settleProposal();
  }

  _settleProposal() {
    const p = this.proposal;
    this.proposal = null;
    if (p.kind === 'BOT') {
      this.io.to(this.code).emit('toast', `大家同意了，${p.targetName} 交給電腦`);
      return this.botSeat(p.target, true);
    }
    // §U 這一局作廢：不計分、不計錢，之前打完的局照算
    this.io.to(this.code).emit('toast', '大家同意，這一局作廢');
    this.abandonHand();
    return { ok: true, passed: true };
  }

  /** 收掉沒打完的一局。不產生任何分數或金錢。 */
  abandonHand() {
    this.clearTimers();
    this.game = null;
    this.paused = null;
    this.stage = 'LOBBY';
    this.io.to(this.code).emit('handAbandoned', {
      ledger: this.ledgerPayload(),
    });
    // 收掉之後直接回到座位畫面，不要把大家丟在半路
    this.openSeating();
  }

  /** 四個位子都有人（或是電腦）就解凍，從原本的位置繼續 */
  resumeIfWhole() {
    if (!this.paused) return;
    const stillGone = this.seats.findIndex((s) => s && !s.isBot && !s.socketId);
    if (stillGone >= 0) return;
    const who = this.paused.name;
    this.paused = null;
    this.io.to(this.code).emit('toast', `${who} 回來了，繼續`);
    this.afterAction();
  }

  /** 逃生門：其他玩家可以把斷線的位子換成電腦（規範 §5.3，永遠是手動） */
  /**
   * 把一個位子交給電腦。只有全體同意的提案才會走到這裡。
   * §J 原本那個人的 token 留著，他隨時可以按「回來玩」把位子要回去，
   *    包括打到一半、換牌換到一半。已經做過的動作照算，不回捲。
   */
  /**
   * CIO 2026-08-23：換電腦代打不用再表決，任何一位在座的真人開口就算。
   * 這一條 **取代** 原本「全體同意才能動別人的位子」裡關於換電腦的部分；
   * 「收掉這一局」因為會把大家的牌全部作廢，仍然要全體同意。
   * 本人的 token 留著，隨時可以按「回來玩」把位子要回去，已經做過的不回捲。
   */
  botSeat(seat, approved) {
    if (!approved) return { ok: false, reason: '要大家同意才能換電腦' };
    const prev = this.seats[seat];
    this.seats[seat] = {
      socketId: null,
      name: `${prev.name}(電腦代打)`,
      realName: prev.realName || prev.name,
      isBot: true,
      token: prev.token,          // 留著讓本人認領
      botFor: prev.token || null,
    };
    if (this.paused && this.paused.seat === seat) this.paused = null;
    if (seat === this.hostSeat) {
      const next = this.seats.findIndex((s) => s && !s.isBot);
      if (next >= 0) this.hostSeat = next;
    }
    this.broadcastLobby();
    this.afterAction();
    return { ok: true };
  }

  fillWithBots() {
    let n = 0;
    for (let i = 0; i < 4; i++) {
      if (!this.seats[i]) {
        this.seats[i] = { socketId: null, name: BOT_NAMES[n % 4], isBot: true };
        n++;
      }
    }
  }

  humanCount() {
    return this.seats.filter((s) => s && !s.isBot).length;
  }

  // --- 座位確認（規範 §5.2） ---

  /** 開始 → 先看座位，一張牌都還沒發 */
  openSeating() {
    this.fillWithBots();
    this.clearTimers();
    this.game = null;
    this.stage = 'SEATING';
    this.broadcastLobby();
    this.broadcastSeating();
  }

  /** ◀ ▶ 把某個位子往前或往後挪一格 */
  moveSeat(seat, direction) {
    if (this.stage !== 'SEATING') return { ok: false, reason: '現在不是排座位的時候' };
    const step = direction === 'left' || direction === -1 ? -1 : 1;
    const target = (seat + step + 4) % 4;
    const t = this.seats[seat];
    this.seats[seat] = this.seats[target];
    this.seats[target] = t;
    if (this.hostSeat === seat) this.hostSeat = target;
    else if (this.hostSeat === target) this.hostSeat = seat;
    this.broadcastSeating();
    this.broadcastLobby();
    return { ok: true, seat: target };
  }

  /** 座位沒錯 → 這一步才發牌 */
  confirmSeats() {
    if (this.stage !== 'SEATING') return { ok: false, reason: '現在不是排座位的時候' };
    if (this.handInProgress()) return { ok: false, reason: '這一局還沒打完' };
    this.deal();
    return { ok: true };
  }

  // --- 對局 ---
  deal() {
    this.fillWithBots();          // 任何空位都補滿，發牌前一定是四家
    this.clearTimers();
    this.declareResponses = {};
    this.rollSessionIfStale();
    this.stage = 'GAME';
    this.paused = null;
    this.game = new Game(this.seats.map((s) => s.name), this.options);
    this.broadcastState();
    this.driveBots();
  }

  broadcastSeating() {
    const base = {
      code: this.code,
      seats: this.seats.map((s) => (s ? { name: s.name, isBot: s.isBot } : null)),
      hostSeat: this.hostSeat,
      options: this.options,
    };
    // 每個人收到的版本都要附上自己的座位號。
    // 少了這個，別人被 ◀ ▶ 挪動時客戶端會繼續用舊的座位號，
    // 「你」的標記就會貼到別人身上。
    for (let i = 0; i < 4; i++) {
      const seat = this.seats[i];
      if (seat && seat.socketId) {
        this.io.to(seat.socketId).emit('seating', { ...base, seat: i });
      }
    }
  }

  clearTimers() {
    // §I 只剩電腦的思考延遲，沒有任何玩家倒數
    if (this.botTimer) { clearTimeout(this.botTimer); this.botTimer = null; }
  }

  /**
   * 輪到一個「人不在」的位子了嗎？
   * CIO 2026-08-23：斷線不再馬上凍結整桌，而是打到真的需要他的時候才停下來等。
   * 所以停不停不能只在斷線那一刻判斷 —— 每次動作之後都要重新看一次。
   */
  _holdIfSomeoneAway() {
    const g = this.game;
    if (!g || this.paused || g.phase === PHASE.FINISHED) return false;
    for (const seat of (g.waitingOn().seats || [])) {
      const st = this.seats[seat];
      if (st && !st.isBot && !st.socketId) { this.pause(seat); return true; }
    }
    return false;
  }

  /** 每次動作之後：檢查結束、廣播、催電腦 */
  afterAction() {
    const g = this.game;
    if (!g) return;
    this._holdIfSomeoneAway();
    if (this.paused) { this.clearTimers(); this.broadcastState(); return; }
    if (g.phase === PHASE.FINISHED && !g.__settled) {
      g.__settled = true;
      this.applySettlement();
    }
    this.broadcastState();
    if (g.phase === PHASE.FINISHED) { this.clearTimers(); return; }
    this.driveBots();
  }

  /** 依目前階段，找出該行動的電腦並代為行動 */
  driveBots() {
    if (this.botTimer) clearTimeout(this.botTimer);
    const g = this.game;
    if (!g || g.phase === PHASE.FINISHED || this.paused) return;

    const delay = BOT_DELAY.min + Math.random() * (BOT_DELAY.max - BOT_DELAY.min);
    this.botTimer = setTimeout(() => {
      if (this.game !== g || g.phase === PHASE.FINISHED) return;
      let acted = false;

      if (g.phase === PHASE.SWAP_SELECT) {
        for (let s = 0; s < 4; s++) {
          if (this.seats[s].isBot && !g.discards[s]) {
            g.submitDiscards(s, AI.chooseDiscards(g.hands[s], this.options.maxDiscard));
            acted = true;
          }
        }
      } else if (g.phase === PHASE.SWAP_DICE) {
        // §N 電腦接手的座位馬上擲（真人要自己按）
        for (const seat of g.diceNeeded) {
          if (this.seats[seat].isBot) { g.rollDice(seat); acted = true; break; }
        }
      } else if (g.phase === PHASE.PROVISIONAL_FINISH) {
        // §P 電腦要自己決定「確認結束」還是「抓」
        for (const seat of g.pendingConfirmers()) {
          if (!this.seats[seat].isBot) continue;
          const suspicious = !this.options.strictMode
            && g.challenge && g.challenge.seat !== seat
            && AI.shouldChallenge(g.challenge, this.options.rules);
          if (suspicious) g.challengePlay(seat);
          else g.confirmFinish(seat);
          acted = true;
          break;
        }
      } else if (g.phase === PHASE.SWAP_PICK) {
        const seat = g.currentPicker();
        if (this.seats[seat].isBot) {
          const avail = g.availablePicks(seat);
          g.pickCard(seat, avail[AI.choosePickIndex(avail)]);
          acted = true;
        }
      } else if (g.phase === PHASE.BET_DECLARE) {
        // 電腦只會宣告對賭，不會替真人按「開始」——那個視窗沒有倒數，
        // 由真人決定何時開打（規範 ruling 5、13）
        for (let s = 0; s < 4; s++) {
          if (!this.seats[s].isBot || this.declareResponses[s] !== undefined) continue;
          if (AI.shouldDeclareBet(g.hands[s], this.options.rules)) { g.declareBet(s); acted = true; break; }
          this.declareResponses[s] = false;
          acted = true;
        }
        // 桌上一個真人都沒有，才由電腦收尾，免得整桌卡住
        const noHumans = this.seats.every((st) => st.isBot || !st.socketId);
        if (g.phase === PHASE.BET_DECLARE && noHumans
            && Object.keys(this.declareResponses).length === 4) {
          g.skipBet();
          acted = true;
        }
      } else if (g.phase === PHASE.BET_RESPOND) {
        for (let s = 0; s < 4; s++) {
          if (s === g.bet.declarer || !this.seats[s].isBot) continue;
          if (g.bet.responses[s] !== undefined) continue;
          const accept = AI.shouldAcceptBet(g.hands[s], this.options.rules);
          this.io.to(this.code).emit('toast',
            `${this.seats[s].name} ${accept ? '同意' : '不同意'}對賭`);
          g.respondBet(s, accept);
          acted = true;
          break;
        }
      } else if (g.phase === PHASE.PLAYING) {
        const seat = g.turn;
        if (this.seats[seat].isBot) {
          // 進階電腦要看得到「每家剩幾張、誰 PASS 掉什麼、誰還沒出過牌」——
          // 這些桌上本來就是公開的（§K），跟真人看到的一樣多。
          const d = AI.choosePlay({
            seat,
            hand: g.hands[seat],
            current: g.current,
            playedCards: g.playedCards,
            counts: g.hands.map((h) => h.length),
            passInfo: g.passLog || [[], [], [], []],
            passesInARow: g.passed.filter(Boolean).length,
            lastPlayerSeat: g.lastPlayerSeat,
            everPlayed: [0, 1, 2, 3].map((s) => g.history.some((h) => h.seat === s)),
            opponentCounts: g.hands.map((h, i) => (i === seat ? null : h.length)).filter((x) => x !== null),
            isFirstPlay: g.isFirstPlay,
            rules: this.options.rules,
          });
          const r = d.action === 'pass' ? g.pass(seat) : g.play(seat, d.cards);
          if (!r.ok) {
            // 策略給了不能用的一手，退而求其次：能不出就不出，否則出最小的合法牌
            const fallback = E.legalPlays(g.hands[seat], g.current, this.options.rules);
            if (!g.isNewRound()) g.pass(seat);
            else if (fallback.length) {
              fallback.sort((x, y) => x.meld.size - y.meld.size
                || (x.cards[0] - y.cards[0]));
              g.play(seat, fallback[0].cards);
            }
          }
          acted = true;
        }
      }

      if (acted) this.afterAction();
    }, delay);
  }

  /** 把單局結果寫進本場的帳（規範 §9.4） */
  applySettlement() {
    this.rollSessionIfStale();
    const s = this.game.settlement;
    this.seats.forEach((seat, i) => {
      const key = seat.realName || seat.name;   // 電腦代打仍記在本人帳上
      this.ledger[key] = (this.ledger[key] || 0) + s.money[i];
    });
    this.history.push({
      time: new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }),
      winner: this.seats[s.winner].name,
      points: s.points,
      money: s.money,
      bet: s.bet,
    });
  }



  // --- 廣播 ---
  lobbyPayload() {
    return {
      code: this.code,
      seats: this.seats.map((s) => (s ? { name: s.name, isBot: s.isBot } : null)),
      hostSeat: this.hostSeat,
      options: this.options,
      inGame: !!this.game && this.game.phase !== PHASE.FINISHED,
      stage: this.stage,
      paused: this.paused,
    };
  }

  broadcastLobby() {
    this.io.to(this.code).emit('lobby', this.lobbyPayload());
  }

  ledgerPayload() {
    return {
      sessionStart: this.sessionStart,
      totals: this.seats.map((s) => ({
        name: (s && (s.realName || s.name)) || '',
        money: this.ledger[(s && (s.realName || s.name)) || ''] || 0,
      })),
      history: this.history.slice(-20),
    };
  }

  broadcastState() {
    if (!this.game) return;
    const ledger = this.ledgerPayload();
    for (let i = 0; i < 4; i++) {
      const seat = this.seats[i];
      const payload = {
        ...this.game.publicState(i),
        seat: i,
        seats: this.seats.map((s) => ({ name: s.name, isBot: s.isBot })),
        hostSeat: this.hostSeat,
        declareResponses: this.declareResponses,
        paused: this.paused,
        proposal: this.proposal && {
          kind: this.proposal.kind,
          by: this.proposal.by, byName: this.proposal.byName,
          target: this.proposal.target, targetName: this.proposal.targetName,
          voters: this.proposal.voters,
          votes: this.proposal.votes,
        },
        stage: this.stage,
        ledger,
        log: this.game.log.slice(-40),
      };
      if (seat.socketId) this.io.to(seat.socketId).emit('state', payload);
    }
  }
}

// ---------------------------------------------------------------------------
// Socket 事件
// ---------------------------------------------------------------------------

/**
 * 掛進盧家遊戲入口。
 *
 *   const { attach } = require('./dalaoer/src/server');
 *   attach(app, io, { mount: '/dalaoer' });
 *
 * 入口的 io 是整個站共用的，所以這裡一律開一個 namespace，
 * 不會跟撲克或麻將的連線互相打架。
 */
function attach(app, io, opts = {}) {
  const mount = opts.mount || '/dalaoer';
  const namespace = opts.namespace || (mount === '/' ? '/' : mount);

  // 前端要知道自己該連哪個 namespace
  app.get(`${mount === '/' ? '' : mount}/ns.js`, (req, res) => {
    res.type('application/javascript')
      .send(`window.DALAOER_NS=${JSON.stringify(namespace)};`);
  });

  app.use(mount, express.static(path.join(__dirname, '..', 'public')));

  if (!attach.__sweeper) {
    attach.__sweeper = setInterval(() => sweepRooms(), 10 * 60 * 1000);
    if (attach.__sweeper.unref) attach.__sweeper.unref();
  }

  const nsp = namespace === '/' ? io : io.of(namespace);

  nsp.on('connection', (socket) => {
    let room = null;

    const ack = (cb, payload) => { if (typeof cb === 'function') cb(payload); };

    socket.on('createRoom', ({ name }, cb) => {
      const code = makeCode();
      room = new Room(code, nsp);
      rooms.set(code, room);
      const r = room.addPlayer(socket.id, name);
      socket.join(code);
      ack(cb, { ok: true, code, seat: r.seat, token: r.token });
      room.broadcastLobby();
    });

    socket.on('joinRoom', ({ code, name, token }, cb) => {
      const r = rooms.get((code || '').toUpperCase());
      if (!r) return ack(cb, { ok: false, reason: '找不到這個房間' });
      const res = r.addPlayer(socket.id, name, token);
      if (res.seat === -1) return ack(cb, { ok: false, reason: '房間已滿' });
      room = r;
      socket.join(r.code);
      ack(cb, { ok: true, code: r.code, seat: res.seat, token: res.token, resumed: !!res.resumed });
      r.broadcastLobby();
      if (r.stage === 'SEATING') r.broadcastSeating();
      if (r.game) r.broadcastState();
    });

    socket.on('setOptions', (options, cb) => {
      if (!room || room.seatOf(socket.id) !== room.hostSeat) {
        return ack(cb, { ok: false, reason: '只有房主可以改設定' });
      }
      // §X turnSeconds 已取消
      const allowed = ['luMode', 'strictMode', 'pointValue', 'maxDiscard'];
      for (const k of allowed) if (options[k] !== undefined) room.options[k] = options[k];
      ack(cb, { ok: true });
      room.broadcastLobby();
    });

    socket.on('startGame', (_, cb) => {
      if (!room) return ack(cb, { ok: false, reason: '你不在任何房間' });
      if (room.seatOf(socket.id) !== room.hostSeat) {
        return ack(cb, { ok: false, reason: '只有房主可以開始' });
      }
      if (room.handInProgress()) {
        return ack(cb, { ok: false, reason: '這一局還沒打完。要收掉的話，提議「結束這一局」，大家同意才行' });
      }
      room.openSeating();
      ack(cb, { ok: true });
    });

    // --- 座位確認（規範 §5.2）---
    socket.on('moveSeat', ({ seat, direction }, cb) => {
      if (!room) return ack(cb, { ok: false, reason: '你不在任何房間' });
      ack(cb, room.moveSeat(seat, direction));
    });

    socket.on('confirmSeats', (_, cb) => {
      if (!room) return ack(cb, { ok: false, reason: '你不在任何房間' });
      ack(cb, room.confirmSeats());
    });

    // --- 遊戲動作 ---
    const withSeat = (cb, fn) => {
      if (!room || !room.game) return ack(cb, { ok: false, reason: '目前沒有牌局' });
      // 凍結時整桌不能動。提案與投票走另一條路，不經過這裡。
      if (room.paused) {
        return ack(cb, { ok: false, reason: `等 ${room.paused.name} 回來，現在不能動` });
      }
      const seat = room.seatOf(socket.id);
      if (seat < 0) return ack(cb, { ok: false, reason: '你不在座位上' });
      const r = fn(room.game, seat);
      if (r && !r.ok) {
        const w = room.game.waitingText();
        if (w && !String(r.reason || '').includes('現在等')) {
          r.reason = `${r.reason}。${w}`;
        }
      }
      ack(cb, r);
      if (r && r.ok) room.afterAction();
    };

    socket.on('discard', ({ cards }, cb) =>
      withSeat(cb, (g, seat) => g.submitDiscards(seat, cards)));

    socket.on('pick', ({ poolIndex }, cb) =>
      withSeat(cb, (g, seat) => g.pickCard(seat, poolIndex)));

    // 對賭視窗沒有倒數：任何一家按「開始」就直接開打，第一個按的人決定（規範 ruling 13）
    socket.on('declareBet', ({ declare }, cb) =>
      withSeat(cb, (g, seat) => {
        if (g.phase !== PHASE.BET_DECLARE) return { ok: false, reason: '階段不符' };
        if (declare) return g.declareBet(seat);
        nsp.to(room.code).emit('toast', `${room.seats[seat].name} 按了開始`);
        return g.skipBet();
      }));

    socket.on('respondBet', ({ accept }, cb) =>
      withSeat(cb, (g, seat) => {
        nsp.to(room.code).emit('toast',
          `${room.seats[seat].name} ${accept ? '同意' : '不同意'}對賭`);
        return g.respondBet(seat, accept);
      }));

    socket.on('play', ({ cards }, cb) =>
      withSeat(cb, (g, seat) => g.play(seat, cards)));

    /**
     * 教練模式：幫我把手牌分組。
     *
     * §K 資訊防火牆：只看「這個座位自己的手牌」，回傳的也只有他自己的牌。
     * 沒有碰到任何別人的手牌、沒有碰到蓋起來的換牌，
     * 所以這不是作弊 —— 等於有人坐在旁邊幫你把牌理一理。
     */
    socket.on('suggestGroups', (_, cb) => {
      if (!room) return ack(cb, { ok: false, reason: '你不在任何房間' });
      const seat = room.seatOf(socket.id);
      if (seat < 0) return ack(cb, { ok: false, reason: '你不在座位上' });
      const g = room.game;
      if (!g) return ack(cb, { ok: false, reason: '現在沒有牌局' });
      const hand = g.hands[seat] || [];
      if (!hand.length) return ack(cb, { ok: true, groups: [] });
      let melds;
      try { melds = AI.decompose(hand, room.options.rules).melds; }
      catch (e) { return ack(cb, { ok: false, reason: '分不出來，手動理牌吧' }); }
      const groups = melds
        .filter((m) => m.cards.length >= 2)
        .map((m) => ({ cards: [...m.cards].sort((a, b) => a - b), label: m.meld ? m.meld.label : '' }))
        .sort((a, b) => b.cards.length - a.cards.length || a.cards[0] - b.cards[0]);
      const singles = melds.filter((m) => m.cards.length === 1).length;
      ack(cb, { ok: true, groups, hands: melds.length, singles });
    });

    socket.on('pass', (_, cb) =>
      withSeat(cb, (g, seat) => g.pass(seat)));

    // 抓牌（規範 §8.2）
    socket.on('challenge', (_, cb) =>
      withSeat(cb, (g, seat) => {
        const r = g.challengePlay(seat);
        if (r.ok) {
          nsp.to(room.code).emit('toast', r.upheld
            ? `${room.seats[seat].name} 抓到了！${r.reason} — 退回重出`
            : `${room.seats[seat].name} 抓 ${room.seats[g.challenge.seat].name}，沒抓到`);
        }
        return r;
      }));

    // §N 擲骰子（換牌張數相同時，本人自己按）
    socket.on('rollDice', (_, cb) =>
      withSeat(cb, (g, seat) => g.rollDice(seat)));

    // §P 確認結束
    socket.on('confirmFinish', (_, cb) =>
      withSeat(cb, (g, seat) => {
        const r = g.confirmFinish(seat);
        if (r.ok) {
          nsp.to(room.code).emit('toast', r.settled
            ? '三家都確認了，這一局結算'
            : `${room.seats[seat].name} 確認結束`);
        }
        return r;
      }));

    // 全體同意才動得了別人的位子，或收掉這一局
    socket.on('propose', ({ kind, target }, cb) => {
      if (!room) return ack(cb, { ok: false, reason: '你不在任何房間' });
      const seat = room.seatOf(socket.id);
      if (seat < 0) return ack(cb, { ok: false, reason: '你不在座位上' });
      if (kind !== 'BOT' && kind !== 'END') return ack(cb, { ok: false, reason: '沒有這種提案' });
      // CIO 2026-08-23：換電腦代打不用表決，開口就換。收掉整局仍要全體同意。
      if (kind === 'BOT') {
        const t = Number.isInteger(target) ? target : -1;
        if (t < 0 || t > 3 || !room.seats[t]) return ack(cb, { ok: false, reason: '沒有這個位子' });
        if (room.seats[t].isBot) return ack(cb, { ok: false, reason: '那個位子已經是電腦了' });
        if (room.seats[t].socketId) return ack(cb, { ok: false, reason: '那個人還在線上' });
        room.io.to(room.code).emit('toast', `${room.seats[t].name} 改由電腦代打`);
        return ack(cb, room.botSeat(t, true));
      }
      ack(cb, room.propose(seat, kind, target));
    });

    // 再等他一下 —— 多等永遠不傷害任何人，所以不用表決
    socket.on('extendHold', (_, cb) => {
      if (!room) return ack(cb, { ok: false, reason: '你不在任何房間' });
      const seat = room.seatOf(socket.id);
      if (seat < 0) return ack(cb, { ok: false, reason: '你不在座位上' });
      ack(cb, room.extendHold(seat));
    });

    socket.on('vote', ({ agree }, cb) => {
      if (!room) return ack(cb, { ok: false, reason: '你不在任何房間' });
      const seat = room.seatOf(socket.id);
      if (seat < 0) return ack(cb, { ok: false, reason: '你不在座位上' });
      ack(cb, room.vote(seat, agree));
    });

    socket.on('nextGame', (_, cb) => {
      if (!room) return ack(cb, { ok: false, reason: '你不在任何房間' });
      if (room.handInProgress()) {
        return ack(cb, { ok: false, reason: '這一局還沒打完。要收掉的話，提議「結束這一局」，大家同意才行' });
      }
      room.openSeating();
      ack(cb, { ok: true });
    });

    socket.on('disconnect', () => {
      if (room) { room.removePlayer(socket.id); room.broadcastLobby(); }
    });
  });

  return { rooms };
}

// 獨立執行模式
if (require.main === module) {
  const http = require('http');
  const { Server } = require('socket.io');
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);
  attach(app, io, { mount: '/' });
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`大老二伺服器啟動：http://localhost:${PORT}`));
}

module.exports = { attach, Room, rooms, sweepRooms };
