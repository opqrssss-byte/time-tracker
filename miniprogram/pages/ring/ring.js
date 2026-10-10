/* ============================================================================
   环形模式 · 拖环旋转 + 松手确认（首页，没有"停止"）
   ----------------------------------------------------------------------------
   来源：prototype/（网页原型，自测 32/32，几何与桌面端逐值校验过）。

   ⚠️ 结构上的关键决定：**盘、环、环心读数全部画进 canvas**，页面上不压任何 view。
   原因（踩过的坑）：小程序的 canvas 是**原生组件**，层级最高；反过来，只要有普通
   view 压在 canvas 上，那块区域的触摸会被 view 吃掉 —— 上一版把"环心读数"做成
   叠在 canvas 上的 view，结果整个圆环都拖不动。现在那个区域只有 canvas 一个元素，
   触摸不可能被别的东西截走。

   坐标：画布与舞台同尺寸（不再负偏移），所以环心 = 画布中心，换算只有一处。
   ========================================================================== */
const { cloud } = require('../../utils/cloud')
const { ensureSession } = require('../../utils/util')
const RM = require('../../utils/ring')

const DEFAULT_CATEGORIES = [
  { name: '工作', color: '#4F8CFF', sort_order: 1 },
  { name: '学习', color: '#9B6DFF', sort_order: 2 },
  { name: '运动', color: '#2FBF71', sort_order: 3 },
  { name: '生活', color: '#F2A93B', sort_order: 4 },
]

/* 手感参数：与网页原型同一套默认值 */
const P = {
  stepDeg: 40, jitterDeg: 1.5, maxStepsPerMove: 3,
  tapMoveTolDeg: 8, tapMaxMs: 350,
  touchPad: 16, centerHole: 34,
  outPush: 1.35, detentDeg: 3.5, detentMs: 160,
  glow: 7, ghostDeg: 4.5, maxSectors: 7,
  haptic: true,
}

/* 深色 token：照桌面组件 DESIGN.md（表面阶梯 + 发丝描边 + 内高光，不用投影） */
const T = {
  plate: '#131417',
  hairline: 'rgba(255,255,255,0.08)',
  highlight: 'rgba(255,255,255,0.10)',
  track: 'rgba(255,255,255,0.07)',
  ghost: 'rgba(255,255,255,0.14)',
  ink: '#f4f4f6',
  body: '#cdcdcd',
  ash: '#5c5d60',
  danger: '#FF5A5A',
  glowA: 0.6,          // 深色底上辉光可以给满（浅色底要给 0.38，否则显脏）
}

const easeOut = (p) => 1 - Math.pow(1 - p, 3)

