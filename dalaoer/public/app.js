'use strict';
/* 大老二 · 前端 */

// 掛在入口底下時要連對 namespace（見 src/server.js 的 attach）
const socket = io(window.DALAOER_NS || '/');
const $ = (id) => document.getElementById(id);

const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
const SUITS = ['♣', '♦', '♥', '♠'];
const rankOf = (c) => Math.floor(c / 4);
const suitOf = (c) => c % 4;

let me = { seat: null, name: '', code: null, hostSeat: 0 };
let state = null;
let selected = new Set();
let options = { luMode: false, strictMode: true, pointValue: 5 };

// ───────────────────────────────────────── 工具


function toast(msg, warn) {
  const el = document.createElement('div');
  el.className = 'toast' + (warn ? ' warn' : '');
  el.textContent = msg;
  $('toast-stack').appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

/** 座位名字。turn / picker 在某些階段是 null，直接取 .name 會整個畫面掛掉。 */
function nameOf(seat) {
  const st = (state && state.seats && seat !== null && seat !== undefined)
    ? state.seats[seat] : null;
  return st ? st.name : '';
}

function cardEl(card, opts = {}) {
  const el = document.createElement('div');
  const suit = suitOf(card);
  el.className = 'card' + (suit === 1 || suit === 2 ? ' red' : '')
    + (opts.small ? ' small' : '') + (opts.static ? ' static' : '');
  el.innerHTML = `<span class="corner"><b>${RANKS[rankOf(card)]}</b><i>${SUITS[suit]}</i></span>`
    + `<span class="pip">${SUITS[suit]}</span>`;
  el.dataset.card = card;
  return el;
}

function backEl(opts = {}) {
  const el = document.createElement('div');
  el.className = 'card back' + (opts.small ? ' small' : '')
    + (opts.pickable ? ' pickable' : '') + (opts.taken ? ' taken' : '');
  return el;
}

function money(n) {
  const cls = n > 0 ? 'plus' : n < 0 ? 'minus' : '';
  const sign = n > 0 ? '+' : '';
  return `<span class="money ${cls}">${sign}${n}</span>`;
}

function showSheet(html) {
  $('sheet').innerHTML = html;
  $('overlay').classList.remove('hidden');
}
function hideSheet() { $('overlay').classList.add('hidden'); }

// ───────────────────────────────────────── 重連用的識別（規範 §8.3）
// 只記在這台裝置上，沒有帳號也沒有密碼

function saveTicket(code, token, name) {
  if (!code || !token) return;
  try {
    window.name = JSON.stringify({ dalaoer: { code, token, name } });
  } catch (e) { /* 無所謂，最多就是要重打名字 */ }
}

function readTicket(code) {
  try {
    const t = JSON.parse(window.name || '{}').dalaoer;
    if (t && (!code || t.code === code)) return t.token;
  } catch (e) { /* 沒有就算了 */ }
  return undefined;
}

function readTicketFull() {
  try { return JSON.parse(window.name || '{}').dalaoer || null; } catch (e) { return null; }
}

// ───────────────────────────────────────── 進入畫面

/**
 * 一進頁面就先看看這台裝置上有沒有上次的座位。
 * 有的話直接帶著 token 回去，不用重打名字和房號。
 * 這就是斷線之後的「回來玩」——不需要另外一顆按鈕。
 */
(function autoRejoin() {
  const t = readTicketFull();
  if (!t || !t.code || !t.token) return;
  socket.on('connect', function once() {
    socket.off('connect', once);
    socket.emit('joinRoom', { code: t.code, name: t.name, token: t.token }, (r) => {
      if (!r || !r.ok) return;                 // 房間沒了就當作沒事，留在入口畫面
      me.seat = r.seat; me.code = r.code; me.name = t.name;
      saveTicket(r.code, r.token, t.name);
      $('panel-entry').classList.add('hidden');
      $('panel-room').classList.remove('hidden');
      toast(r.resumed ? '歡迎回來，回到你原本的位子' : '已重新入座');
    });
  });
}());

$('btn-create').onclick = () => {
  const name = $('input-name').value.trim();
  if (!name) return toast('先輸入你的名字', true);
  me.name = name;
  socket.emit('createRoom', { name }, (r) => {
    if (!r.ok) return toast(r.reason, true);
    me.seat = r.seat; me.code = r.code;
    saveTicket(r.code, r.token, name);
    $('panel-entry').classList.add('hidden');
    $('panel-room').classList.remove('hidden');
  });
};

$('btn-join').onclick = () => {
  const name = $('input-name').value.trim();
  const code = $('input-code').value.trim().toUpperCase();
  if (!name) return toast('先輸入你的名字', true);
  if (code.length !== 4) return toast('房間代碼是四個字', true);
  me.name = name;
  socket.emit('joinRoom', { code, name, token: readTicket(code) }, (r) => {
    if (!r.ok) return toast(r.reason, true);
    me.seat = r.seat; me.code = r.code;
    saveTicket(r.code, r.token, name);
    if (r.resumed) toast('歡迎回來，牌局繼續');
    $('panel-entry').classList.add('hidden');
    $('panel-room').classList.remove('hidden');
  });
};

$('btn-start').onclick = () => {
  socket.emit('startGame', {}, (r) => { if (!r.ok) toast(r.reason, true); });
};

// 設定：分段按鈕
document.querySelectorAll('.segmented').forEach((group) => {
  group.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (me.seat !== me.hostSeat) return toast('只有房主可以改設定', true);
    group.querySelectorAll('button').forEach((b) => b.classList.remove('on'));
    btn.classList.add('on');
    const key = group.dataset.key;
    const raw = btn.dataset.value;
    options[key] = raw === 'true' ? true : raw === 'false' ? false : Number(raw);
    socket.emit('setOptions', { [key]: options[key] }, () => {});
  });
});

