/* ========== 初始化云客户端（publicConfig，安全可前置） ========== */
const cloud = WorkBuddyCloud.createWorkBuddyCloud({
  endpoint: 'https://mp-api.app.workbuddy.host',
  publishableKey: 'wbpk_Nv3mR6jZnOsFxEs3wbZrvd_Hw3G3bU9x7kabAo23YK62qBAxnFk3KYL',
})

/* ========== 运行模式 ========== */
const IS_WIDGET = new URLSearchParams(location.search).has('widget')
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
  if (sec < 60) return `${sec}秒`
  const m = Math.floor(sec / 60)
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

/* ========== 桌面悬浮组件（widget）模式：环形色块 ========== */
const WIDGET_W = 260
const WIDGET_H = 130
const RING_CX = 59
const RING_R = 47
const RING_SW = 17
const RING_CIRC = 2 * Math.PI * RING_R
const SEG_GAP_VIS = 5       // 相邻扇区视觉间隙(px)（圆头线帽会向两端各延伸 SW/2）
const TEXT_MIN_DEG = 25      // 扇区内显示文字所需的最小角度
const MAX_SECTORS = 7        // 环上直接展示的最大扇区数，其余合并为「其他」
const WIDGET_SWATCH_COLORS = ['#4F8CFF', '#9B6DFF', '#2FBF71', '#F2A93B', '#FF5A5A', '#23B8D5', '#F06EAA', '#8a91a3']
let widgetSwatchColor = WIDGET_SWATCH_COLORS[0]
let ringData = []            // 当前环上扇区数据（供 tooltip 使用）

function showWidgetLogin() {
  $('view-widget').classList.remove('hidden')
  $('widget-login').classList.remove('hidden')
  $('widget-main').classList.add('hidden')
  $('widget-tip').classList.add('hidden')
  $('widget-add-panel').classList.add('hidden')
  $('widget-tagbar').classList.add('hidden')
}

$('btn-widget-login').addEventListener('click', () => {
  if (isElectron) window.electronAPI.openFull()
  else location.href = location.origin + location.pathname
})

async function enterWidget() {
  $('view-login').classList.add('hidden')
  $('view-widget').classList.remove('hidden')
  $('widget-login').classList.add('hidden')
  $('widget-main').classList.remove('hidden')
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

function elapsedSec() {
  if (!runningEntry) return 0
  return Math.max(0, (Date.now() - new Date(runningEntry.start_time).getTime()) / 1000)
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
    byCat[k] = (byCat[k] || 0) + (e.duration_sec || 0)
    if (!latest[k]) latest[k] = (e.title || '').trim()
  })
  todayStats = { day: dayKey(new Date()), byCat, latest }
  if (IS_WIDGET) renderRing()
}

/* ---------- 环形渲染 ---------- */
function setAttrs(el, attrs) {
  for (const k in attrs) el.setAttribute(k, attrs[k])
}

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
  list.sort((a, b) => b.sec - a.sec)
  return list
}