Page({
  data: {
    canvasPx: 0, padTop: 40,
    focusName: '', focusDur: '', focusColor: '#ffffff', showCand: false,
    showHint: true,
    diag: '',
  },

  onReady() { this.initCanvas() },

  async onShow() {
    const session = await ensureSession()
    if (!session) return
    await this.loadCategories()
    await this.refreshRunning()
    await this.refreshTodayStats()
    this.refreshRect()
    this.startTicker()
    this.rebuild()
  },

  onHide() { this.clearTimers() },
  onUnload() { this.clearTimers() },

  clearTimers() {
    ;['_ticker', '_poll', '_breathe', '_a_push', '_a_detent'].forEach((k) => {
      if (this[k]) { clearInterval(this[k]); this[k] = null }
    })
  },

  /* ---------- 一、画布 ---------- */
  initCanvas() {
    let win = {}
    try { win = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()) || {} } catch (e) { win = {} }
    const w = win.windowWidth || 375
    const dpr = win.pixelRatio || 2
    const K = w / 375
    this._K = K
    this._dpr = dpr
    /* 几何全部按屏宽等比：375 宽为设计基准（与 prototype/ 一致） */
    this._G = { R: 86.4 * K, SW: 17.6 * K, GAP_VIS: 6.4 * K, PLATE_R: 121.6 * K }
    const canvasPx = 279.2 * K
    this.setData({ canvasPx, padTop: (win.statusBarHeight || 20) + 28 })

    const q = wx.createSelectorQuery()
    q.select('#ring').fields({ node: true, size: true })
    q.select('#ring').boundingClientRect()
    q.exec((res) => {
      const info = res && res[0]
      const rect = res && res[1]
      if (!info || !info.node) { this.setData({ diag: '画布初始化失败（没取到 canvas 节点）' }); return }
      const canvas = info.node
      const ctx = canvas.getContext('2d')
      const cw = (rect && rect.width) || info.width || canvasPx
      const ch = (rect && rect.height) || info.height || canvasPx
      canvas.width = Math.round(cw * dpr)
      canvas.height = Math.round(ch * dpr)
      this._canvas = canvas
      this._ctx = ctx
      this._cw = cw
      this._ch = ch
      this.setRect(rect)
      this.setData({ diag: '' })
      this.rebuild()
    })
  },

  setRect(rect) {
    if (rect && rect.left != null && rect.top != null) {
      this._rect = { left: rect.left, top: rect.top }
      this._rectOk = true
    } else {
      this._rect = this._rect || { left: 0, top: 0 }
      this._rectOk = false
    }
  },

  /* 布局可能变（切 tab 回来、横竖屏），触摸前重取一次位置 */
  refreshRect() {
    if (!this._canvas) return
    wx.createSelectorQuery().select('#ring').boundingClientRect().exec((res) => {
      this.setRect(res && res[0])
    })
  },

  /* ---------- 二、数据 ---------- */
  async loadCategories() {
    let { data, error } = await cloud.database
      .from('categories').select('*').order('sort_order', { ascending: true })
    if (error) { wx.showToast({ title: '分类加载失败', icon: 'none' }); return }
    if (!data || data.length === 0) {
      const seeded = await cloud.database.from('categories').insert(DEFAULT_CATEGORIES).select()
      if (!seeded.error && seeded.data && seeded.data.length) data = seeded.data
    }
    this._cats = data || []
  },

  async refreshRunning() {
    const { data, error } = await cloud.database
      .from('time_entries').select('*').is('end_time', null).maybeSingle()
    if (error) return
    this._running = data || null
  },

  async refreshTodayStats() {
    const start = new Date(); start.setHours(0, 0, 0, 0)
    const { data, error } = await cloud.database.from('time_entries')
      .select('category_id,duration_sec,title,start_time')
      .gte('start_time', start.toISOString())
      .not('end_time', 'is', null)
      .order('start_time', { ascending: false }).limit(500)
    if (error) return
    const byCat = {}
    ;(data || []).forEach((e) => {
      const k = e.category_id || 'none'
      byCat[k] = (byCat[k] || 0) + Math.floor(e.duration_sec || 0)
    })
    this._byCat = byCat
  },

  startTicker() {
    if (this._ticker) clearInterval(this._ticker)
    this._ticker = setInterval(() => { this.rebuild() }, 1000)
    // 呼吸动画走慢节奏（不挂常驻 rAF，手机省电）
    if (this._breathe) clearInterval(this._breathe)
    this._breathe = setInterval(() => {
      if (!this._running || !this._layout) return
      this._breathPhase = (this._breathPhase || 0) + 0.25
      this.draw()
    }, 120)
  },

  /* ---------- 三、几何 ---------- */
  runningId() { return this._running ? (this._running.category_id || '__none__') : null },

  catById(id) {
    const cats = this._cats || []
    for (let i = 0; i < cats.length; i++) if (cats[i].id === id) return cats[i]
    return null
  },

  rebuild() {
    if (!this._G) return
    const elapsed = RM.elapsedSec(this._running, Date.now())
    const items = RM.sectors(this._cats || [], this._byCat || {}, this._running, elapsed, {
      ghostDeg: P.ghostDeg, maxSectors: P.maxSectors,
    })
    this._layout = RM.layout(items, { R: this._G.R, SW: this._G.SW, GAP_VIS: this._G.GAP_VIS })
    this.renderCandidate()
    this.draw()
  },

  renderCandidate() {
    const id = this._focusId
    /* 去重键要把"是否在计时"也带上：否则开始计时后 key 不变，引导语会一直留着 */
    const key = (id || '') + '|' + (this._layout ? this._layout.length : 0) + '|' + (this._running ? 1 : 0)
    if (key === this._candKey) return
    this._candKey = key
    if (!id) {
      this.setData({ showCand: false, showHint: !this._running })
      return
    }
    let it = null
    const laid = this._layout || []
    for (let i = 0; i < laid.length; i++) if (laid[i].id === id) { it = laid[i]; break }
    const name = id === '__none__' ? '未分类' : id === '__other__' ? '其他分类' : (it ? it.name : '')
    this.setData({
      showCand: true,
      showHint: false,
      focusName: name,
      focusColor: it && !it.ghost ? it.color : '#8a8f98',
      focusDur: it && it.sec ? RM.fmtDurMin(it.sec) : '今天还没有',
    })
  },

  /* ---------- 四、绘制（盘 + 环 + 环心读数，全在 canvas 里） ---------- */
  draw() {
    const ctx = this._ctx
    if (!ctx || !this._G) return
    const G = this._G
    const K = this._K
    const W = this._cw
    const H = this._ch
    const cx = W / 2
    const cy = H / 2
    const rad = (deg) => (deg - 90) * Math.PI / 180

    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)

    /* 盘：层级靠"表面阶梯 + 发丝描边 + 顶部内高光"，不用投影（桌面组件的做法） */
    ctx.beginPath()
    ctx.arc(cx, cy, G.PLATE_R, 0, Math.PI * 2)
    ctx.fillStyle = T.plate
    ctx.fill()
    ctx.beginPath()
    ctx.arc(cx, cy, G.PLATE_R - 0.5, 0, Math.PI * 2)
    ctx.strokeStyle = T.hairline
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(cx, cy, G.PLATE_R - 1.5, rad(202), rad(338))
    ctx.strokeStyle = T.highlight
    ctx.lineWidth = 1.5
    ctx.stroke()

    /* 环 */
    ctx.save()
    ctx.translate(cx, cy)
    if (this._detent) ctx.rotate(this._detent * Math.PI / 180)

    ctx.beginPath()
    ctx.arc(0, 0, G.R, 0, Math.PI * 2)
    ctx.lineWidth = G.SW
    ctx.strokeStyle = T.track
    ctx.stroke()

    const laid = this._layout || []
    const push = this._push == null ? 0 : this._push
    const breath = this._running ? (0.74 + 0.26 * (0.5 + 0.5 * Math.sin(this._breathPhase || 0))) : 1

    for (let i = 0; i < laid.length; i++) {
      const it = laid[i]
      const focused = this._focusId === it.id
      const active = !!it.active
      let w = G.SW
      if (focused) w = G.SW * (1 + (P.outPush - 1) * push)

      ctx.beginPath()
      ctx.arc(0, 0, G.R, rad(it.drawStart), rad(it.drawEnd))
      ctx.lineWidth = w
      ctx.lineCap = 'round'
      ctx.strokeStyle = it.ghost ? T.ghost : it.color
      // 深色底上辉光可以给满（浅色底上会显脏，网页原型里为此收过强度）
      if (active || focused) {
        ctx.shadowColor = RM.rgba(it.color, T.glowA)
        ctx.shadowBlur = P.glow * (focused ? 1.15 : 1) * (active ? breath : 1)
      } else {
        ctx.shadowBlur = 0
      }
      ctx.globalAlpha = active ? breath : 1
      ctx.stroke()
      ctx.shadowBlur = 0
      ctx.globalAlpha = 1
    }
    ctx.restore()

    this.drawCenter(ctx, cx, cy)
  },

  /* 环心读数：两行（大字 + 状态行），与桌面组件的主通道一致 */
  drawCenter(ctx, cx, cy) {
    const K = this._K
    const run = this._running
    const cat = run ? this.catById(run.category_id) : null
    const txt = run ? RM.fmtMS(RM.elapsedSec(run, Date.now())) : '0:00'

    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'
    ctx.fillStyle = run ? T.ink : T.ash
    ctx.font = '600 ' + Math.round(40 * K) + 'px sans-serif'
    ctx.fillText(txt, cx, cy - 11 * K)

    const name = run ? (cat ? cat.name : '未分类') : '空闲'
    ctx.font = '500 ' + Math.round(15 * K) + 'px sans-serif'
    const tw = ctx.measureText(name).width
    const dotR = 4 * K
    const gap = 8 * K
    const startX = cx - (dotR * 2 + gap + tw) / 2

    ctx.beginPath()
    ctx.arc(startX + dotR, cy + 21 * K, dotR, 0, Math.PI * 2)
    ctx.fillStyle = run ? (cat ? cat.color : T.danger) : T.ash
    ctx.globalAlpha = run ? (0.72 + 0.28 * (0.5 + 0.5 * Math.sin(this._breathPhase || 0))) : 1
    ctx.fill()
    ctx.globalAlpha = 1

    ctx.textAlign = 'left'
    ctx.fillStyle = run ? T.body : T.ash
    ctx.fillText(name, startX + dotR * 2 + gap, cy + 21 * K)
  },

  /* 补间：20ms 定时器推 _push / _detent，不挂常驻 rAF */
  animateTo(key, to, ms) {
    const prop = '_' + key
    if (this[prop] === to && this['_a' + key]) return
    const from = this[prop] == null ? 0 : this[prop]
    const t0 = Date.now()
    if (this['_a' + key]) clearInterval(this['_a' + key])
    this['_a' + key] = setInterval(() => {
      const p = Math.min(1, (Date.now() - t0) / ms)
      this[prop] = from + (to - from) * easeOut(p)
      this.draw()
      if (p >= 1) { clearInterval(this['_a' + key]); this['_a' + key] = null; this[prop] = to }
    }, 20)
  },

  /* ---------- 五、触摸 ---------- */
  touchPoint(e) {
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0])
    if (!t) return null
    const r = this._rect || { left: 0, top: 0 }
    const vx = (t.clientX != null) ? t.clientX : (t.pageX != null ? t.pageX : 0)
    const vy = (t.clientY != null) ? t.clientY : (t.pageY != null ? t.pageY : 0)
    return { x: vx - r.left, y: vy - r.top }
  },

  onTouchStart(e) {
    if (!this._ctx) return
    const p = this.touchPoint(e)
    if (!p) return
    /* 自诊断：坐标落在画布外 = rect 没取对。只在这种时候显示，正常用不会看到 */
    if (p.x < -4 || p.y < -4 || p.x > this._cw + 4 || p.y > this._ch + 4) {
      this.setData({
        diag: '触摸坐标异常 ' + Math.round(p.x) + ',' + Math.round(p.y) +
          ' 画布 ' + Math.round(this._cw) + '×' + Math.round(this._ch) +
          ' rect ' + Math.round(this._rect.left) + ',' + Math.round(this._rect.top),
      })
    } else if (this.data.diag) {
      this.setData({ diag: '' })
    }

    const hit = RM.hitTest(p.x, p.y, this._cw / 2, this._ch / 2, this._layout || [], {
      R: this._G.R, SW: this._G.SW, TOUCH_PAD: P.touchPad,
      PLATE_R: this._G.PLATE_R, CENTER_HOLE: P.centerHole,
    })
    this._pressing = true
    this._pressZone = hit.zone
    this._pressHitId = hit.id
    this._pressFocusId = this._focusId || null
    this._lastAngle = hit.deg
    this._dragDeg = 0
    this._dragSign = 0
    this._netDeg = 0
    this._moved = false
    this._steps = 0
    this._downT = Date.now()
  },

  onTouchMove(e) {
    if (!this._pressing) return
    if (this._pressZone === 'center' || this._pressZone === 'outside') return
    const p = this.touchPoint(e)
    if (!p) return
    const pol = RM.polarOf(p.x, p.y, this._cw / 2, this._ch / 2)
    if (pol.r < 20) { this._lastAngle = pol.deg; return }
    const delta = RM.norm180(pol.deg - this._lastAngle)
    this._lastAngle = pol.deg
    if (Math.abs(delta) < P.jitterDeg) return

    const sign = delta > 0 ? 1 : -1
    if (this._dragSign !== 0 && sign !== this._dragSign) this._dragDeg = 0
    this._dragSign = sign
    this._dragDeg += delta
    this._netDeg += delta

    const n = Math.floor(Math.abs(this._dragDeg) / P.stepDeg)
    if (n > 0) {
      const take = Math.min(n, P.maxStepsPerMove)
      for (let i = 0; i < take; i++) this.step(sign)
      this._dragDeg -= sign * take * P.stepDeg
      this._moved = true
    }
  },

  onTouchEnd() {
    if (!this._pressing) return
    this._pressing = false
    const zone = this._pressZone
    if (zone === 'outside') { this.setFocus(null); return }
    if (zone === 'center') { if (this._focusId) this.setFocus(null); else this.haptic(); return }

    const dt = Date.now() - this._downT
    if (this._moved) { this.commit(this._focusId); this.setFocus(null); return }
    if (Math.abs(this._netDeg) < P.tapMoveTolDeg && dt < P.tapMaxMs) {
      this.commit(this._pressHitId)
      this.setFocus(null)
      return
    }
    this.setFocus(this._pressFocusId)
  },

  onTouchCancel() {
    if (!this._pressing) return
    this._pressing = false
    this.setFocus(this._pressFocusId)
  },

  step(dir) {
    const next = RM.stepId(this._layout || [], this._focusId, dir, this.runningId())
    if (!next) return
    this.setFocus(next)
    this._steps++
    this._detent = dir * P.detentDeg
    this.animateTo('detent', 0, P.detentMs)
    this.haptic()
  },

  setFocus(id) {
    if (this._focusId === id) return
    this._focusId = id
    this.animateTo('push', id ? 1 : 0, 180)
    this.renderCandidate()
  },

  haptic() {
    if (!P.haptic) return
    const now = Date.now()
    if (this._lastHaptic && now - this._lastHaptic < 60) return
    this._lastHaptic = now
    try { wx.vibrateShort({ type: 'light', fail: () => {} }) } catch (e) { /* 模拟器会抛 */ }
  },

  /* ---------- 六、确认：只有切换，没有停止 ---------- */
  async commit(id) {
    if (!id) return
    if (id === '__other__') { wx.showToast({ title: '环上只画前 7 个分类', icon: 'none' }); return }
    const cur = this.runningId()
    if (cur === id) {
      this.haptic()
      wx.showToast({ title: '已在计时 · ' + this.nameOf(id), icon: 'none' })
      return
    }
    this.haptic()
    const now = new Date()
    const entry = this._running

    // 1) 先关旧的：库里对 (owner_id) WHERE end_time IS NULL 有唯一部分索引，同一时刻只能有一条进行中
    if (entry) {
      const dur = Math.max(1, Math.round((now.getTime() - new Date(entry.start_time).getTime()) / 1000))
      const { error } = await cloud.database.from('time_entries')
        .update({ end_time: now.toISOString(), duration_sec: dur, updated_at: now.toISOString() })
        .eq('id', entry.id)
      if (error) { wx.showToast({ title: '切换失败，请重试', icon: 'none' }); return }
    }

    // 2) 再开新的
    const { data, error } = await cloud.database.from('time_entries')
      .insert({ title: '', category_id: id === '__none__' ? null : id, start_time: now.toISOString() })
      .select()
    if (error) {
      wx.showToast({
        title: error.code === '23505' ? '另一台设备正在计时' : '开始失败，请重试',
        icon: 'none',
      })
      await this.refreshRunning()
      return
    }
    this._running = (data && data[0]) || null
    this._candKey = null
    this.rebuild()
    this.refreshTodayStats().then(() => { this._candKey = null; this.rebuild() })
  },

  nameOf(id) {
    if (id === '__none__') return '未分类'
    const c = this.catById(id)
    return c ? c.name : ''
  },
})
