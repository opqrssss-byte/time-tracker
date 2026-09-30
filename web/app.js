/* ========== 初始化云客户端（publicConfig，安全可前置） ========== */
const cloud = WorkBuddyCloud.createWorkBuddyCloud({
  endpoint: 'https://mp-api.app.workbuddy.host',
  publishableKey: 'wbpk_Nv3mR6jZnOsFxEs3wbZrvd_Hw3G3bU9x7kabAo23YK62qBAxnFk3KYL',
})

/* ========== 运行模式 ========== */
const IS_WIDGET = new URLSearchParams(location.search).has('widget')
/* 演示模式（?widget=1&demo=1）：本地预览组件外观与交互，用样例数据、不连云端。
   仅用于开发预览/效果确认，正式环境不带该参数。 */
const IS_DEMO = IS_WIDGET && new URLSearchParams(location.search).has('demo')
const isElectron = !!(window.electronAPI && window.electronAPI.isElectron)
if (IS_WIDGET) document.body.classList.add('widget-mode')
if (isElectron) document.body.classList.add('electron')

/* ========== 全局状态 ========== */
let pendingEmailOtp = null
let currentUser = null
let categories = []
let selectedCategoryId = null
let runningEntry = null
let ticker = null
let pollTimer = null
let resendCountdown = 0
let resendTimer = null
let statsRange = 'day'
let pieChart = null
let barChart = null
let editingEntry = null
let editCategoryId = null
let historyEntries = []
let historyFilter = 'all'          // all | pending（待补充）
let quickTagEntry = null           // 停止后待打标签的记录

/* ========== 工具 ========== */
const $ = (id) => document.getElementById(id)

function showToast(msg, ms = 2600) {
  const t = $('toast')
  t.textContent = msg
  t.classList.remove('hidden')
  clearTimeout(showToast._t)
  showToast._t = setTimeout(() => t.classList.add('hidden'), ms)
}

function fmtHMS(totalSec) {
  const s = Math.max(0, Math.floor(totalSec))
  const h = String(Math.floor(s / 3600)).padStart(2, '0')
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const sec = String(s % 60).padStart(2, '0')
  return `${h}:${m}:${sec}`
}

/* 纯分:秒（小时折进分钟，如 125:15）——悬浮组件专用 */
function fmtMS(totalSec) {
  const s = Math.max(0, Math.floor(totalSec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function fmtClock(iso) {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function fmtDurMin(sec) {
  if (sec == null) return '-'
  // 一律按整秒处理：累计/实时时长都可能带浮点小数（如 5.343），不能直接展示
  const s = Math.max(0, Math.floor(Number(sec) || 0))
  if (s < 60) return `${s}秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}分钟`
  return `${Math.floor(m / 60)}小时${m % 60 ? (m % 60) + '分' : ''}`
}

function dateLabel(iso) {
  const d = new Date(iso)
  const today = new Date()
  const yest = new Date(today); yest.setDate(today.getDate() - 1)
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (same(d, today)) return '今天'
  if (same(d, yest)) return '昨天'
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function catById(id) {
  return categories.find((c) => c.id === id) || null
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]))
}

function isoToLocalInput(iso) {
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/* ========== Google 同步（引擎在 gsync.js） ========== */
async function fetchSyncData() {
  const since = new Date()
  since.setDate(since.getDate() - 30)
  const { data, error } = await cloud.database.from('time_entries')
    .select('*').not('end_time', 'is', null)
    .gte('start_time', since.toISOString())
    .order('start_time', { ascending: false }).limit(2000)
  if (error) throw new Error('云端记录读取失败')
  return { entries: data || [], categories }
}

function triggerSync() { GSync.scheduleSync(fetchSyncData) }

function renderGsyncStatus(msg, isError) {
  const el = $('gsync-status')
  if (!el) return
  if (msg) {
    el.textContent = msg
    el.style.color = isError ? '#FF5A5A' : '#2FBF71'
  } else if (GSync.isConfigured()) {
    const last = GSync.lastSyncAt()
    el.textContent = last ? `上次同步：${new Date(last).toLocaleString('zh-CN')}` : '已配置，尚未同步'
    el.style.color = ''
  } else {
    el.textContent = '未配置'
    el.style.color = ''
  }
}

GSync.onStatus(renderGsyncStatus)

function wireGsyncSettings() {
  const cfg = GSync.getConfig()
  if (cfg) {
    $('gdoc-id').value = cfg.docId || ''
    $('gsa-json').value = cfg.saRaw || ''
  }
  renderGsyncStatus()

  $('btn-gsync-save').addEventListener('click', async () => {
    const docId = $('gdoc-id').value.trim()
    const saRaw = $('gsa-json').value.trim().replace(/^﻿/, '')
    if (!docId || !saRaw) { showToast('请填写 Doc ID 和密钥 JSON'); return }
    let sa
    try { sa = JSON.parse(saRaw) } catch { showToast('密钥 JSON 格式不正确，请确认粘贴的是完整 JSON 文本'); return }
    if (!sa.client_email || !sa.private_key) { showToast('密钥 JSON 缺少 client_email 或 private_key'); return }
    GSync.saveConfig({ docId, sa, saRaw })
    showToast('配置已保存（仅存本机），正在自检…')
    renderGsyncStatus()
    await runGsyncDiagnose()
  })

  $('btn-gsync-check').addEventListener('click', () => runGsyncDiagnose())
  $('btn-gsync-now').addEventListener('click', () => GSync.syncNow(fetchSyncData))
}

/* 分步自检并渲染结果 */
async function runGsyncDiagnose() {
  const box = $('gsync-steps')
  box.classList.remove('hidden')
  box.innerHTML = '<div class="gsync-step"><span class="step-icon">⏳</span><span>自检中…</span></div>'
  let steps
  try {
    steps = await GSync.diagnose()
  } catch (e) {
    steps = [{ ok: false, name: '自检', message: String(e && e.message || e) }]
  }
  box.innerHTML = ''
  steps.forEach((s) => {
    const row = document.createElement('div')
    row.className = 'gsync-step ' + (s.ok ? 'ok' : 'fail')
    row.innerHTML = `<span class="step-icon">${s.ok ? '✅' : '❌'}</span>
      <div class="step-body">
        <div class="step-name">${escapeHtml(s.name)}：${escapeHtml(s.message)}</div>
        ${s.suggestion ? `<div class="step-suggestion">💡 ${escapeHtml(s.suggestion)}</div>` : ''}
      </div>`
    box.appendChild(row)
  })
  const allOk = steps.length && steps.every((s) => s.ok)
  if (allOk) {
    renderGsyncStatus('自检全部通过，正在执行首次同步…')
    await GSync.syncNow(fetchSyncData)
  }
}

/* ========== 登录 ========== */
function showLogin() {
  if (IS_WIDGET) { showWidgetLogin(); return }
  $('view-app').classList.add('hidden')
  $('view-login').classList.remove('hidden')
}

function loginError(msg) {
  const el = $('login-error')
  if (!msg) { el.classList.add('hidden'); return }
  el.textContent = msg
  el.classList.remove('hidden')
}

$('tab-otp').addEventListener('click', () => {
  $('tab-otp').classList.add('active'); $('tab-pwd').classList.remove('active')
  $('form-otp').classList.remove('hidden'); $('form-pwd').classList.add('hidden')
  loginError('')
})
$('tab-pwd').addEventListener('click', () => {
  $('tab-pwd').classList.add('active'); $('tab-otp').classList.remove('active')
  $('form-pwd').classList.remove('hidden'); $('form-otp').classList.add('hidden')
  loginError('')
})

function startResendCountdown() {
  resendCountdown = 60
  const btn = $('btn-send-code')
  btn.disabled = true
  btn.textContent = `${resendCountdown}s 后重发`
  clearInterval(resendTimer)
  resendTimer = setInterval(() => {
    resendCountdown -= 1
    if (resendCountdown <= 0) {
      clearInterval(resendTimer)
      btn.disabled = false
      btn.textContent = '重新获取'
    } else {
      btn.textContent = `${resendCountdown}s 后重发`
    }
  }, 1000)
}

$('btn-send-code').addEventListener('click', async () => {
  const email = $('otp-email').value.trim()
  if (!email) { loginError('请先输入邮箱地址'); return }
  loginError('')
  const btn = $('btn-send-code')
  btn.disabled = true
  try {
    const sent = await cloud.auth.sendOtp({ email })
    if (sent.error) {
      btn.disabled = false
      loginError(sent.error.message || '验证码发送失败，请稍后重试')
      return
    }
    pendingEmailOtp = {
      email,
      verificationId: sent.data.verificationId,
      isExistingUser: sent.data.isExistingUser,
    }
    $('otp-password-row').classList.toggle('hidden', pendingEmailOtp.isExistingUser)
    showToast('验证码已发送，请查收邮件')
    startResendCountdown()
  } catch (e) {
    btn.disabled = false
    loginError('网络异常，请稍后重试')
  }
})

$('form-otp').addEventListener('submit', async (e) => {
  e.preventDefault()
  const email = $('otp-email').value.trim()
  const code = $('otp-code').value.trim()
  const password = $('otp-password').value
  if (!pendingEmailOtp || pendingEmailOtp.email !== email) {
    loginError('请先获取当前邮箱的验证码'); return
  }
  if (!code) { loginError('请输入验证码'); return }
  if (!pendingEmailOtp.isExistingUser && password.length < 6) {
    loginError('首次登录请设置至少 6 位密码'); return
  }
  loginError('')
  const completed = await cloud.auth.verifyOtp({
    email: pendingEmailOtp.email,
    verificationId: pendingEmailOtp.verificationId,
    isExistingUser: pendingEmailOtp.isExistingUser,
    token: code,
    password: pendingEmailOtp.isExistingUser ? undefined : password,
  })
  if (completed.error) {
    loginError(completed.error.message || '验证码错误或已过期')
    return
  }
  pendingEmailOtp = null
  enterApp(completed.data && completed.data.user)
})

$('form-pwd').addEventListener('submit', async (e) => {
  e.preventDefault()
  loginError('')
  const { data, error } = await cloud.auth.signInWithPassword({
    email: $('pwd-email').value.trim(),
    password: $('pwd-password').value,
  })
  if (error) { loginError('账号或密码错误'); return }
  enterApp(data && data.user)
})

$('btn-forgot').addEventListener('click', () => {
  $('tab-otp').click()
  showToast('用验证码登录后即为本人，新用户流程可重设密码')
})

/* ========== 主应用入口 ========== */
async function enterApp(user) {
  currentUser = user || currentUser
  if (IS_WIDGET) { enterWidget(); return }
  $('view-login').classList.add('hidden')
  $('view-app').classList.remove('hidden')
  const emailText = (currentUser && currentUser.email) || ''
  $('header-user').textContent = emailText
  $('settings-user').textContent = emailText ? `当前账号：${emailText}` : ''
  wireGsyncSettings()
  await loadCategories()
  await refreshRunning()
  await loadHistory()
  startTicker()
  startPolling()
  triggerSync() // 启动时补同步
}

/* 标签页切换 */
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'))
    btn.classList.add('active')
    document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'))
    $('page-' + btn.dataset.tab).classList.remove('hidden')
    if (btn.dataset.tab === 'history') loadHistory()
    if (btn.dataset.tab === 'stats') loadStats()
    if (btn.dataset.tab === 'settings') renderCatManage()
  })
})

