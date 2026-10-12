/* ========== 初始化云客户端（publicConfig，安全可前置） ========== */
const cloud = WorkBuddyCloud.createWorkBuddyCloud({
  endpoint: 'https://mp-api.app.workbuddy.host',
  publishableKey: 'wbpk_aEuqo04CtucnCnaaQ8i9oU_KX9epFWbkdZikmsR6fpdEl35UhKMFiAv',
})

/* ========== 运行模式 ========== */
const IS_WIDGET = new URLSearchParams(location.search).has('widget')
/* 演示模式（?widget=1&demo=1）：本地预览组件外观与交互，用样例数据、不连云端。
   仅用于开发预览/效果确认，正式环境不带该参数。 */
const IS_DEMO = IS_WIDGET && new URLSearchParams(location.search).has('demo')
/* 沙盒模式（?widget=1&sandbox=1）：**空数据起步**的本地试用通道，不连云端。
   与演示模式的区别：① 初始无任何记录（只在首次种子 4 个默认分类，与正式首登一致）
   ② 每次操作写 localStorage，刷新/重开窗口后记录与"正在计时"都还在（真机手感）
   ③ 文案不带"演示"字样；?widget=1&sandbox=1&reset=1 或控制台 __sandboxReset() 可清空重来 */
const IS_SANDBOX = IS_WIDGET && !IS_DEMO && new URLSearchParams(location.search).has('sandbox')
/* 本地模式：都不连云端（所有云端分支一律跳过） */
const IS_LOCAL = IS_DEMO || IS_SANDBOX
const LOCAL_SUFFIX = IS_SANDBOX ? '' : '（演示）'
const SANDBOX_KEY = 'tt-sandbox-v1'
const isElectron = !!(window.electronAPI && window.electronAPI.isElectron)
if (IS_WIDGET) document.body.classList.add('widget-mode')
if (isElectron) document.body.classList.add('electron')
// 新壳才有的能力：手动拖动（任意位置）。旧壳继续走 -webkit-app-region
if (isElectron && window.electronAPI.dragStart) document.body.classList.add('has-drag-ipc')

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

function hideToast() {
  const t = $('toast')
  if (t) t.classList.add('hidden')
}

function showToast(msg, ms = 2600) {
  const t = $('toast')
  // 组件模式下：面板占据圆盘下方空间，此时不弹提示条，避免叠在面板上
  if (IS_WIDGET && typeof anyPanelOpen === 'function' && anyPanelOpen()) return
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
  /* ⚠️ 这里曾经加过一道"已经在用就别踢出去"的闸，是**错的**，已撤掉。
     当时的假设是"会话检查会误报"，可实际用户的会话是真失效的 ——
     结果闸一拦，登录界面根本不显示，页面变成白屏（2026-10-12 用户截图）。
     教训：不要用"猜测的容错"去盖住一个自己没搞清的检查逻辑。 */
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
const WIDGET_W = 260           // 窗口固定尺寸（盘 152 居中 + 面板空间；不再运行期改尺寸）
const WIDGET_H = 380
const WIDGET_PANEL_W = 260     // 旧壳（会改尺寸的那种）展开面板时用的尺寸
const WIDGET_PANEL_H = 320
const RING_CX = 60
const RING_R = 54              // 环半径（玻璃盘 152 → 外缘 59，留 15px 呼吸位）
const RING_SW = 11             // 环带宽（中心留 98px 放读数，可容 125:15）
const RING_CIRC = 2 * Math.PI * RING_R
const SEG_GAP_VIS = 4          // 扇区视觉间隙（圆头线帽各向外延伸 SW/2）
/* 环上直接展示的最大扇区数，其余合并为「其他分类」。
   7 → 15（用户："我新添加了几个选项进去，新增选项在表盘中不会高亮展示"）——
   注意：**缩放列表不受这个上限影响**，它始终展示全部分类。 */
const MAX_SECTORS = 15
const GHOST_DEG = 4.5          // 今日无记录的分类保留的最小可点角度（幽灵扇区，越小越含蓄）
/* —— 滚轮交互（仿三星旋转表圈：旋转=移动高亮，停顿/点击=确认）—— */
const WHEEL_STEP = 100         // 累积 |deltaY| 达到该值才走一步（鼠标一格≈100~120，触控板小增量先攒）
const WHEEL_LOCK_MS = 150      // （已废弃，保留常量以免别处引用报错）
const WHEEL_MAX_STEPS = 6      // 一次事件最多跨几步：防止"一笔甩出去几十格"
const WHEEL_IDLE_RESET_MS = 300 // 停这么久累积清零，避免两次半格拼成一格
const FOCUS_CONFIRM_MS = 900   // 选中后停顿多久自动确认（开始 / 切换）
const RING_CONFIRM_SW = 3      // 确认进度弧线宽
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
  /* ⚠️ 必须把其它视图也收起来：原来只 remove 自己的 hidden、不 add 别人的，
     所以只要"完整版已经进来了"、之后又有一次会话判定失败（刷新竞态 / 瞬时
     SIGNED_OUT），就会**两个视图叠在一起** —— 完整版在正常计时，右边却挂着一个
     死的组件登录圈，用户看到的就是"卡住"（2026-10-12 用户截图确认）。
     视图切换必须是**互斥**的，不能是"只点灯不关灯"。 */
  ;['view-app', 'view-login'].forEach((id) => { const el = $(id); if (el) el.classList.add('hidden') })
  $('view-widget').classList.remove('hidden')
  $('widget-login').classList.remove('hidden')
  $('widget-plate').classList.add('hidden')
  hideAllPanels()
}

