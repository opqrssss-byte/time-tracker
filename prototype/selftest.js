/* ============================================================================
   手机端原型 · 页内自测
   ----------------------------------------------------------------------------
   跑法（在仓库根目录起 python -m http.server 8899 之后，串在一条命令里）：
     playwright-cli open "http://localhost:8899/prototype/index.html"
     playwright-cli resize 375 812
     playwright-cli eval "fetch('/prototype/selftest.js').then(r=>r.text()).then(t=>eval(t))"

   返回 { pass, fail, results }，同名断言沿用 tools/widget-selftest.js 的写法。
   ⚠️ 不幂等：跑完页面上会留下"正在计时"的状态，重跑前先 reload。
   ========================================================================== */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const P = window.__proto
  const RM = P.model
  const results = {}
  const check = (name, ok, extra) => {
    results[name] = ok === true ? true : (ok === false ? false : { value: ok, ...(extra || {}) })
    console.log((ok === true ? '✓ ' : '✗ ') + name + (extra ? '  ' + JSON.stringify(extra) : ''))
  }
  const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 1e-6 : tol)

  /* canvas 局部坐标 → 屏幕上某角度的点（deg 从 12 点起、顺时针） */
  const cx = P.cx(), cy = P.cy()
  const at = (deg, r) => {
    const rad = (deg - 90) * Math.PI / 180
    const rr = r == null ? P.geom().R : r
    return { x: cx + rr * Math.cos(rad), y: cy + rr * Math.sin(rad) }
  }
  /* 从 deg0 平滑转到 deg1（模拟真实拖动，每次不超过 20°，避免被"单次上限"截断） */
  const drag = async (deg0, deg1) => {
    const a = at(deg0); P.press(a.x, a.y)
    const total = deg1 - deg0
    const n = Math.max(1, Math.ceil(Math.abs(total) / 15))
    for (let i = 1; i <= n; i++) {
      const p = at(deg0 + total * (i / n)); P.move(p.x, p.y)
      await sleep(8)
    }
    return at(deg1)
  }
  const big = () => document.getElementById('c-time').textContent
  const runningId = () => (P.st.running ? (P.st.running.category_id || '__none__') : null)

  /* ── 1. 几何：与桌面同源算法，样例数据下逐值可算 ───────────────── */
  P.useSample(); await sleep(80)
  let laid = P.laid()
  const sec = { c1: 3600, c2: 1800, c4: 7200, c5: 2400 }
  const total = 15000, restDeg = 360 - 4.5 * 2
  const expect = { c4: restDeg * 7200 / total, c1: restDeg * 3600 / total, c5: restDeg * 2400 / total, c2: restDeg * 1800 / total }
  const degOk = ['c4', 'c1', 'c5', 'c2'].every((k) => {
    const it = laid.find((x) => x.id === k)
    return it && near(it.deg, expect[k], 1e-6)
  })
  check('几何·计时分类按累计等比分配', degOk, { 实际: laid.map((x) => x.id + ':' + x.deg.toFixed(2)).join(' ') })
  check('几何·今日 0 秒为幽灵且占固定小槽', laid.filter((x) => x.ghost).length === 2 && laid.filter((x) => x.ghost).every((x) => near(x.deg, 4.5)), { ghosts: laid.filter((x) => x.ghost).map((x) => x.deg) })
  check('几何·分角合计 360°', near(laid.reduce((s, x) => s + x.deg, 0), 360, 1e-9), { sum: laid.reduce((s, x) => s + x.deg, 0) })
  check('几何·span 连续无死区', near(laid[0].spanStart, 0, 1e-9) && near(laid[laid.length - 1].spanEnd, 360, 1e-6))
  check('几何·间隙只在绘制层（span 比 draw 宽）', laid.every((x) => x.drawStart > x.spanStart && x.drawEnd < x.spanEnd))

  /* ── 2. 命中分区 ────────────────────────────────────────────── */
  const h12 = RM.hitTest(at(0).x, at(0).y, cx, cy, laid, { R: P.geom().R, SW: P.geom().SW, TOUCH_PAD: P.P.touchPad, PLATE_R: P.geom().PLATE_R, CENTER_HOLE: P.P.centerHole })
  check('命中·12 点在环带且落在首段', h12.zone === 'band' && h12.id === laid[0].id, { zone: h12.zone, id: h12.id })
  const hc = RM.hitTest(cx, cy, cx, cy, laid, { R: P.geom().R, SW: P.geom().SW, TOUCH_PAD: P.P.touchPad, PLATE_R: P.geom().PLATE_R, CENTER_HOLE: P.P.centerHole })
  check('命中·环心孔', hc.zone === 'center', { zone: hc.zone })
  const ho = RM.hitTest(cx + 400, cy, cx, cy, laid, { R: P.geom().R, SW: P.geom().SW, TOUCH_PAD: P.P.touchPad, PLATE_R: P.geom().PLATE_R, CENTER_HOLE: P.P.centerHole })
  check('命中·盘外', ho.zone === 'outside', { zone: ho.zone })

  /* ── 3. 拖动：走格 / 环绕 / 撤销手感 ─────────────────────────── */
  check('静止时无选中', P.st.focusId === null)
  await drag(0, 45); await sleep(20)
  check('拖 45° 走一格', P.st.steps === 1 && P.st.focusId === laid[0].id, { steps: P.st.steps, focus: P.st.focusId })
  check('选中态中心仍是主读数', big() === '00:00', { big: big() })

  P.cancel(); P.setFocus(null); await sleep(20)
  await drag(0, 140)
  check('连续拖多格（不超过单次上限 3）', P.st.steps <= 3 && P.st.steps >= 1, { steps: P.st.steps })
  P.cancel(); P.setFocus(null)

  await drag(0, -45)
  check('逆时针走上一格', P.st.focusId === laid[laid.length - 1].id, { focus: P.st.focusId, last: laid[laid.length - 1].id })
  P.cancel(); P.setFocus(null)

  // 抖动：每步 1°（< 1.5° 过滤）转 10 次，不该走格
  { const a = at(0); P.press(a.x, a.y)
    for (let i = 1; i <= 10; i++) { const p = at(i); P.move(p.x, p.y); await sleep(6) }
    check('抖动被过滤（连续 1° 不走格）', P.st.steps === 0, { steps: P.st.steps, drag: P.st.dragDeg.toFixed(2) })
    // 方向翻转：继续 +25° 后再 -25°，累积归零后仍不足一格
    let p = at(30); P.move(p.x, p.y); await sleep(6)
    const before = P.st.steps
    p = at(10); P.move(p.x, p.y); await sleep(6)
    check('方向翻转后累积清零', P.st.steps === before, { steps: P.st.steps, drag: P.st.dragDeg.toFixed(2) })
    P.cancel() }

  /* ── 4. 松手即确认（本轮的核心）─────────────────────────────── */
  P.useSample(); await sleep(60)
  check('初始空闲', runningId() === null)
  await drag(0, 45); P.release(at(45).x, at(45).y); await sleep(60)
  check('松手即确认：空闲 → 开始', runningId() === P.laid()[0].id, { running: runningId() })
  check('确认后清除选中态', P.st.focusId === null)
  check('确认后主读数在走', big() !== '00:00' || big() === '0:00', { big: big() })

  /* 拖到"正在计时"的分类松手 → 无操作（没有停止）。
     注意取数规则：已有计时中分类时，首次起跳是从它的**下一格**开始的（镜像桌面 stepFocus），
     所以必须转满一整圈才会绕回它 —— 这也顺便验了环绕。 */
  const runId = runningId()
  const n = P.laid().length
  const stepDeg = P.P.stepDeg
  const sweep = n * stepDeg + 5
  await drag(0, sweep)
  check('转满一圈绕回起点', P.st.focusId === runId, { focus: P.st.focusId, runId, steps: P.st.steps })
  P.release(at(sweep).x, at(sweep).y); await sleep(60)
  check('拖到运行中分类松手 → 计时不变（无停止）', runningId() === runId, { before: runId, after: runningId() })

  // 弱拖动（不足一格）松手 → 不提交
  P.useSample(); await sleep(60)
  await drag(0, 20); P.release(at(20).x, at(20).y); await sleep(60)
  check('弱拖动松手不提交', runningId() === null && P.st.steps === 0, { running: runningId(), steps: P.st.steps })

  /* ── 5. 轻点 ───────────────────────────────────────────────── */
  P.useSample(); await sleep(60)
  laid = P.laid()
  const mid = (laid[1].spanStart + laid[1].spanEnd) / 2
  { const p = at(mid); P.press(p.x, p.y); await sleep(30); P.release(p.x, p.y); await sleep(60) }
  check('轻点扇区立即切换', runningId() === laid[1].id, { want: laid[1].id, got: runningId() })

  P.setFocus(laid[2].id); await sleep(20)
  { const p = at(0, 10); P.press(p.x, p.y); await sleep(20); P.release(p.x, p.y); await sleep(30) }
  check('轻点环心清除选中', P.st.focusId === null)

  check('拖动全程页面不滚动', window.scrollY === 0 && document.documentElement.scrollTop === 0)

  /* ── 6. 空数据路径 & active 不当幽灵 ─────────────────────────── */
  P.useEmpty(); await sleep(60)
  laid = P.laid()
  check('空数据：4 个幽灵等分 360°', laid.length === 4 && laid.every((x) => x.ghost && near(x.deg, 90)), { degs: laid.map((x) => x.deg) })
  { const p = at(0); P.press(p.x, p.y); await sleep(20); P.release(p.x, p.y); await sleep(60) }
  check('空数据轻点即开始', runningId() !== null, { running: runningId() })
  const activeIt = P.laid().find((x) => x.active)
  check('开始瞬间它就不是幽灵（用户报过的 bug）', !!activeIt && activeIt.ghost === false, { item: activeIt && { id: activeIt.id, ghost: activeIt.ghost, sec: activeIt.sec } })
  check('只有一段在计时', P.laid().filter((x) => x.active).length === 1)

  /* ── 7. 超过上限合并「其他分类」─────────────────────────────── */
  P.st.categories = ['一', '二', '三', '四', '五', '六', '七', '八', '九'].map((n, i) => ({ id: 'x' + i, name: n, color: '#4F8CFF' }))
  P.st.running = null
  P.st.byCat = { x0: 10, x1: 9, x2: 8, x3: 7, x4: 6, x5: 5, x6: 4, x7: 3, x8: 2 }
  P.rebuild(); await sleep(60)
  laid = P.laid()
  check('超过 7 类合并为「其他分类」', laid.length === 8 && laid[laid.length - 1].id === '__other__', { n: laid.length, last: laid[laid.length - 1].id })

  /* ── 8. 画布 / 布局 ────────────────────────────────────────── */
  const c = document.getElementById('ring')
  const dpr = Math.min(window.devicePixelRatio || 1, 3)
  check('canvas 后备缓冲按 DPR 放大', c.width === Math.round(c.getBoundingClientRect().width * dpr), { buf: c.width, css: c.getBoundingClientRect().width, dpr })

  P.useSample(); await sleep(60)
  const app = document.getElementById('app').getBoundingClientRect()
  const over = []
  document.querySelectorAll('#app *').forEach((el) => {
    const b = el.getBoundingClientRect()
    if (b.width && b.height && (b.bottom > app.bottom + 1 || b.right > app.right + 1 || b.top < app.top - 1)) {
      over.push((el.id || el.className || el.tagName) + `(${Math.round(b.top)},${Math.round(b.bottom)})`)
    }
  })
  check('窗口内无元素溢出', over.length === 0, { over: over.slice(0, 5) })

  const pass = Object.values(results).filter((v) => v === true).length
  const fail = Object.values(results).filter((v) => v === false).length
  console.log(`── 原型自测：通过 ${pass} 项，失败 ${fail} 项 ──`)
  return { pass, fail, results }
})()