function renderRing() {
  const svg = $('widget-ring')
  if (!svg) return
  const NS = 'http://www.w3.org/2000/svg'
  svg.innerHTML = ''
  const g = document.createElementNS(NS, 'g')
  g.setAttribute('transform', `rotate(-90 ${RING_CX} ${RING_CX})`) // 从 12 点方向开始
  svg.appendChild(g)

  const list = widgetSectors()
  const total = list.reduce((s, x) => s + x.sec, 0)
  if (total <= 0) {
    ringData = []
    const c = document.createElementNS(NS, 'circle')
    setAttrs(c, { cx: RING_CX, cy: RING_CX, r: RING_R, fill: 'none', stroke: 'rgba(255,255,255,0.10)', 'stroke-width': RING_SW })
    g.appendChild(c)
    return
  }

  const top = list.slice(0, MAX_SECTORS)
  const rest = list.slice(MAX_SECTORS)
  const items = [...top]
  if (rest.length) items.push({ id: '__other__', name: '其他', color: '#555b6e', sec: rest.reduce((s, x) => s + x.sec, 0), rest })

  ringData = items
  let acc = 0
  items.forEach((it) => {
    const frac = it.sec / total
    const arcLen = frac * RING_CIRC
    // 圆头线帽从虚线两端向外延伸 SW/2，虚线间隙 = 视觉间隙 + SW 才能留出白色间隔
    const gap = items.length > 1 ? Math.min(RING_SW + SEG_GAP_VIS, arcLen * 0.6) : 0
    const drawLen = Math.max(1.5, arcLen - gap)
    const c = document.createElementNS(NS, 'circle')
    setAttrs(c, {
      cx: RING_CX, cy: RING_CX, r: RING_R, fill: 'none',
      stroke: it.color, 'stroke-width': RING_SW, 'stroke-linecap': 'round',
      'stroke-dasharray': `${drawLen} ${RING_CIRC - drawLen}`,
      'stroke-dashoffset': String(-acc - gap / 2),
      'data-cat': it.id, 'data-name': it.name,
      class: 'ring-seg' + (it.active ? ' active' : ''),
    })
    g.appendChild(c)

    // 扇区文字：角度足够时画在弧中点（截断到 4 字）
    const deg = frac * 360
    if (deg >= TEXT_MIN_DEG && it.id !== '__other__') {
      const theta = -Math.PI / 2 + (acc + arcLen / 2) / RING_CIRC * 2 * Math.PI
      const tx = RING_CX + RING_R * Math.cos(theta)
      const ty = RING_CX + RING_R * Math.sin(theta)
      const label = it.name.length > 4 ? it.name.slice(0, 4) : it.name
      const t = document.createElementNS(NS, 'text')
      setAttrs(t, {
        x: tx, y: ty, 'text-anchor': 'middle', 'dominant-baseline': 'central',
        class: 'ring-label',
      })
      t.textContent = label
      svg.appendChild(t)
    }
    acc += arcLen
  })
}

/* ---------- 悬停详情浮层 ---------- */
function showWidgetTip(catId, fallbackName) {
  const tip = $('widget-tip')
  if (!tip) return
  if (catId === '__other__') {
    const other = ringData.find((x) => x.id === '__other__')
    if (!other || !other.rest || !other.rest.length) return
    tip.classList.add('clickable')
    tip.innerHTML = other.rest.map((r) =>
      `<button type="button" class="tip-row" data-cat="${escapeHtml(r.id)}">
        <span class="dot" style="background:${r.color}"></span>${escapeHtml(r.name)} · ${fmtDurMin(r.sec)}
      </button>`).join('')
  } else {
    tip.classList.remove('clickable')
    const it = ringData.find((x) => x.id === catId) || { name: fallbackName, sec: 0 }
    const latest = todayStats.latest[catId === '__none__' ? 'none' : catId]
    tip.innerHTML = `<b>${escapeHtml(it.name || fallbackName || '')}</b> · 今日 ${fmtDurMin(it.sec || 0)}`
      + (latest ? `<div class="tip-sub">最近：${escapeHtml(latest)}</div>` : `<div class="tip-sub">今日暂无记录</div>`)
  }
  tip.classList.remove('hidden')
}

function hideWidgetTip() {
  const tip = $('widget-tip')
  if (tip) tip.classList.add('hidden')
}

/* ---------- 点击扇区：开始 / 停止 / 切换 ---------- */
async function onSectorClick(catId) {
  if (!navigator.onLine) { showToast('当前离线，无法操作'); return }
  if (!$('widget-tagbar').classList.contains('hidden')) return  // 打标签时不响应
  if (!$('widget-add-panel').classList.contains('hidden')) return
  const cid = catId === '__none__' ? null : catId
  if (runningEntry && runningEntry.category_id === cid) {
    await stopTimer()
    return
  }
  if (runningEntry) {
    const ok = await stopTimer({ skipQuickTag: true })  // 切换：不弹标签栏
    if (!ok) return
  }
  await startTimer({ categoryId: cid })
}

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
  $('widget-add-panel').classList.remove('hidden')
  $('widget-new-cat-name').value = ''
  renderSwatches()
  widgetResize(WIDGET_W, 250)
  $('widget-new-cat-name').focus()
}

