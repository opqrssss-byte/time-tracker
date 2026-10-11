/* ============================================================================
   本机数据层 —— 设备的唯一真相
   ----------------------------------------------------------------------------
   职责边界：**只碰本地存储，绝不发网络请求**。网络在 sync.js，页面只读这里。
   为什么要有它：以前所有读写直连云端、且以登录为前提，所以"打开小程序必然先登录"。
   现在数据先落在本机，登录/配对变成可选的增强。

   存完整数据（不是聚合值）：categories + entries，字段与云端逐字段对齐，
   这样配对时的合并才可能幂等（聚合值没法做合并）。
   ========================================================================== */

const KEY = 'tt-mp-store-v1'
const SCHEMA_V = 1

const DEFAULT_CATEGORIES = [
  { name: '工作', color: '#4F8CFF', sort_order: 1 },
  { name: '学习', color: '#9B6DFF', sort_order: 2 },
  { name: '运动', color: '#2FBF71', sort_order: 3 },
  { name: '生活', color: '#F2A93B', sort_order: 4 },
]

/* 小程序里没有 crypto.randomUUID，用 Math.random 拼 v4。
   122 bit 随机量足够（跨设备撞 id 的概率可以忽略），且合并算法只依赖 id 不撞。 */
function uuid() {
  const h = '0123456789abcdef'
  let s = ''
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) s += '-'
    else if (i === 14) s += '4'
    else if (i === 19) s += h[(Math.random() * 4 | 0) + 8]
    else s += h[Math.random() * 16 | 0]
  }
  return s
}

const nowIso = () => new Date().toISOString()
const ts = (v) => (v ? new Date(v).getTime() : 0)
const secs = (a, b) => Math.max(1, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000))

let state = { categories: [], entries: [] }
let loaded = false
let mode = 'local'                       // 'local' | 'paired'
const subs = []
const modeSubs = []

function notify() {
  subs.slice().forEach((f) => { try { f(state) } catch (e) { /* 订阅方出错不影响数据层 */ } })
}
function notifyMode() {
  modeSubs.slice().forEach((f) => { try { f(mode) } catch (e) {} })
}

function persist() {
  try {
    wx.setStorageSync(KEY, { v: SCHEMA_V, categories: state.categories, entries: state.entries })
  } catch (e) { /* 存储满/被清理：内存态仍然可用，不阻塞交互 */ }
}

/* 不变量：任何时刻**至多一条进行中**（对应云端 (owner_id) WHERE end_time IS NULL 的唯一部分索引）。
   多于一条时保留 start_time 最新的那条，其余在它的开始时刻封口。 */
function normalize() {
  const run = state.entries.filter((e) => !e.end_time)
  if (run.length > 1) {
    run.sort((a, b) => ts(b.start_time) - ts(a.start_time))
    const keep = run[0]
    run.slice(1).forEach((e) => {
      e.end_time = keep.start_time
      e.duration_sec = secs(e.start_time, keep.start_time)
      e.updated_at = keep.start_time
    })
  }
  // 补 duration_sec（老数据可能只有 end_time）
  state.entries.forEach((e) => {
    if (e.end_time && (e.duration_sec == null || !isFinite(e.duration_sec))) {
      e.duration_sec = secs(e.start_time, e.end_time)
    }
  })
}

function seed() {
  const at = nowIso()
  state.categories = DEFAULT_CATEGORIES.map((c) => ({
    id: uuid(), name: c.name, color: c.color, sort_order: c.sort_order, created_at: at,
  }))
  state.entries = []
}

function load() {
  let raw = null
  try { raw = wx.getStorageSync(KEY) } catch (e) { raw = null }
  if (raw && raw.v === SCHEMA_V && Array.isArray(raw.categories) && Array.isArray(raw.entries)) {
    state.categories = raw.categories
    state.entries = raw.entries
  } else {
    if (raw) { try { wx.setStorageSync(KEY + '.bak', raw) } catch (e) {} }   // 版本不符/损坏 → 备份后重建
    seed()
  }
  normalize()
  loaded = true
}

/* ---------------- 读 ---------------- */

const ready = () => (loaded ? Promise.resolve(state) : (load(), persist(), Promise.resolve(state)))
const getState = () => state
const getCategories = () => state.categories.slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
const getEntries = () => state.entries.slice()
const getRunning = () => state.entries.find((e) => !e.end_time) || null

const subscribe = (fn) => { subs.push(fn); return () => { const i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1) } }
const onModeChange = (fn) => { modeSubs.push(fn); return () => { const i = modeSubs.indexOf(fn); if (i >= 0) modeSubs.splice(i, 1) } }
const getMode = () => mode
function setMode(m) { if (m !== mode) { mode = m; notifyMode() } }

/* 今日各分类累计（口径与云端 refreshTodayStats 完全一致）：
   本机 0 点起、**只算已结束的段**、按 category_id（空归 'none'）累加。
   正在计时那段不进这里，由渲染层用 now - start_time 单独叠加。 */
