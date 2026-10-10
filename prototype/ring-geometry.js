/* ============================================================================
   环形几何 · 纯函数层（零 canvas、零 DOM）
   ----------------------------------------------------------------------------
   为什么单独一层：这是整个原型里唯一真正要"搬走"的资产。
   搬进小程序时整体拷成 utils/ring.js —— 两端差异只剩"取尺寸"和"事件名"，
   绘制与命中数学是同一份（见 prototype/README.md 的搬迁映射）。

   移植来源（保持逐值同构，自测里有奇偶校验）：
     sectors()  ← site/app.js 的 widgetSectors()
     layout()   ← site/app.js 的 applyArcGeometry()
     stepId()   ← site/app.js 的 stepFocus()
     fmtMS() / fmtDurMin() / elapsedSec()  ← 同名字段

   角度口径：一律「从 12 点起、顺时针、单位度、0..360」，与 canvas 的
   atan2/arc 差一个 −90°，换算只在绘制层做一次。
   ========================================================================== */
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.RingModel = api
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const mod = (a, n) => ((a % n) + n) % n

  /* 归一到 (−180, 180]：跨越 12 点时角度会从 359 跳到 1，直接相减会得到 −358 这种假大幅 */
  function norm180(deg) {
    const x = ((deg % 360) + 360) % 360
    return x > 180 ? x - 360 : x
  }

  /* 纯分:秒（小时折进分钟，如 125:15）——与桌面组件同口径，不用配套小程序的 HH:MM:SS */
  function fmtMS(totalSec) {
    const s = Math.max(0, Math.floor(totalSec))
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  }

  function fmtDurMin(sec) {
    if (sec == null) return '-'
    const s = Math.max(0, Math.floor(Number(sec) || 0))
    if (s < 60) return `${s}秒`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}分钟`
    return `${Math.floor(m / 60)}小时${m % 60 ? (m % 60) + '分' : ''}`
  }

  function elapsedSec(running, nowMs) {
    if (!running) return 0
    return Math.max(0, Math.floor((nowMs - new Date(running.start_time).getTime()) / 1000))
  }

  /* 分类色 → rgba（辉光用） */
  function rgba(hex, a) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex).trim())
    if (!m) return `rgba(120,130,150,${a})`
    return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`
  }

  /* --------------------------------------------------------------------------
     扇区分角：今日有记录的分类按累计秒数等比分配，今日 0 秒的占固定小槽（幽灵）。
     与桌面 widgetSectors() 逐值同构 —— 唯一的差别见下面那行修正。
     ------------------------------------------------------------------------ */
  function sectors(categories, byCat, running, elapsed, opts) {
    const ghostLimit = opts.ghostDeg
    const maxSectors = opts.maxSectors
    const col = (byCat || {})

    const list = (categories || []).map((c) => ({
      id: c.id, name: c.name, color: c.color,
      sec: (col[c.id] || 0) + (running && running.category_id === c.id ? elapsed : 0),
      active: !!(running && running.category_id === c.id),
    }))
    const noneSec = (col.none || 0) + (running && !running.category_id ? elapsed : 0)
    if (noneSec > 0 || (running && !running.category_id)) {
      list.push({
        id: '__none__', name: '未分类', color: '#78808f', sec: noneSec,
        active: !!(running && !running.category_id),
      })
    }
    if (!list.length) return []

    // 稳定排序：deg 相同时保持原顺序（与桌面一致，扇区不会每秒乱跳）
    list.sort((a, b) => b.sec - a.sec)

    const timed = list.filter((x) => x.sec > 0)
    const zero = list.filter((x) => x.sec <= 0)
    const ghostDeg = zero.length ? Math.min(ghostLimit, 120 / zero.length) : 0
    const restDeg = 360 - ghostDeg * zero.length
    const timedTotal = timed.reduce((s, x) => s + x.sec, 0)

    const withDeg = []
    if (timedTotal > 0) {
      timed.forEach((x) => withDeg.push({ ...x, deg: restDeg * (x.sec / timedTotal), ghost: false }))
      zero.forEach((x) => withDeg.push({ ...x, deg: ghostDeg, ghost: true }))
    } else {
      // 全天零记录：等分 360°（此时环是"启动器"语义，见 DESIGN.md §3.3）
      zero.forEach((x) => withDeg.push({ ...x, deg: 360 / zero.length, ghost: true }))
    }

    /* 修正（桌面是在渲染层补的）：正在计时的扇区即使今日 0 秒也不算幽灵。
       不修的话，刚点下开始的那几秒它会被画成轨道灰 —— 用户实测报过。
       注意 deg 仍按上面算（与桌面逐值一致），只改渲染标记。 */
    withDeg.forEach((x) => { if (x.active) x.ghost = false })

    const sorted = withDeg.sort((a, b) => b.deg - a.deg)
    const items = sorted.slice(0, maxSectors)
    const rest = sorted.slice(maxSectors)
    if (rest.length) {
      items.push({
        id: '__other__', name: '其他分类', color: '#aab0bb',
        sec: rest.reduce((s, x) => s + x.sec, 0),
        deg: rest.reduce((s, x) => s + x.deg, 0),
        rest,
      })
    }
    return items
  }

  /* --------------------------------------------------------------------------
     排布：给每个扇区算出两套角度
       spanStart/spanEnd —— **未扣间隙**的连续区间，用于命中与步进（不留死区）
       drawStart/drawEnd —— 扣掉视觉间隙后的实际绘制区间（弧长制，与桌面同算法）
     ------------------------------------------------------------------------ */
  function layout(items, opts) {
    const R = opts.R
    const SW = opts.SW
    const GAP_VIS = opts.GAP_VIS
    const CIRC = 2 * Math.PI * R
    const degPerPx = 360 / CIRC
    let acc = 0
    const out = []
    items.forEach((it, i) => {
      const arcLen = (it.deg / 360) * CIRC
      // 圆头线帽各向外延伸 SW/2，所以视觉间隙要加在虚线间隙之上
      const gap = items.length > 1 ? Math.min(SW + GAP_VIS, arcLen * 0.55) : 0
      const drawLen = Math.max(1.5, arcLen - gap)   // 1.5px 保底：幽灵点也要看得见
      const spanStart = acc * degPerPx
      const spanEnd = (acc + arcLen) * degPerPx
      const drawStart = (acc + gap / 2) * degPerPx
      const drawEnd = drawStart + drawLen * degPerPx
      acc += arcLen
      out.push({ ...it, index: i, spanStart, spanEnd, drawStart, drawEnd, capDeg: (SW / 2) * degPerPx })
    })
    return out
  }

  /* 触点到环心的极坐标（从 12 点起、顺时针、度） */
  function polarOf(px, py, cx, cy) {
    const dx = px - cx
    const dy = py - cy
    const r = Math.sqrt(dx * dx + dy * dy)
    let deg = Math.atan2(dx, -dy) * 180 / Math.PI
    if (deg < 0) deg += 360
    return { r, deg }
  }

  /* --------------------------------------------------------------------------
     命中分区。canvas 没有 DOM 命中测试，全部自己算。
     三档：环心孔（不参与旋转）/ 环带 ± 宽容 / 盘面其余 / 盘外
     ------------------------------------------------------------------------ */
  function hitTest(px, py, cx, cy, laid, opts) {
    const { r, deg } = polarOf(px, py, cx, cy)
    const R = opts.R
    const SW = opts.SW
    const TOUCH_PAD = opts.TOUCH_PAD
    const PLATE_R = opts.PLATE_R
    const CENTER_HOLE = opts.CENTER_HOLE

    const onBand = Math.abs(r - R) <= SW / 2 + TOUCH_PAD
    let zone = 'plate'                       // 盘面（可起拖）
    if (r < CENTER_HOLE) zone = 'center'     // 环心孔（不参与旋转）
    else if (r > PLATE_R) zone = 'outside'   // 盘外
    else if (onBand) zone = 'band'           // 环带（精确命中带，仍可起拖）

    // 命中按未扣间隙的区间判：间隙只是视觉产物，不该在环上留一圈点不中的死区
    let hit = null
    for (const it of (laid || [])) {
      if (deg >= it.spanStart && deg < it.spanEnd) { hit = it; break }
    }
    if (!hit && laid && laid.length) hit = laid[laid.length - 1]   // 浮点兜底

    return {
      zone, r, deg, item: hit, id: hit ? hit.id : null, index: hit ? hit.index : -1,
      band: onBand,
    }
  }

  /* --------------------------------------------------------------------------
     沿环步进一格、首尾循环 —— 逐行移植 stepFocus()。
     首次（还没选中）：从"正在计时的分类"起跳一步；空闲则从 12 点（顺）/ 末段（逆）进入。
     ------------------------------------------------------------------------ */
  function stepId(laid, focusId, dir, runningId) {
    const n = (laid || []).length
    if (!n) return null
    let idx = focusId ? laid.findIndex((x) => x.id === focusId) : -1
    if (idx < 0) {
      const ri = runningId ? laid.findIndex((x) => x.id === runningId) : -1
      idx = ri >= 0 ? mod(ri + dir, n) : (dir > 0 ? 0 : n - 1)
    } else {
      idx = mod(idx + dir, n)
    }
    return laid[idx].id
  }

  return { mod, norm180, fmtMS, fmtDurMin, elapsedSec, rgba, sectors, layout, polarOf, hitTest, stepId }
})