$('btn-widget-login').addEventListener('click', () => {
  if (isElectron) window.electronAPI.openFull()
  else location.href = location.origin + location.pathname
})

/* 沙盒持久化：只写本机（localStorage），绝不入库、不连云端 */
function sandboxSave() {
  if (!IS_SANDBOX) return
  try {
    localStorage.setItem(SANDBOX_KEY, JSON.stringify({
      v: 1,
      day: todayStats.day,
      categories,
      byCat: todayStats.byCat,
      latest: todayStats.latest,
      running: runningEntry,
    }))
  } catch (e) { /* 无痕模式 / 配额满：退化为纯内存，不影响试用 */ }
}
function sandboxReset() {
  try { localStorage.removeItem(SANDBOX_KEY) } catch (e) {}
  location.reload()
}
window.__sandboxReset = sandboxReset          // 控制台一行清空重来

/* ---------- 演示模式：样例数据 + 本地计时，不连云端 ---------- */
function enterDemo() {
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
  }
  currentUser = { email: 'demo@local' }
  $('view-login').classList.add('hidden')
  $('view-widget').classList.remove('hidden')
  $('widget-login').classList.add('hidden')
  $('widget-plate').classList.remove('hidden')
  renderRing()
  renderCenter()
  stopTicker()                                   // 演示的心跳也交给全局 ticker，便于统一清理
  ticker = setInterval(() => { tickRing(); renderCenter() }, 1000)
}

/* 本地模式（演示 / 沙盒）的计时：只在本地状态里开关，不连云端。
   沙盒会顺带落盘 —— 刷新后"正在计时"仍在走（与正式流程"状态存云端"的体感一致） */
