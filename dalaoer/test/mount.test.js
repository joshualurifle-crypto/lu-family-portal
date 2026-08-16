'use strict';
/**
 * 掛進盧家遊戲入口的驗證（規範 A-8）
 *
 * 模擬入口：同一個 express + 同一個 socket.io，
 * 底下同時掛著另一個遊戲，確認兩邊不會互相干擾。
 *
 *   node test/mount.test.js
 */

const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const ioc = require('socket.io-client');
const { attach } = require('../src/server');

const PORT = 4322;
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(path) {
  return new Promise((res) => {
    http.get(`http://localhost:${PORT}${path}`, (r) => {
      let body = '';
      r.on('data', (d) => { body += d; });
      r.on('end', () => res({ status: r.statusCode, body }));
    }).on('error', () => res({ status: 0, body: '' }));
  });
}

function connect(ns) {
  return new Promise((res, rej) => {
    const c = ioc(`http://localhost:${PORT}${ns}`, { transports: ['websocket'], forceNew: true });
    c.__msgs = [];
    c.onAny((ev, payload) => c.__msgs.push({ ev, payload }));
    c.on('connect', () => res(c));
    c.on('connect_error', rej);
  });
}

const emit = (c, ev, payload) => new Promise((res) => {
  if (payload === undefined) c.emit(ev, null, res); else c.emit(ev, payload, res);
});

async function main() {
  // ---- 假的盧家遊戲入口 ----
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);

  app.get('/', (req, res) => res.send('盧家遊戲入口'));

  // 另一個遊戲，掛在自己的 namespace（模擬既有的撲克桌）
  const poker = io.of('/dealer');
  poker.on('connection', (socket) => {
    socket.on('ping-poker', (_, cb) => cb({ ok: true, from: 'poker' }));
  });

  // 大老二掛進來
  attach(app, io, { mount: '/dalaoer' });

  await new Promise((r) => server.listen(PORT, r));
  console.log(`\n入口啟動於 ${PORT}\n`);

  console.log('一、靜態檔案掛在正確的路徑底下');
  const home = await get('/');
  ok('入口首頁還在', home.status === 200 && home.body.includes('盧家遊戲入口'));

  const page = await get('/dalaoer/');
  ok('大老二頁面出得來', page.status === 200, `status=${page.status}`);
  ok('是中文介面', page.body.includes('大老二'));
  ok('頁面會載入 namespace 設定', page.body.includes('ns.js'));

  const ns = await get('/dalaoer/ns.js');
  ok('ns.js 回得出來', ns.status === 200, `status=${ns.status}`);
  ok('指向 /dalaoer namespace', ns.body.includes('"/dalaoer"'), ns.body);

  console.log('\n二、兩個遊戲的連線互不干擾');
  const pk = await connect('/dealer');
  const dl = await connect('/dalaoer');

  const pong = await emit(pk, 'ping-poker');
  ok('撲克桌照常運作', pong && pong.ok && pong.from === 'poker', JSON.stringify(pong));

  const made = await emit(dl, 'createRoom', { name: '約書亞' });
  ok('大老二可以開房', made.ok, JSON.stringify(made));

  pk.__msgs.length = 0;
  await emit(dl, 'startGame');
  await sleep(400);

  ok('大老二收到自己的座位畫面', dl.__msgs.some((m) => m.ev === 'seating'));
  ok('撲克桌沒有被波及', pk.__msgs.length === 0,
    JSON.stringify(pk.__msgs.map((m) => m.ev)));

  console.log('\n三、大老二的指令不會外洩到別的 namespace');
  // 沒有人接的話 ack 永遠不會回來，所以這裡自己設一個時限
  const strayed = await Promise.race([
    emit(pk, 'createRoom', { name: '亂入' }),
    sleep(800).then(() => '__無人接聽__'),
  ]);
  ok('撲克桌那邊沒有 createRoom 可以叫', strayed === '__無人接聽__',
    JSON.stringify(strayed));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  [pk, dl].forEach((c) => { try { c.disconnect(); } catch (e) { /* ignore */ } });
  io.close();
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('\n測試爆了：', e.message);
  console.error(e.stack);
  process.exit(1);
});