// 設定：加減
document.querySelectorAll('.stepper').forEach((group) => {
  group.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (me.seat !== me.hostSeat) return toast('只有房主可以改設定', true);
    const key = group.dataset.key;
    options[key] = Math.max(1, Math.min(500, options[key] + Number(btn.dataset.delta)));
    $('point-value').textContent = options[key];
    socket.emit('setOptions', { [key]: options[key] }, () => {});
  });
});

socket.on('lobby', (data) => {
  me.code = data.code;
  me.hostSeat = data.hostSeat;
  options = { ...options, ...data.options };
  $('room-code-value').textContent = data.code;
  $('point-value').textContent = options.pointValue;

  document.querySelectorAll('.segmented').forEach((g) => {
    const val = String(options[g.dataset.key]);
    g.querySelectorAll('button').forEach((b) =>
      b.classList.toggle('on', b.dataset.value === val));
  });

  const list = $('seat-list');
  list.innerHTML = '';
  data.seats.forEach((s, i) => {
    const li = document.createElement('li');
    if (!s) { li.className = 'empty'; li.textContent = `座位 ${i + 1} · 空著（電腦會補）`; }
    else {
      li.textContent = s.name + (i === me.seat ? '（你）' : '');
      const tag = document.createElement('span');
      if (i === data.hostSeat && !s.isBot) { tag.className = 'seat-tag host'; tag.textContent = '房主'; }
      else if (s.isBot) { tag.className = 'seat-tag bot'; tag.textContent = '電腦'; }
      if (tag.textContent) li.appendChild(tag);
    }
    list.appendChild(li);
  });

  const isHost = me.seat === data.hostSeat;
  $('btn-start').disabled = !isHost;
  $('btn-start').textContent = isHost ? '開始' : '等房主開始';
  $('host-hint').textContent = isHost
    ? '空位會由電腦補上。'
    : `房主是 ${data.seats[data.hostSeat] ? data.seats[data.hostSeat].name : '—'}。`;
});

// ───────────────────────────────────────── 座位確認（規範 §5.2）

let seatingData = null;

socket.on('seating', (data) => {
  seatingData = data;
  me.hostSeat = data.hostSeat;
  if (data.seat !== undefined) me.seat = data.seat;   // 伺服器才知道你現在坐哪
  $('screen-game').classList.remove('active');
  $('screen-lobby').classList.add('active');
  $('panel-entry').classList.add('hidden');
  $('panel-room').classList.add('hidden');
  $('panel-seating').classList.remove('hidden');
  renderSeating();
});

function renderSeating() {
  const box = $('seating-list');
  box.innerHTML = '';
  seatingData.seats.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'seat-row' + (i === me.seat ? ' seat-me' : '');

    const left = document.createElement('button');
    left.className = 'seat-move';
    left.textContent = '◀';
    left.onclick = () => socket.emit('moveSeat', { seat: i, direction: 'left' }, (r) => {
      if (!r.ok) toast(r.reason, true);
    });

    const label = document.createElement('div');
    label.className = 'seat-name';
    label.innerHTML = `<span class="seat-no">${i + 1}</span>${s ? s.name : '空位'}` +
      (i === me.seat ? '<span class="seat-tag">你</span>' : '') +
      (s && s.isBot ? '<span class="seat-tag bot">電腦</span>' : '');

    const right = document.createElement('button');
    right.className = 'seat-move';
    right.textContent = '▶';
    right.onclick = () => socket.emit('moveSeat', { seat: i, direction: 'right' }, (r) => {
      if (!r.ok) toast(r.reason, true);
    });

    row.append(left, label, right);
    box.appendChild(row);
  });
}

$('btn-confirm-seats').onclick = () => {
  socket.emit('confirmSeats', {}, (r) => { if (!r.ok) toast(r.reason, true); });
};

socket.on('toast', (msg) => toast(msg));

// ───────────────────────────────────────── 牌桌

socket.on('state', (s) => {
  state = s;
  me.seat = s.seat;
  me.hostSeat = s.hostSeat;
  $('panel-seating').classList.add('hidden');
  $('screen-lobby').classList.remove('active');
  $('screen-game').classList.add('active');
  render();
});

function render() {
  if (!state) return;
  try { renderAll(); } catch (err) {
    // 畫面出錯不該把整桌卡死：記下來，下一次 state 進來再畫一次
    console.error('render 失敗：', err);
  }
}

function renderAll() {
  selected = new Set([...selected].filter((c) => state.hand.includes(c)));
  if (coachOn) applyCoach(false);      // 出過牌之後自動重理
  renderOpponents();
  renderCenter();
  renderSwapMode();
  renderSortBar();
  renderGroups();
  renderHand();
  renderActions();
  renderWaiting();
  renderChallenge();
  renderHistory();
  renderDice();
  renderProvisional();
  renderProposal();
  renderPause();
  renderTimer();
  if (state.phase === 'FINISHED') renderSettlement();
  else if ($('overlay').classList.contains('hidden') === false
           && !$('sheet').dataset.keep) hideSheet();
}