function localToggle(catId, { viaWheel = false } = {}) {
  const cid = catId === '__none__' ? null : catId
  const prefix = IS_SANDBOX ? 'sb' : 'demo'
  if (runningEntry && runningEntry.category_id === cid) {
    if (viaWheel) return                                   // 滚轮确认 → 不误停
    const dur = elapsedSec()                               // 点击 → 停止（并弹快速标签，与正式流程一致）
    const start = runningEntry.start_time
    runningEntry = null
    if (cid) todayStats.byCat[cid] = (todayStats.byCat[cid] || 0) + dur
    else todayStats.byCat.none = (todayStats.byCat.none || 0) + dur
    showToast(`已记录 ${fmtDurMin(Math.max(1, dur))}`)
    if (!quickTagEntry) {
      quickTagEntry = { id: prefix + '-entry', category_id: cid, start_time: start, end_time: new Date().toISOString(), duration_sec: dur }
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
    runningEntry = { id: prefix + '-run', title: '', category_id: cid, start_time: new Date().toISOString() }
    if (!IS_WIDGET) showToast((wasRunning ? '已切换' : '计时开始') + LOCAL_SUFFIX)
  }
  clearHover()
  renderRing()
  renderCenter()
  sandboxSave()
}

/* ---------- 沙盒模式：无记录起步 + 本机持久化，不连云端 ---------- */
function enterSandbox() {
  if (new URLSearchParams(location.search).has('reset')) {
    try { localStorage.removeItem(SANDBOX_KEY) } catch (e) {}
  }
  const today = dayKey(new Date())
  let saved = null
  try { saved = JSON.parse(localStorage.getItem(SANDBOX_KEY) || 'null') } catch (e) { saved = null }

  if (saved && saved.v === 1) {
    const sameDay = saved.day === today                   // 跨天：今日统计归零（与正式流程一致）
    categories = Array.isArray(saved.categories) ? saved.categories : []
    todayStats = {
      day: today,
      byCat: sameDay ? (saved.byCat || {}) : {},
      latest: sameDay ? (saved.latest || {}) : {},
    }
    runningEntry = saved.running || null
  } else {
    /* 全新沙盒 = 全新用户：正式首登时 loadCategories() 会种子这 4 个分类、且库里没有任何记录 */
    categories = DEFAULT_CATEGORIES.map((c, i) => ({ id: 'sb-c' + (i + 1), ...c }))
    todayStats = { day: today, byCat: {}, latest: {} }
    runningEntry = null
  }

  currentUser = { email: 'sandbox@local' }
  $('view-login').classList.add('hidden')
  $('view-widget').classList.remove('hidden')
  $('widget-login').classList.add('hidden')
  $('widget-plate').classList.remove('hidden')
  renderRing()
  renderCenter()
  if (runningEntry) showToast('已恢复上次的计时（本机保存）')
  stopTicker()                                   // 与演示模式一致：心跳交给全局 ticker，便于统一清理
  ticker = setInterval(() => {
    if (dayKey(new Date()) !== todayStats.day) { // 跨天：环归零（沙盒不发网络请求）
      todayStats = { day: dayKey(new Date()), byCat: {}, latest: {} }
      renderRing()
      sandboxSave()
    }
    tickRing()
    renderCenter()
  }, 1000)
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

/* 扩窗：固定窗口的新壳不调（改尺寸会在 Windows 上留残影）；旧壳仍按老协议扩窗 */
function widgetResize(width, height) {
  if (!isElectron) return
  if (window.electronAPI.fixedSize) return          // 固定窗：面板只做 DOM 显隐
  if (window.electronAPI.resizeTo) window.electronAPI.resizeTo(width, height)
  else window.electronAPI.resize(height)
}

/* ========== 点击穿透 ==========
   Electron 透明窗口的透明区域**不会**穿透点击，窗口矩形会挡住下方/右侧的桌面点击。
   做法：指针不在"可交互区域"（圆盘圆形范围 / 已展开的面板）时，让主进程忽略鼠标事件。 */
let ignoringMouse = null
function inPlateArea(x, y) {
  const el = $('widget-plate')
  if (!el || el.classList.contains('hidden')) return false
  const b = el.getBoundingClientRect()
  const cx = b.left + b.width / 2
  const cy = b.top + b.height / 2
  const r = b.width / 2
  return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r
}
function inRect(x, y, el) {
  if (!el || el.classList.contains('hidden')) return false
  const b = el.getBoundingClientRect()
  return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom
}
function isInteractiveAt(x, y) {
  if (inPlateArea(x, y)) return true
  if (inRect(x, y, $('widget-login'))) return true      // 未登录态：登录盘也要可点，否则按钮永远点不到
  return ['widget-add-panel', 'widget-others-panel', 'widget-tagbar'].some((id) => inRect(x, y, $(id)))
}
function setMousePassthrough(ignore) {
  if (!isElectron || !window.electronAPI.ignoreMouse) return
  if (ignore === ignoringMouse) return
  ignoringMouse = ignore
  window.electronAPI.ignoreMouse(ignore)
}
document.addEventListener('mousemove', (e) => {
  if (!IS_WIDGET) return
  setMousePassthrough(!isInteractiveAt(e.clientX, e.clientY))
})
document.addEventListener('mouseleave', () => setMousePassthrough(true))   // 指针离开窗口 → 全部放行

/* ========== 任意位置拖动 ==========
   按下圆盘任意处即可拖动（不只盘缘）。位移在主进程按光标计算，指针移出窗口也不丢。
   拖动阈值 4px 用来区分"点击"与"拖动"；拖动结束后紧随的 click 会被吞掉，避免误触发切换/停止。 */
let dragging = false
let dragMoved = false
let dragStartPt = null
const canManualDrag = () => isElectron && !!window.electronAPI.dragStart

function beginDrag(e) {
  if (e.button !== 0) return
  if (e.target.closest('.widget-panel')) return     // 面板内（输入框等）不拖
  if (!canManualDrag()) return                      // 旧壳：走 -webkit-app-region
  dragging = true
  dragMoved = false
  dragStartPt = { x: e.screenX, y: e.screenY }
  window.electronAPI.dragStart()
}
$('widget-plate').addEventListener('mousedown', beginDrag)
$('widget-login').addEventListener('mousedown', beginDrag)   // 未登录盘同样可拖动
window.addEventListener('mousemove', (e) => {
  if (!dragging) return
  if (Math.abs(e.screenX - dragStartPt.x) + Math.abs(e.screenY - dragStartPt.y) > 4) {
    dragMoved = true
    document.body.classList.add('is-dragging')
  }
})
window.addEventListener('mouseup', () => {
  if (!dragging) return
  dragging = false
  document.body.classList.remove('is-dragging')
  if (window.electronAPI.dragEnd) window.electronAPI.dragEnd()
})
/* 捕获阶段吞掉"拖动之后"的那次 click */
$('widget-plate').addEventListener('click', (e) => {
  if (!dragMoved) return
  dragMoved = false
  e.stopPropagation()
  e.preventDefault()
}, true)

/* 面板统一开关（新增分类 / 其他分类 / 快速标签） */
function anyPanelOpen() {
  return ['widget-add-panel', 'widget-others-panel', 'widget-tagbar']
    .some((id) => !$(id).classList.contains('hidden'))
}
function openPanel(id) {
  clearFocus()             // 面板语义优先，取消滚轮选中
  hideToast()              // 提示条与面板抢同一块位置
  $(id).classList.remove('hidden')
  widgetResize(WIDGET_PANEL_W, WIDGET_PANEL_H)
  renderCenter()
}
function closePanel(id) {
  // 关键：面板里的输入框即使被隐藏仍会持有焦点，会让"输入框聚焦时忽略滚轮/方向键"的守卫一直生效
  if (document.activeElement && $(id).contains(document.activeElement)) document.activeElement.blur()
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

  /* 正在计时的那个**优先入选、绝不参与截断** —— 否则分类一多，刚切过去/刚新增的
     那一类会被折进「其他分类」，环上就看不到高亮（2026-10-12 用户实测报过）。 */
  const sorted = withDeg.sort((a, b) => b.deg - a.deg)
  const ordered = sorted.filter((x) => x.active).concat(sorted.filter((x) => !x.active))
  const items = ordered.slice(0, MAX_SECTORS)
  const rest = ordered.slice(MAX_SECTORS)
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
  paintPickProgress()      // 浮层里选中条的进度线（环上的弧被浮层盖住了）
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
    // ghost 也每秒跟着数据校正一次：形状没变时不会重建 DOM，靠它兜住"幽灵↔实心"的转换
    arc.el.classList.toggle('ghost', !!it.ghost && !active)
    arc.el.classList.toggle('dim', !!hoverCatId && !focusCatId && hoverCatId !== arc.id)
    if (active || focused) {
      // 注意：内联 filter 会盖掉 CSS 的 :hover{filter}，所以悬停提亮要自己拼进来
      const f = [active
        ? `drop-shadow(0 0 6px ${hexToRgba(it.color, 0.6)})`
        : `drop-shadow(0 0 6px ${hexToRgba(it.color, 0.45)})`]
      if (hovered) f.push('brightness(1.35)')
      arc.el.style.filter = f.join(' ')
    } else {
      arc.el.style.filter = ''
    }
  })
  if (confirmArcEl) confirmArcEl.classList.toggle('focused', !!focusCatId)
  updatePickOverlay()    // 浮层挂在同一条状态通路上，不新增第二条状态源
}
/* ============================================================================
   桌面组件 · 切换态浮层
   ----------------------------------------------------------------------------
   用户明确："桌面常驻还要这个表盘形式，只是在切换，也就是鼠标滚轮在上面滚动的时候
   弹出荧光条，背景用模糊效果遮住表盘，同时几个荧光条滚动，最下方是新增项目，
   可以循环滚动，停留并移开鼠标就会开始对应项目的计时。"

   → **常驻形态是表盘，不动**；本浮层只在 focusCatId 有值时出现，盖在表盘上（模糊遮罩在 CSS）。
     滚动 / 选中 / 确认仍走原有那条通路
     （onWheel → stepFocus → setFocus → 停顿 FOCUS_CONFIRM_MS → finishConfirm），
     这里只负责"把选中状态画成荧光条列表"，不新增第二条状态源。

   循环滚动：每行相对选中行的位移用**环形最短距离**算，滚到末位自然绕回开头
   （而不是跳回），且无论多少分类都只露出附近 5 行。
   ========================================================================== */
