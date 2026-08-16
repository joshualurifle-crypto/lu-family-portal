# 掛進盧家遊戲入口

大老二是一個模組，不是獨立網站。入口那邊已經有 express 和 socket.io，接上去就好。

---

## 三步驟

### 1. 把資料夾放進入口專案

```
lu-family-portal/
├── server.js          ← 你的入口主程式
├── package.json
└── dalaoer/           ← 整個資料夾複製進來
    ├── src/
    ├── public/
    ├── test/
    └── package.json
```

### 2. 裝相依套件

大老二只用 `express` 和 `socket.io`，入口本來就有的話不用再裝。
保險起見在入口專案根目錄跑一次：

```bash
npm install express socket.io
```

### 3. 在入口的主程式加兩行

```js
const { attach } = require('./dalaoer/src/server');

attach(app, io, { mount: '/dalaoer' });
```

完成。<https://你的網域/dalaoer> 就是大老二。

---

## 完整範例

如果入口還沒有 socket.io，整份長這樣：

```js
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 入口首頁、其他遊戲……
app.use('/', express.static('public'));

// 大老二
const { attach } = require('./dalaoer/src/server');
attach(app, io, { mount: '/dalaoer' });

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`盧家遊戲入口：${PORT}`));
```

---

## 不會跟其他遊戲打架

`attach` 會自己開一個 socket.io namespace（預設跟 `mount` 同名）。
入口底下的撲克、麻將各走各的連線，互不干擾。

要換路徑就改 `mount`；namespace 也可以另外指定：

```js
attach(app, io, { mount: '/games/big2', namespace: '/big2' });
```

`test/mount.test.js` 就是在驗這件事：同一個 io 底下同時掛撲克桌和大老二，
確認兩邊的訊息不會外洩到對方。跑 `npm test` 會一起跑到。

---

## 上線之前要知道的事

**一定要是常駐的 node 程式。** Netlify、GitHub Pages、Vercel 的靜態方案都不行，
websocket 需要一個活著的行程。Render、Railway、Fly.io、自己的 VPS 都可以。

**要開 websocket 和 sticky session。** 如果前面有 nginx 或 Cloudflare，
記得讓 `/socket.io/` 的 Upgrade 標頭穿過去。多台機器的話要開 sticky session，
否則同一個人會被丟到不同機器上，房間就對不起來了。

nginx 大概像這樣：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

**資料都在記憶體裡。** 重開伺服器 = 所有房間和本場戰績歸零。
這是規範 §9.4 講好的：一場就是一場，不跨重開。要保留歷史就得另外接資料庫。

**沒有帳號也沒有密碼。** 拿到四碼房號的人就進得來。
家裡人互相報房號沒問題；如果網址會公開，可能要在入口那層加一道。

**閒置房間會自己清掉。** 整桌都關掉分頁的房間，兩小時後自動回收，
免得 `rooms` 越積越多。要改時間用環境變數：

```bash
DALAOER_ROOM_IDLE_MS=3600000 npm start   # 改成一小時
```

---

## 上線前的檢查清單

```bash
cd dalaoer
npm install
npm test      # 牌型、規則、抓牌、掛載、防護
npm run e2e   # 端對端走 socket 一整輪
```

兩個都要 `0 failed`。`npm test` 裡的 `mount.test.js` 就是在測掛載這件事，
它過了，接進入口就不會有意外。
