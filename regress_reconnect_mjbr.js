/* C. 麻將／橋牌：被電腦代打的人，連回來就把位子還他（IND DIR 2026-09-27 issue #2）
 * 真的起一個伺服器、用 SSE 連線來跑，驗證的是實際上線的路徑。
 *
 *   node regress_reconnect_mjbr.js
 */
const { spawn } = require('child_process');
const http = require('http');

const PORT = 3117;
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  → ' + x : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function post(path, data) {
  return new Promise((res) => {
    const body = JSON.stringify(data || {});
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (r) => {
      let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { res({ raw: b }); } });
    });
    req.end(body);
  });
}

/** 開一條 SSE；last 永遠是最新的一筆 */
function sse(token) {
  const c = { last: null, req: null };
  c.req = http.get({ host: '127.0.0.1', port: PORT, path: '/events' + (token ? '?token=' + token : '') }, (r) => {
    let buf = '';
    r.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (line) { try { c.last = JSON.parse(line.slice(6)); } catch (e) { /* ignore */ } }
      }
    });
  });
  c.req.on('error', () => {});
  c.close = () => { try { c.req.destroy(); } catch (e) { /* ignore */ } };
  return c;
}

async function until(fn, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch (e) { /* not yet */ } await sleep(50); }
  return false;
}

(async () => {
  for (const game of ['mahjong', 'bridge']) {
  const srv = spawn(process.execPath, [__dirname + '/lu_family_portal.js'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  await sleep(1200);
  try {
    const A = await post('/api/join', { name: '阿公' });
    const B = await post('/api/join', { name: '阿媽' });
    const host = sse(null);
    let sa = sse(A.token), sb = sse(B.token);
    await sleep(400);
    {
      console.log('\n' + (game === 'mahjong' ? 'C1. 麻將' : 'C2. 橋牌'));
      await post('/api/portal', { game });
      const st = await post(game === 'mahjong' ? '/api/mj/start' : '/api/br/start', { base: 30, tai: 10 });
      ok('開局', st.ok, JSON.stringify(st));
      await until(() => host.last && host.last.game === game && host.last.pub.seats && host.last.pub.seats.length === 4);
      const seatOf = (name) => host.last.pub.seats.findIndex((x) => x.name === name);
      const autoOf = (name) => !!host.last.pub.seats[seatOf(name)].auto;
      const idB = host.last.pub.roster.find((r) => r.name === '阿媽').id;
      const sB = seatOf('阿媽');
      const autoPath = game === 'mahjong' ? '/api/mj/auto' : '/api/br/auto';

      // ── 斷線 → 被踢成電腦代打 → 連回來 ───────────────────
      sb.close(); await sleep(300);
      await post('/api/kick', { id: idB });
      ok('斷線被踢 → 電腦代打', await until(() => autoOf('阿媽')));
      sb = sse(B.token);
      ok('連回來就把位子還她', await until(() => !autoOf('阿媽')), JSON.stringify(host.last.pub.seats[sB]));

      // ── 她不在時，房主按「代打」 → 連回來也還她 ─────────────
      sb.close(); await sleep(300);
      const t1 = await post(autoPath, { seat: sB });
      ok('離線時被按代打', t1.ok && await until(() => autoOf('阿媽')), JSON.stringify(t1));
      sb = sse(B.token);
      ok('連回來一樣還她', await until(() => !autoOf('阿媽')));

      // ── 她自己在線上按「代打」 → 重新連線不會被取消 ─────────
      await sleep(300);
      await post(autoPath, { seat: sB });
      ok('在線上自己選代打', await until(() => autoOf('阿媽')));
      sb.close(); await sleep(300); sb = sse(B.token); await sleep(800);
      ok('手機重新連線後，還是照她的意思代打', autoOf('阿媽'));
      await post(autoPath, { seat: sB });
      ok('她自己按還原就回來', await until(() => !autoOf('阿媽')));

      // ── 牌局沒有被這些切換弄壞 ───────────────────────────
      ok('牌局還在進行', host.last.pub.phase === 'play', host.last.pub.phase);
    }
    sa.close(); sb.close(); host.close();
  } finally {
    srv.kill();
    await sleep(400);
  }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
