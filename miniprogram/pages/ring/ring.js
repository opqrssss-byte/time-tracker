/* ============================================================================
   环形模式 · 首页（拖不了环了 —— 整屏上下滑选分类）
   ----------------------------------------------------------------------------
   视觉与交互来源：prototype/draft-hold-list.html v3（用户 10-11 拍板）

   为什么 canvas 铺满整屏、所有东西都画在里面：
     · 需求是"屏幕任意位置上下滑都能切换" → 手势载体必须覆盖全屏
     · 小程序里 canvas 是**原生组件**，层级最高；反过来说，**压在它上面的普通 view
       会把那块区域的触摸全吃掉**（上一版把环心读数做成叠上去的 view，整个环都拖不动）
     → 全屏 canvas + 页面上不压任何 view，触摸不可能被别的东西截走

   手势：按下(任意处) → 列表浮出 → 上下滑切换 → 松手提交；滑到底可选中「新增分类」
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
const SWATCH = ['#4F8CFF', '#9B6DFF', '#2FBF71', '#F2A93B', '#23B8D5', '#F06EAA', '#FF5A5A', '#8a91a3']

/* 视觉参数：与草稿 v3 同源，全部按屏宽 K 等比（375 宽为设计基准） */
const V = {
  pitch: 76,          // 行距：视觉用（条高 58 要留呼吸）
  dragPerRow: 40,     // 手感用：手指滑多少 px 走一行 ← 与行距**分开**
                      //   绑在一起的话就得滑满 76px 才换一行，分类一多非常烦
  barH: 58, barSelH: 68, barMaxW: 335, padL: 18, padR: 20,
  nameSize: 19, nameSelSize: 24, durSize: 13, durSelSize: 14,
  plusArm: 6, plusGap: 10,      // 「新增」的 ＋ 用两条线画（不用字符：字符宽受字体回退影响，量不准）
  plateR: 121.6, ringR: 86.4, ringSW: 17.6, gapVis: 6.4, ghostDeg: 4.5, maxSectors: 7,
  dialAt: 0.40, listAt: 0.50, revealMs: 200,
}
const T = {
  plate: '#131417', hairline: 'rgba(255,255,255,0.08)',
  track: 'rgba(255,255,255,0.06)', ghost: 'rgba(255,255,255,0.13)',
  ink: '#f4f4f6', body: '#cdcdcd', ash: '#5c5d60', danger: '#FF5A5A',
  addFill: 'rgba(255,255,255,0.085)', addInk: 'rgba(255,255,255,0.72)',
}

const ADD_ID = '__add__'

/* 亮底用深字、暗底用白字。阈值 .62：再低会把中蓝/中绿也判成深字，整排字色就乱了 */
function inkFor(hex) {
  const r = parseInt(String(hex).slice(1, 3), 16)
  const g = parseInt(String(hex).slice(3, 5), 16)
  const b = parseInt(String(hex).slice(5, 7), 16)
  const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return L > 0.62 ? 'rgba(12,14,18,0.9)' : 'rgba(255,255,255,0.97)'
}
const easeOut = (p) => 1 - Math.pow(1 - p, 3)

