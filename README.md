# 盧家遊樂園 · Lu Family Game Portal

德州撲克 · 台灣麻將十六張 · 合約橋牌 · 大老二 — 一個 Node 程序，電視當牌桌，手機當手牌。

---

## Deploying to Render (clean slate)

**This folder is the whole application.** Nothing else is needed. Do not upload
`node_modules` — Render builds it from `package.json`.

### 1. Wipe what is there now

In the Render dashboard, on the `lu-family-portal` service:

- **Settings → Delete Service**, then create a new Web Service, **or**
- if you deploy from Git: delete every file in the repository, commit the deletion,
  then copy this folder in and commit that. A clean history is not required —
  an empty commit followed by these files is enough.

Deleting the service also clears the build cache, which is the cleanest option
and takes about a minute to recreate.

### 2. Service settings

| Field | Value |
|---|---|
| Environment | Node |
| Build command | `npm install` |
| Start command | `npm start` |
| Node version | 18 or newer (`engines` in package.json already asks for this) |
| Health check path | `/` |

No environment variables are required. Render supplies `PORT` and the server reads it.

### 3. What you get

| URL | Who opens it |
|---|---|
| `https://lu-family-portal.onrender.com/` | The TV / big screen — 大廳, seating, and the card table |
| `https://lu-family-portal.onrender.com/join` | Every phone — scan the QR on the TV |
| `https://lu-family-portal.onrender.com/dalaoer/` | 大老二 (its own room codes) |

---

## Two things to know about running on Render rather than the living-room Wi-Fi

**1. The free tier sleeps.** After about 15 minutes with nobody connected, Render
stops the service. All game state is held in memory, so a sleep ends whatever
table was open. The first person back waits ~30 seconds for it to wake, and starts
a fresh table. If that becomes annoying, a paid instance stays awake.

**2. The address is public.** On the home Wi-Fi only the family could reach the
server, so it has no passwords and no access control — that was the ruling, and it
was the right one for a LAN. On the open internet anyone who has the link can join
the table, and from the TV page can also reorder seats or remove players. Nobody
can see another player's cards — that protection is real and unchanged — but the
table itself is open to anyone with the URL.

For a family game on an obscure URL that is usually fine. If it stops being fine,
say so and a door code takes about twenty minutes to add.

---

## Running it at home instead

```bash
npm install
npm start
```

The console prints the LAN address for the TV and for the phones.

## Self-checks

```bash
MJ_TEST=50 npm start          # 50 mahjong hands, asserts the scoring balances
node regress_mjclaim.js       # claim window vs a disconnected player (no server needed)
```

The full test suites and the independent-review pack live in
`LU_PORTAL_REVIEW_2026-08-23_revC.zip`, not in this deploy folder — they are not
needed to run the game and would pull in extra dependencies.

## What is in here

| File | What it is |
|---|---|
| `lu_family_portal.js` | The portal: HTTP + SSE server, poker, mahjong and bridge engines, and both web pages |
| `dalaoer/src/` | 大老二 rules, game state, computer player, socket server |
| `dalaoer/public/` | 大老二 phone client |
| `package.json` | Dependencies and the start script — this is the only one Render reads |