function todayByCat(nowMs) {
  const d = nowMs ? new Date(nowMs) : new Date()
  d.setHours(0, 0, 0, 0)
  const from = d.getTime()
  const byCat = {}
  state.entries.forEach((e) => {
    if (!e.end_time) return
    if (ts(e.start_time) < from) return
    const k = e.category_id || 'none'
    byCat[k] = (byCat[k] || 0) + Math.floor(e.duration_sec || 0)
  })
  return byCat
}

/* ---------------- 写 ---------------- */

function commit() { normalize(); persist(); notify() }

/** 关掉当前进行中的段（若有），返回被关掉的那条或 null */
function closeRunning(endIso) {
  const run = getRunning()
  if (!run) return null
  run.end_time = endIso
  run.duration_sec = secs(run.start_time, endIso)
  run.updated_at = endIso
  return run
}

/** 原子切换：关旧 + 开新，同一时刻，不留空档。与云端 dev_switch 同语义。 */
function switchTo(categoryId, nowMs) {
  const at = nowMs ? new Date(nowMs).toISOString() : nowIso()
  const run = getRunning()
  if (run && (run.category_id || null) === (categoryId || null)) return { ok: false, error: 'same' }
  const closed = closeRunning(at)
  const entry = {
    id: uuid(), title: '', category_id: categoryId || null,
    start_time: at, end_time: null, duration_sec: null,
    created_at: at, updated_at: at,
  }
  state.entries.push(entry)
  commit()
  return { ok: true, entry, closed }
}

/** 空闲 → 开始；已有进行中则拒绝（调用方应该用 switchTo） */
function startEntry(categoryId, nowMs) {
  if (getRunning()) return { ok: false, error: 'already_running' }
  const at = nowMs ? new Date(nowMs).toISOString() : nowIso()
  const entry = {
    id: uuid(), title: '', category_id: categoryId || null,
    start_time: at, end_time: null, duration_sec: null,
    created_at: at, updated_at: at,
  }
  state.entries.push(entry)
  commit()
  return { ok: true, entry }
}

function stopEntry(nowMs) {
  const at = nowMs ? new Date(nowMs).toISOString() : nowIso()
  const closed = closeRunning(at)
  if (!closed) return { ok: false, error: 'not_running' }
  commit()
  return { ok: true, entry: closed }
}

function putEntry(entry) {
  if (!entry || !entry.id) return { ok: false, error: 'no_id' }
  const i = state.entries.findIndex((e) => e.id === entry.id)
  if (i >= 0) state.entries[i] = Object.assign({}, state.entries[i], entry)
  else state.entries.push(Object.assign({}, entry))
  commit()
  return { ok: true }
}

function deleteEntry(id) {
  const n = state.entries.length
  state.entries = state.entries.filter((e) => e.id !== id)
  if (state.entries.length === n) return { ok: false, error: 'not_found' }
  commit()
  return { ok: true }
}

function addCategory(name, color) {
  const nm = String(name || '').trim()
  if (!nm) return { ok: false, error: 'empty_name' }
  if (state.categories.some((c) => c.name === nm)) return { ok: false, error: 'duplicate_name' }
  const maxSort = state.categories.reduce((m, c) => Math.max(m, c.sort_order || 0), 0)
  const cat = { id: uuid(), name: nm, color: color || '#8a91a3', sort_order: maxSort + 1, created_at: nowIso() }
  state.categories.push(cat)
  commit()
  return { ok: true, category: cat }
}

function renameCategory(id, name) {
  const c = state.categories.find((x) => x.id === id)
  if (!c) return { ok: false, error: 'not_found' }
  const nm = String(name || '').trim()
  if (!nm) return { ok: false, error: 'empty_name' }
  if (state.categories.some((x) => x.name === nm && x.id !== id)) return { ok: false, error: 'duplicate_name' }
  c.name = nm
  commit()
  return { ok: true }
}

function deleteCategory(id) {
  const i = state.categories.findIndex((c) => c.id === id)
  if (i < 0) return { ok: false, error: 'not_found' }
  state.categories.splice(i, 1)
  // 对齐云端的 ON DELETE SET NULL：分类没了，它名下的记录落成"未分类"
  state.entries.forEach((e) => { if (e.category_id === id) e.category_id = null })
  commit()
  return { ok: true }
}

/** 整体替换（拉取后覆盖用） */
function replaceAll(next) {
  state.categories = Array.isArray(next && next.categories) ? next.categories.slice() : state.categories
  state.entries = Array.isArray(next && next.entries) ? next.entries.slice() : state.entries
  commit()
}

/** 合并结果落盘（merge.js 算出的新 state 写回来） */
function applyMerged(merged) {
  if (!merged) return
  state.categories = merged.categories.slice()
  state.entries = merged.entries.slice()
  commit()
}

module.exports = {
  ready, getState, getCategories, getEntries, getRunning, todayByCat, subscribe,
  startEntry, switchTo, stopEntry, putEntry, deleteEntry,
  addCategory, renameCategory, deleteCategory,
  replaceAll, applyMerged,
  getMode, setMode, onModeChange,
  uuid, DEFAULT_CATEGORIES, STORAGE_KEY: KEY,
}