function renderOpponents() {
  const box = $('opponents');
  box.innerHTML = '';
  for (let k = 1; k <= 3; k++) {
    const seat = (me.seat + k) % 4;
    const p = state.seats[seat];
    const count = state.counts[seat];
    const div = document.createElement('div');
    div.className = 'opp'
      + (state.turn === seat && state.phase === 'PLAYING' ? ' turn' : '')
      + (count <= 2 ? ' danger' : '');
    const status = state.passed[seat] ? '不出'
      : state.revealedSeat === seat ? '攤牌中'
      : state.lastPlayerSeat === seat && state.currentCards.length ? '出牌' : '';
    div.innerHTML = `
      <div class="opp-avatar">${p.name.slice(-1)}
        <span class="opp-count">${count}</span>
      </div>
      <div class="opp-name">${p.name}</div>
      <div class="opp-status ${status === '不出' ? 'pass' : ''}">${status}</div>`;
    box.appendChild(div);
  }
}

function renderCenter() {
  const label = $('center-label');
  const pile = $('pile');
  const note = $('phase-note');
  pile.innerHTML = '';
  note.textContent = '';

  if (state.phase === 'SWAP_SELECT') {
    label.textContent = '換牌 · 蓋牌';
    const done = state.swap.submitted.map((v, i) => v ? nameOf(i) : null).filter(Boolean);
    note.textContent = state.swap.submitted[me.seat]
      ? `已蓋 ${state.swap.discardCounts[me.seat]} 張，等其他人（已完成：${done.join('、')}）`
      : (swapPick === 'keep'
        ? '點你要留下來的牌，沒點到的就會被蓋掉。'
        : '點你要蓋掉的牌，張數自己決定，然後按「蓋牌」。');
    return;
  }

  if (state.phase === 'SWAP_PICK') {
    label.textContent = '換牌 · 抽回';
    const picker = state.swap.picker;
    note.textContent = picker === me.seat
      ? `輪到你，還要抽 ${state.swap.picksRemaining} 張`
      : `${nameOf(picker)} 正在抽牌（還要 ${state.swap.picksRemaining} 張）`;
    renderPool();
    return;
  }

  if (state.phase === 'SWAP_DICE') {
    label.textContent = '換牌 · 擲骰子';
    const mine = state.dice && state.dice.needed.includes(me.seat);
    note.textContent = mine
      ? '你跟人蓋的張數一樣多，按「擲骰子」分先後。'
      : '等蓋牌張數相同的人擲骰子。';
    return;
  }

  if (state.phase === 'PROVISIONAL_FINISH') {
    label.textContent = '等三家確認';
    note.textContent = state.provisional && state.provisional.winner === me.seat
      ? '你出完了，等其他三家確認或抓你最後一手。'
      : '確認結束之後就不能再抓了。';
    if (state.currentCards.length) {
      state.currentCards.slice().sort((a, b) => a - b)
        .forEach((c) => pile.appendChild(cardEl(c, { static: true })));
    }
    return;
  }

  if (state.phase === 'BET_DECLARE') {
    label.textContent = '對賭';
    note.textContent = '覺得這副牌一定贏，就宣告對賭：三家都答應才成立。';
    return;
  }

  if (state.phase === 'BET_RESPOND') {
    label.textContent = '對賭';
    note.textContent = `${nameOf(state.bet.declarer)} 宣告對賭，等大家表態。`;
    return;
  }

  if (state.currentCards.length) {
    label.textContent = `${nameOf(state.lastPlayerSeat)} 出的 ${state.currentLabel || ''}`;
    state.currentCards.slice().sort((a, b) => a - b)
      .forEach((c) => pile.appendChild(cardEl(c, { static: true })));
  } else {
    label.textContent = state.turn === me.seat ? '你開牌' : `${nameOf(state.turn)} 開牌`;
    if (state.isFirstPlay) note.textContent = '你持有 ♣3，先開牌。要出什麼都可以。';
  }

  if (state.revealedSeat !== null && state.revealedSeat !== undefined && state.revealedHand) {
    const who = nameOf(state.revealedSeat);
    const wrap = document.createElement('div');
    wrap.className = 'pool-owner';
    wrap.innerHTML = `<h3>${who} 攤開的牌（對賭中）</h3>`;
    const row = document.createElement('div');
    row.className = 'pool-cards';
    state.revealedHand.forEach((c) => row.appendChild(cardEl(c, { small: true, static: true })));
    wrap.appendChild(row);
    note.appendChild(wrap);
  }
}

function renderPool() {
  const note = $('phase-note');
  const myTurn = state.swap.picker === me.seat;
  const available = new Set(state.swap.available);

  const order = [0, 1, 2, 3].filter((o) => o !== me.seat).concat([me.seat]);
  for (const owner of order) {
    const cards = state.swap.pool.filter((p) => p.owner === owner);
    if (!cards.length) continue;
    const wrap = document.createElement('div');
    wrap.className = 'pool-owner';
    const left = cards.filter((c) => !c.taken).length;
    wrap.innerHTML = `<h3>${nameOf(owner)}${owner === me.seat ? '（你）' : ''} 蓋的 · 剩 ${left} 張</h3>`;
    const row = document.createElement('div');
    row.className = 'pool-cards';
    cards.forEach((c) => {
      const el = backEl({ small: true, taken: c.taken, pickable: myTurn && available.has(c.i) });
      if (myTurn && available.has(c.i)) {
        el.onclick = () => socket.emit('pick', { poolIndex: c.i }, (r) => {
          if (!r.ok) toast(r.reason, true);
          else toast(`抽到 ${SUITS[suitOf(r.card)]}${RANKS[rankOf(r.card)]}`);
        });
      }
      row.appendChild(el);
    });
    wrap.appendChild(row);
    note.appendChild(wrap);
  }
  if (myTurn && !state.swap.pool.some((p) => !p.taken && p.owner !== me.seat)) {
    const p = document.createElement('p');
    p.textContent = '別人的牌抽完了，只好抽回自己蓋的。';
    note.appendChild(p);
  }
}