const PICK_ROW_H = 52      // 条高 46 + 间隙 6；配合"方形遮罩"把条做大做直观

const pickName = (id) => (id === '__none__' ? '未分类' : id === '__other__' ? '其他分类'
  : id === '__add__' ? '新增项目' : ((catById(id) || {}).name || ''))

/* 条内文字色：亮底用深字、暗底用白字。阈值 .62 —— 再低会把中蓝/中绿也判成深字，整排就乱 */
function inkForBar(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''))
  if (!m) return '#fff'
  const L = (0.299 * parseInt(m[1], 16) + 0.587 * parseInt(m[2], 16) + 0.114 * parseInt(m[3], 16)) / 255
  return L > 0.62 ? 'rgba(12,14,18,.9)' : 'rgba(255,255,255,.97)'
}

let pickRows = []
let pickIds = []

function updatePickOverlay() {
  const layer = $('widget-pick')
  const box = $('widget-pick-list')
  if (!layer || !box) return
  const on = !!focusCatId
  layer.classList.toggle('hidden', !on)
  if (!on) return

  pickData = pickList()                       // 完整列表（含新增项），不受环的截断影响
  const ids = pickData.map((x) => x.id)

  if (ids.join(',') !== pickIds.join(',')) {
    box.innerHTML = ''
    pickRows = []
    pickIds = ids
    ids.forEach((id) => {
      const el = document.createElement('div')
      el.className = 'wp-row'
      /* 「新增项目」那行**没有时长**（.wp-du），但有确认进度线（.wp-prog）——
         滚到它、停留 900ms 同样会走进度、同样能确认。 */
      el.innerHTML = id === '__add__'
        ? '<div class="wp-bar wp-add"><span class="wp-plus"></span><span class="wp-nm"></span><span class="wp-prog"></span></div>'
        : '<div class="wp-bar"><span class="wp-nm"></span><span class="wp-du"></span><span class="wp-prog"></span></div>'
      box.appendChild(el)
      const bar = el.querySelector('.wp-bar')
      pickRows.push({
        el, bar, id, prog: bar.querySelector('.wp-prog'),
        nm: bar.querySelector('.wp-nm'), du: bar.querySelector('.wp-du'),
      })
    })
  }

  const n = pickIds.length
  let fi = pickIds.indexOf(focusCatId)
  if (fi < 0) fi = 0
  const maxW = Math.max(110, box.clientWidth - 20)

  /* 先写文字、量**文字**宽。不要量条本身：条宽是我们自己上一轮写进去的，
     再量它会把零点顶到满格、所有条被拉平成一样长（第一版就是这么错的）。 */
  /* ⚠️ 量宽必须包 try：它只是"锦上添花"，一旦抛异常会把后面的**定位**带崩，
     结果是所有条叠在中心、看着只剩一条（用户截图就是这个现象）。
     位置是命脉，宽度是装饰，两者不能串在一起。 */
  let L0 = 80
  /* maxSec 放在 try 外面：它只依赖 ringData，不会抛；而它一旦留在兜底值 1，
     所有非零的条都会算成 share=1 → 全变成满宽，条长就彻底失去意义了 */
  const maxSec = Math.max(1, ...pickData.map((x) => x.sec || 0))
  try {
    pickRows.forEach((r) => {
      const it = pickData.find((x) => x.id === r.id) || {}
      r.nm.textContent = pickName(r.id)
      if (r.du) r.du.textContent = (it.sec || 0) > 0 ? fmtDurMin(it.sec) : '—'
      /* ⚠️ 必须判空：`__add__` 那行没有 .wp-du，「新增项目」又占一个 ＋ 图标宽。
       不判空这里会抛 TypeError —— 之前"浮层只剩一条"的根因就是它。 */
    L0 = Math.max(L0, r.nm.scrollWidth + (r.du ? r.du.scrollWidth : 0) + (r.id === '__add__' ? 16 : 0) + 10 + 32 + 2)
    })
    L0 = Math.min(L0, maxW)
  } catch (err) {
    L0 = Math.max(80, Math.min(L0, maxW))         // 量失败就退回保守值，继续往下走
  }
  pickRows.forEach((r, i) => {
    let d = i - fi                       // 环形最短距离 → 到末位自然绕回开头
    if (d > n / 2) d -= n
    if (d < -n / 2) d += n
    r.el.style.top = 'calc(50% + ' + (d * PICK_ROW_H) + 'px)'   // 居中由 CSS 的 translateY(-50%) 负责
    const a = Math.abs(d)
    r.el.style.opacity = a < 0.5 ? 1 : a < 1.5 ? 0.55 : a < 2.5 ? 0.22 : 0
    r.el.style.visibility = a > 2.5 ? 'hidden' : 'visible'
    r.el.classList.toggle('cur', d === 0)

    const it = pickData.find((x) => x.id === r.id) || {}
    /* 「新增项目」不吃时长映射，固定用最短档（它本来就没有时长） */
    if (r.id === '__add__') { r.bar.style.width = L0 + 'px'; return }
    const ghost = !!it.ghost && !it.active
    const share = Math.min(1, (it.sec || 0) / maxSec)
    r.bar.style.width = Math.round(Math.min(maxW, L0 + (maxW - L0) * share)) + 'px'
    r.bar.style.background = ghost ? 'rgba(255,255,255,.10)' : (it.color || '#5a5d64')
    r.bar.style.color = ghost ? 'rgba(255,255,255,.58)' : inkForBar(it.color)
  })
}

