"""
v1.10 真瀏覽器回歸測試（Chromium / Playwright）

  PORT=3100 node lu_family_portal.js   # 另一個視窗先開伺服器
  python3 dalaoer/test/browser_reconnect.py [base_url]

每個玩家一個獨立的 browser context（等於四支不同的手機）。
"""
import sys, time, json
from playwright.sync_api import sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:3100').rstrip('/')
URL = BASE + '/dalaoer/'
results = []

def ok(name, cond, extra=''):
    results.append((name, bool(cond)))
    print(('  ✓ ' if cond else '  ✗ ') + name + ('' if cond else f'  → {extra}'), flush=True)

TOAST_HOOK = """
window.__toasts = [];
new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => {
  if (n.classList && n.classList.contains('toast')) window.__toasts.push(n.textContent);
}))).observe(document.getElementById('toast-stack'), {childList: true});
"""

def wait_for(fn, label, timeout=15):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            if fn():
                return True
        except Exception:
            pass
        time.sleep(0.2)
    return False

def st(pg):
    return pg.evaluate("state ? {phase: state.phase, turn: state.turn, seat: state.seat, hand: state.hand.length, "
                       "paused: state.paused, isNewRound: state.isNewRound, counts: state.counts} : null")

def emit(pg, ev, data=None):
    return pg.evaluate("([ev, d]) => new Promise(r => socket.emit(ev, d || {}, x => r(x)))", [ev, data])

def open_player(browser, name):
    ctx = browser.new_context(viewport={'width': 390, 'height': 844})
    pg = ctx.new_page()
    pg.goto(URL)
    pg.wait_for_function('socket.connected', timeout=10000)
    pg.evaluate(TOAST_HOOK)
    pg.fill('#input-name', name)
    return ctx, pg

def seat_room(browser, names, lu_mode=False, coach_off=False):
    players = []
    ctx, host = open_player(browser, names[0])
    if coach_off:
        host.evaluate("localStorage.setItem('dl_coach','0'); coachOn=false;")
    host.click('#btn-create')
    host.wait_for_function('me.code', timeout=5000)
    code = host.evaluate('me.code')
    players.append((ctx, host))
    for n in names[1:]:
        c, p = open_player(browser, n)
        if coach_off:
            p.evaluate("localStorage.setItem('dl_coach','0'); coachOn=false;")
        p.fill('#input-code', code)
        p.click('#btn-join')
        p.wait_for_function('me.code', timeout=5000)
        players.append((c, p))
    if lu_mode:
        r = emit(host, 'setOptions', {'luMode': True})
        assert r and r.get('ok'), r
    r = emit(host, 'startGame')
    assert r and r.get('ok'), r
    time.sleep(0.6)
    r = emit(host, 'confirmSeats')
    assert r and r.get('ok'), r
    wait_for(lambda: all(st(p) for _, p in players), 'deal', 10)
    return code, players

def page_on_turn(players):
    s0 = st(players[0][1])
    for c, p in players:
        if st(p)['seat'] == s0['turn']:
            return c, p
    return None, None

def banner_visible(pg):
    return pg.evaluate("(() => { const b = document.getElementById('conn-banner'); return !!b && !b.classList.contains('hidden'); })()")

def act(pg):
    s = st(pg)
    if s['isNewRound']:
        hand = pg.evaluate('state.hand')
        return emit(pg, 'play', {'cards': [min(hand)]})
    return emit(pg, 'pass')