function closeWidgetAddPanel() {
  if ($('widget-add-panel').classList.contains('hidden')) return
  $('widget-add-panel').classList.add('hidden')
  if ($('widget-tagbar').classList.contains('hidden')) widgetResize(WIDGET_W, WIDGET_H)
  else widgetResize(WIDGET_W, 250)
}

async function saveWidgetCategory() {
  const name = $('widget-new-cat-name').value.trim()
  if (!name) { showToast('请输入分类名称'); return }
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
}

/* ---------- 事件接线（委托， survives 每秒重绘） ---------- */
$('widget-ring').addEventListener('click', (e) => {
  const t = e.target.closest('[data-cat]')
  if (!t) return
  hideWidgetTip()
  onSectorClick(t.getAttribute('data-cat'))
})
$('widget-ring').addEventListener('mouseover', (e) => {
  const t = e.target.closest('[data-cat]')
  if (t) showWidgetTip(t.getAttribute('data-cat'), t.getAttribute('data-name'))
})
$('widget-ring').addEventListener('mouseout', (e) => {
  if (e.target.closest('[data-cat]') && !$('widget-ring').contains(e.relatedTarget)) hideWidgetTip()
})
$('widget-tip').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cat]')
  if (!b) return
  hideWidgetTip()
  onSectorClick(b.getAttribute('data-cat'))
})
$('widget-tip').addEventListener('mouseleave', hideWidgetTip)

/* 右侧时长条：计时中点击 = 停止；空闲点击 = 开始未分类计时 */
$('widget-side').addEventListener('click', async () => {
  if (!navigator.onLine) { showToast('当前离线，无法操作'); return }
  if (runningEntry) await stopTimer()
  else await startTimer()
})

/* 右键 = Electron 菜单（打开完整版/开机自启/退出） */
$('widget-main').addEventListener('contextmenu', (e) => {
  e.preventDefault()
  if (isElectron) window.electronAPI.menu()
})

$('widget-add-cat').addEventListener('click', openWidgetAddPanel)
$('btn-widget-cat-save').addEventListener('click', saveWidgetCategory)
$('btn-widget-cat-cancel').addEventListener('click', closeWidgetAddPanel)
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && IS_WIDGET) closeWidgetAddPanel()
})

function renderWidgetState() {
  const time = $('widget-time')
  const dot = $('widget-state-dot')
  const text = $('widget-state-text')
  const addBtn = $('widget-add-cat')
  if (!time) return
  const running = !!runningEntry
  time.classList.toggle('idle', !running)
  const cat = running ? catById(runningEntry.category_id) : null
  if (running) {
    text.textContent = cat ? cat.name : '计时中'
    dot.style.background = cat ? cat.color : '#FF5A5A'
    dot.classList.add('on')
  } else {
    text.textContent = '空闲'
    dot.style.background = '#6b7280'
    dot.classList.remove('on')
  }
  addBtn.classList.toggle('hidden', running)
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
    if (IS_WIDGET) {
      const t = $('widget-time')
      if (t) t.textContent = '00:00'
    }
  }
  renderWidgetState()
  if (IS_WIDGET) renderRing()
}

function updateElapsed() {
  if (!runningEntry) return
  const sec = elapsedSec()
  $('elapsed').textContent = fmtHMS(sec)
  if (IS_WIDGET) {
    $('widget-time').textContent = fmtMS(sec)
    if (dayKey(new Date()) !== todayStats.day) refreshTodayStats()  // 跨天：环形归零
    renderRing()
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
    // 组件下方展开标签栏，并通知 Electron 扩窗
    const bar = $('widget-tagbar')
    bar.classList.remove('hidden')
    widgetResize(WIDGET_W, 250)
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
  if (IS_WIDGET) {
    $('widget-tagbar').classList.add('hidden')
    widgetResize(WIDGET_W, WIDGET_H)
  }
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
  const { data: session, error } = await cloud.auth.getSession()
  if (error || !session) { showLogin(); return }
  currentUser = session.user || null
  enterApp(currentUser)
})()