/* ========== 桌面悬浮组件（widget）模式：极简光环 ==========
   设计依据：Apple HIG Activity Rings（圆头进度弧 + 中心读数）· Orbital 桌面番茄钟（极简光环 + 微光呼吸）
   表面/描边/排印遵循 Raycast 设计系统（表面阶梯 + 发丝描边 + 无投影），详见 DESIGN.md
*/
const WIDGET_W = 160           // 基础窗宽（圆形玻璃盘 152 + 边距）
const WIDGET_H = 168           // 比盘高 16px：给盘底「+」入口留出不被窗口裁切的余量
const WIDGET_PANEL_W = 260     // 展开面板时的窗口尺寸
const WIDGET_PANEL_H = 320
const RING_CX = 60
const RING_R = 54              // 环半径（玻璃盘 152 → 外缘 59，留 15px 呼吸位）
const RING_SW = 11             // 环带宽（中心留 98px 放读数，可容 125:15）
const RING_CIRC = 2 * Math.PI * RING_R
const SEG_GAP_VIS = 4          // 扇区视觉间隙（圆头线帽各向外延伸 SW/2）
const MAX_SECTORS = 7          // 环上直接展示的最大扇区数，其余合并为「其他」
const GHOST_DEG = 6            // 今日无记录的分类保留的最小可点角度（幽灵扇区）
/* —— 滚轮交互（仿三星旋转表圈：旋转=移动高亮，停顿/点击=确认）—— */
const WHEEL_STEP = 100         // 累积 |deltaY| 达到该值才走一步（鼠标一格≈100~120，触控板小增量先攒）
const WHEEL_LOCK_MS = 150      // 步进后锁定时长：忽略惯性连发，一次事件至多一步
const WHEEL_IDLE_RESET_MS = 300 // 停这么久累积清零，避免两次半格拼成一格
const FOCUS_CONFIRM_MS = 900   // 选中后停顿多久自动确认（开始 / 切换）
const RING_CONFIRM_SW = 3      // 确认进度弧线宽
const DETENT_DEG = 3.5         // 档位反馈扭动幅度
const WIDGET_SWATCH_COLORS = ['#4F8CFF', '#9B6DFF', '#2FBF71', '#F2A93B', '#FF5A5A', '#23B8D5', '#F06EAA', '#8a91a3']
let widgetSwatchColor = WIDGET_SWATCH_COLORS[0]
let ringData = []              // 环上扇区数据（供中心读数使用）
let hoverCatId = null          // 悬停中的扇区 id（'__other__' / '__none__' / 分类 id）
let focusCatId = null          // 滚轮选中的扇区 id（与 hover 互斥，focus 优先）
let confirmTimer = null        // 停顿自动确认的 setTimeout
let confirmRAF = null          // 确认进度弧的 rAF
let confirmProgress = 0        // 0..1，确认进度
let confirmArcEl = null        // 细白确认弧 <circle>
let ringRotEl = null           // 档位扭动用的内层 <g>
let wheelAccum = 0             // 滚轮累积量
let wheelSign = 0              // 上次滚动方向
let wheelLockUntil = 0         // 步进锁定截止时间戳
let wheelResetTimer = null     // 累积清零定时器

function showWidgetLogin() {
  $('view-widget').classList.remove('hidden')
  $('widget-login').classList.remove('hidden')
  $('widget-plate').classList.add('hidden')
  hideAllPanels()
}

$('btn-widget-login').addEventListener('click', () => {
  if (isElectron) window.electronAPI.openFull()
  else location.href = location.origin + location.pathname
})

/* ---------- 演示模式：样例数据 + 本地计时，不连云端 ---------- */
function enterDemo() {
  const todayAt = (h, m) => { const d = new Date(); d.setHours(h, m || 0, 0, 0); return d.toISOString() }
  categories = [
    { id: 'd1', name: '工作', color: '#4F8CFF', sort_order: 1 },
    { id: 'd2', name: '学习', color: '#9B6DFF', sort_order: 2 },
    { id: 'd3', name: '运动', color: '#2FBF71', sort_order: 3 },
    { id: 'd4', name: '生活', color: '#F2A93B', sort_order: 4 },
    { id: 'd5', name: '阅读', color: '#23B8D5', sort_order: 5 },
    { id: 'd6', name: '写作', color: '#F06EAA', sort_order: 6 },
  ]
  todayStats = {
    day: dayKey(new Date()),
    byCat: { d1: 3600, d2: 1800, d4: 7200, d5: 2400 },
    latest: { d1: '写周报', d2: '看论文', d4: '买菜做饭', d5: '读《设计心理学》' },
    demoStartedAt: todayAt(9),
  }
  currentUser = { email: 'demo@local' }
  $('view-login').classList.add('hidden')
  $('view-widget').classList.remove('hidden')
  $('widget-login').classList.add('hidden')
  $('widget-plate').classList.remove('hidden')
  renderRing()
  renderCenter()
  setInterval(() => { tickRing(); renderCenter() }, 1000)
}