/**
 * 理牌。伺服器只管牌在不在你手上，怎麼排是你家的事。
 *   rank  依大小排（3 最小、2 最大），同點數再依花色
 *   suit  依花色分堆，堆內再依大小
 * 選擇會記在 handSort，換局也留著。
 */
let handSort = 'rank';

// 換牌時，有人習慣點「要丟的」，有人習慣點「要留的」。兩種都給。
let swapPick = 'discard';   // 'discard' = 點到的丟掉；'keep' = 點到的留著

/** 依目前模式，算出真正要蓋掉的牌 */
function cardsToDiscard() {
  if (swapPick === 'keep') return state.hand.filter((c) => !selected.has(c));
  return [...selected];
}

// ───────────────────────────────────────── 分組（把組好的牌先放一邊）
// 純粹是這台裝置上的整理，伺服器完全不知道，也不影響任何規則。
let groups = [];   // [[card,...], ...]

/** 手上已經被分進某一組的牌 */
function groupedCards() {
  const set = new Set();
  groups.forEach((g) => g.forEach((c) => set.add(c)));
  return set;
}

/** 出過的牌要從組裡拿掉；組空了就丟掉 */
function pruneGroups() {
  const inHand = new Set(state.hand);
  groups = groups
    .map((g) => g.filter((c) => inHand.has(c)))
    .filter((g) => g.length > 0);
}

// ───────────────────────────────────────── 教練模式（自動理牌）
// 伺服器用電腦玩家那一套拆解，把手牌拆成最少的出牌手數，
// 再把每一組送回來。只看得到自己的牌，看不到別人的 —— 等於旁邊坐了個人幫你理牌。
let coachOn = localStorage.getItem('dl_coach') === '1';
let coachSig = '';          // 手牌指紋，變了才重算
let coachInfo = null;       // {hands, singles}

function handSignature() {
  return (state && state.hand ? state.hand : []).slice().sort((a, b) => a - b).join(',');
}

function applyCoach(force) {
  if (!state || !state.hand || !state.hand.length) return;
  const sig = handSignature();
  if (!force && (!coachOn || sig === coachSig)) return;
  coachSig = sig;
  socket.emit('suggestGroups', {}, (r) => {
    if (!r || !r.ok) { if (force) toast(r && r.reason ? r.reason : '理不動', true); return; }
    groups = (r.groups || []).map((g) => g.cards.slice());
    coachInfo = { hands: r.hands, singles: r.singles };
    selected.clear();
    render();
  });
}

function toggleCoach() {
  coachOn = !coachOn;
  localStorage.setItem('dl_coach', coachOn ? '1' : '0');
  if (coachOn) { coachSig = ''; applyCoach(true); }
  else { groups = []; coachInfo = null; render(); }
}

/** 理牌用的按鈕（教練／分組／重選）——任何可以選牌的階段都該有 */
function addTidyButtons(add) {
  add(coachOn ? '教練 ✓' : '教練 Coach', coachOn ? 'btn-coach-on' : '', () => toggleCoach());
  if (!coachOn) add('幫我理一次', '', () => applyCoach(true));
  if (selected.size >= 2) add('分成一組', '', makeGroup);
  if (selected.size) add('重選', '', () => { selected.clear(); render(); });
}

/** 把目前選的牌收成一組 */
function makeGroup() {
  const cards = [...selected].filter((c) => state.hand.includes(c));
  if (cards.length < 2) return toast('至少選兩張才分得成一組', true);
  // 這些牌如果原本在別組，先從那邊拿掉
  groups = groups.map((g) => g.filter((c) => !cards.includes(c))).filter((g) => g.length);
  groups.push(cards.sort((a, b) => a - b));
  selected.clear();
  render();
}

/** 這一組是什麼牌型（純提示，看不出來就不寫） */
function groupLabel(cards) {
  const m = identifyLocal(cards);
  return m || '';
}

/** 客戶端的簡易牌型辨識，只為了在組上標個名字 */
function identifyLocal(cards) {
  const n = cards.length;
  const ranks = cards.map(rankOf).sort((a, b) => a - b);
  const suits = cards.map(suitOf);
  const same = ranks.every((r) => r === ranks[0]);
  if (n === 1) return '單張';
  if (n === 2) return same ? '對子' : '';
  if (n === 3) return same ? '三條' : '';
  if (n !== 5) return '';
  const flush = suits.every((x) => x === suits[0]);
  const LADDER = [[11, 12, 0, 1, 2], [12, 0, 1, 2, 3], [0, 1, 2, 3, 4], [1, 2, 3, 4, 5],
    [2, 3, 4, 5, 6], [3, 4, 5, 6, 7], [4, 5, 6, 7, 8], [5, 6, 7, 8, 9],
    [6, 7, 8, 9, 10], [7, 8, 9, 10, 11]];
  const set = new Set(ranks);
  const straight = set.size === 5 && LADDER.some((seq) => seq.every((r) => set.has(r)));
  if (straight && flush) return '同花順';
  const counts = {};
  ranks.forEach((r) => { counts[r] = (counts[r] || 0) + 1; });
  const sizes = Object.values(counts).sort((a, b) => b - a);
  if (sizes[0] === 4) return '鐵支';
  if (sizes[0] === 3 && sizes[1] === 2) return '葫蘆';
  if (flush) return '同花';
  if (straight) return '順子';
  return '';
}

