/* ============================================================================
   同步层 —— 设备与空间之间的网络边界
   ----------------------------------------------------------------------------
   职责边界：**只碰网络与令牌存储，不碰 UI**；本地数据一律经 store 读写。
   设计要点：
     · 免登录：未配对时本模块全程 no-op，App 照常用（store 是唯一真相）
     · **merge 本身就是重试机制** —— 不另建待同步队列。本地有、远端没有的，
       merge 会算进 ops 回推；推失败了下次 pull 再算一遍，天然重放，
       而且因为都是 `on conflict(id) do update`，重复推不会产生脏数据。
     · 写路径只有一条：先写本地（store），再让 sync() 去对齐远端 ——
       不做"本地/云端双写"，避免两边 id 与时间戳不一致。
   ========================================================================== */
const { cloud } = require('./cloud')
const store = require('./store')
const merge = require('./merge')

const DEV_KEY = 'tt-mp-device-v1'

function getDevice() {
  try { return wx.getStorageSync(DEV_KEY) || null } catch (e) { return null }
}
function setDevice(d) {
  try { d ? wx.setStorageSync(DEV_KEY, d) : wx.removeStorageSync(DEV_KEY) } catch (e) {}
}
const isPaired = () => !!getDevice()

/* rpc 返回形状在实现间有差异（可能是值、可能是 [{...}]、可能包一层 result），统一拆一下 */
function unwrap(data) {
  if (Array.isArray(data)) data = data[0]
  if (data && typeof data === 'object' && data.result !== undefined) data = data.result
  return data
}

async function call(name, args) {
  const { data, error } = await cloud.database.rpc(name, args || {})
  if (error) return { ok: false, error: (error && error.message) || 'rpc_failed' }
  const d = unwrap(data)
  if (!d || typeof d !== 'object') return { ok: false, error: 'bad_response' }
  return d
}

/* ---------- 配对 ---------- */

/** 输码换令牌。成功后立刻做一次双向对齐（本机记录并进去 + 空间数据拉下来）。 */
async function redeem(code, deviceName) {
  const r = await call('pair_redeem', { p_code: String(code || '').trim(), p_device_name: deviceName || '手机' })
  if (!r.ok) return r
  setDevice({ token: r.token, deviceId: r.device_id, spaceId: r.space_id, pairedAt: Date.now() })
  store.setMode('paired')
  const s = await sync()
  return { ok: true, synced: s }
}

/** 断开配对：尽力通知服务端作废令牌，失败也照样清本机（本机数据保留） */
async function unpair() {
  const dev = getDevice()
  if (dev) await call('dev_unpair', { p_token: dev.token })
  setDevice(null)
  store.setMode('local')
  return { ok: true }
}

/* ---------- 双向对齐 ---------- */

let syncing = null

/** 拉取 + 合并 + 回推。幂等，可反复调用；未配对时是 no-op。 */
function sync() {
  if (!isPaired()) return Promise.resolve({ ok: false, error: 'not_paired' })
  if (syncing) return syncing                       // 并发去重：同时只跑一次
  syncing = (async () => {
    const dev = getDevice()
    const remote = await call('dev_pull', { p_token: dev.token, p_since: null })
    if (!remote.ok) {
      /* 令牌被撤销（在别的设备上点了"断开"）→ 自动降级回本机模式，不打断使用 */
      if (remote.error === 'invalid_token') { setDevice(null); store.setMode('local') }
      return remote
    }
    const m = merge.mergeStates(store.getState(), remote)
    const ops = merge.pickOps(m.state, m.ops)
    store.applyMerged(m.state)                      // 先落本地，界面立刻是对的
    let pushed = 0
    for (const c of ops.categories) {
      const r = await call('dev_put_category', { p_token: dev.token, p_cat: c })
      if (r.ok) pushed++
    }
    for (const e of ops.entries) {
      const r = await call('dev_put_entry', { p_token: dev.token, p_entry: e })
      if (r.ok) pushed++
    }
    return { ok: true, pulled: (remote.categories || []).length + (remote.entries || []).length, pushed }
  })()
  const done = () => { syncing = null }
  syncing.then(done, done)
  return syncing
}

/* 写之后延迟对齐：合并 + 连点几次只发一轮 */
let timer = null
function syncSoon(delayMs) {
  if (!isPaired()) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => { timer = null; sync() }, delayMs == null ? 800 : delayMs)
}

/** 首次校验令牌是否还有效（App 启动时乐观进 paired，这里确认一下） */
async function verify() {
  if (!isPaired()) return { ok: false, error: 'not_paired' }
  const r = await call('pair_list_devices', { p_token: getDevice().token })
  if (!r.ok && r.error === 'invalid_token') { setDevice(null); store.setMode('local') }
  return r
}

module.exports = { redeem, unpair, sync, syncSoon, verify, isPaired, getDevice }