Page({
  data: {},

  onReady() { this.initCanvas() },

  async onShow() {
    const session = await ensureSession()
    if (!session) return
    await this.loadCategories()
    await this.refreshRunning()
    await this.refreshTodayStats()
    this.startTicker()
    this.rebuild()
  },

  onHide() { this.clearTimers() },
  onUnload() { this.clearTimers() },

  clearTimers() {
    ;['_ticker', '_breathe', '_a_reveal'].forEach((k) => {
      if (this[k]) { clearInterval(this[k]); this[k] = null }
    })
  },

  /* ---------- 一、画布：铺满整屏 ---------- */
  initCanvas() {
    let win = {}
    try { win = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()) || {} } catch (e) { win = {} }
    const dpr = win.pixelRatio || 2
    this._dpr = dpr

    wx.createSelectorQuery().select('#ring')
      .fields({ node: true, size: true })
      .exec((res) => {
        const info = res && res[0]
        if (!info || !info.node) { this._diag = '画布初始化失败（没取到 canvas 节点）'; return }
        const canvas = info.node
        const ctx = canvas.getContext('2d')
        const w = info.width || win.windowWidth || 375
        const h = info.height || win.windowHeight || 667
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
        ctx.scale(dpr, dpr)
        this._canvas = canvas
        this._ctx = ctx
        this._w = w
        this._h = h
        this._K = w / 375
        this._dialY = h * V.dialAt
        this._listY = h * V.listAt
        this._diag = ''
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
      .select('category_id,duration_sec,start_time')
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
    this._ticker = setInterval(() => this.rebuild(), 1000)
    // 呼吸动画走慢节奏（手机端不挂常驻 rAF）
    if (this._breathe) clearInterval(this._breathe)
    this._breathe = setInterval(() => {
      if (!this._running || this._open) return
      this._breath = ((this._breath || 0) + 0.25) % (Math.PI * 2)
      this.draw()
    }, 120)
  },

  /* ---------- 三、几何与行数据 ---------- */
  runningId() { return this._running ? (this._running.category_id || '__none__') : null },

  catById(id) {
    const c = this._cats || []
    for (let i = 0; i < c.length; i++) if (c[i].id === id) return c[i]
    return null
  },

  rebuild() {
    if (!this._K) return
    const K = this._K
    const elapsed = RM.elapsedSec(this._running, Date.now())
    const items = RM.sectors(this._cats || [], this._byCat || {}, this._running, elapsed, {
      ghostDeg: V.ghostDeg, maxSectors: V.maxSectors,
    })
    const G = {
      R: V.ringR * K, SW: V.ringSW * K, GAP_VIS: V.gapVis * K, PLATE_R: V.plateR * K,
    }
    this._G = G
    this._laid = RM.layout(items, G)
    // 行：分类（按环上顺序，也就是今日时长降序）+ 末尾「新增分类」
    this._rows = this._laid.map((it) => ({
      id: it.id, name: it.name, color: it.ghost ? T.ash : it.color,
      sec: it.sec || 0, ghost: !!it.ghost, isAdd: false,
    }))
    this._rows.push({ id: ADD_ID, name: '新增分类', color: T.addFill, sec: 0, ghost: false, isAdd: true })
    this._maxSec = Math.max(1, ...this._rows.map((r) => r.sec))
    // 零点 L0 = 最宽那行文字所需的宽（用选中字号算，保证选中时也不挤）
    this._L0 = this.computeL0()
    this.draw()
  },

  measure(text, size, weight) {
    const ctx = this._ctx
    if (!ctx) return 0
    ctx.font = (weight || 400) + ' ' + Math.round(size) + 'px sans-serif'
    return ctx.measureText(String(text)).width
  },

  /* 一条记录"这行文字最少要多宽"。**一律按选中字号量**：
     行被选中时字会从 19 放大到 24，按小字号量的话选中那一刻文字就顶出条外了
     （「新增」那行就是这么出问题的 —— 其他行按选中字号量，只有它漏了）。 */
  needOf(r) {
    const K = this._K
    const pad = (V.padL + V.padR) * K
    if (r.isAdd) {
      const offset = V.padL * K + V.plusArm * 2 * K + V.plusGap * K
      return offset + this.measure(r.name, V.nameSelSize * K, 600) + V.padR * K
    }
    const nameW = this.measure(r.name, V.nameSelSize * K, 600)
    const durW = this.measure(r.sec ? RM.fmtDurMin(r.sec) : '今天还没有', V.durSelSize * K, 500)
    return nameW + 10 * K + durW + pad
  },

  computeL0() {
    let L0 = 60 * this._K
    ;(this._rows || []).forEach((r) => { L0 = Math.max(L0, this.needOf(r)) })
    return L0
  },

  /* ---------- 四、绘制 ---------- */
  draw() {
    const ctx = this._ctx
    if (!ctx) return
    const rev = this._reveal == null ? 0 : this._reveal
    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0)
    ctx.clearRect(0, 0, this._w, this._h)
    if (rev < 1) this.drawDial(ctx, 1 - rev)
    if (rev > 0) this.drawList(ctx, rev)
    if (this._diag) {
      ctx.globalAlpha = 1
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillStyle = T.danger; ctx.font = '400 12px sans-serif'
      ctx.fillText(this._diag, this._w / 2, this._h - 40)
    }
  },

  capsule(ctx, x, y, w, h) {
    const r = h / 2
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.lineTo(x + w - r, y)
    ctx.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2)
    ctx.lineTo(x + r, y + h)
    ctx.arc(x + r, y + r, r, Math.PI / 2, Math.PI * 1.5)
    ctx.closePath()
  },

  /* 「新增」的 ＋ 用两条线画：字符（U+FF0B）是全角、宽度还受字体回退影响，量不准 */
  drawPlus(ctx, cx, cy, arm, lw) {
    ctx.beginPath()
    ctx.moveTo(cx - arm, cy); ctx.lineTo(cx + arm, cy)
    ctx.moveTo(cx, cy - arm); ctx.lineTo(cx, cy + arm)
    ctx.lineWidth = lw
    ctx.lineCap = 'round'
    ctx.stroke()
  },

  /* 环（空闲态）：盘 + 环 + 环心读数 */
  drawDial(ctx, alpha) {
    if (alpha <= 0.02) return
    const K = this._K
    const G = this._G
    if (!G) return
    const cx = this._w / 2
    const cy = this._dialY
    const rad = (d) => (d - 90) * Math.PI / 180

    ctx.save()
    ctx.globalAlpha = alpha

    ctx.beginPath(); ctx.arc(cx, cy, G.PLATE_R, 0, Math.PI * 2)
    ctx.fillStyle = T.plate; ctx.fill()
    ctx.beginPath(); ctx.arc(cx, cy, G.PLATE_R - 0.5, 0, Math.PI * 2)
    ctx.strokeStyle = T.hairline; ctx.lineWidth = 1; ctx.stroke()

    ctx.save()
    ctx.translate(cx, cy)
    ctx.beginPath(); ctx.arc(0, 0, G.R, 0, Math.PI * 2)
    ctx.lineWidth = G.SW; ctx.strokeStyle = T.track; ctx.stroke()

    const breath = this._running ? (0.74 + 0.26 * (0.5 + 0.5 * Math.sin(this._breath || 0))) : 1
    const laid = this._laid || []
    for (let i = 0; i < laid.length; i++) {
      const it = laid[i]
      ctx.beginPath()
      ctx.arc(0, 0, G.R, rad(it.drawStart), rad(it.drawEnd))
      ctx.lineWidth = G.SW
      ctx.lineCap = 'round'
      ctx.strokeStyle = it.ghost ? T.ghost : it.color
      if (it.active) {
        ctx.shadowColor = RM.rgba(it.color, 0.6)
        ctx.shadowBlur = 7
      } else { ctx.shadowBlur = 0 }
      ctx.globalAlpha = alpha * (it.active ? breath : 1)
      ctx.stroke()
      ctx.shadowBlur = 0
    }
    ctx.globalAlpha = alpha
    ctx.restore()

    // 环心两行：大字 + 状态行
    const cat = this._running ? this.catById(this._running.category_id) : null
    const txt = this._running ? RM.fmtMS(RM.elapsedSec(this._running, Date.now())) : '0:00'
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'
    ctx.fillStyle = this._running ? T.ink : T.ash
    ctx.font = '600 ' + Math.round(40 * K) + 'px sans-serif'
    ctx.fillText(txt, cx, cy - 11 * K)

    const name = this._running ? (cat ? cat.name : '未分类') : '空闲'
    ctx.font = '500 ' + Math.round(15 * K) + 'px sans-serif'
    const tw = ctx.measureText(name).width
    const dotR = 4 * K, gap = 8 * K
    const sx = cx - (dotR * 2 + gap + tw) / 2
    ctx.beginPath(); ctx.arc(sx + dotR, cy + 21 * K, dotR, 0, Math.PI * 2)
    ctx.fillStyle = this._running ? (cat ? cat.color : T.danger) : T.ash
    ctx.fill()
    ctx.textAlign = 'left'
    ctx.fillStyle = this._running ? T.body : T.ash
    ctx.fillText(name, sx + dotR * 2 + gap, cy + 21 * K)

    ctx.restore()
  },

  /* 列表：每行 = 一条荧光条，文字嵌在条里；文字全在 canvas 里、页面上不压 view */
  drawList(ctx, alpha) {
    const K = this._K
    const rows = this._rows || []
    if (!rows.length) return
    const pitch = V.pitch * K
    const maxW = Math.min(V.barMaxW * K, this._w - 40 * K)
    const L0 = Math.min(this._L0, maxW)
    const cx = this._w / 2
    const cy = this._listY
    const pos = this._pos == null ? 0 : this._pos

    ctx.save()
    ctx.globalAlpha = alpha

    for (let i = 0; i < rows.length; i++) {
      const d = Math.abs(i - pos)
      const rowA = d < 0.5 ? 1 : d < 1.5 ? 0.5 : d < 2.5 ? 0.26 : 0
      if (rowA <= 0) continue
      const r = rows[i]
      const y = cy + (i - pos) * pitch
      if (y < -pitch || y > this._h + pitch) continue
      const isSel = d < 0.5

      const h = (isSel ? V.barSelH : V.barH) * K
      const share = r.isAdd ? 0 : Math.min(1, r.sec / this._maxSec)
      const need = this.needOf(r)
      const w = Math.max(need, L0 + (maxW - L0) * share)
      const x = cx - maxW / 2

      ctx.globalAlpha = alpha * rowA * (isSel ? 1 : 0.5)
      ctx.fillStyle = r.isAdd ? T.addFill : r.color
      if (!r.isAdd && !r.ghost) {
        ctx.shadowColor = RM.rgba(r.color, isSel ? 0.55 : 0.28)
        ctx.shadowBlur = isSel ? 26 : 16
      } else { ctx.shadowBlur = 0 }
      this.capsule(ctx, x, y - h / 2, w, h)
      ctx.fill()
      ctx.shadowBlur = 0

      // 文字嵌在条内（起点/内距必须与 needOf() 完全一致，否则会顶出条外）
      const ink = r.isAdd ? T.addInk : (r.ghost ? 'rgba(255,255,255,0.72)' : inkFor(r.color))
      const nameSize = (isSel ? V.nameSelSize : V.nameSize) * K
      const durSize = (isSel ? V.durSelSize : V.durSize) * K
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'left'
      ctx.fillStyle = ink
      ctx.font = '600 ' + Math.round(nameSize) + 'px sans-serif'
      if (r.isAdd) {
        const arm = V.plusArm * K
        this.drawPlus(ctx, x + V.padL * K + arm, y, arm, 2 * K)
        ctx.fillText(r.name, x + V.padL * K + arm * 2 + V.plusGap * K, y)
      } else {
        ctx.fillText(r.name, x + V.padL * K, y)
        ctx.textAlign = 'right'
        ctx.globalAlpha = alpha * rowA * (isSel ? 0.85 : 0.5)
        ctx.font = '500 ' + Math.round(durSize) + 'px sans-serif'
        ctx.fillText(r.sec ? RM.fmtDurMin(r.sec) : '今天还没有', x + w - V.padR * K, y)
      }
    }
    ctx.restore()
  },

  revealTo(on) {
    const from = this._reveal == null ? 0 : this._reveal
    const to = on ? 1 : 0
    if (from === to) return
    const t0 = Date.now()
    if (this._a_reveal) clearInterval(this._a_reveal)
    this._a_reveal = setInterval(() => {
      const p = Math.min(1, (Date.now() - t0) / V.revealMs)
      this._reveal = from + (to - from) * easeOut(p)
      this.draw()
      if (p >= 1) { clearInterval(this._a_reveal); this._a_reveal = null; this._reveal = to }
    }, 20)
  },

  /* ---------- 五、手势：整屏任意位置 ---------- */
  pointOf(e) {
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0])
    if (!t) return null
    const cy = (t.clientY != null) ? t.clientY : t.pageY
    return { y: cy || 0 }
  },

  onTouchStart(e) {
    if (!this._ctx || !this._rows) return
    const p = this.pointOf(e)
    if (!p) return
    // 初始选中"正在计时那一类"；空闲则从第一条开始
    const rid = this.runningId()
    let idx = rid ? this._rows.findIndex((r) => r.id === rid) : 0
    if (idx < 0) idx = 0
    this._pos = idx
    this._downY = p.y
    this._downPos = idx
    this._open = true
    this.revealTo(true)
  },

  onTouchMove(e) {
    if (!this._open) return
    const p = this.pointOf(e)
    if (!p) return
    /* 用 dragPerRow（手感）而不是 pitch（视觉）来换算：
       两个值分开之后，想调"滑多少换一行"就不必动视觉，反之亦然 */
    const step = V.dragPerRow * this._K
    const n = this._rows.length
    const next = this._downPos + (this._downY - p.y) / step
    this._pos = Math.max(0, Math.min(n - 1, next))
    this.draw()
  },

  onTouchEnd() {
    if (!this._open) return
    this._open = false
    this._pos = Math.round(this._pos || 0)
    const r = this._rows[this._pos]
    this.revealTo(false)
    if (!r) return
    if (r.isAdd) this.askAddCategory()
    else this.commit(r.id)
  },

  onTouchCancel() {
    if (!this._open) return
    this._open = false
    this.revealTo(false)
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

    // 先关旧的：库里对 (owner_id) WHERE end_time IS NULL 有唯一部分索引，同一时刻只能有一条进行中
    if (entry) {
      const dur = Math.max(1, Math.round((now.getTime() - new Date(entry.start_time).getTime()) / 1000))
      const { error } = await cloud.database.from('time_entries')
        .update({ end_time: now.toISOString(), duration_sec: dur, updated_at: now.toISOString() })
        .eq('id', entry.id)
      if (error) { wx.showToast({ title: '切换失败，请重试', icon: 'none' }); return }
    }

    const { data, error } = await cloud.database.from('time_entries')
      .insert({ title: '', category_id: id === '__none__' ? null : id, start_time: now.toISOString() })
      .select()
    if (error) {
      wx.showToast({
        title: error.code === '23505' ? '另一台设备正在计时' : '开始失败，请重试',
        icon: 'none',
      })
      await this.refreshRunning()
      this.rebuild()
      return
    }
    this._running = (data && data[0]) || null
    this.rebuild()
    this.refreshTodayStats().then(() => this.rebuild())
  },

  /* ---------- 七、新增分类 ---------- */
  askAddCategory() {
    wx.showModal({
      title: '新增分类',
      editable: true,
      placeholderText: '分类名称，比如「写作」',
      success: (res) => {
        if (!res.confirm) return
        const name = (res.content || '').trim()
        if (!name) { wx.showToast({ title: '名称不能为空', icon: 'none' }); return }
        this.createCategory(name)
      },
      fail: () => { wx.showToast({ title: '当前版本不支持直接新增，可去「设置」里加', icon: 'none' }) },
    })
  },

  async createCategory(name) {
    const cats = this._cats || []
    if (cats.some((c) => c.name === name)) { wx.showToast({ title: '同名分类已存在', icon: 'none' }); return }
    const color = SWATCH[cats.length % SWATCH.length]
    const maxSort = cats.reduce((m, c) => Math.max(m, c.sort_order || 0), 0)
    const { error } = await cloud.database.from('categories')
      .insert({ name, color, sort_order: maxSort + 1 }).select()
    if (error) {
      wx.showToast({ title: error.code === '23505' ? '同名分类已存在' : '添加失败，请重试', icon: 'none' })
      return
    }
    wx.showToast({ title: '已添加「' + name + '」', icon: 'success' })
    await this.loadCategories()
    this.rebuild()
  },

  haptic() {
    const now = Date.now()
    if (this._lastHaptic && now - this._lastHaptic < 80) return
    this._lastHaptic = now
    try { wx.vibrateShort({ type: 'light', fail: () => {} }) } catch (e) { /* 模拟器会抛 */ }
  },

  nameOf(id) {
    if (id === '__none__') return '未分类'
    const c = this.catById(id)
    return c ? c.name : ''
  },
})