function renderGroups() {
  const box = $('groups');
  if (!box) return;
  pruneGroups();
  const tally = $('coach-tally');
  if (tally) {
    if (coachOn && coachInfo) {
      tally.classList.remove('hidden');
      tally.textContent = '教練：這手牌最少 ' + coachInfo.hands + ' 手出得完'
        + (coachInfo.singles ? '（其中 ' + coachInfo.singles + ' 張孤張）' : '');
    } else tally.classList.add('hidden');
  }
  if (!groups.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  box.innerHTML = '';

  groups.forEach((g, gi) => {
    const wrap = document.createElement('div');
    const allSelected = g.every((c) => selected.has(c));
    wrap.className = 'group' + (allSelected ? ' group-on' : '');

    const head = document.createElement('div');
    head.className = 'group-head';
    const label = groupLabel(g);
    head.innerHTML = `<span>${label || `${g.length} 張`}</span>`;
    const x = document.createElement('button');
    x.className = 'group-x';
    x.textContent = '×';
    x.title = '拆開這一組';
    x.onclick = (e) => {
      e.stopPropagation();
      groups.splice(gi, 1);
      render();
    };
    head.appendChild(x);

    const row = document.createElement('div');
    row.className = 'group-cards';
    g.forEach((c) => row.appendChild(cardEl(c, { small: true, static: true })));

    // 點整組 = 一次選起來（或一次取消）
    wrap.onclick = () => {
      if (allSelected) g.forEach((c) => selected.delete(c));
      else g.forEach((c) => selected.add(c));
      render();
    };

    wrap.append(head, row);
    box.appendChild(wrap);
  });
}

function sortedHand() {
  const inGroup = groupedCards();
  const h = state.hand.filter((c) => !inGroup.has(c));
  if (handSort === 'suit') {
    return h.sort((a, b) => suitOf(a) - suitOf(b) || rankOf(a) - rankOf(b));
  }
  return h.sort((a, b) => a - b);   // card id 本身就是 rank 優先的順序
}

function renderSwapMode() {
  const bar = $('swap-mode');
  if (!bar) return;
  if (state.phase !== 'SWAP_SELECT' || state.swap.submitted[me.seat]) {
    bar.classList.add('hidden'); bar.innerHTML = ''; return;
  }
  bar.classList.remove('hidden');
  const drop = cardsToDiscard().length;
  bar.innerHTML = `
    <span class="swap-hint">點牌選：</span>
    <button class="sort-btn ${swapPick === 'discard' ? 'on' : ''}" data-m="discard">要蓋的</button>
    <button class="sort-btn ${swapPick === 'keep' ? 'on' : ''}" data-m="keep">要留的</button>
    <span class="swap-count">會蓋掉 ${drop} 張</span>`;
  bar.querySelectorAll('.sort-btn').forEach((b) => {
    b.onclick = () => { swapPick = b.dataset.m; selected.clear(); render(); };
  });
}

function renderSortBar() {
  const bar = $('sort-bar');
  if (!bar) return;
  const canSort = state.phase === 'SWAP_SELECT' || state.phase === 'SWAP_PICK'
    || state.phase === 'PLAYING' || state.phase === 'PROVISIONAL_FINISH'
    || state.phase === 'BET_DECLARE' || state.phase === 'BET_RESPOND';
  if (!canSort) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  bar.innerHTML = `
    <button class="sort-btn ${handSort === 'rank' ? 'on' : ''}" data-sort="rank">依大小</button>
    <button class="sort-btn ${handSort === 'suit' ? 'on' : ''}" data-sort="suit">依花色</button>`;
  bar.querySelectorAll('.sort-btn').forEach((b) => {
    b.onclick = () => { handSort = b.dataset.sort; render(); };
  });
}

function renderHand() {
  const box = $('hand');
  box.innerHTML = '';
  // 牌隨時都選得起來，不用等輪到自己——不然想趁空檔理牌、分組都做不了。
  // 真正的限制在「出牌」那個按鈕上，伺服器也會再擋一次。
  const selectable = state.phase === 'SWAP_SELECT'
    ? !state.swap.submitted[me.seat]
    : ['PLAYING', 'PROVISIONAL_FINISH', 'BET_DECLARE', 'BET_RESPOND'].includes(state.phase);

  sortedHand().forEach((c) => {
    const el = cardEl(c, { static: !selectable });
    if (selected.has(c)) {
      el.classList.add('selected');
      // 選「要留的」時，被點到的是留下來的牌，用不同顏色，免得看反
      if (state.phase === 'SWAP_SELECT' && swapPick === 'keep') el.classList.add('selected-keep');
    }
    if (selectable) {
      el.onclick = () => {
        if (selected.has(c)) selected.delete(c); else selected.add(c);
        render();   // 整個重畫，「會蓋掉幾張」才會跟著動
      };
    }
    box.appendChild(el);
  });
}

function renderActions() {
  const box = $('actions');
  box.innerHTML = '';
  const add = (text, cls, fn, disabled) => {
    const b = document.createElement('button');
    b.className = 'btn ' + (cls || '');
    b.textContent = text;
    b.disabled = !!disabled;
    b.onclick = fn;
    box.appendChild(b);
    return b;
  };

  if (state.phase === 'SWAP_SELECT') {
    if (state.swap.submitted[me.seat]) { add('等其他人蓋牌', '', () => {}, true); return; }
    const drop = cardsToDiscard();
    add(`蓋牌（${drop.length} 張）`, 'btn-primary', () => {
      socket.emit('discard', { cards: drop }, (r) => {
        if (!r.ok) toast(r.reason, true); else selected.clear();
      });
    });
    if (selected.size >= 2) add('分成一組', '', makeGroup);
    if (selected.size) add('重選', '', () => { selected.clear(); render(); });
    return;
  }

  if (state.phase === 'SWAP_PICK') { add('抽牌中', '', () => {}, true); return; }

  // §N 蓋牌張數一樣多 → 自己按，大家都看得到點數
  if (state.phase === 'SWAP_DICE') {
    const mustRoll = state.dice && state.dice.needed.includes(me.seat);
    if (mustRoll) {
      add('擲骰子', 'btn-primary', () => {
        socket.emit('rollDice', {}, (r) => {
          if (!r.ok) return toast(r.reason, true);
          toast(`你擲出 ${r.value} 點`);
        });
      });
    } else {
      add('等其他人擲骰子', '', () => {}, true);
    }
    return;
  }

  // §P 有人出完了，但要三家都確認才算數
  if (state.phase === 'PROVISIONAL_FINISH') {
    const p = state.provisional;
    if (p.winner === me.seat) { add('等其他三家確認', '', () => {}, true); return; }
    if (p.confirmed.includes(me.seat)) { add('已確認，等其他人', '', () => {}, true); return; }
    add('確認結束', 'btn-primary', () => {
      socket.emit('confirmFinish', {}, (r) => { if (!r.ok) toast(r.reason, true); });
    });
    return;
  }

  if (state.phase === 'BET_DECLARE') {
    if (state.declareResponses && state.declareResponses[me.seat] !== undefined) {
      add('等其他人決定', '', () => {}, true);
      addTidyButtons(add);          // 等別人決定時照樣可以理牌
      return;
    }
    add('我要對賭', 'btn-danger', () => {
      showSheet(`
        <h2 class="bet">確定要對賭？</h2>
        <p>三家都答應才成立。成立之後你的牌要全部攤開。<br>
           贏：三家各付你 <strong>三倍</strong>。<br>
           輸：你付贏家 <strong>十倍</strong>。</p>
        <button class="btn btn-danger" id="bet-yes">確定宣告</button>
        <button class="btn" id="bet-no">再想想</button>`);
      $('bet-yes').onclick = () => {
        hideSheet();
        socket.emit('declareBet', { declare: true }, (r) => { if (!r.ok) toast(r.reason, true); });
      };
      $('bet-no').onclick = hideSheet;
    });
    add('不賭', '', () => {
      socket.emit('declareBet', { declare: false }, (r) => { if (!r.ok) toast(r.reason, true); });
    });
    addTidyButtons(add);            // 要不要賭，先把牌理清楚再說
    return;
  }

  if (state.phase === 'BET_RESPOND') {
    if (state.bet.declarer === me.seat) { add('等三家表態', '', () => {}, true); addTidyButtons(add); return; }
    if (state.bet.responded.includes(me.seat)) { add('已表態', '', () => {}, true); addTidyButtons(add); return; }
    add('同意對賭', 'btn-danger', () =>
      socket.emit('respondBet', { accept: true }, (r) => { if (!r.ok) toast(r.reason, true); }));
    add('不同意', '', () =>
      socket.emit('respondBet', { accept: false }, (r) => { if (!r.ok) toast(r.reason, true); }));
    addTidyButtons(add);            // 表態之前先分組，看清楚自己有幾手
    return;
  }

  if (state.phase === 'PLAYING') {
    if (state.turn !== me.seat) {
      add(`等 ${nameOf(state.turn)} 出牌`, '', () => {}, true);
      // 等別人的時候正好可以理牌
      addTidyButtons(add);
      return;
    }
    add(`出牌（${selected.size} 張）`, 'btn-primary', () => {
      if (!selected.size) return toast('先選牌', true);
      socket.emit('play', { cards: [...selected] }, (r) => {
        if (!r.ok) toast(r.reason, true); else selected.clear();
      });
    }, !selected.size);
    addTidyButtons(add);
    add('不出', '', () => {
      socket.emit('pass', {}, (r) => { if (!r.ok) toast(r.reason, true); });
    }, state.isNewRound);
  }
}

// ───────────────────────────────────────── 抓牌（規範 §8.2）
// 每一手都可以抓，按下去才由伺服器判定——按鈕本身不會洩漏答案

// §N 骰子點數是公開的
function renderDice() {
  const box = $('dice');
  if (!box) return;
  const d = state.dice;
  if (!d || (state.phase !== 'SWAP_DICE' && state.phase !== 'SWAP_PICK')) {
    box.classList.add('hidden'); box.innerHTML = ''; return;
  }
  box.classList.remove('hidden');
  const rows = state.seats.map((st, i) => {
    const v = d.rolls[i];
    const waiting = d.needed.includes(i);
    if (v === undefined && !waiting) return '';
    return `<div class="dice-row${i === me.seat ? ' dice-me' : ''}">
      <span class="dice-name">${st.name}</span>
      <span class="dice-val">${v === undefined ? '等擲…' : `${v} 點`}</span>
    </div>`;
  }).join('');
  box.innerHTML = `<div class="dice-title">蓋的張數一樣，擲骰子分先後</div>${rows}`;
}

// §P 誰確認了、誰還沒，全桌都看得到
function renderProvisional() {
  const box = $('provisional');
  if (!box) return;
  const p = state.provisional;
  if (state.phase !== 'PROVISIONAL_FINISH' || !p) {
    box.classList.add('hidden'); box.innerHTML = ''; return;
  }
  box.classList.remove('hidden');
  const rows = state.seats.map((st, i) => {
    if (i === p.winner) return '';
    const done = p.confirmed.includes(i);
    return `<div class="conf-row">
      <span class="conf-name">${st.name}</span>
      <span class="conf-mark ${done ? 'done' : ''}">${done ? '✓' : '等待'}</span>
    </div>`;
  }).join('');
  box.innerHTML = `
    <div class="conf-title">${nameOf(p.winner)} 出完了</div>
    <div class="conf-sub">三家都確認才算數</div>${rows}`;
}

/**
 * 出牌歷史。最近幾手橫向排開，最新的一手加亮，
 * 這樣不用記也看得出誰出過什麼、這一墩打到哪裡。
 */
/**
 * 常駐提示：現在在等誰做什麼。
 * 畫面不動的時候，玩家至少知道是卡在誰身上，而不是以為當掉了。
 */
function renderWaiting() {
  const box = $('waiting');
  if (!box) return;
  const w = state.waiting;
  if (!w || !w.seats.length || state.phase === 'FINISHED') {
    box.classList.add('hidden'); box.innerHTML = ''; return;
  }
  const mine = w.seats.includes(me.seat);
  const others = w.seats.filter((i) => i !== me.seat).map(nameOf);
  box.classList.remove('hidden');
  box.classList.toggle('waiting-me', mine);

  if (mine && !others.length) {
    box.innerHTML = `<strong>輪到你${w.what}</strong>，大家在等你`;
  } else if (mine) {
    box.innerHTML = `<strong>等你${w.what}</strong>　還有：${others.join('、')}`;
  } else {
    box.innerHTML = `等 <strong>${others.join('、')}</strong> ${w.what}`;
  }
}

function renderHistory() {
  const box = $('history');
  if (!box) return;
  // 只顯示「這一墩」的出牌。一墩結束就自動清掉，
  // 不然打久了整條會拖得又長又難看（CIO 8/16）。
  const all = state.history || [];
  const h = all.filter((e) => e.trick === state.trickNo);
  if (!h.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');

  const latest = h.length - 1;
  box.innerHTML = h.map((entry, i) => {
    const cards = entry.cards.slice().sort((a, b) => a - b).map((c) => {
      const suit = suitOf(c);
      const red = suit === 1 || suit === 2 ? ' red' : '';
      return `<span class="hist-card${red}">${RANKS[rankOf(c)]}${SUITS[suit]}</span>`;
    }).join('');
    return `<div class="hist-item${i === latest ? ' hist-latest' : ''}">
      <div class="hist-who">${nameOf(entry.seat)}${entry.seat === me.seat ? '（你）' : ''}</div>
      <div class="hist-cards">${cards}</div>
      <div class="hist-label">${entry.label}</div>
    </div>`;
  }).join('');
  box.scrollLeft = box.scrollWidth;
}

function renderChallenge() {
  const box = $('challenge');
  const w = state.challengeWindow;
  const mine = w && w.playSeat === me.seat;
  const alreadyConfirmed = state.provisional
    && state.provisional.confirmed.includes(me.seat);
  if (!w || mine || alreadyConfirmed || state.options.strictMode) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }

  const who = nameOf(w.playSeat);
  box.classList.remove('hidden');
  box.innerHTML = `<button class="btn btn-catch" id="btn-catch">抓 ${who} 這手</button>`;
  $('btn-catch').onclick = () => {
    socket.emit('challenge', {}, (r) => {
      if (!r.ok) return toast(r.reason, true);
      if (!r.upheld) toast('沒抓到，那手是合法的，這手定案');
    });
  };
}

// ───────────────────────────────────────── 有人斷線就整桌凍結（規範 §5.3）

/**
 * 全體同意的提案（CIO 定案）。
 * 沒有倒數了，所以要動別人的位子、或收掉這一局，
 * 都得在線上的其他真人全部點頭。一個人不同意就作廢。
 */
function renderProposal() {
  const box = $('proposal');
  if (!box) return;
  const p = state.proposal;
  if (!p) { box.classList.add('hidden'); box.innerHTML = ''; return; }

  const mustVote = p.voters.includes(me.seat) && p.votes[me.seat] === undefined;
  const waiting = p.voters.filter((v) => p.votes[v] === undefined)
    .map((v) => nameOf(v));
  const what = p.kind === 'BOT'
    ? `把 ${p.targetName} 換成電腦代打`
    : '結束這一局（不算分、不算錢）';

  box.classList.remove('hidden');
  box.innerHTML = `
    <div class="prop-card">
      <div class="prop-title">${p.byName} 提議</div>
      <div class="prop-what">${what}</div>
      <div class="prop-sub">要在場的人全部同意才算數</div>
      ${mustVote ? `
        <button class="btn btn-primary" id="prop-yes">我同意</button>
        <button class="btn" id="prop-no">不同意</button>`
    : `<div class="prop-wait">等 ${waiting.join('、') || '大家'} 表態…</div>`}
    </div>`;

  if (mustVote) {
    $('prop-yes').onclick = () => socket.emit('vote', { agree: true },
      (r) => { if (!r.ok) toast(r.reason, true); });
    $('prop-no').onclick = () => socket.emit('vote', { agree: false },
      (r) => { if (!r.ok) toast(r.reason, true); });
  }
}

/** 開一個提案。任何一家都可以發起。 */
function propose(kind, target) {
  socket.emit('propose', { kind, target }, (r) => {
    if (!r.ok) toast(r.reason, true);
  });
}

let holdTick = null;

function holdText(until) {
  if (!until) return '';
  const left = Math.max(0, until - Date.now());
  if (left <= 0) return '等候時間到了';
  const m = Math.floor(left / 60000);
  const sec = Math.floor((left % 60000) / 1000);
  return `還等 ${m}:${String(sec).padStart(2, '0')}`;
}

function renderPause() {
  const box = $('pause');
  if (holdTick) { clearInterval(holdTick); holdTick = null; }
  if (!state.paused) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  const { seat, name, until, extends: exts } = state.paused;
  const expired = until && Date.now() >= until;
  box.classList.remove('hidden');
  box.innerHTML = `
    <div class="pause-card">
      <div class="pause-title">${name} 斷線了</div>
      <div class="pause-sub">
        牌局打到輪到他才停下來等，手牌不會變。<br>
        等不到就按「換電腦代打」— 他回來隨時可以把位子要回去。
      </div>
      <div class="hold-line ${expired ? 'hold-out' : ''}" id="hold-left">${holdText(until)}</div>
      <button class="btn btn-primary" id="btn-hold">再等 5 分鐘</button>
      <button class="btn ${expired ? 'btn-danger' : ''}" id="btn-prop-bot">換電腦代打</button>
      <button class="btn ${expired ? 'btn-danger' : ''}" id="btn-prop-end">提議結束這一局</button>
      <div class="pause-note">${exts ? `已經延長 ${exts} 次 · ` : ''}換電腦：誰按都算。結束這一局：要全部同意</div>
    </div>`;
  $('btn-hold').onclick = () => socket.emit('extendHold', {},
    (r) => { if (!r.ok) toast(r.reason, true); });
  $('btn-prop-bot').onclick = () => propose('BOT', seat);
  $('btn-prop-end').onclick = () => propose('END');
  if (until) {
    holdTick = setInterval(() => {
      const el = $('hold-left');
      if (!el) { clearInterval(holdTick); holdTick = null; return; }
      el.textContent = holdText(until);
      if (Date.now() >= until) el.classList.add('hold-out');
    }, 1000);
  }
}

// §I 已經沒有任何倒數了。這裡只負責把舊的計時器欄位清乾淨。
function renderTimer() {
  const el = $('timer');
  if (el) { el.textContent = ''; el.classList.remove('urgent'); }
}

function renderSettlement() {
  const s = state.settlement;
  if (!s) return;
  const rows = state.seats.map((p, i) => {
    const isWin = i === s.winner;
    return `<tr>
      <td class="${isWin ? 'win' : ''}">${p.name}${i === me.seat ? '（你）' : ''}${isWin ? ' 🏆' : ''}</td>
      <td>${s.points[i]} 分</td>
      <td>${money(s.money[i])}</td></tr>`;
  }).join('');

  const betNote = s.bet
    ? `<p>${nameOf(s.bet.declarer)} 對賭${s.bet.result === 'WIN' ? '成功' : '失敗'}
        · ${s.bet.multiplier} 倍</p>`
    : '';

  const ledgerRows = state.ledger.totals
    .map((t) => `<tr><td>${t.name}</td><td></td><td>${money(t.money)}</td></tr>`).join('');
  const blankNote = (s.blanks || []).some(Boolean)
    ? `<p class="blank-note">${s.blanks.map((b, i) => (b ? nameOf(i) : null))
        .filter(Boolean).join('、')} 整局沒出過牌，賠雙倍。</p>`
    : '';

  const isHost = me.seat === me.hostSeat;
  showSheet(`
    <h2>${nameOf(s.winner)} 贏了</h2>
    ${betNote}
    ${blankNote}
    <table class="result-table">
      <tr><th>玩家</th><th>剩牌</th><th>本局</th></tr>
      ${rows}
    </table>
    ${(s.transfers || []).length ? `<h2 style="font-size:20px">誰付誰</h2>
      <table class="result-table">${s.transfers.map((t) =>
    `<tr><td>${t.fromName}</td><td>→ ${t.toName}</td><td>${money(-t.amount).replace('-', '')}${t.blank ? ' <span class="blank-tag">白板×2</span>' : ''}</td></tr>`).join('')}</table>` : ''}
    <h2 style="font-size:20px">本場累計（${sessionLabel()}）</h2>
    <table class="result-table">${ledgerRows}</table>
    <button class="btn btn-primary" id="btn-next" ${isHost ? '' : 'disabled'}>
      ${isHost ? '再來一局' : '等房主開下一局'}
    </button>`);
  $('sheet').dataset.keep = '1';
  const next = $('btn-next');
  if (next && isHost) next.onclick = () => {
    delete $('sheet').dataset.keep;
    hideSheet();
    socket.emit('nextGame', {}, (r) => { if (!r.ok) toast(r.reason, true); });
  };
}

/** 本場是從開桌算起的，不是從今天零點算起（規範 §9.4） */
function sessionLabel() {
  const t = state && state.ledger && state.ledger.sessionStart;
  if (!t) return '';
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

$('btn-ledger').onclick = () => {
  if (!state || !state.ledger) return;
  const rows = state.ledger.totals
    .map((t) => `<tr><td>${t.name}</td><td>${money(t.money)}</td></tr>`).join('');
  const hist = state.ledger.history.length
    ? state.ledger.history.slice().reverse().map((h) =>
        `<tr><td>${h.time}</td><td>${h.winner} 贏${h.bet ? '（對賭）' : ''}</td></tr>`).join('')
    : '<tr><td colspan="2">這一場還沒有紀錄。</td></tr>';
  showSheet(`
    <h2>本場戰績</h2>
    <p>${sessionLabel()}開桌 · 一分 ${state.options.pointValue} 元</p>
    <table class="result-table"><tr><th>玩家</th><th>累計</th></tr>${rows}</table>
    <h2 style="font-size:20px">每局</h2>
    <table class="result-table">${hist}</table>
    <button class="btn" id="btn-close">關閉</button>`);
  $('sheet').dataset.keep = '1';
  $('btn-close').onclick = () => { delete $('sheet').dataset.keep; hideSheet(); };
};

$('overlay').onclick = (e) => {
  if (e.target === $('overlay') && !$('sheet').dataset.keep) hideSheet();
};

socket.on('disconnect', () => toast('連線中斷，重新整理看看', true));