with sync_playwright() as pw:
    browser = pw.chromium.launch()

    # =====================================================================
    print('\n一、網路斷 6 秒（輪到他的時候）', flush=True)
    code, P = seat_room(browser, ['TEST-A', 'TEST-B', 'TEST-C', 'TEST-D'])
    ok('四家都拿到 13 張、進入出牌', all(st(p)['hand'] == 13 and st(p)['phase'] == 'PLAYING' for _, p in P))
    ctx, X = page_on_turn(P)
    xseat = st(X)['seat']
    ctx.set_offline(True)
    X.evaluate('socket.io.engine.close()')
    time.sleep(1.5)
    ok('斷線時畫面出現「重新連線中」提示條', banner_visible(X))
    time.sleep(4.5)
    ctx.set_offline(False)
    back = wait_for(lambda: X.evaluate('socket.connected') and not banner_visible(X), 'back', 20)
    ok('網路恢復後自動連回、提示條消失', back)
    ok('跳出「已回到你的座位」', wait_for(lambda: '已回到你的座位' in X.evaluate('window.__toasts'), 't', 5),
       X.evaluate('window.__toasts'))
    other = P[(P.index((ctx, X)) + 1) % 4][1]
    ok('其他人看到牌局沒有卡住', wait_for(lambda: st(other)['paused'] is None, 'unpause', 5), st(other))
    r = act(X)
    ok('回來的人可以直接出牌', r and r.get('ok'), r)
    ok('還坐在原本的位子', st(X)['seat'] == xseat)

    # =====================================================================
    print('\n二、螢幕鎖 65 秒（手機把連線整個砍掉）', flush=True)
    wait_for(lambda: page_on_turn(P)[1] is not None, 'turn', 5)
    ctx, Y = page_on_turn(P)
    yseat, yhand = st(Y)['seat'], st(Y)['hand']
    Y.evaluate("""socket.disconnect();
      Object.defineProperty(document, 'hidden', {configurable: true, get: () => true});
      document.dispatchEvent(new Event('visibilitychange'));""")
    other = P[(P.index((ctx, Y)) + 1) % 4][1]
    ok('輪到他而他不在 → 牌局暫停等他', wait_for(lambda: st(other)['paused'] is not None, 'pause', 8), st(other))
    time.sleep(65)
    ok('65 秒後位子還保留（沒有被電腦接走）',
       other.evaluate("state.seats[%d] && !state.seats[%d].isBot" % (yseat, yseat)))
    Y.evaluate("""Object.defineProperty(document, 'hidden', {configurable: true, get: () => false});
      document.dispatchEvent(new Event('visibilitychange'));""")
    ok('解鎖後 5 秒內自動連回', wait_for(lambda: Y.evaluate('socket.connected') and not banner_visible(Y), 'wake', 5))
    ok('牌局恢復', wait_for(lambda: st(other)['paused'] is None, 'resume', 5), st(other))
    ok('手牌原封不動', st(Y)['hand'] == yhand and st(Y)['seat'] == yseat, st(Y))
    r = act(Y)
    ok('解鎖後可以直接出牌', r and r.get('ok'), r)

    # =====================================================================
    print('\n三、分頁被關掉，開新分頁（同一支手機）', flush=True)
    ctxZ, Z = P[2]
    zseat, zhand = st(Z)['seat'], st(Z)['hand']
    Z.close()
    Z2 = ctxZ.new_page()
    Z2.goto(URL)
    Z2.evaluate(TOAST_HOOK)
    ok('新分頁不用打名字就回到原位',
       wait_for(lambda: Z2.evaluate('state && state.seat') == zseat, 'reseat', 10),
       Z2.evaluate('me'))
    ok('手牌張數一致', wait_for(lambda: st(Z2)['hand'] == zhand, 'hand', 5), st(Z2))
    P[2] = (ctxZ, Z2)
    ok('入口畫面已經收起來', Z2.evaluate("document.getElementById('screen-game').classList.contains('active')"))

    # =====================================================================
    print('\n四、連續斷線 5 次', flush=True)
    ctxW, W = P[1]
    wseat = st(W)['seat']
    for k in range(5):
        W.evaluate('socket.io.engine.close()')
        time.sleep(1.2 if k % 2 else 3.0)
    ok('五次之後仍連線、提示條消失',
       wait_for(lambda: W.evaluate('socket.connected') and not banner_visible(W), 'w', 15))
    ok('位子沒變', st(W)['seat'] == wseat)
    ok('牌局沒有卡在暫停', wait_for(lambda: st(P[0][1])['paused'] is None, 'p', 5), st(P[0][1]))
    # 把牌局推進到 W，確認他動得了
    moved = False
    for _ in range(12):
        c, T = page_on_turn(P)
        if T is None:
            time.sleep(0.3); continue
        r = act(T)
        if T is W:
            moved = r and r.get('ok')
            break
        time.sleep(0.3)
    ok('輪到他時照樣出得了牌', moved)
    for c, p in P:
        c.close()

    # =====================================================================
    print('\n五、教練：換牌、對賭之前自動打開（盧家玩法）', flush=True)
    code, Q = seat_room(browser, ['COACH-A', 'COACH-B', 'COACH-C', 'COACH-D'], lu_mode=True, coach_off=True)
    ok('進入換牌階段', all(st(p)['phase'] == 'SWAP_SELECT' for _, p in Q), [st(p)['phase'] for _, p in Q])
    ok('四家的教練都自動打開', all(p.evaluate('coachOn') for _, p in Q))
    ok('教練已經把牌分好組', wait_for(lambda: all(p.evaluate('groups.length > 0') for _, p in Q), 'g', 5))
    qb = Q[1][1]
    btn = qb.locator('button', has_text='教練 ✓').first
    btn.click()
    ok('玩家可以自己關掉', qb.evaluate('coachOn') is False)
    # 大家都不蓋牌 → 直接進對賭
    for _, p in Q:
        emit(p, 'discard', {'cards': []})
    reached = wait_for(lambda: st(qb)['phase'] == 'BET_DECLARE', 'bet', 8)
    ok('進入對賭階段', reached, st(qb))
    ok('對賭前教練又自動打開（剛剛關掉的人也是）', wait_for(lambda: qb.evaluate('coachOn'), 'c', 3))
    shot = '/tmp/claude-0/coach_bet.png'
    qb.screenshot(path=shot)
    for c, p in Q:
        c.close()

    browser.close()

passed = sum(1 for _, g in results if g)
print(f'\n{passed} passed, {len(results) - passed} failed', flush=True)
sys.exit(0 if passed == len(results) else 1)