/* 演示模式的计时：只在本地状态里开关，方便体验点击手感 */
function demoToggle(catId, { viaWheel = false } = {}) {
  const cid = catId === '__none__' ? null : catId
  if (runningEntry && runningEntry.category_id === cid) {
    if (viaWheel) return                                   // 滚轮确认 → 不误停
    const dur = elapsedSec()                               // 点击 → 停止（并弹快速标签，与正式流程一致）
    runningEntry = null
    if (cid) todayStats.byCat[cid] = (todayStats.byCat[cid] || 0) + dur
    else todayStats.byCat.none = (todayStats.byCat.none || 0) + dur
    showToast(`已记录 ${fmtDurMin(Math.max(1, dur))}`)
    if (!quickTagEntry) {
      quickTagEntry = { id: 'demo', category_id: cid, start_time: new Date().toISOString(), end_time: new Date().toISOString(), duration_sec: dur }
      openQuickTag(quickTagEntry)
    }
  } else {
    const wasRunning = !!runningEntry                         // 切换：不弹标签栏（对应正式流程的 skipQuickTag）
    if (runningEntry) {
      const p = runningEntry
      const d = elapsedSec()
      if (p.category_id) todayStats.byCat[p.category_id] = (todayStats.byCat[p.category_id] || 0) + d
      else todayStats.byCat.none = (todayStats.byCat.none || 0) + d
    }
    runningEntry = { id: 'demo-run', title: '', category_id: cid, start_time: new Date().toISOString() }
    showToast(wasRunning ? '已切换（演示）' : '计时开始（演示）')
  }
  clearHover()
  renderRing()
  renderCenter()
}

async function enterWidget() {
  $('view-login').classList.add('hidden')
  $('view-widget').classList.remove('hidden')
  $('widget-login').classList.add('hidden')
  $('widget-plate').classList.remove('hidden')
  // 桌面常驻时也能新增分类（右键菜单入口，旧 exe 无此通道则忽略）
  if (isElectron && window.electronAPI.onAddCat) window.electronAPI.onAddCat(() => openWidgetAddPanel())
  await loadCategories()
  await refreshRunning()
  refreshTodayStats()
  startTicker()
  startPolling()
  triggerSync()
}

/* 扩窗：新 exe 用 resizeTo，旧 exe 兜底只扩高度 */
function widgetResize(width, height) {
  if (!isElectron) return
  if (window.electronAPI.resizeTo) window.electronAPI.resizeTo(width, height)
  else window.electronAPI.resize(height)
}

/* 面板统一开关（新增分类 / 其他分类 / 快速标签） */
function anyPanelOpen() {
  return ['widget-add-panel', 'widget-others-panel', 'widget-tagbar']
    .some((id) => !$(id).classList.contains('hidden'))
}
function openPanel(id) {
  clearFocus()             // 面板语义优先，取消滚轮选中
  $(id).classList.remove('hidden')
  widgetResize(WIDGET_PANEL_W, WIDGET_PANEL_H)
  renderCenter()
}
function closePanel(id) {
  $(id).classList.add('hidden')
  if (!anyPanelOpen()) widgetResize(WIDGET_W, WIDGET_H)
  renderCenter()
}
function hideAllPanels() {
  ;['widget-add-panel', 'widget-others-panel', 'widget-tagbar'].forEach((id) => $(id).classList.add('hidden'))
}

function elapsedSec() {
  if (!runningEntry) return 0
  // 取整：避免浮点秒（如 5.343000000000001）流进累计值与界面
  return Math.max(0, Math.floor((Date.now() - new Date(runningEntry.start_time).getTime()) / 1000))
}

/* 今日累计统计（end_time 非空的记录按分类聚合 + 每分类最近一条标题） */
let todayStats = { day: '', byCat: {}, latest: {} }
async function refreshTodayStats() {
  const start = new Date(); start.setHours(0, 0, 0, 0)
  const { data, error } = await cloud.database.from('time_entries')
    .select('category_id,start_time,duration_sec,title')
    .gte('start_time', start.toISOString())
    .not('end_time', 'is', null)
    .order('start_time', { ascending: false }).limit(500)
  if (error) return
  const byCat = {}, latest = {}
  ;(data || []).forEach((e) => {
    const k = e.category_id || 'none'
    byCat[k] = (byCat[k] || 0) + Math.floor(e.duration_sec || 0)   // 整秒累积
    if (!latest[k]) latest[k] = (e.title || '').trim()
  })
  todayStats = { day: dayKey(new Date()), byCat, latest }
  if (IS_WIDGET) { renderRing(); renderCenter() }
}

/* ---------- 环形渲染 ---------- */
function setAttrs(el, attrs) {
  for (const k in attrs) el.setAttribute(k, attrs[k])
}

