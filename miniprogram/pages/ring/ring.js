/* ============================================================================
   环形模式 · 拖环旋转 + 松手确认（手机端试用手感的页面）
   ----------------------------------------------------------------------------
   来源：prototype/（网页原型，已自测 32/32、且几何与桌面端逐值校验过）。
   小程序侧的三处差异：canvas 取尺寸、touch 事件、震动 API —— 其余同构。

   与 timer 页的关系：**不动 timer 页**，本页从它上面一个入口进入。
   交互取舍：没有"停止"——空闲→开始，不同→原子切换（先关旧再开新），相同→无操作。
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

/* 手感参数：与网页原型同一套默认值（原型里可以在调试面板上实时拖） */
const P = {
  stepDeg: 40, jitterDeg: 1.5, maxStepsPerMove: 3,
  tapMoveTolDeg: 8, tapMaxMs: 350,
  touchPad: 16, centerHole: 34,
  outPush: 1.35, detentDeg: 3.5, detentMs: 160,
  glow: 7, ghostDeg: 4.5, maxSectors: 7,
  haptic: true,
}

const easeOut = (p) => 1 - Math.pow(1 - p, 3)

Page({
  data: {
    // 画布与几何（px，按屏宽等比算出来）
    platePx: 0, canvasPx: 0, padPx: 0, timeSize: 40,
    // 读数
    elapsedText: '0:00', running: false, stateText: '空闲', stateColor: '#c8ccd4',
    latestText: '',
    // 次要通道（选中时）
    showCand: false, focusName: '', focusDur: '', focusColor: '',
    showHint: true,
    // 诊断
    canvasReady: false, canvasError: '',
  },

  onReady() { this.initCanvas() },

  async onShow() {
    const session = await ensureSession()
    if (!session) return
    await this.loadCategories()
    await this.refreshRunning()
    await this.refreshTodayStats()   // 缺了这句环上就只有"正在计时"那一段，其余全是幽灵
    this.startTicker()
    this.startPolling()
  },

  onHide() { this.clearTimers() },
  onUnload() { this.clearTimers() },

  clearTimers() {
    if (this._ticker) { clearInterval(this._ticker); this._ticker = null }
    if (this._poll) { clearInterval(this._poll); this._poll = null }
    if (this._breathe) { clearInterval(this._breathe); this._breathe = null }
    if (this._a_push) { clearInterval(this._a_push); this._a_push = null }
    if (this._a_detent) { clearInterval(this._a_detent); this._a_detent = null }
  },

  /* ---------- 一、画布初始化 ---------- */
  initCanvas() {
    // 等比基准：以 375 宽的设计稿为准（与 prototype/ 一致），屏宽不同则整体缩放
    let win = null
    try {
      win = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync())
    } catch (e) { win = { windowWidth: 375, pixelRatio: 2 } }
    const w = (win && win.windowWidth) || 375
    const dpr = (win && win.pixelRatio) || 2
    const K = w / 375

    const platePx = 243.2 * K
    const canvasPx = 279.2 * K          // 盘 + 两侧留白，给选中外扩与辉光留余量
    const padPx = -(canvasPx - platePx) / 2

    this._K = K
    this._dpr = dpr
    this._G = {
      R: 86.4 * K, SW: 17.6 * K, GAP_VIS: 6.4 * K, PLATE_R: 121.6 * K,
    }
    this.setData({ platePx, canvasPx, padPx, timeSize: Math.round(40 * K) })

    wx.createSelectorQuery().select('#ring')
      .fields({ node: true, size: true, rect: true })
      .exec((res) => {
        const info = res && res[0]
        if (!info || !info.node) {
          this.setData({ canvasError: '画布没取到（node 为空）' })
          return
        }
        const canvas = info.node
        const ctx = canvas.getContext('2d')
        canvas.width = Math.round(info.width * dpr)
        canvas.height = Math.round(info.height * dpr)
        ctx.scale(dpr, dpr)
        this._canvas = canvas
        this._ctx = ctx
        this._cw = info.width
        this._ch = info.height
        this._rect = { left: info.left || 0, top: info.top || 0 }
        this.setData({ canvasReady: true, canvasError: '' })
        this.rebuild()
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
    this.rebuild()
  },

  async refreshRunning() {
    const { data, error } = await cloud.database
      .from('time_entries').select('*').is('end_time', null).maybeSingle()
    if (error) return
    this._running = data || null
    this.rebuild()
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
    const latest = {}
    ;(data || []).forEach((e) => {
      const k = e.category_id || 'none'
      byCat[k] = (byCat[k] || 0) + Math.floor(e.duration_sec || 0)
      if (!latest[k]) latest[k] = (e.title || '').trim()
    })
    this._byCat = byCat
    this._latest = latest
    this.rebuild()
  },

  startTicker() {
    if (this._ticker) clearInterval(this._ticker)
    this._ticker = setInterval(() => { this.rebuild() }, 1000)
    // 呼吸动画单独走慢节奏：手机端不挂常驻 rAF（费电）
    if (this._breathe) clearInterval(this._breathe)
    this._breathe = setInterval(() => {
      if (!this._running || !this._layout) return
      this._breathPhase = (this._breathPhase || 0) + 0.25
      this.draw()
    }, 120)
  },

  startPolling() {
    if (this._poll) clearInterval(this._poll)
    this._poll = setInterval(async () => {
      await this.refreshRunning()
      await this.refreshTodayStats()
    }, 30000)
  },

  /* ---------- 三、几何与读数 ---------- */
  runningId() {
    return this._running ? (this._running.category_id || '__none__') : null
  },

  rebuild() {
    if (!this._G) return
    const cats = this._cats || []
    const elapsed = RM.elapsedSec(this._running, Date.now())
    const items = RM.sectors(cats, this._byCat || {}, this._running, elapsed, {
      ghostDeg: P.ghostDeg, maxSectors: P.maxSectors,
    })
    this._layout = RM.layout(items, {
      R: this._G.R, SW: this._G.SW, GAP_VIS: this._G.GAP_VIS,
    })
    this.renderReadout()
    this.renderCandidate()
    this.draw()
  },

  catById(id) {
    const cats = this._cats || []
    for (let i = 0; i < cats.length; i++) if (cats[i].id === id) return cats[i]
    return null
  },

  renderReadout() {
    const run = this._running
    const cat = run ? this.catById(run.category_id) : null
    const txt = run ? RM.fmtMS(RM.elapsedSec(run, Date.now())) : '0:00'
    const latestKey = run ? (run.category_id || 'none') : null
    const patch = {
      elapsedText: txt,
      running: !!run,
      stateText: run ? (cat ? cat.name : '未分类') : '空闲',
      stateColor: run ? (cat ? cat.color : '#FF5A5A') : '#c8ccd4',
      latestText: (latestKey && (this._latest || {})[latestKey]) ? ('最近：' + this._latest[latestKey]) : '',
      showHint: !run && !this._focusId,
    }
    this.setData(patch)
  },

  renderCandidate() {
    const id = this._focusId
    if (!id) { this.setData({ showCand: false }); return }
    const laid = this._layout || []
    let it = null
    for (let i = 0; i < laid.length; i++) if (laid[i].id === id) { it = laid[i]; break }
    const name = id === '__none__' ? '未分类' : id === '__other__' ? '其他分类' : (it ? it.name : '')
    this.setData({
      showCand: true,
      focusName: name,
      focusColor: it && !it.ghost ? it.color : '#c8ccd4',
      focusDur: it && it.sec ? RM.fmtDurMin(it.sec) : '今天还没有',
    })
  },

  /* ---------- 四、绘制（canvas 2d） ---------- */
  draw() {
    const ctx = this._ctx
    if (!ctx || !this._G) return
    const G = this._G
    const W = this._cw, H = this._ch
    const cx = W / 2, cy = H / 2
    const now = Date.now()
    const rad = (deg) => (deg - 90) * Math.PI / 180

    ctx.clearRect(0, 0, W, H)
    ctx.save()
    ctx.translate(cx, cy)
    if (this._detent) ctx.rotate(this._detent * Math.PI / 180)

    // 轨道底环
    ctx.beginPath()
    ctx.arc(0, 0, G.R, 0, Math.PI * 2)
    ctx.lineWidth = G.SW
    ctx.strokeStyle = 'rgba(20,30,50,0.07)'
    ctx.stroke()

    const laid = this._layout || []
    const push = this._push == null ? 0 : this._push
    const breath = this._running ? (0.74 + 0.26 * (0.5 + 0.5 * Math.sin((this._breathPhase || 0)))) : 1

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
      ctx.strokeStyle = it.ghost ? 'rgba(20,30,50,0.11)' : it.color
      // 辉光只给"选中"和"计时中"；强度按浅色底收着来（深色底才需要全强度）
      if (active || focused) {
        ctx.shadowColor = RM.rgba(it.color, 0.38)
        ctx.shadowBlur = P.glow * 0.55 * (focused ? 1.15 : 1)
      } else {
        ctx.shadowBlur = 0
      }
      ctx.globalAlpha = active ? breath : 1
      ctx.stroke()
      ctx.shadowBlur = 0
      ctx.globalAlpha = 1
    }
    ctx.restore()
  },

  /* 补间：160ms 内把 _push / _detent 推到目标（用 20ms 的定时器，不挂常驻 rAF） */
  animateTo(key, to, ms) {
    if (this['_' + key] === to && this['_a_' + key]) return
    const from = this['_' + key] == null ? 0 : this['_' + key]
    const t0 = Date.now()
    if (this['_a_' + key]) clearInterval(this['_a_' + key])
    this['_a_' + key] = setInterval(() => {
      const p = Math.min(1, (Date.now() - t0) / ms)
      this['_' + key] = from + (to - from) * easeOut(p)
      this.draw()
      if (p >= 1) { clearInterval(this['_a_' + key]); this['_a_' + key] = null; this['_' + key] = to }
    }, 20)
  },

  /* ---------- 五、触摸手势 ---------- */
  touchPoint(e) {
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0])
    if (!t) return null
    const r = this._rect || { left: 0, top: 0 }
    // 小程序 touch 对象带 clientX/clientY（相对视口）；本页不滚动，rect 一次取值即可
    const px = (t.clientX != null) ? t.clientX : (t.pageX != null ? t.pageX : 0)
    const py = (t.clientY != null) ? t.clientY : (t.pageY != null ? t.pageY : 0)
    return { x: px - r.left, y: py - r.top }
  },

  onTouchStart(e) {
    const ctx = this._ctx
    if (!ctx) return
    const p = this.touchPoint(e)
    if (!p) return
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

  onTouchEnd(e) {
    if (!this._pressing) return
    this._pressing = false
    const zone = this._pressZone
    if (zone === 'outside') { this.setFocus(null); return }
    if (zone === 'center') { if (this._focusId) this.setFocus(null); return }

    const dt = Date.now() - this._downT
    if (this._moved) { this.commit(this._focusId); this.setFocus(null); return }
    if (Math.abs(this._netDeg) < P.tapMoveTolDeg && dt < P.tapMaxMs) {
      this.commit(this._pressHitId)
      this.setFocus(null)
      return
    }
    this.setFocus(this._pressFocusId)   // 弱拖动：不提交，回到按下前的选中态
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
    this.setData({ showHint: !this._running && !id })
  },

  haptic() {
    if (!P.haptic) return
    const now = Date.now()
    if (this._lastHaptic && now - this._lastHaptic < 60) return
    this._lastHaptic = now
    try { wx.vibrateShort({ type: 'light', fail: () => {} }) } catch (e) { /* 老基础库/模拟器会抛 */ }
  },

  /* ---------- 六、确认：只有切换，没有停止 ---------- */
  async commit(id) {
    if (!id) return
    if (id === '__other__') {
      wx.showToast({ title: '环上只画前 7 个分类', icon: 'none' })
      return
    }
    const cur = this.runningId()
    if (cur === id) {
      // 防误停：与运行中相同 → 无操作，只给一点触感与提示
      this.haptic()
      wx.showToast({ title: '已在计时', icon: 'none' })
      return
    }
    this.haptic()
    const now = new Date()
    const entry = this._running

    // 1) 先关旧的那条：库里对 (owner_id) WHERE end_time IS NULL 有唯一部分索引，
    //    同一时刻只能有一条"进行中"，所以必须先关后开
    if (entry) {
      const dur = Math.max(1, Math.round((now.getTime() - new Date(entry.start_time).getTime()) / 1000))
      const { error } = await cloud.database.from('time_entries')
        .update({
          end_time: now.toISOString(),
          duration_sec: dur,
          updated_at: now.toISOString(),
        })
        .eq('id', entry.id)
      if (error) { wx.showToast({ title: '切换失败，请重试', icon: 'none' }); return }
    }

    // 2) 再开新的
    const { data, error } = await cloud.database.from('time_entries')
      .insert({
        title: '',
        category_id: id === '__none__' ? null : id,
        start_time: now.toISOString(),
      })
      .select()
    if (error) {
      if (error.code === '23505') {
        wx.showToast({ title: '另一台设备正在计时', icon: 'none' })
      } else {
        wx.showToast({ title: '开始失败，请重试', icon: 'none' })
      }
      await this.refreshRunning()
      return
    }
    this._running = (data && data[0]) || null
    this.rebuild()
    this.refreshTodayStats()
  },
})
