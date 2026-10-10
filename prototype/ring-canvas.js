/* ============================================================================
   手机端环形交互 · canvas 绘制 + 手势状态机
   ----------------------------------------------------------------------------
   搬迁到小程序时本文件 → pages/timer/timer.js，差异只有三处（见 README）：
     1. 取尺寸：getBoundingClientRect → wx.createSelectorQuery().select().fields({node,size})
     2. 事件：pointer/touch 归一 → bindtouchstart / catchtouchmove / bindtouchend
     3. 触感：navigator.vibrate → wx.vibrateShort
   其余（几何、状态机、绘制、参数）原样复用。
   ========================================================================== */
(function () {
  const RM = window.RingModel
  const $ = (id) => document.getElementById(id)

  /* ---------- 一、参数（调试面板直接读写同一对象） ---------- */
  const DEFAULTS = {
    scale: 1.6,          // 几何总缩放：桌面常量 × scale
    ringCy: 330,         // 环心距页面顶部（px）：偏下一点，落在单手拇指的舒展区
    stepDeg: 40,         // 拖动多少度走一格
    jitterDeg: 1.5,      // 小于它的角度变化忽略（滤触摸抖动）
    maxStepsPerMove: 3,  // 单次 touchmove 最多跳几格
    stepCooldownMs: 0,   // 步进冷却（默认关；觉得甩得快会跳再开）
    tapMoveTolDeg: 8,    // 旋转量小于它、且时长短，才算"轻点"
    tapMaxMs: 350,
    touchPad: 16,        // 环带命中相对视觉环拓宽（px）
    centerHole: 34,      // 环心孔半径：不参与旋转（手指压圆心角度抖得厉害）
    outPush: 1.35,       // 选中扇区线宽倍率（外推的 canvas 替身，绝不动半径）
    detentDeg: 3.5,      // 档位回弹角度
    detentMs: 160,
    glow: 7,             // 同色辉光
    ghostDeg: 4.5,       // 幽灵扇区角度（= 桌面代码值；DESIGN §3.1 写的 6° 是过期的）
    maxSectors: 7,
    breathe: 1,          // active 呼吸
    haptic: 1,           // 步进触感
    toastOnSwitch: 1,
  }
  const P = Object.assign({}, DEFAULTS)

  /* 桌面基准常量（site/app.js:362-368），乘 scale 得到手机端几何 */
  const BASE = { R: 54, SW: 11, GAP_VIS: 4, PLATE_R: 76 }
  let G = {}
  const geomOpts = () => ({
    R: G.R, SW: G.SW, GAP_VIS: G.GAP_VIS, PLATE_R: G.PLATE_R,
    TOUCH_PAD: P.touchPad, CENTER_HOLE: P.centerHole,
  })

  /* ---------- 二、数据（内存 mock，不连云端） ---------- */
  const SAMPLE_CATS = [
    { id: 'c1', name: '工作', color: '#4F8CFF' },
    { id: 'c2', name: '学习', color: '#9B6DFF' },
    { id: 'c3', name: '运动', color: '#2FBF71' },
    { id: 'c4', name: '生活', color: '#F2A93B' },
    { id: 'c5', name: '阅读', color: '#23B8D5' },
    { id: 'c6', name: '写作', color: '#F06EAA' },
  ]
  const SEED_CATS = SAMPLE_CATS.slice(0, 4)     // 与正式首登 loadCategories() 的种子一致

  const st = {
    categories: [], byCat: {}, latest: {}, running: null,
    laid: [],
    focusId: null, pressFocusId: null,
    pressing: false, pressZone: null, pressHitId: null,
    lastAngle: null, dragDeg: 0, dragSign: 0, netDeg: 0, moved: false,
    downT: 0, steps: 0, lastStepAt: 0, lastZone: '-', lastR: 0, lastDeg: 0,
  }

  function useSample() {
    st.categories = SAMPLE_CATS.slice()
    st.byCat = { c1: 3600, c2: 1800, c4: 7200, c5: 2400 }
    st.latest = { c1: '写周报', c2: '看论文', c4: '买菜做饭', c5: '读《设计心理学》' }
    st.running = null
    resetInteract()
    rebuild()
  }
  function useEmpty() {
    st.categories = SEED_CATS.slice()
    st.byCat = {}
    st.latest = {}
    st.running = null
    resetInteract()
    rebuild()
  }
  function resetInteract() {
    st.focusId = null; st.pressFocusId = null
    st.pressing = false; st.dragDeg = 0; st.dragSign = 0; st.netDeg = 0; st.moved = false
  }

  const catById = (id) => st.categories.find((c) => c.id === id) || null
  const nameOf = (id) => (id === '__none__' ? '未分类' : id === '__other__' ? '其他分类' : (catById(id) ? catById(id).name : ''))
  const runningId = () => (st.running ? (st.running.category_id || '__none__') : null)

  /* ---------- 三、动画值（三根独立补间，全部走同一个 rAF） ---------- */
  const mkAnim = (v) => ({ cur: v, from: v, to: v, t0: 0, ms: 0 })
  const AN = { push: mkAnim(0), detent: mkAnim(0), flash: mkAnim(0) }
  const easeOut = (p) => 1 - Math.pow(1 - p, 3)

  function animateTo(a, to, ms, now) {
    if (a.to === to && a.ms > 0) return
    a.from = a.cur; a.to = to; a.t0 = now; a.ms = ms
    kick()
  }
  function animStep(a, now) {
    if (a.ms <= 0) { a.cur = a.to; return false }
    const p = Math.min(1, (now - a.t0) / a.ms)
    a.cur = a.from + (a.to - a.from) * easeOut(p)
    if (p >= 1) { a.ms = 0; a.cur = a.to; return false }
    return true
  }

  /* ---------- 四、画布 ---------- */
  const canvas = $('ring')
  const ctx = canvas.getContext('2d')
  let CW = 0, CH = 0, CX = 0, CY = 0, DPR = 1
  let TH = { track: 'rgba(20,30,50,.07)', ghost: 'rgba(20,30,50,.11)', glowK: 0.6, glowA: 0.40, ghostA: 1 }

  function readTheme() {
    const cs = getComputedStyle(document.documentElement)
    TH.track = cs.getPropertyValue('--track').trim() || TH.track
    TH.ghost = cs.getPropertyValue('--ghost').trim() || TH.ghost
    /* 辉光要跟主题走：深色画布上它是提气的霓虹边，浅色画布上同样的强度只会显脏。
       对比截图见 docs/screenshots/_proto-glow7.png（浅色·全强度）与 _proto-glow0.png（关掉）。 */
    const dark = document.documentElement.getAttribute('data-theme') === 'dark'
    TH.glowK = dark ? 1 : 0.55
    TH.glowA = dark ? 0.6 : 0.38
  }

  function layoutCanvas() {
    const r = canvas.getBoundingClientRect()
    CW = Math.max(1, Math.round(r.width))
    CH = Math.max(1, Math.round(r.height))
    DPR = Math.min(window.devicePixelRatio || 1, 3)
    canvas.width = Math.round(CW * DPR)
    canvas.height = Math.round(CH * DPR)
    CX = CW / 2
    CY = CH / 2
  }

  /* 角度换算：本层口径是"12 点起、顺时针"，canvas 的 0 在 3 点，故 −90° */
  const rad = (deg) => (deg - 90) * Math.PI / 180

  function draw(now) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    ctx.clearRect(0, 0, CW, CH)
    ctx.save()
    ctx.translate(CX, CY)
    if (AN.detent.cur) ctx.rotate(AN.detent.cur * Math.PI / 180)

    // 轨道底环
    ctx.beginPath()
    ctx.arc(0, 0, G.R, 0, Math.PI * 2)
    ctx.lineWidth = G.SW
    ctx.strokeStyle = TH.track
    ctx.stroke()

    for (const it of st.laid) {
      const focused = st.focusId === it.id
      const active = !!it.active
      let w = G.SW
      if (focused) w = G.SW * (1 + (P.outPush - 1) * AN.push.cur)
      else if (active) w = G.SW * (1 + (P.outPush - 1) * 0.22 * AN.flash.cur)

      let alpha = 1
      if (active && P.breathe) {
        alpha = 0.74 + 0.26 * (0.5 + 0.5 * Math.sin(now / 2400 * Math.PI * 2))
      }

      ctx.beginPath()
      ctx.arc(0, 0, G.R, rad(it.drawStart), rad(it.drawEnd))
      ctx.lineWidth = w
      ctx.lineCap = 'round'
      ctx.strokeStyle = it.ghost ? TH.ghost : it.color

      if (active || focused || AN.flash.cur > 0.01) {
        /* 定标结论（本机 Chromium，dpr 1/2/3 对比截图）：shadowBlur **随当前变换缩放**，
           所以这里写 CSS 像素值即可 —— 乘 DPR 会让大屏上辉光翻倍（已验证）。 */
        ctx.shadowColor = RM.rgba(it.color, TH.glowA)
        ctx.shadowBlur = P.glow * TH.glowK * (focused ? 1.15 : 1) * (active && P.breathe ? alpha : 1)
      } else {
        ctx.shadowBlur = 0
      }
      ctx.globalAlpha = alpha
      ctx.stroke()
      ctx.shadowBlur = 0
      ctx.globalAlpha = 1
    }
    ctx.restore()
  }

  /* ---------- 五、rAF 调度：有动画才转，静止时靠 1s ticker ---------- */
  let rafId = 0, lastSoft = 0, frames = 0
  function kick() { if (!rafId) rafId = requestAnimationFrame(frame) }
  function frame(now) {
    rafId = 0
    frames++
    let hard = st.pressing
    if (animStep(AN.push, now)) hard = true
    if (animStep(AN.detent, now)) hard = true
    if (animStep(AN.flash, now)) hard = true
    const soft = !!P.breathe && !!st.running
    if (hard || !soft || now - lastSoft > 40) { draw(now); lastSoft = now }
    if (hard || soft) kick()
  }

  /* ---------- 六、生命周期：重建几何 / 刷新读数 ---------- */
  function rebuild() {
    const elapsed = RM.elapsedSec(st.running, Date.now())
    const items = RM.sectors(st.categories, st.byCat, st.running, elapsed, {
      ghostDeg: P.ghostDeg, maxSectors: P.maxSectors,
    })
    st.laid = RM.layout(items, { R: G.R, SW: G.SW, GAP_VIS: G.GAP_VIS })
    renderCenter()
    renderCandidate()
    kick()
    renderDebugState()
  }

  function renderCenter() {
    const running = st.running
    const cat = running ? catById(running.category_id) : null
    const txt = running ? RM.fmtMS(RM.elapsedSec(running, Date.now())) : '00:00'
    const t = $('c-time')
    t.textContent = txt
    t.classList.toggle('idle', !running)
    t.classList.toggle('compact', txt.length >= 7)

    const dot = $('c-dot')
    dot.style.background = running ? (cat ? cat.color : '#FF5A5A') : ''
    dot.classList.toggle('on', !!running)

    $('c-state').textContent = running ? (cat ? cat.name : '未分类') : '空闲'

    const title = running && cat ? st.latest[cat.id] : ''
    const latest = $('c-latest')
    latest.textContent = title ? `最近：${title}` : ''
    latest.classList.toggle('hidden', !title)
  }

  function renderCandidate() {
    const el = $('cand')
    const hint = $('hint')
    const id = st.focusId
    if (!id) {
      el.classList.remove('show')
      // 引导语只在"还没开始过任何一段"时出现：一旦有计时在跑，说明用户已经会了，别再占位置
      hint.classList.toggle('hidden', !!st.running)
      return
    }
    const it = st.laid.find((x) => x.id === id) || {}
    const sec = it.sec || 0
    const color = it.ghost ? '' : (it.color || '')
    el.innerHTML =
      '<span class="arrow">→</span>' +
      (color ? `<span class="dot" style="background:${color}"></span>` : '') +
      `<span>${esc(nameOf(id))}</span>` +
      '<span class="dursep">·</span>' +
      `<span>${sec ? RM.fmtDurMin(sec) : '今天还没有'}</span>`
    el.classList.add('show')
    hint.classList.add('hidden')
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

  let toastTimer = null
  function toast(msg) {
    const el = $('toast')
    el.textContent = msg
    el.classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => el.classList.remove('show'), 1100)
  }

  /* ---------- 七、手势状态机 ---------- */
  let lastHaptic = 0
  function haptic(ms) {
    if (!P.haptic) return
    const now = performance.now()
    if (now - lastHaptic < 28) return
    lastHaptic = now
    try { if (navigator.vibrate) navigator.vibrate(ms || 8) } catch (e) {}
  }

  function onPress(x, y) {
    const hit = RM.hitTest(x, y, CX, CY, st.laid, geomOpts())
    st.pressing = true
    st.pressZone = hit.zone
    st.pressHitId = hit.id
    st.pressFocusId = st.focusId
    st.lastAngle = hit.deg
    st.dragDeg = 0; st.dragSign = 0; st.netDeg = 0; st.moved = false
    st.downT = performance.now(); st.steps = 0
    st.lastZone = hit.zone; st.lastR = hit.r; st.lastDeg = hit.deg
    kick()
  }

  function onMove(x, y) {
    if (!st.pressing) return
    if (st.pressZone === 'center' || st.pressZone === 'outside') return
    const { r, deg } = RM.polarOf(x, y, CX, CY)
    st.lastR = r; st.lastDeg = deg
    if (r < 20) { st.lastAngle = deg; return }   // 掠过圆心：角度无意义，只重置基准、不累计
    const delta = RM.norm180(deg - st.lastAngle)
    st.lastAngle = deg
    if (Math.abs(delta) < P.jitterDeg) return

    const sign = delta > 0 ? 1 : -1
    if (st.dragSign !== 0 && sign !== st.dragSign) st.dragDeg = 0   // 方向翻转 → 累积清零
    st.dragSign = sign
    st.dragDeg += delta
    st.netDeg += delta

    let n = Math.floor(Math.abs(st.dragDeg) / P.stepDeg)
    if (n > 0) {
      const now = performance.now()
      if (P.stepCooldownMs > 0 && now - st.lastStepAt < P.stepCooldownMs) { kick(); return }
      const take = Math.min(n, P.maxStepsPerMove)
      for (let i = 0; i < take; i++) step(sign)
      st.dragDeg -= sign * take * P.stepDeg      // 只减掉已消费的，慢速连续拖能持续走格
      st.moved = true
      st.lastStepAt = now
    }
    kick()
  }

  function step(dir) {
    const next = RM.stepId(st.laid, st.focusId, dir, runningId())
    if (!next) return
    setFocus(next)
    st.steps++
    const now = performance.now()
    AN.detent.from = dir * P.detentDeg; AN.detent.to = 0; AN.detent.t0 = now; AN.detent.ms = P.detentMs
    haptic(8)
  }

  function setFocus(id) {
    if (st.focusId === id) return
    st.focusId = id
    animateTo(AN.push, id ? 1 : 0, 180, performance.now())
    renderCandidate()
    kick()
  }

  function onRelease(x, y) {
    if (!st.pressing) return
    st.pressing = false
    const zone = st.pressZone
    if (zone === 'outside') { setFocus(null); kick(); return }
    if (zone === 'center') { if (st.focusId) setFocus(null); else haptic(6); kick(); return }

    const dt = performance.now() - st.downT
    if (st.moved) { commit(st.focusId); setFocus(null); kick(); return }
    if (Math.abs(st.netDeg) < P.tapMoveTolDeg && dt < P.tapMaxMs) {
      // 轻点扇区 = 立即确认（与"拖一步再松手"走同一个 commit）
      const id = st.pressHitId
      if (id) commit(id)
      setFocus(null); kick(); return
    }
    // 弱拖动（不足一格）：不提交，回到按下前的选中态
    setFocus(st.pressFocusId)
    kick()
  }

  function onCancel() {
    if (!st.pressing) return
    st.pressing = false
    setFocus(st.pressFocusId)
    kick()
  }

  /* ---------- 八、确认语义：只有切换，没有停止 ---------- */
  function commit(id) {
    if (!id) return
    if (id === '__other__') { toast('「其他分类」面板本轮未做'); return }
    const cur = runningId()
    if (cur === id) {
      // 防误停：与运行中相同 → 无操作，只给脉冲 + 提示（镜像桌面 viaWheel 的语义）
      const now = performance.now()
      AN.flash.from = 0; AN.flash.to = 1; AN.flash.t0 = now; AN.flash.ms = 110
      setTimeout(() => { AN.flash.from = 1; AN.flash.to = 0; AN.flash.t0 = performance.now(); AN.flash.ms = 320; kick() }, 110)
      haptic(16)
      toast(`已在计时 · ${nameOf(id)}`)
      kick()
      return
    }
    const wasRunning = !!st.running
    if (st.running) {
      const sec = RM.elapsedSec(st.running, Date.now())
      const key = st.running.category_id || 'none'
      if (sec > 0) st.byCat[key] = (st.byCat[key] || 0) + sec
    }
    st.running = {
      id: 'run-' + Date.now(),
      category_id: id === '__none__' ? null : id,
      start_time: new Date().toISOString(),
    }
    haptic(12)
    if (P.toastOnSwitch) toast((wasRunning ? '已切到 ' : '开始 ') + nameOf(id))
    rebuild()
  }

  /* ---------- 九、事件绑定（pointer 与 touch 归一） ---------- */
  function pt(e) {
    const r = canvas.getBoundingClientRect()
    const s = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || e
    return { x: s.clientX - r.left, y: s.clientY - r.top }
  }

  function bind() {
    if (window.PointerEvent) {
      canvas.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        try { canvas.setPointerCapture(e.pointerId) } catch (err) {}
        const p = pt(e); onPress(p.x, p.y)
      })
      canvas.addEventListener('pointermove', (e) => {
        if (!st.pressing) return
        e.preventDefault()
        const p = pt(e); onMove(p.x, p.y)
      })
      canvas.addEventListener('pointerup', (e) => { const p = pt(e); onRelease(p.x, p.y) })
      canvas.addEventListener('pointercancel', onCancel)
      window.addEventListener('blur', onCancel)
    } else {
      canvas.addEventListener('touchstart', (e) => { e.preventDefault(); const p = pt(e); onPress(p.x, p.y) }, { passive: false })
      canvas.addEventListener('touchmove', (e) => { e.preventDefault(); const p = pt(e); onMove(p.x, p.y) }, { passive: false })
      canvas.addEventListener('touchend', (e) => { e.preventDefault(); const p = pt(e); onRelease(p.x, p.y) }, { passive: false })
      canvas.addEventListener('touchcancel', (e) => { e.preventDefault(); onCancel() }, { passive: false })
    }
  }

  /* ---------- 十、调试面板 ---------- */
  const PARAMS = [
    { g: '几何' },
    { k: 'scale', label: '整体缩放', min: 1, max: 2.2, step: 0.05, fmt: (v) => v.toFixed(2) },
    { k: 'ringCy', label: '环心高度', min: 140, max: 560, step: 2, fmt: (v) => v + 'px' },
    { g: '旋转手感' },
    { k: 'stepDeg', label: '步进角度', min: 10, max: 120, step: 1, fmt: (v) => v + '°' },
    { k: 'jitterDeg', label: '抖动过滤', min: 0, max: 6, step: 0.5, fmt: (v) => v + '°' },
    { k: 'maxStepsPerMove', label: '单次最多跳', min: 1, max: 8, step: 1, fmt: (v) => v + ' 格' },
    { k: 'stepCooldownMs', label: '步进冷却', min: 0, max: 400, step: 10, fmt: (v) => v + 'ms' },
    { g: '点按判定' },
    { k: 'tapMoveTolDeg', label: '轻点容差', min: 0, max: 30, step: 1, fmt: (v) => v + '°' },
    { k: 'tapMaxMs', label: '轻点时限', min: 100, max: 800, step: 10, fmt: (v) => v + 'ms' },
    { k: 'centerHole', label: '环心孔半径', min: 0, max: 70, step: 1, fmt: (v) => v + 'px' },
    { k: 'touchPad', label: '环带宽容', min: 0, max: 40, step: 1, fmt: (v) => v + 'px' },
    { g: '视觉' },
    { k: 'outPush', label: '选中外扩', min: 1, max: 1.8, step: 0.05, fmt: (v) => '×' + v.toFixed(2) },
    { k: 'detentDeg', label: '档位角度', min: 0, max: 10, step: 0.5, fmt: (v) => v + '°' },
    { k: 'detentMs', label: '档位时长', min: 0, max: 500, step: 10, fmt: (v) => v + 'ms' },
    { k: 'glow', label: '辉光', min: 0, max: 20, step: 1, fmt: (v) => String(v) },
    { k: 'ghostDeg', label: '幽灵扇区', min: 0, max: 20, step: 0.5, fmt: (v) => v + '°' },
    { k: 'maxSectors', label: '扇区上限', min: 3, max: 12, step: 1, fmt: (v) => String(v) },
    { g: '开关' },
    { k: 'breathe', label: '呼吸动画', min: 0, max: 1, step: 1, fmt: (v) => (v ? '开' : '关') },
    { k: 'haptic', label: '触感震动', min: 0, max: 1, step: 1, fmt: (v) => (v ? '开' : '关') },
    { k: 'toastOnSwitch', label: '切换提示', min: 0, max: 1, step: 1, fmt: (v) => (v ? '开' : '关') },
  ]

  function buildDebug() {
    const box = $('dbgRows')
    box.innerHTML = ''
    for (const d of PARAMS) {
      if (d.g) {
        const g = document.createElement('div')
        g.className = 'dbg-group'
        g.textContent = d.g
        box.appendChild(g)
        continue
      }
      const row = document.createElement('div')
      row.className = 'dbg-row'
      row.innerHTML =
        `<label for="p-${d.k}">${d.label}</label>` +
        `<input id="p-${d.k}" type="range" min="${d.min}" max="${d.max}" step="${d.step}" value="${P[d.k]}">` +
        `<span class="val" id="v-${d.k}">${d.fmt(P[d.k])}</span>`
      box.appendChild(row)
      const input = row.querySelector('input')
      input.addEventListener('input', () => {
        P[d.k] = parseFloat(input.value)
        $('v-' + d.k).textContent = d.fmt(P[d.k])
        applyGeometryParams()
        rebuild()
      })
    }
  }

  function syncDebugInputs() {
    for (const d of PARAMS) {
      if (d.g) continue
      const i = $('p-' + d.k)
      if (i) i.value = P[d.k]
      const v = $('v-' + d.k)
      if (v) v.textContent = d.fmt(P[d.k])
    }
  }

  let dbgLast = ''
  function renderDebugState() {
    const el = $('dbgState')
    if (!el || !$('debug').classList.contains('open')) return
    const s = [
      `状态      ${st.pressing ? '按下/拖动中' : '空闲'}`,
      `累积角度  ${st.dragDeg.toFixed(1)}°  净 ${st.netDeg.toFixed(1)}°`,
      `已走格数  ${st.steps}   方向 ${st.dragSign > 0 ? '顺' : st.dragSign < 0 ? '逆' : '-'}`,
      `选中      ${st.focusId || '—'}`,
      `计时中    ${runningId() || '—'}`,
      `按下区    ${st.lastZone}   r=${st.lastR.toFixed(0)}  θ=${st.lastDeg.toFixed(0)}°`,
      `几何      R=${G.R.toFixed(1)} SW=${G.SW.toFixed(1)} 盘=${(G.PLATE_R * 2).toFixed(0)}`,
      `命中带    |r−R| ≤ ${(G.SW / 2 + P.touchPad).toFixed(1)}`,
    ].join('\n')
    if (s !== dbgLast) { el.textContent = s; dbgLast = s }
  }
  setInterval(renderDebugState, 120)

  /* ---------- 十一、启动 ---------- */
  function applyGeometryParams() {
    G = { R: BASE.R * P.scale, SW: BASE.SW * P.scale, GAP_VIS: BASE.GAP_VIS * P.scale, PLATE_R: BASE.PLATE_R * P.scale }
    const rs = document.documentElement.style
    rs.setProperty('--ring-cy', P.ringCy + 'px')
    rs.setProperty('--plate-d', (G.PLATE_R * 2).toFixed(1) + 'px')
    rs.setProperty('--below-top', (P.ringCy + G.PLATE_R + 16).toFixed(1) + 'px')
    layoutCanvas()
  }

  function init() {
    readTheme()
    applyGeometryParams()
    buildDebug()
    bind()
    const openDebug = (on) => {
      $('debug').classList.toggle('open', on)
      $('dbgTab').style.display = on ? 'none' : ''
      dbgLast = ''
      renderDebugState()
    }
    $('dbgTab').addEventListener('click', () => openDebug(true))
    $('dbgClose').addEventListener('click', () => openDebug(false))
    document.querySelectorAll('.dbg-actions button').forEach((b) => {
      b.addEventListener('click', () => {
        const act = b.dataset.act
        if (act === 'demo') useSample()
        else if (act === 'empty') useEmpty()
        else if (act === 'theme') {
          const cur = document.documentElement.getAttribute('data-theme')
          document.documentElement.setAttribute('data-theme', cur === 'dark' ? 'light' : 'dark')
          readTheme(); kick()
        } else if (act === 'reset') {
          Object.assign(P, DEFAULTS)
          applyGeometryParams(); rebuild(); syncDebugInputs(); kick()
        }
      })
    })
    window.addEventListener('resize', () => { applyGeometryParams(); rebuild() })
    useSample()
    setInterval(rebuild, 1000)     // 每秒心跳：累计秒在长，弧也要跟着长
  }

  /* 自测钩子（tools/ 下的自测脚本用；真机跑不受影响） */
  window.__proto = {
    st, P, AN,
    press: (x, y) => onPress(x, y),
    move: (x, y) => onMove(x, y),
    release: (x, y) => onRelease(x, y),
    cancel: onCancel,
    rebuild, commit, setFocus,
    cx: () => CX, cy: () => CY, geom: () => G,
    frames: () => frames,          // 让"动画真的在跑"可被自测断言
    laid: () => st.laid,
    useSample, useEmpty,
    model: RM,
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