/* 分类色 → rgba（用于 active 扇区的同色辉光） */
function hexToRgba(hex, a) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex).trim())
  if (!m) return `rgba(255,255,255,${a})`
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`
}

/* 扇区角度分配：有记录的按今日累计比例；今日无记录的给一个最小可点角度（幽灵扇区），保证仍能一键开始 */
function widgetSectors() {
  const elapsed = elapsedSec()
  const list = categories.map((c) => ({
    id: c.id, name: c.name, color: c.color,
    sec: (todayStats.byCat[c.id] || 0) + (runningEntry && runningEntry.category_id === c.id ? elapsed : 0),
    active: !!(runningEntry && runningEntry.category_id === c.id),
  }))
  const noneSec = (todayStats.byCat.none || 0) + (runningEntry && !runningEntry.category_id ? elapsed : 0)
  if (noneSec > 0 || (runningEntry && !runningEntry.category_id)) {
    list.push({ id: '__none__', name: '未分类', color: '#6b7280', sec: noneSec, active: !!(runningEntry && !runningEntry.category_id) })
  }
  if (!list.length) return { items: [] }

  list.sort((a, b) => b.sec - a.sec)
  const timed = list.filter((x) => x.sec > 0)
  const ghosts = list.filter((x) => x.sec <= 0)
  const ghostDeg = ghosts.length ? Math.min(GHOST_DEG, 120 / ghosts.length) : 0
  const restDeg = 360 - ghostDeg * ghosts.length
  const timedTotal = timed.reduce((s, x) => s + x.sec, 0)

  const withDeg = []
  if (timedTotal > 0) {
    timed.forEach((x) => withDeg.push({ ...x, deg: restDeg * (x.sec / timedTotal) }))
    ghosts.forEach((x) => withDeg.push({ ...x, deg: ghostDeg, ghost: true }))
  } else {
    ghosts.forEach((x) => withDeg.push({ ...x, deg: 360 / ghosts.length, ghost: true }))
  }

  const sorted = withDeg.sort((a, b) => b.deg - a.deg)
  const items = sorted.slice(0, MAX_SECTORS)
  const rest = sorted.slice(MAX_SECTORS)
  if (rest.length) {
    items.push({
      id: '__other__', name: '其他分类', color: 'rgba(255,255,255,0.16)',
      sec: rest.reduce((s, x) => s + x.sec, 0), deg: rest.reduce((s, x) => s + x.deg, 0), rest,
    })
  }
  return { items }
}

/* 环形 DOM 只在数据形状变化时构建；每秒的"生长"用 applyArcGeometry() 原地改属性。
   之前每秒整环重建会销毁鼠标下的扇区元素 → mouseout 丢失 → 悬停状态永久卡死。 */
let ringArcs = []              // [{ el, id }]，与 ringData 顺序一致
let focusSlot = null           // 当前选中扇区的几何槽 { drawLen, offset }，供确认进度弧对齐

function applyArcGeometry(items) {
  let acc = 0
  focusSlot = null
  items.forEach((it, i) => {
    const arc = ringArcs[i]
    if (!arc) return
    const arcLen = (it.deg / 360) * RING_CIRC
    // 圆头线帽各向外延伸 SW/2，虚线间隙 = 视觉间隙 + SW
    const gap = items.length > 1 ? Math.min(RING_SW + SEG_GAP_VIS, arcLen * 0.55) : 0
    const drawLen = Math.max(1.5, arcLen - gap)
    const offset = -acc - gap / 2
    arc.el.setAttribute('stroke-dasharray', `${drawLen} ${RING_CIRC - drawLen}`)
    arc.el.setAttribute('stroke-dashoffset', String(offset))
    if (focusCatId === arc.id) focusSlot = { drawLen, offset }
    acc += arcLen
  })
  paintConfirmArc()   // 每秒数据变化后复绘，保证进度弧不跑偏
}

/* 确认进度弧：叠在选中扇区上，随停顿时间沿弧"点亮"，示意即将确认 */
function paintConfirmArc() {
  if (!confirmArcEl) return
  if (!focusCatId || !focusSlot || confirmProgress <= 0) {
    confirmArcEl.style.display = 'none'
    return
  }
  const len = Math.max(1.5, focusSlot.drawLen * Math.min(1, confirmProgress))
  confirmArcEl.style.display = ''
  confirmArcEl.setAttribute('stroke-dasharray', `${len} ${RING_CIRC - len}`)
  confirmArcEl.setAttribute('stroke-dashoffset', String(focusSlot.offset))
}

function applyRingStateClasses() {
  ringArcs.forEach((arc, i) => {
    const it = ringData[i]
    if (!it) return
    const active = !!it.active
    const focused = focusCatId === arc.id          // 滚轮选中：向外推出 + 提亮，其余不变暗
    const hovered = !focusCatId && hoverCatId === arc.id   // 选中期间悬停被抑制
    arc.el.classList.toggle('active', active)
    arc.el.classList.toggle('focused', focused)
    arc.el.classList.toggle('hovered', hovered)
    arc.el.classList.toggle('dim', !!hoverCatId && !focusCatId && hoverCatId !== arc.id)
    arc.el.style.filter = (active || focused)
      ? `drop-shadow(0 0 6px ${hexToRgba(it.color, active ? 0.6 : 0.45)})`
      : ''
  })
  if (confirmArcEl) confirmArcEl.classList.toggle('focused', !!focusCatId)
}

function renderRing() {
  const svg = $('widget-ring')
  if (!svg) return
  const NS = 'http://www.w3.org/2000/svg'
  svg.innerHTML = ''
  const g = document.createElementNS(NS, 'g')
  g.setAttribute('transform', `rotate(-90 ${RING_CX} ${RING_CX})`) // 从 12 点方向开始
  svg.appendChild(g)

  // 内层 g 专供"档位反馈"扭动（外层 rotate 是属性，互不覆盖）
  const rot = document.createElementNS(NS, 'g')
  rot.setAttribute('class', 'ring-rot')
  g.appendChild(rot)
  ringRotEl = rot

  // 轨道底环
  const track = document.createElementNS(NS, 'circle')
  setAttrs(track, {
    cx: RING_CX, cy: RING_CX, r: RING_R, fill: 'none',
    'stroke-width': RING_SW, class: 'ring-track',
  })
  rot.appendChild(track)

  const { items } = widgetSectors()
  ringData = items
  ringArcs = []
  items.forEach((it) => {
    const c = document.createElementNS(NS, 'circle')
    setAttrs(c, {
      cx: RING_CX, cy: RING_CX, r: RING_R, fill: 'none',
      stroke: it.color, 'stroke-width': RING_SW, 'stroke-linecap': 'round',
      'data-cat': it.id,
      class: 'ring-seg' + (it.ghost ? ' ghost' : ''),
    })
    rot.appendChild(c)
    ringArcs.push({ el: c, id: it.id })
  })

  // 确认进度弧（叠在选中扇区上，仅选中时显示；pointer-events:none 由 CSS 给，避免挡住点击）
  const conf = document.createElementNS(NS, 'circle')
  setAttrs(conf, {
    cx: RING_CX, cy: RING_CX, r: RING_R, fill: 'none',
    'stroke-width': RING_CONFIRM_SW, 'stroke-linecap': 'round',
    class: 'ring-confirm',
  })
  conf.style.display = 'none'
  rot.appendChild(conf)
  confirmArcEl = conf

  applyArcGeometry(items)
  applyRingStateClasses()
  // 选中项可能已不存在（分类被删 / 形状变化）
  if (focusCatId && !ringData.some((x) => x.id === focusCatId)) clearFocus()
}

/* 每秒调用：形状没变就原地更新，形状变了（如幽灵变实心、出现"其他"）才重建 */
function tickRing() {
  const { items } = widgetSectors()
  const sameShape = items.length === ringArcs.length && items.every((it, i) => ringArcs[i].id === it.id)
  if (!sameShape) { renderRing(); return }
  ringData = items
  applyArcGeometry(items)
  applyRingStateClasses()
}

/* ---------- 悬停：只写"次要通道"（扇区高亮 + 下方小字），绝不改动主读数 ---------- */
function setHover(id) {
  if (focusCatId) return                 // 滚轮选中期间，悬停让位
  if (hoverCatId === id) return
  hoverCatId = id
  applyRingStateClasses()
  renderCenter()
}
function clearHover() {
  if (!hoverCatId) return
  hoverCatId = null
  applyRingStateClasses()
  renderCenter()
}

/* ========== 滚轮选中（仿三星旋转表圈的"旋转选择"） ==========
   旋转=沿环移动高亮，不改变任何计时；停住 FOCUS_CONFIRM_MS 或点击 = 确认（换标签）。
   产品方向：最终形态没有"停止"，切换才是主路径 —— 所以确认只做"开始/切换"，绝不停表。 */
const mod = (a, n) => ((a % n) + n) % n

function setFocus(id) {
  if (focusCatId === id) return
  focusCatId = id
  hoverCatId = null                      // 与悬停互斥
  applyArcGeometry(ringData)             // 重算几何槽：确认进度弧要贴着选中扇区
  applyRingStateClasses()
  renderCenter()
}

function clearFocus() {
  cancelConfirm()
  if (!focusCatId) { applyRingStateClasses(); renderCenter(); return }
  focusCatId = null
  applyArcGeometry(ringData)
  applyRingStateClasses()
  renderCenter()
}

/* 沿环（按绘制顺序）步进一格，首尾循环 */
function stepFocus(dir) {
  const n = ringData.length
  if (!n) return
  let idx = focusCatId ? ringData.findIndex((x) => x.id === focusCatId) : -1
  if (idx < 0) {
    // 首次滚动：优先从"正在计时的分类"起跳一步；空闲则从 12 点（顺时针）/ 末段（逆时针）进入
    const rid = runningEntry ? (runningEntry.category_id || '__none__') : null
    const ri = rid ? ringData.findIndex((x) => x.id === rid) : -1
    idx = ri >= 0 ? mod(ri + dir, n) : (dir > 0 ? 0 : n - 1)
  } else {
    idx = mod(idx + dir, n)
  }
  setFocus(ringData[idx].id)
  kickDetent(dir)
  restartConfirmTimer()
}

/* 停顿自动确认：空闲→开始计时；运行中且不同→切换；与运行中相同→无操作（防误停） */
function restartConfirmTimer() {
  cancelConfirm()
  const t0 = performance.now()
  const tick = (ts) => {
    confirmProgress = Math.min(1, (ts - t0) / FOCUS_CONFIRM_MS)
    paintConfirmArc()
    if (confirmProgress < 1) confirmRAF = requestAnimationFrame(tick)
  }
  confirmRAF = requestAnimationFrame(tick)
  confirmTimer = setTimeout(finishConfirm, FOCUS_CONFIRM_MS)
}

function cancelConfirm() {
  if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = null }
  if (confirmRAF) { cancelAnimationFrame(confirmRAF); confirmRAF = null }
  confirmProgress = 0
  paintConfirmArc()
}

function finishConfirm() {
  const id = focusCatId
  if (!id) return
  if (id === '__other__') { clearFocus(); openOthersPanel(); return }
  clearFocus()
  applySectorAction(id, { viaWheel: true })
}

/* 档位反馈：环整体沿方向轻扭一下再弹回（模拟表圈磁点） */
function kickDetent(dir) {
  if (!ringRotEl) return
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  ringRotEl.classList.remove('detent-cw', 'detent-ccw')
  void ringRotEl.getBoundingClientRect()      // 强制重排以重启动画
  ringRotEl.classList.add(dir > 0 ? 'detent-cw' : 'detent-ccw')
}

/* 滚轮入口：防误触（阈值累积 + 步进锁 + 方向翻转清零）；面板/输入框/捏合缩放时不响应 */
function onWheel(e) {
  if (!IS_WIDGET) return
  if (!e.target.closest || !e.target.closest('#widget-plate')) return
  if (e.ctrlKey) return                                  // 触控板捏合缩放
  if (anyPanelOpen()) return                             // 面板打开：滚轮留给面板内部列表
  const ae = document.activeElement
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return
  if (!ringData.length) return

  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 100 : e.deltaY
  if (!dy) return
  e.preventDefault()

  const sign = Math.sign(dy)
  if (sign !== wheelSign) { wheelAccum = 0; wheelSign = sign }
  clearTimeout(wheelResetTimer)
  wheelResetTimer = setTimeout(() => { wheelAccum = 0 }, WHEEL_IDLE_RESET_MS)

  const now = performance.now()
  if (now < wheelLockUntil) return                       // 锁定期内丢弃：忽略惯性连发
  wheelAccum += dy
  if (Math.abs(wheelAccum) < WHEEL_STEP) return          // 触控板小增量先累积成一格
  wheelAccum = 0
  wheelLockUntil = now + WHEEL_LOCK_MS
  stepFocus(sign > 0 ? 1 : -1)                           // 滚轮向下 = 顺时针 = 下一段
}
window.addEventListener('wheel', onWheel, { passive: false })

/* ---------- 扇区动作：开始 / 停止 / 切换 ----------
   viaWheel=true（滚轮确认）：与运行中分类相同 → 无操作（防误停）
   viaWheel=false（点击）：与运行中分类相同 → 停止（保留既有肌肉记忆；
   产品最终形态是"无暂停的连续记录"，届时该手势会改为无操作） */
async function applySectorAction(catId, { viaWheel = false } = {}) {
  if (IS_DEMO) { demoToggle(catId, { viaWheel }); return }   // 演示模式：本地开关，不连云端
  if (!navigator.onLine) { showToast('当前离线，无法操作'); return }
  if (anyPanelOpen()) return                       // 面板打开时不响应
  const cid = catId === '__none__' ? null : catId
  const same = runningEntry && runningEntry.category_id === cid
  if (same) {
    if (viaWheel) return                           // 滚轮停在正在计时的分类：什么都不做
    await stopTimer()
    return
  }
  if (runningEntry) {
    const ok = await stopTimer({ skipQuickTag: true })  // 切换：不弹标签栏
    if (!ok) return
  }
  await startTimer({ categoryId: cid })
}

function onSectorClick(catId) { return applySectorAction(catId, { viaWheel: false }) }

/* ---------- 新增分类（桌面常驻内嵌） ---------- */
function renderSwatches() {
  const box = $('widget-color-swatches')
  box.innerHTML = ''
  WIDGET_SWATCH_COLORS.forEach((col) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'swatch' + (col === widgetSwatchColor ? ' selected' : '')
    b.style.background = col
    b.addEventListener('click', () => { widgetSwatchColor = col; renderSwatches() })
    box.appendChild(b)
  })
}

function openWidgetAddPanel() {
  clearHover()
  $('widget-new-cat-name').value = ''
  renderSwatches()
  openPanel('widget-add-panel')
  $('widget-new-cat-name').focus()
}

function closeWidgetAddPanel() { closePanel('widget-add-panel') }

async function saveWidgetCategory() {
  const name = $('widget-new-cat-name').value.trim()
  if (!name) { showToast('请输入分类名称'); return }
  if (IS_DEMO) {                                   // 演示模式：只加在本地
    categories.push({ id: 'demo-c' + Date.now(), name, color: widgetSwatchColor, sort_order: categories.length + 1 })
    showToast('分类已添加（演示）')
    closeWidgetAddPanel()
    renderRing(); renderCenter()
    return
  }
  const maxSort = categories.reduce((m, c) => Math.max(m, c.sort_order || 0), 0)
  const { error } = await cloud.database.from('categories')
    .insert({ name, color: widgetSwatchColor, sort_order: maxSort + 1 }).select()
  if (error) {
    showToast(error.code === '23505' ? '同名分类已存在' : '添加失败，请重试')
    return
  }
  showToast('分类已添加')
  closeWidgetAddPanel()
  await loadCategories()
  renderRing()
  renderCenter()
}

/* ---------- 全部分类面板（扇区超上限时点「其他」进入） ---------- */
function renderOthersList() {
  const box = $('widget-others-list')
  box.innerHTML = ''
  const elapsed = elapsedSec()
  const rows = categories.map((c) => ({
    id: c.id, name: c.name, color: c.color,
    sec: (todayStats.byCat[c.id] || 0) + (runningEntry && runningEntry.category_id === c.id ? elapsed : 0),
  })).sort((a, b) => b.sec - a.sec)
  rows.forEach((r) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'others-row'
    b.innerHTML = `<span class="dot" style="background:${escapeHtml(r.color)}"></span>
      <span class="others-name">${escapeHtml(r.name)}</span>
      <span class="others-sec">${r.sec > 0 ? fmtDurMin(r.sec) : ''}</span>`
    b.addEventListener('click', () => { closePanel('widget-others-panel'); onSectorClick(r.id) })
    box.appendChild(b)
  })
}

function openOthersPanel() {
  clearHover()
  renderOthersList()
  openPanel('widget-others-panel')
}

/* ---------- 事件接线 ---------- */
$('widget-ring').addEventListener('click', (e) => {
  const t = e.target.closest('[data-cat]')
  if (!t) return
  const id = t.getAttribute('data-cat')
  cancelConfirm()          // 点击 = 立即确认，先撤掉停顿确认
  clearFocus()
  if (id === '__other__') { openOthersPanel(); return }
  clearHover()
  onSectorClick(id)
})
$('widget-ring').addEventListener('mouseover', (e) => {
  const t = e.target.closest('[data-cat]')
  if (t) setHover(t.getAttribute('data-cat'))
})
/* 鼠标离开只复原悬停，不取消滚轮选中（选中的倒计时与鼠标位置无关，由用户确认）。
   不依赖 mouseout 的 relatedTarget 判断，那样在元素被重绘替换时会漏事件（曾导致悬停永久卡死） */
$('widget-ring-wrap').addEventListener('mouseleave', clearHover)
$('widget-plate').addEventListener('mouseleave', clearHover)
window.addEventListener('blur', () => { clearFocus(); clearHover() })
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearFocus(); clearHover() }
})

/* 右键 = Electron 菜单（打开完整版 / 新增分类 / 开机自启 / 退出） */
$('widget-plate').addEventListener('contextmenu', (e) => {
  e.preventDefault()
  if (isElectron) window.electronAPI.menu()
})

$('widget-add-cat').addEventListener('click', openWidgetAddPanel)
$('btn-widget-cat-save').addEventListener('click', saveWidgetCategory)
$('btn-widget-cat-cancel').addEventListener('click', closeWidgetAddPanel)
$('btn-widget-others-close').addEventListener('click', () => closePanel('widget-others-panel'))

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !IS_WIDGET) return
  clearFocus()             // Esc：取消滚轮选中（安全阀）
  closePanel('widget-add-panel')
  closePanel('widget-others-panel')
  clearHover()
})

/* ---------- 中心读数 ----------
   第一行（大字）= 主读数，永远是"当前状态"：计时中=实时用时，空闲=00:00。
   第二行 = 当前状态（运行中的分类 / 空闲）
   第三、四行 = 次要通道（滚轮选中 或 鼠标悬停 的分类信息），加 → 前缀表示"待确认的选中"
   主读数永不因悬停/选中而改变（DESIGN.md §3.4） */
function renderCenter() {
  const timeEl = $('widget-time')
  const dot = $('widget-state-dot')
  const textEl = $('widget-state-text')
  const hoverEl = $('widget-hover')
  const sub = $('widget-sub')
  const addBtn = $('widget-add-cat')
  if (!timeEl) return
  const running = !!runningEntry
  const cat = running ? catById(runningEntry.category_id) : null

  // 主读数（不受悬停/选中影响）
  if (running) {
    const t = fmtMS(elapsedSec())
    timeEl.textContent = t
    timeEl.classList.toggle('compact', t.length >= 7)
    timeEl.classList.remove('idle')
    dot.style.background = cat ? cat.color : '#FF5A5A'
    dot.classList.add('on')
    textEl.textContent = cat ? cat.name : '未分类'
  } else {
    timeEl.textContent = '00:00'
    timeEl.classList.add('idle')
    timeEl.classList.remove('compact')
    dot.style.background = '#6a6b6c'
    dot.classList.remove('on')
    textEl.textContent = '空闲'
  }

  // 次要通道：滚轮选中优先于鼠标悬停
  const cursorId = focusCatId || hoverCatId
  if (cursorId) {
    const it = ringData.find((x) => x.id === cursorId) || {}
    const latest = todayStats.latest[cursorId === '__none__' ? 'none' : cursorId]
    const prefix = focusCatId ? '→ ' : ''
    if (cursorId === '__other__') {
      hoverEl.textContent = `${prefix}其他分类 · ${(it.rest || []).length} 个`
      sub.textContent = '点一下看全部'
      sub.classList.remove('hidden')
    } else {
      // 空间只有约 9 个汉字：省掉"今日"（今日口径由扇区含义与"最近"行承载）
      hoverEl.textContent = `${prefix}${it.name || ''} · ${it.sec ? fmtDurMin(it.sec) : '0秒'}`
      sub.textContent = latest ? `最近：${latest}` : ''
      sub.classList.toggle('hidden', !sub.textContent)
    }
    hoverEl.classList.remove('hidden')
  } else {
    hoverEl.classList.add('hidden')
    sub.classList.add('hidden')
  }
  addBtn.classList.toggle('hidden', running || !!cursorId || anyPanelOpen())
}

/* ========== 分类 ========== */
const DEFAULT_CATEGORIES = [
  { name: '工作', color: '#4F8CFF', sort_order: 1 },
  { name: '学习', color: '#9B6DFF', sort_order: 2 },
  { name: '运动', color: '#2FBF71', sort_order: 3 },
  { name: '生活', color: '#F2A93B', sort_order: 4 },
]

async function loadCategories() {
  let { data, error } = await cloud.database
    .from('categories').select('*').order('sort_order', { ascending: true })
  if (error) { showToast('分类加载失败：' + (error.message || '请重试')); return }
  if (!data || data.length === 0) {
    const seeded = await cloud.database.from('categories').insert(DEFAULT_CATEGORIES).select()
    if (!seeded.error && seeded.data && seeded.data.length) data = seeded.data
  }
  categories = data || []
  renderCategories()
}

function renderCategories() {
  const row = $('category-row')
  row.innerHTML = ''
  categories.forEach((c) => {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'cat-chip' + (selectedCategoryId === c.id ? ' selected' : '')
    chip.innerHTML = `<span class="dot" style="background:${c.color}"></span>${escapeHtml(c.name)}`
    chip.addEventListener('click', () => {
      selectedCategoryId = selectedCategoryId === c.id ? null : c.id
      renderCategories()
      if (runningEntry) saveRunningEdits()
    })
    row.appendChild(chip)
  })
}

/* ========== 计时核心 ========== */
async function refreshRunning() {
  const { data, error } = await cloud.database
    .from('time_entries').select('*').is('end_time', null).maybeSingle()
  if (error) return
  const prev = runningEntry
  runningEntry = data || null
  if (runningEntry) {
    if (!IS_WIDGET) {
      $('entry-title').value = runningEntry.title || ''
      selectedCategoryId = runningEntry.category_id
      renderCategories()
    }
  } else if (prev) {
    if (!IS_WIDGET) {
      $('entry-title').value = ''
      selectedCategoryId = null
      renderCategories()
      showToast('计时已在其他设备停止')
      loadHistory()
    }
  }
  renderTimer()
}

function renderTimer() {
  const btn = $('btn-toggle')
  const since = $('running-since')
  if (runningEntry) {
    btn.textContent = '停止'
    btn.className = 'btn-big btn-stop'
    since.textContent = `开始于 ${fmtClock(runningEntry.start_time)} · 可在任意设备停止`
    since.classList.remove('hidden')
    updateElapsed()
  } else {
    btn.textContent = '开始'
    btn.className = 'btn-big btn-start'
    since.classList.add('hidden')
    $('elapsed').textContent = '00:00:00'
  }
  if (IS_WIDGET) { renderRing(); renderCenter() }
}

function updateElapsed() {
  if (!runningEntry) return
  const sec = elapsedSec()
  $('elapsed').textContent = fmtHMS(sec)
  if (IS_WIDGET) {
    if (dayKey(new Date()) !== todayStats.day) refreshTodayStats()  // 跨天：环归零
    tickRing()      // 原地更新（不重建 DOM，避免打断悬停）
    renderCenter()
  }
}

function startTicker() {
  stopTicker()
  ticker = setInterval(updateElapsed, 1000)
}
function stopTicker() { if (ticker) clearInterval(ticker); ticker = null }

function startPolling() {
  stopPolling()
  pollTimer = setInterval(() => {
    refreshRunning()
    refreshTodayStats()
  }, 30000)
}
function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null }

window.addEventListener('focus', () => { if (currentUser) refreshRunning() })

$('entry-title').addEventListener('blur', () => { if (runningEntry) saveRunningEdits() })

async function saveRunningEdits() {
  if (!runningEntry) return
  const title = $('entry-title').value.trim()
  if (title === (runningEntry.title || '') && selectedCategoryId === runningEntry.category_id) return
  await cloud.database.from('time_entries')
    .update({ title, category_id: selectedCategoryId, updated_at: new Date().toISOString() })
    .eq('id', runningEntry.id)
  runningEntry.title = title
  runningEntry.category_id = selectedCategoryId
}

$('btn-toggle').addEventListener('click', async () => {
  if (!navigator.onLine) { showToast('当前离线，无法操作'); return }
  if (runningEntry) await stopTimer()
  else await startTimer()
})

async function startTimer(opts = {}) {
  await refreshRunning()
  if (runningEntry) {
    showToast('已有一段计时在进行中')
    return
  }
  // 分类来源：显式参数 > widget 模式留空 > 完整版用已选分类
  const categoryId = opts.categoryId !== undefined
    ? opts.categoryId
    : (IS_WIDGET ? null : selectedCategoryId)
  const { data, error } = await cloud.database.from('time_entries')
    .insert({
      title: IS_WIDGET ? '' : $('entry-title').value.trim(),
      category_id: categoryId,
      start_time: new Date().toISOString(),
    })
    .select()
  if (error) {
    if (error.code === '23505') {
      showToast('另一台设备正在计时，请先在那一端停止')
      await refreshRunning()
    } else {
      showToast('开始失败：' + (error.message || '请重试'))
    }
    return
  }
  runningEntry = data && data[0]
  renderTimer()
  showToast('计时开始')
}

async function stopTimer({ skipQuickTag = false } = {}) {
  const entry = runningEntry
  if (!entry) return false
  const end = new Date()
  const dur = Math.max(1, Math.round((end.getTime() - new Date(entry.start_time).getTime()) / 1000))
  const patch = {
    end_time: end.toISOString(),
    duration_sec: dur,
    updated_at: end.toISOString(),
  }
  if (!IS_WIDGET) {
    patch.title = $('entry-title').value.trim()
    patch.category_id = selectedCategoryId
  }
  const { data, error } = await cloud.database.from('time_entries')
    .update(patch).eq('id', entry.id).select()
  if (error || !data || data.length === 0) {
    showToast('停止失败，请重试')
    await refreshRunning()
    return false
  }
  const saved = data[0]
  runningEntry = null
  if (!IS_WIDGET) {
    $('entry-title').value = ''
    selectedCategoryId = null
    renderCategories()
  }
  renderTimer()
  showToast(`已记录 ${fmtDurMin(dur)}`)
  if (!IS_WIDGET) loadHistory()
  triggerSync()
  refreshTodayStats()
  if (!skipQuickTag) openQuickTag(saved) // 快速标签流程（切换计时时跳过）
  return true
}

/* ========== 快速标签（停止后一键分类，内容稍后补） ========== */
function openQuickTag(entry) {
  quickTagEntry = entry
  if (IS_WIDGET) {
    // 盘下方展开标签栏，并通知 Electron 扩窗
    openPanel('widget-tagbar')
    const wrap = $('widget-tags')
    wrap.innerHTML = ''
    categories.forEach((c) => {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'cat-chip'
      chip.innerHTML = `<span class="dot" style="background:${c.color}"></span>${escapeHtml(c.name)}`
      chip.addEventListener('click', () => applyQuickTag(c.id))
      wrap.appendChild(chip)
    })
  } else {
    const cat = catById(entry.category_id)
    $('tag-entry-info').textContent =
      `${fmtClock(entry.start_time)} - ${fmtClock(entry.end_time)} · ${fmtDurMin(entry.duration_sec)}${entry.title ? ' · ' + entry.title : ''}${cat ? ' · 当前：' + cat.name : ''}`
    renderQuickTagChips()
    $('tag-modal').classList.remove('hidden')
  }
}

function renderQuickTagChips() {
  const row = $('tag-category-row')
  row.innerHTML = ''
  categories.forEach((c) => {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'cat-chip' + (quickTagEntry && quickTagEntry.category_id === c.id ? ' selected' : '')
    chip.innerHTML = `<span class="dot" style="background:${c.color}"></span>${escapeHtml(c.name)}`
    chip.addEventListener('click', () => applyQuickTag(c.id))
    row.appendChild(chip)
  })
}

async function applyQuickTag(categoryId) {
  const entry = quickTagEntry
  closeQuickTag()
  if (!entry || entry.category_id === categoryId) return
  if (IS_DEMO) {                                   // 演示模式：只走本地
    entry.category_id = categoryId
    const cat = catById(categoryId)
    showToast(`已标记为「${cat ? cat.name : ''}」（演示）`)
    return
  }
  const { data, error } = await cloud.database.from('time_entries')
    .update({ category_id: categoryId, updated_at: new Date().toISOString() })
    .eq('id', entry.id).select()
  if (error || !data || data.length === 0) { showToast('标签保存失败，可在记录页修改'); return }
  const cat = catById(categoryId)
  showToast(`已标记为「${cat ? cat.name : ''}」`)
  if (!IS_WIDGET) loadHistory()
  triggerSync()
  refreshTodayStats()
}

function closeQuickTag() {
  quickTagEntry = null
  $('tag-modal').classList.add('hidden')
  if (IS_WIDGET) closePanel('widget-tagbar')
}

$('btn-tag-skip').addEventListener('click', closeQuickTag)
$('widget-tag-skip').addEventListener('click', closeQuickTag)

/* ========== 历史记录 ========== */
document.querySelectorAll('.filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'))
    btn.classList.add('active')
    historyFilter = btn.dataset.filter
    renderHistory(historyEntries)
  })
})

async function loadHistory() {
  const { data, error } = await cloud.database.from('time_entries')
    .select('*').not('end_time', 'is', null)
    .order('start_time', { ascending: false }).limit(100)
  if (error) { showToast('记录加载失败'); return }
  historyEntries = data || []
  renderHistory(historyEntries)
}

function renderHistory(entries) {
  const list = $('history-list')
  list.innerHTML = ''

  const pending = entries.filter((e) => !(e.title || '').trim())
  const badge = $('pending-count')
  badge.textContent = pending.length || ''
  badge.classList.toggle('hidden', pending.length === 0)

  const shown = historyFilter === 'pending' ? pending : entries
  $('history-empty').classList.toggle('hidden', shown.length > 0)
  if (historyFilter === 'pending' && !shown.length) {
    $('history-empty').textContent = '没有待补充的记录，都很好'
  } else {
    $('history-empty').textContent = '还没有记录，去开始第一段计时吧'
  }

  let lastDay = ''
  shown.forEach((en) => {
    const day = dateLabel(en.start_time)
    if (day !== lastDay) {
      lastDay = day
      const h = document.createElement('div')
      h.className = 'day-label'
      h.textContent = day
      list.appendChild(h)
    }
    const cat = catById(en.category_id)
    const isPending = !(en.title || '').trim()
    const item = document.createElement('div')
    item.className = 'entry-item'
    item.innerHTML = `
      <div class="entry-main">
        <div class="entry-title-row">
          ${cat ? `<span class="dot" style="background:${cat.color}"></span>` : ''}
          <span class="entry-title">${escapeHtml(en.title || '（未填写）')}</span>
          ${isPending ? '<span class="pending-badge">待补充</span>' : ''}
        </div>
        <div class="entry-meta">${fmtClock(en.start_time)} - ${fmtClock(en.end_time)} · ${fmtDurMin(en.duration_sec)}</div>
      </div>
      <button class="btn-edit" type="button" title="编辑">✎</button>
      <button class="btn-del" type="button" title="删除">✕</button>`
    item.querySelector('.btn-edit').addEventListener('click', () => openEditModal(en))
    item.querySelector('.btn-del').addEventListener('click', () => deleteEntry(en.id))
    list.appendChild(item)
  })
}

async function deleteEntry(id) {
  if (!confirm('确定删除这段记录吗？')) return
  const { data, error } = await cloud.database.from('time_entries').delete().eq('id', id).select()
  if (error || !data || data.length === 0) {
    showToast('删除失败，请重试')
    return
  }
  showToast('已删除')
  loadHistory()
  triggerSync()
}

/* ========== 编辑记录 ========== */
function openEditModal(en) {
  editingEntry = en
  editCategoryId = en.category_id
  $('edit-title').value = en.title || ''
  $('edit-start').value = isoToLocalInput(en.start_time)
  $('edit-end').value = isoToLocalInput(en.end_time)
  $('edit-error').classList.add('hidden')
  renderEditCategories()
  $('edit-modal').classList.remove('hidden')
}

function renderEditCategories() {
  const row = $('edit-category-row')
  row.innerHTML = ''
  categories.forEach((c) => {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'cat-chip' + (editCategoryId === c.id ? ' selected' : '')
    chip.innerHTML = `<span class="dot" style="background:${c.color}"></span>${escapeHtml(c.name)}`
    chip.addEventListener('click', () => {
      editCategoryId = editCategoryId === c.id ? null : c.id
      renderEditCategories()
    })
    row.appendChild(chip)
  })
}

$('btn-edit-cancel').addEventListener('click', () => {
  editingEntry = null
  $('edit-modal').classList.add('hidden')
})

$('btn-edit-save').addEventListener('click', async () => {
  if (!editingEntry) return
  const title = $('edit-title').value.trim()
  const startLocal = $('edit-start').value
  const endLocal = $('edit-end').value
  const errEl = $('edit-error')
  if (!startLocal || !endLocal) {
    errEl.textContent = '请填写完整的起止时间'; errEl.classList.remove('hidden'); return
  }
  const start = new Date(startLocal)
  const end = new Date(endLocal)
  if (end <= start) {
    errEl.textContent = '结束时间必须晚于开始时间'; errEl.classList.remove('hidden'); return
  }
  const dur = Math.round((end.getTime() - start.getTime()) / 1000)
  const { data, error } = await cloud.database.from('time_entries')
    .update({
      title,
      category_id: editCategoryId,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      duration_sec: dur,
      updated_at: new Date().toISOString(),
    })
    .eq('id', editingEntry.id)
    .select()
  if (error || !data || data.length === 0) {
    errEl.textContent = '保存失败，请重试'; errEl.classList.remove('hidden'); return
  }
  editingEntry = null
  $('edit-modal').classList.add('hidden')
  showToast('已保存')
  loadHistory()
  triggerSync()
})

/* ========== 统计 ========== */
document.querySelectorAll('.range-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.range-btn').forEach((b) => b.classList.remove('active'))
    btn.classList.add('active')
    statsRange = btn.dataset.range
    loadStats()
  })
})

function rangeBounds(range) {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (range === 'week') {
    const dow = (now.getDay() + 6) % 7
    start.setDate(start.getDate() - dow)
  } else if (range === 'month') {
    start.setDate(1)
  }
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  return { start, end }
}

async function loadStats() {
  const { start, end } = rangeBounds(statsRange)
  const { data, error } = await cloud.database.from('time_entries')
    .select('category_id,start_time,duration_sec')
    .gte('start_time', start.toISOString())
    .lt('start_time', end.toISOString())
    .not('end_time', 'is', null)
  if (error) { showToast('统计数据加载失败'); return }
  renderStats(data || [], start, end)
}

function renderStats(entries, start, end) {
  const totalSec = entries.reduce((s, e) => s + (e.duration_sec || 0), 0)
  const rangeName = { day: '今天', week: '本周', month: '本月' }[statsRange]
  $('stats-summary').innerHTML =
    `${rangeName}共记录 <b>${entries.length}</b> 段，总计 <b>${fmtDurMin(totalSec)}</b>`

  const byCat = {}
  entries.forEach((e) => {
    const key = e.category_id || 0
    byCat[key] = (byCat[key] || 0) + (e.duration_sec || 0)
  })
  const pieData = Object.entries(byCat).map(([cid, sec]) => {
    const cat = catById(Number(cid))
    return {
      name: cat ? cat.name : '未分类',
      value: Math.round(sec / 60),
      itemStyle: cat ? { color: cat.color } : undefined,
    }
  }).filter((d) => d.value > 0)

  if (!pieChart) pieChart = echarts.init($('chart-pie'))
  pieChart.setOption({
    tooltip: { trigger: 'item', formatter: '{b}: {c} 分钟 ({d}%)' },
    series: [{
      type: 'pie', radius: ['42%', '68%'],
      label: { formatter: '{b}\n{c}分钟' },
      data: pieData.length ? pieData : [{ name: '暂无数据', value: 1, itemStyle: { color: '#e6e9f0' } }],
    }],
  }, true)

  const byDay = {}
  entries.forEach((e) => {
    const k = dayKey(new Date(e.start_time))
    byDay[k] = (byDay[k] || 0) + (e.duration_sec || 0)
  })
  const days = []
  const cursor = new Date(start)
  while (cursor < end) {
    days.push(dayKey(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }
  const labels = days.map((k) => {
    const [y, m, d] = k.split('-')
    return statsRange === 'day' ? '今天' : `${Number(m)}/${Number(d)}`
  })
  const values = days.map((k) => Math.round((byDay[k] || 0) / 60))

  if (!barChart) barChart = echarts.init($('chart-bar'))
  barChart.setOption({
    tooltip: { trigger: 'axis', formatter: '{b}: {c} 分钟' },
    grid: { left: 40, right: 16, top: 20, bottom: 28 },
    xAxis: { type: 'category', data: labels, axisLabel: { color: '#8a91a3' } },
    yAxis: { type: 'value', name: '分钟', axisLabel: { color: '#8a91a3' } },
    series: [{ type: 'bar', data: values, itemStyle: { color: '#4F8CFF', borderRadius: [4, 4, 0, 0] }, barMaxWidth: 32 }],
  }, true)

  setTimeout(() => { pieChart && pieChart.resize(); barChart && barChart.resize() }, 50)
}

window.addEventListener('resize', () => {
  pieChart && pieChart.resize()
  barChart && barChart.resize()
})

/* ========== 设置：分类管理 ========== */
function renderCatManage() {
  const list = $('cat-manage-list')
  list.innerHTML = ''
  if (!categories.length) {
    list.innerHTML = '<p class="hint" style="text-align:left">暂无分类</p>'
    return
  }
  categories.forEach((c) => {
    const row = document.createElement('div')
    row.className = 'cat-manage-row'
    row.innerHTML = `
      <span class="dot" style="background:${c.color}"></span>
      <span class="cat-name">${escapeHtml(c.name)}</span>
      <input type="color" class="cat-color-edit" value="${c.color}" title="改颜色">
      <button class="btn-del" type="button" title="删除">✕</button>`
    row.querySelector('.cat-color-edit').addEventListener('change', async (e) => {
      const { error } = await cloud.database.from('categories')
        .update({ color: e.target.value }).eq('id', c.id).select()
      if (error) { showToast('修改失败'); return }
      showToast('颜色已更新')
      await loadCategories()
      renderCatManage()
    })
    row.querySelector('.btn-del').addEventListener('click', async () => {
      if (!confirm(`删除分类「${c.name}」？该分类下的记录会保留但变为未分类。`)) return
      const { data, error } = await cloud.database.from('categories').delete().eq('id', c.id).select()
      if (error || !data || data.length === 0) { showToast('删除失败'); return }
      showToast('已删除')
      await loadCategories()
      renderCatManage()
    })
    list.appendChild(row)
  })
}

$('btn-add-cat').addEventListener('click', async () => {
  const name = $('new-cat-name').value.trim()
  const color = $('new-cat-color').value
  if (!name) { showToast('请输入分类名称'); return }
  const maxSort = categories.reduce((m, c) => Math.max(m, c.sort_order || 0), 0)
  const { data, error } = await cloud.database.from('categories')
    .insert({ name, color, sort_order: maxSort + 1 }).select()
  if (error) {
    showToast(error.code === '23505' ? '同名分类已存在' : '添加失败，请重试')
    return
  }
  $('new-cat-name').value = ''
  showToast('已添加')
  await loadCategories()
  renderCatManage()
})

/* ========== 设置：导出 ========== */
async function fetchExportEntries() {
  let q = cloud.database.from('time_entries')
    .select('*').not('end_time', 'is', null)
    .order('start_time', { ascending: true }).limit(2000)
  const range = $('export-range').value
  if (range !== 'all') {
    const since = new Date()
    since.setDate(since.getDate() - Number(range))
    q = q.gte('start_time', since.toISOString())
  }
  const { data, error } = await q
  if (error) { showToast('导出失败：' + (error.message || '请重试')); return null }
  if (!data || !data.length) { showToast('所选范围内没有记录'); return null }
  return data
}

function exportRows(entries) {
  return entries.map((e) => {
    const cat = catById(e.category_id)
    return {
      '标题': e.title || '',
      '分类': cat ? cat.name : '未分类',
      '开始时间': new Date(e.start_time).toLocaleString('zh-CN'),
      '结束时间': new Date(e.end_time).toLocaleString('zh-CN'),
      '时长(分钟)': Math.round((e.duration_sec || 0) / 60),
      '备注': e.note || '',
    }
  })
}

function downloadBlob(content, filename, type) {
  const blob = new Blob([content], { type })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

$('btn-export-csv').addEventListener('click', async () => {
  const entries = await fetchExportEntries()
  if (!entries) return
  const rows = exportRows(entries)
  const headers = Object.keys(rows[0])
  const esc = (v) => {
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = '﻿' + [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\r\n')
  downloadBlob(csv, `时间记录_${dayKey(new Date())}.csv`, 'text/csv;charset=utf-8')
  showToast(`已导出 ${rows.length} 条记录`)
})

$('btn-export-xlsx').addEventListener('click', async () => {
  const entries = await fetchExportEntries()
  if (!entries) return
  const rows = exportRows(entries)
  const ws = XLSX.utils.json_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '时间记录')
  XLSX.writeFile(wb, `时间记录_${dayKey(new Date())}.xlsx`)
  showToast(`已导出 ${rows.length} 条记录`)
})

/* ========== 设置：退出登录 ========== */
$('btn-signout').addEventListener('click', async () => {
  await cloud.auth.signOut()
  stopTicker(); stopPolling()
  runningEntry = null
  currentUser = null
  showLogin()
})

/* ========== 离线提示 ========== */
function updateOfflineBanner() {
  $('offline-banner').classList.toggle('hidden', navigator.onLine)
}
window.addEventListener('online', () => { updateOfflineBanner(); refreshRunning() })
window.addEventListener('offline', updateOfflineBanner)

/* ========== 启动 ========== */
;(async function init() {
  updateOfflineBanner()
  if (IS_DEMO) { enterDemo(); return }   // ?widget=1&demo=1：本地预览，不校验登录
  const { data: session, error } = await cloud.auth.getSession()
  if (error || !session) { showLogin(); return }
  currentUser = session.user || null
  enterApp(currentUser)
})()