/* 确认进度线：原来画在环上的 ring-confirm 弧，浮层盖住后改画在选中条底部 */
function paintPickProgress() {
  pickRows.forEach((r) => {
    if (!r.prog) return
    const cur = r.el.classList.contains('cur') && !!focusCatId
    r.prog.style.width = cur ? Math.round(confirmProgress * 100) + '%' : '0%'
  })
}

function renderRing() {
  const { items } = widgetSectors()
  ringData = items
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

  ringArcs = []        // items / ringData 已在函数开头取好（列表形态也要用）
  items.forEach((it) => {
    const c = document.createElementNS(NS, 'circle')
    setAttrs(c, {
      cx: RING_CX, cy: RING_CX, r: RING_R, fill: 'none',
      stroke: it.color, 'stroke-width': RING_SW, 'stroke-linecap': 'round',
      'data-cat': it.id,
      /* 正在计时的扇区**即使今日 0 秒也不算幽灵**：否则"刚开始 / 刚切换"的那一瞬间
         它会被按轨道灰画出来，而 tickRing 只在形状变化时才重建 DOM → 这个灰会一直留着
         （用户报过："开始第一个计时的时候，圈还是灰色的"）。见 DESIGN.md §3.2 */
      class: 'ring-seg' + (it.ghost && !it.active ? ' ghost' : ''),
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
/* 滚轮只转**分类**。
   「新增项目」刻意不进这条序列 —— 用户："新增不应该和切换项目用同样的逻辑，
   做出一点差异性"。切换 = 滚轮循环 + 停留确认；新增 = 底部独立一格、只接受点击。
   （曾经把「新增」并进序列让它可停留，结果是每转一圈都会扫过它、一停就弹面板，
    太重也容易误触。） */
/* 浮层用**完整**分类列表，不走环的截断 —— 环上超出上限可以折叠成「其他分类」，
   但**切换列表不能少任何一项**（2026-10-12 用户实测：新加的分类在滚动菜单里看不到）。
   已经从 ringData 拿到的直接用（省一次计算），没拿到的按同一口径现算。 */
let pickData = []
function pickList() {
  const byId = {}
  ringData.forEach((it) => { byId[it.id] = it })
  const elapsed = elapsedSec()
  const out = categories.map((c) => {
    if (byId[c.id]) return byId[c.id]
    const sec = (todayStats.byCat[c.id] || 0) + (runningEntry && runningEntry.category_id === c.id ? elapsed : 0)
    return {
      id: c.id, name: c.name, color: c.color, sec: sec,
      active: !!(runningEntry && runningEntry.category_id === c.id),
      ghost: sec <= 0,
    }
  })
  if (byId.__none__) out.push(byId.__none__)
  out.push({ id: '__add__', name: '新增项目', color: null, sec: 0 })   // 末位固定「新增项目」
  return out
}

function focusableIds() { return pickList().map((x) => x.id) }

function stepFocus(dir) {
  const ids = focusableIds()
  const n = ids.length
  if (!n) return
  let idx = focusCatId ? ids.indexOf(focusCatId) : -1
  if (idx < 0) {
    // 首次滚动：优先从"正在计时的分类"起跳一步；空闲则从第一条（顺时针）/ 末条（逆时针）进入
    const rid = runningEntry ? (runningEntry.category_id || '__none__') : null
    const ri = rid ? ids.indexOf(rid) : -1
    idx = ri >= 0 ? mod(ri + dir, n) : (dir > 0 ? 0 : n - 1)
  } else {
    idx = mod(idx + dir, n)
  }
  setFocus(ids[idx])
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
  if (id === '__add__') { clearFocus(); openWidgetAddPanel(); return }   // 浮层末位的「新增项目」
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

  /* ── 动量式步进（2026-10-12 改）────────────────────────────────────────
     原来有两处让"快滚也没用"：
       ① `if (now < wheelLockUntil) return` —— 锁定期间的事件被**直接丢弃**，
          于是步进被硬性限速在 ~6.7 步/秒，滚多快都一格一格跳
       ② `wheelAccum = 0` —— 余数清零，两次半格拼不成一格
     现在：**先累加、再按累积量一次性走多步**（保留余数）。
       快速滚动 → 一次事件跨多格 → 立刻走多步；惯性尾巴也会继续推进，
       手感像真正的滚动，而不是滴水。
     每步仍各自 restartConfirmTimer()，所以"停住 900ms 确认"是从**最后一步**起算的。 */
  wheelAccum += dy
  const dir = Math.sign(wheelAccum)
  const steps = Math.floor(Math.abs(wheelAccum) / WHEEL_STEP)
  if (steps < 1) return                                  // 触控板小增量先累积成一格
  wheelAccum -= dir * steps * WHEEL_STEP                 // 保留余数
  const n = Math.min(steps, WHEEL_MAX_STEPS)             // 上限：一笔最多跨 6 格
  for (let i = 0; i < n; i++) stepFocus(dir)             // 滚轮向下 = 顺时针 = 下一段
}
window.addEventListener('wheel', onWheel, { passive: false })

/* ---------- 扇区动作：开始 / 停止 / 切换 ----------
   viaWheel=true（滚轮确认）：与运行中分类相同 → 无操作（防误停）
   viaWheel=false（点击）：与运行中分类相同 → 停止（保留既有肌肉记忆；
   产品最终形态是"无暂停的连续记录"，届时该手势会改为无操作） */
async function applySectorAction(catId, { viaWheel = false } = {}) {
  if (IS_LOCAL) {                                              // 演示 / 沙盒：本地开关，不连云端
    if (anyPanelOpen()) return                                 // 与正式流程一致：面板打开时不响应
    localToggle(catId, { viaWheel })
    return
  }
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
  setAddError('')
  renderSwatches()
  openPanel('widget-add-panel')
  $('widget-new-cat-name').focus()
}

function closeWidgetAddPanel() { closePanel('widget-add-panel') }

/* 校验/错误反馈走面板内的内联错误行（提示条在面板打开时会被隐藏，不能用来报错） */
function setAddError(msg) {
  const el = $('widget-add-error')
  if (!el) return
  el.textContent = msg || ''
  el.classList.toggle('hidden', !msg)
}

/* ── 会话失效的识别与兜底（2026-10-12 补）────────────────────────────────
   背景：云端的 categories/time_entries 开着 RLS，owner_id 的默认值是 auth.uid()。
   会话一旦过期，**读会返回空数组而不是报错**（RLS 的自然行为），写入才会报错：
     · 42501  RLS 策略拒绝（with check owner_id = auth.uid() 不成立）
     · 23502  owner_id 非空约束失败（默认值 auth.uid() 取到了 null）
   之前的代码遇到这两种情况只会说"添加失败，请重试"，用户完全不知道是登录过期 ——
   而**组件上根本没有重新登录的入口**，于是就成了死路。
   现在：识别出来 → 直接把组件切回登录态（那里有「打开完整版登录」按钮）。 */
function isAuthExpired(err) {
  if (!err) return false
  const code = String(err.code || '')
  const msg = String(err.message || '')
  return code === '42501' || code === '23502' ||
    /row-level security|violates not-null|permission denied/i.test(msg)
}

/** 会话失效时的统一兜底：提示 + （组件下）切回登录态，给用户一条出路 */
function handleAuthExpired() {
  if (IS_WIDGET) { showWidgetLogin(); return true }
  showToast('登录已过期，请重新登录')
  return true
}

async function saveWidgetCategory() {
  const name = $('widget-new-cat-name').value.trim()
  if (!name) { setAddError('请输入分类名称'); return }
  if (IS_LOCAL) {                                  // 演示 / 沙盒：只加在本地
    const newCat = { id: (IS_SANDBOX ? 'sb-c' : 'demo-c') + Date.now(), name, color: widgetSwatchColor, sort_order: categories.length + 1 }
    categories.push(newCat)
    setAddError('')
    closeWidgetAddPanel()
    showToast('分类已添加' + LOCAL_SUFFIX)
    renderRing(); renderCenter()
    sandboxSave()
    await applySectorAction(newCat.id)             // 加完直接开始这一类
    return
  }
  const maxSort = categories.reduce((m, c) => Math.max(m, c.sort_order || 0), 0)
  const { data, error } = await cloud.database.from('categories')
    .insert({ name, color: widgetSwatchColor, sort_order: maxSort + 1 }).select()
  if (error) {
    /* 会话过期要给"人话 + 出路"，不能只说"添加失败" —— 组件上没有别的登录入口 */
    if (isAuthExpired(error)) { closeWidgetAddPanel(); handleAuthExpired(); return }
    /* 带上具体原因：只说"添加失败，请重试"等于没说，用户没法反馈也没法自查
       （2026-10-12：用户报"添加没法用"，界面上却什么都看不到） */
    setAddError(error.code === '23505'
      ? '同名分类已存在'
      : '添加失败：' + (error.code || '') + ' ' + (error.message || '请重试'))
    return
  }
  setAddError('')
  closeWidgetAddPanel()                            // 先收面板再提示，避免提示条被面板挡住
  showToast('分类已添加')
  await loadCategories()
  renderRing()
  renderCenter()
  /* 新增完**直接开始这一类的计时**（用户："新增之后直接开始新增项目的计时就好，
     现在新增之后还是原项目继续计时"）—— 走的是和"点这个分类"完全相同的路径，
     所以旧项目会被正常关掉、新项目接着开始，不会出现两段并行。 */
  const newId = (data && data[0] && data[0].id) || null
  if (newId) await applySectorAction(newId)
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
/* 浮层里的条也要能点（点 = 立即确认，与扇区点击同一条路径）。
   ⚠️ 滚轮**不在这里拦**：它必须冒泡到 window 上的 onWheel 去驱动 stepFocus，
   否则滚轮就没法滚列表了。 */
const pickEl = $('widget-pick-list')
if (pickEl) {
  pickEl.addEventListener('click', (e) => {
    const row = e.target.closest('.wp-row')
    if (!row) return
    const idx = [...pickEl.children].indexOf(row)
    const id = pickIds[idx]
    if (!id) return
    cancelConfirm()
    clearFocus()
    if (id === '__other__') { openOthersPanel(); return }
    clearHover()
    onSectorClick(id)
  })
}
/* 底部「新增项目」：独立一格，**只走点击**，不参与滚轮与停留 */
const pickAddEl = $('widget-pick-add')
if (pickAddEl) {
  pickAddEl.addEventListener('click', () => {
    cancelConfirm()
    clearFocus()
    openWidgetAddPanel()
  })
}
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
$('widget-new-cat-name').addEventListener('input', () => setAddError(''))   // 重新输入即清掉错误
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
  if (!timeEl || !dot || !textEl || !hoverEl || !sub || !addBtn) return
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
    /* 空 ≠ 新用户！RLS 下"会话失效"同样返回空数组。
       所以这里要区分：插入成功 = 真是新用户；插入被权限拒 = 会话过期，
       必须把状态暴露出来（否则界面看起来"正常"，用户只会觉得"点了没反应"）。 */
    const seeded = await cloud.database.from('categories').insert(DEFAULT_CATEGORIES).select()
    if (isAuthExpired(seeded.error)) { handleAuthExpired(); return }
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

// 本地模式（演示 / 沙盒）绝不能走云端刷新：否则失焦再聚焦会把本地计时冲掉
window.addEventListener('focus', () => { if (currentUser && !IS_LOCAL) refreshRunning() })

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
  /* 组件模式下不弹这条：它压在环心读数上，正好挡住刚启动的读秒。
     "正在计时"改由**对应色块的呼吸高亮**表达（.ring-seg.active），
     比一行会盖住数字的提示更直接。完整版网页仍保留提示。 */
  if (!IS_WIDGET) showToast('计时开始')
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
  if (IS_LOCAL) {                                  // 演示 / 沙盒：只走本地
    const from = entry.category_id
    entry.category_id = categoryId
    // 与正式流程一致：改标签 = 这段时长换个分类重新聚合（否则环上的分布不会动）
    if (from !== categoryId) {
      const sec = Math.floor(entry.duration_sec || 0)
      const fromKey = from || 'none'
      todayStats.byCat[fromKey] = Math.max(0, (todayStats.byCat[fromKey] || 0) - sec)
      if (!todayStats.byCat[fromKey]) delete todayStats.byCat[fromKey]   // 扣到 0 → 抹掉这条，环上不留空槽
      if (sec > 0) todayStats.byCat[categoryId] = (todayStats.byCat[categoryId] || 0) + sec
      renderRing(); renderCenter()
    }
    const cat = catById(categoryId)
    showToast(`已标记为「${cat ? cat.name : ''}」${LOCAL_SUFFIX}`)
    sandboxSave()
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
    if (isAuthExpired(error)) { handleAuthExpired(); return }
    showToast(error.code === '23505'
      ? '同名分类已存在'
      : '添加失败：' + (error.code || '') + ' ' + (error.message || '请重试'))
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
window.addEventListener('online', () => { updateOfflineBanner(); if (!IS_LOCAL) refreshRunning() })
window.addEventListener('offline', updateOfflineBanner)

/* ========== 启动 ========== */
;(async function init() {
  updateOfflineBanner()
  if (IS_DEMO) { enterDemo(); return }         // ?widget=1&demo=1：样例数据预览
  if (IS_SANDBOX) { enterSandbox(); return }   // ?widget=1&sandbox=1：空数据起步 + 本机持久化
  /* ── 免登录 ──────────────────────────────────────────────────────────
     先绑定空间，再进应用；**这里不再检查账号会话**。
     绑定优先级见 Repo.bootstrap：
       有令牌            → 直接用
       没令牌 + 有账号会话 → claim：把账号名下已有数据迁进空间（老用户不丢数据）
       没令牌 + 无会话     → create：开一个全新空间（新用户，全程不需要注册）
     之后读写全部走令牌 + rpc，界面上再也不出现登录。

     只有"绑定彻底失败"（典型是完全没网）才退回登录流程 —— 那是兜底，不是常规路径。 */
  if (typeof Repo !== 'undefined' && Repo.bootstrap) {
    const bind = await Repo.bootstrap()
    if (bind && bind.ok) { enterApp(null); return }
    const { data: fallbackSession } = await cloud.auth.getSession()   // 兜底：老账号会话还在就先让人进来
    if (fallbackSession) { currentUser = fallbackSession.user || null; enterApp(currentUser); return }
    showLogin()
    return
  }

  const { data: session, error } = await cloud.auth.getSession()
  if (error || !session) { showLogin(); return }
  currentUser = session.user || null
  enterApp(currentUser)
})()
