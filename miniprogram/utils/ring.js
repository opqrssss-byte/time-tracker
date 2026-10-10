/* ============================================================================
   环形几何 · 纯函数层（零 canvas、零 DOM）
   ----------------------------------------------------------------------------
   来源：prototype/ring-geometry.js，逐值同构（那份已与 site/app.js 的 widgetSectors
   做过奇偶校验：同样例数据下 6 段角度与幽灵标记完全一致）。

   小程序侧只走 module.exports 分支；浏览器侧挂 window.RingModel。
   角度口径：一律「从 12 点起、顺时针、单位度、0..360」，与 canvas 的 atan2/arc 差 −90°。
   ========================================================================== */
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else if (root) root.RingModel = api
})(typeof globalThis !== 'undefined' ? globalThis
  : (typeof self !== 'undefined' ? self : (typeof this !== 'undefined' ? this : null)), function () {
  const mod = (a, n) => ((a % n) + n) % n

  /* 归一到 (−180, 180]：跨越 12 点时角度会从 359 跳到 1，直接相减会得到 −358 这种假大幅 */
  function norm180(deg) {
    const x = ((deg % 360) + 360) % 360
    return x > 180 ? x - 360 : x
  }

  /* 纯分:秒（小时折进分钟，如 125:15）——与桌面组件同口径 */
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

  function fmtClock(iso) {
    const d = new Date(iso)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  function elapsedSec(running, nowMs) {
    if (!running) return 0
    return Math.max(0, Math.floor((nowMs - new Date(running.start_time).getTime()) / 1000))
  }

  function rgba(hex, a) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex).trim())
    if (!m) return `rgba(120,130,150,${a})`
    return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`
  }

  /* 扇区分角：今日有记录的分类按累计秒数等比分配，今日 0 秒的占固定小槽（幽灵） */
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
      zero.forEach((x) => withDeg.push({ ...x, deg: 360 / zero.length, ghost: true }))
    }

    /* 正在计时的扇区即使今日 0 秒也不算幽灵：不修的话"刚点下开始"那几秒它是灰的
       （桌面在渲染层补，这里直接在数据层修；deg 与桌面仍逐值一致） */
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

  /* 排布：spanStart/End 是未扣间隙的连续区间（命中与步进用，不留死区）；
     drawStart/End 是扣掉视觉间隙后的绘制区间（与桌面同算法） */
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
      const gap = items.length > 1 ? Math.min(SW + GAP_VIS, arcLen * 0.55) : 0
      const drawLen = Math.max(1.5, arcLen - gap)
      const spanStart = acc * degPerPx
      const spanEnd = (acc + arcLen) * degPerPx
      const drawStart = (acc + gap / 2) * degPerPx
      const drawEnd = drawStart + drawLen * degPerPx
      acc += arcLen
      out.push({ ...it, index: i, spanStart, spanEnd, drawStart, drawEnd, capDeg: (SW / 2) * degPerPx })
    })
    return out
  }

  function polarOf(px, py, cx, cy) {
    const dx = px - cx
    const dy = py - cy
    const r = Math.sqrt(dx * dx + dy * dy)
    let deg = Math.atan2(dx, -dy) * 180 / Math.PI
    if (deg < 0) deg += 360
    return { r, deg }
  }

  function hitTest(px, py, cx, cy, laid, opts) {
    const p = polarOf(px, py, cx, cy)
    const r = p.r
    const deg = p.deg
    const R = opts.R
    const SW = opts.SW
    const TOUCH_PAD = opts.TOUCH_PAD
    const PLATE_R = opts.PLATE_R
    const CENTER_HOLE = opts.CENTER_HOLE

    const onBand = Math.abs(r - R) <= SW / 2 + TOUCH_PAD
    let zone = 'plate'
    if (r < CENTER_HOLE) zone = 'center'
    else if (r > PLATE_R) zone = 'outside'
    else if (onBand) zone = 'band'

    let hit = null
    for (let i = 0; i < (laid || []).length; i++) {
      const it = laid[i]
      if (deg >= it.spanStart && deg < it.spanEnd) { hit = it; break }
    }
    if (!hit && laid && laid.length) hit = laid[laid.length - 1]

    return {
      zone, r, deg, band: onBand, item: hit,
      id: hit ? hit.id : null, index: hit ? hit.index : -1,
    }
  }

  /* 沿环步进一格、首尾循环（逐行移植桌面的 stepFocus） */
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

  return { mod, norm180, fmtMS, fmtDurMin, fmtClock, elapsedSec, rgba, sectors, layout, polarOf, hitTest, stepId }
})
