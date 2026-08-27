/* B. 麻將宣告視窗：斷線的人不能被 10 秒自動 PASS 掉。
 * 直接把入口的麻將引擎抽出來跑，才能精準造出「宣告視窗開著 + 那個人斷線」的狀態，
 * 不用等牌局碰運氣發生。
 */
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/lu_family_portal.js', 'utf8');
const a = src.indexOf('/* ================= MAHJONG ENGINE');
const b = src.indexOf('/* ================= BRIDGE ENGINE');
if (a < 0 || b < 0) { console.error('could not locate the mahjong section'); process.exit(1); }

let broadcasts = 0;
const harness = `
  let G = { game:"mahjong", pace:0, players:[] };
  function broadcast(){ __bc(); }
  ${src.slice(a, b)}
  module.exports = { get M(){return M;}, get G(){return G;},
    mjClaimTimeout, mjSeatWatching, resolveClaims, botClaim, seatP, WINDC };
`;
const file = '/tmp/mjharness.js';
fs.writeFileSync(file, 'const __bc = () => { global.__bcCount = (global.__bcCount||0)+1; };\n' + harness);
const H = require(file);

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  → ' + x : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('\nB. 麻將：宣告視窗遇到斷線的人');

  const G = H.G, M = H.M;
  // 座位 0 = 真人（等一下讓他斷線），1~3 = 電腦
  G.players.push({ id: 'h0', token: 't0', isAI: false, name: '阿媽', connected: true, mjScore: 0 });
  for (let k = 1; k < 4; k++) G.players.push({ id: 'b' + k, token: null, isAI: true, name: '電腦' + k, connected: true, mjScore: 0 });
  M.seats = [0, 1, 2, 3].map((pi) => ({ pi, hand: [], melds: [], flowers: [], discards: [], drawn: null, auto: false }));
  M.phase = 'play'; M.handOver = false; M.seq = 1; M.claimSeq = 0;

  // 手上有兩張二萬 → 別人打二萬時可以碰。這是會改變輸贏的一手。
  M.seats[0].hand = [1, 1, 5, 9, 14, 20, 22, 27, 28, 30, 31, 12, 13, 17, 18, 19];

  ok('這個位子是真人，而且在線上', H.mjSeatWatching(0));

  // 造出宣告視窗：座位 1 打出二萬，座位 0 可以碰
  M.pending = { kind: 'discard', tile: 1, from: 1,
    claims: [{ seat: 0, opts: { win: false, pong: true, gang: false, chi: [] }, resp: null }] };
  M.claimUntil = Date.now() + 10;

  // ── 1. 人斷線了 ────────────────────────────────────────────────
  G.players[0].connected = false;
  ok('斷線之後就不算「有人看著」', !H.mjSeatWatching(0));

  const cs = ++M.claimSeq, sq = M.seq;
  H.mjClaimTimeout(cs, sq);                    // 10 秒到，視窗到期
  ok('視窗沒有被自動 PASS 掉', !!M.pending && M.pending.claims[0].resp === null,
    JSON.stringify(M.pending && M.pending.claims));
  ok('碰的機會還在', !!M.pending && M.pending.claims[0].opts.pong === true);

  // 撐過去好幾輪重試（現實是 5 分鐘，這裡驗的是「不會自己放棄」）
  for (let k = 0; k < 4; k++) { H.mjClaimTimeout(cs, sq); await sleep(30); }
  ok('反覆到期也不會替他決定', !!M.pending && M.pending.claims[0].resp === null);
  ok('視窗時限一直往後推，畫面才不會顯示過期', M.claimUntil > Date.now(),
    String(M.claimUntil - Date.now()));

  // ── 2. 人回來了 → 視窗照常運作 ─────────────────────────────────
  G.players[0].connected = true;
  ok('回來之後又算「有人看著」', H.mjSeatWatching(0));
  H.mjClaimTimeout(cs, sq);
  ok('人在線上，10 秒到就照規則算 PASS，牌桌不會卡住', !M.pending || M.pending.claims[0].resp !== null,
    JSON.stringify(M.pending && M.pending.claims));

  // ── 3. 交給電腦 → 視窗立刻放行 ─────────────────────────────────
  M.pending = { kind: 'discard', tile: 1, from: 1,
    claims: [{ seat: 0, opts: { win: false, pong: true, gang: false, chi: [] }, resp: null }] };
  G.players[0].connected = false;
  M.seats[0].auto = true;
  ok('交給電腦之後不再算「等真人」', !H.mjSeatWatching(0));
  const cs2 = ++M.claimSeq;
  H.mjClaimTimeout(cs2, M.seq);
  ok('代打的位子不會把牌桌卡住', !M.pending || M.pending.claims[0].resp !== null,
    JSON.stringify(M.pending && M.pending.claims));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
