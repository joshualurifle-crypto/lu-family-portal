'use strict';
/** 端對端測試：真的連上伺服器，用一個人類玩家 + 三個電腦打完一局盧家玩法。 */

const { io } = require('socket.io-client');
const E = require('../src/engine');
const AI = require('../src/ai');

const URL = 'http://localhost:4200';
const steps = [];
let finished = false;

const sock = io(URL, { transports: ['websocket'] });

sock.on('connect_error', (e) => { console.error('連線失敗:', e.message); process.exit(1); });

sock.on('connect', () => {
  steps.push('已連線');
  sock.emit('createRoom', { name: '約書亞' }, (r) => {
    if (!r.ok) throw new Error(r.reason);
    steps.push(`建立房間 ${r.code}，座位 ${r.seat}`);
    sock.emit('setOptions', { luMode: true, strictMode: true, turnSeconds: 0, pointValue: 5 }, () => {
      steps.push('設定：盧家玩法 / 嚴格 / 不限時 / 一分5元');
      sock.emit('startGame', {}, (r2) => {
        if (!r2.ok) throw new Error(r2.reason);
        steps.push('開始遊戲（三個空位由電腦補上）');
      });
    });
  });
});

sock.on('toast', (m) => steps.push(`  · ${m}`));

const seen = new Set();
sock.on('state', (s) => {
  if (finished) return;
  const tag = `${s.phase}:${s.turn}:${s.counts.join(',')}:${s.swap ? s.swap.picker : ''}`;
  if (!seen.has(s.phase)) { seen.add(s.phase); steps.push(`階段 → ${s.phase}`); }

  if (s.phase === 'SWAP_SELECT' && !s.swap.submitted[s.seat]) {
    const d = AI.chooseDiscards(s.hand);
    steps.push(`我蓋 ${d.length} 張：${E.cardsName(d)}`);
    sock.emit('discard', { cards: d }, (r) => { if (!r.ok) fail('蓋牌', r.reason); });
    return;
  }

  if (s.phase === 'SWAP_PICK' && s.swap.picker === s.seat) {
    const av = s.swap.available;
    if (av.length) sock.emit('pick', { poolIndex: av[0] }, (r) => {
      if (!r.ok) fail('抽牌', r.reason);
      else steps.push(`我抽到 ${E.cardName(r.card)}`);
    });
    return;
  }

  if (s.phase === 'BET_DECLARE' && (!s.declareResponses || s.declareResponses[s.seat] === undefined)) {
    const want = AI.shouldDeclareBet(s.hand);
    steps.push(`對賭宣告：我${want ? '要賭' : '不賭'}`);
    sock.emit('declareBet', { declare: want }, (r) => { if (!r.ok) fail('宣告', r.reason); });
    return;
  }

  if (s.phase === 'BET_RESPOND' && s.bet.declarer !== s.seat && !s.bet.responded.includes(s.seat)) {
    const ok = AI.shouldAcceptBet(s.hand);
    steps.push(`對賭表態：我${ok ? '同意' : '不同意'}`);
    sock.emit('respondBet', { accept: ok }, (r) => { if (!r.ok) fail('表態', r.reason); });
    return;
  }

  if (s.phase === 'PLAYING' && s.turn === s.seat) {
    const current = s.currentCards.length ? E.identify(s.currentCards) : null;
    const d = AI.choosePlay({
      hand: s.hand, current, playedCards: [],
      opponentCounts: s.counts.filter((_, i) => i !== s.seat),
      isFirstPlay: s.isFirstPlay,
    });
    if (d.action === 'pass') {
      sock.emit('pass', {}, (r) => { if (!r.ok) fail('PASS', r.reason); });
    } else {
      sock.emit('play', { cards: d.cards }, (r) => { if (!r.ok) fail('出牌', r.reason + ' → ' + E.cardsName(d.cards)); });
    }
    return;
  }

  if (s.phase === 'FINISHED' && !finished) {
    finished = true;
    const st = s.settlement;
    steps.push('');
    steps.push('=== 結算 ===');
    s.seats.forEach((p, i) => {
      steps.push(`  ${p.name.padEnd(8)} 剩 ${st.points[i]} 張   ${st.money[i] >= 0 ? '+' : ''}${st.money[i]} 元`
        + (i === st.winner ? '  ← 贏' : ''));
    });
    if (st.bet) steps.push(`  對賭：${s.seats[st.bet.declarer].name} ${st.bet.result === 'WIN' ? '成功' : '失敗'} (${st.bet.multiplier}倍)`);
    steps.push(`  今日累計：${s.ledger.totals.map((t) => `${t.name} ${t.money >= 0 ? '+' : ''}${t.money}`).join(' / ')}`);
    const sum = st.money.reduce((a, b) => a + b, 0);
    steps.push(`  金額平衡檢查：${sum === 0 ? '通過' : '失敗 ' + sum}`);
    console.log(steps.join('\n'));
    sock.close();
    process.exit(sum === 0 ? 0 : 1);
  }
});

function fail(what, why) {
  console.log(steps.join('\n'));
  console.error(`\n✗ ${what} 失敗：${why}`);
  process.exit(1);
}

setTimeout(() => { console.log(steps.join('\n')); console.error('\n✗ 逾時'); process.exit(1); }, 90000);
