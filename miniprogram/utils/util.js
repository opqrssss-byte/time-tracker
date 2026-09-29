const { cloud } = require('./cloud')

function pad(n) { return String(n).padStart(2, '0') }

function fmtHMS(totalSec) {
  const s = Math.max(0, Math.floor(totalSec))
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
}

function fmtClock(iso) {
  const d = new Date(iso)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
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
  const yest = new Date(); yest.setDate(today.getDate() - 1)
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (same(d, today)) return '今天'
  if (same(d, yest)) return '昨天'
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/* 会话守卫：未登录跳登录页，返回 null */
async function ensureSession() {
  const { data: session, error } = await cloud.auth.getSession()
  if (error || !session) {
    wx.redirectTo({ url: '/pages/login/login' })
    return null
  }
  return session
}

module.exports = { fmtHMS, fmtClock, fmtDurMin, dateLabel, ensureSession }
