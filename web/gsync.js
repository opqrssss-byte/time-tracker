/* ============================================================
 * GSync — Google Docs 同步引擎（NotebookLM 被动数据管道）
 * 服务账号自签 JWT → 换 access_token → Docs API 全量重写同步
 * 配置仅存本机 localStorage，不上云、不进代码库。
 * ============================================================ */
const GSync = (() => {
  const LS_CFG = 'gsync_config'
  const LS_LAST = 'gsync_last_at'
  const SCOPE = 'https://www.googleapis.com/auth/documents'
  const TOKEN_URI_FALLBACK = 'https://oauth2.googleapis.com/token'

  let tokenCache = { token: null, exp: 0 }
  let syncing = null
  let debounce = null
  let statusCb = null

  function onStatus(cb) { statusCb = cb }
  function report(msg, isError) { if (statusCb) statusCb(msg, !!isError) }

  /* 任何异常都转成可读文本（jsrsasign 会抛字符串而非 Error） */
  function errText(e) {
    if (!e) return '未知错误'
    if (e.message) return String(e.message)
    return String(e)
  }

  function getConfig() {
    try { return JSON.parse(localStorage.getItem(LS_CFG) || 'null') } catch { return null }
  }
  function saveConfig(cfg) { localStorage.setItem(LS_CFG, JSON.stringify(cfg)) }
  function isConfigured() {
    const c = getConfig()
    return !!(c && c.docId && c.sa && c.sa.client_email && c.sa.private_key)
  }
  function lastSyncAt() { return localStorage.getItem(LS_LAST) || '' }

  /* 私钥规范化：兼容双重转义粘贴，返回规范 PEM 或抛中文错误 */
  function normalizePrivateKey(raw) {
    if (!raw) throw new Error('密钥 JSON 中没有 private_key 字段')
    const key = String(raw).replace(/\\n/g, '\n').trim()
    if (!key.includes('-----BEGIN PRIVATE KEY-----')) {
      throw new Error('private_key 内容不完整（缺少 BEGIN PRIVATE KEY），请重新下载服务账号 JSON 并原样粘贴全文')
    }
    return key
  }

  /* Google 错误 → 中文建议 */
  function explainGoogleError(msg) {
    const m = String(msg || '')
    if (/invalid_grant|invalid JWT|Key ID|invalid key/i.test(m)) {
      return '密钥无效或不完整：请到 GCP 控制台重新下载服务账号 JSON 密钥，原样粘贴全文'
    }
    if (/insufficient|forbidden|PERMISSION_DENIED|403/i.test(m)) {
      return '权限不足：请确认 ① Google Docs API 已在 GCP 启用 ② 文档已共享给服务账号邮箱（编辑者）'
    }
    if (/not found|404|File not found/i.test(m)) {
      return '找不到文档：请检查 Doc ID 是否正确（文档链接 /d/ 和 /edit 之间那串）'
    }
    if (/Failed to fetch|NetworkError|network/i.test(m)) {
      return '网络不通：访问 Google API 需要代理环境，请确认代理已开启（和使用 Gemini 相同的网络条件）'
    }
    if (/API has not been used|is disabled/i.test(m)) {
      return 'Google Docs API 未启用：请到 GCP 控制台 → API 和服务 → 库，启用 Google Docs API'
    }
    return null
  }

  /* ---------- Google 鉴权：服务账号 JWT Bearer ---------- */
  async function getToken() {
    if (tokenCache.token && Date.now() < tokenCache.exp - 60000) return tokenCache.token
    const { sa } = getConfig()
    const tokenUri = sa.token_uri || TOKEN_URI_FALLBACK
    const privateKey = normalizePrivateKey(sa.private_key)
    const now = Math.floor(Date.now() / 1000)

    let jwt
    try {
      jwt = KJUR.jws.JWS.sign(
        null,
        { alg: 'RS256', typ: 'JWT' },
        { iss: sa.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 },
        privateKey,
      )
    } catch (e) {
      throw new Error('密钥签名失败（' + errText(e) + '）：请确认粘贴的是服务账号 JSON 全文，私钥未被截断')
    }

    const resp = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(jwt)}`,
    })
    const data = await resp.json().catch(() => ({}))
    if (!resp.ok || !data.access_token) {
      const raw = data.error_description || data.error || `HTTP ${resp.status}`
      throw new Error('Google 授权失败：' + raw + (explainGoogleError(raw) ? '（' + explainGoogleError(raw) + '）' : ''))
    }
    tokenCache = { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 }
    return tokenCache.token
  }

  /* ---------- Docs API ---------- */
  async function docsRequest(suffix, method, body) {
    const token = await getToken()
    const { docId } = getConfig()
    const resp = await fetch(`https://docs.googleapis.com/v1/documents/${docId}${suffix}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = await resp.json().catch(() => ({}))
    if (!resp.ok) {
      const raw = (data.error && data.error.message) || `HTTP ${resp.status}`
      const hint = explainGoogleError(raw)
      throw new Error(raw + (hint ? '（' + hint + '）' : ''))
    }
    return data
  }

  /* ---------- 文档文本生成（兼顾 NotebookLM RAG 可读性） ---------- */
  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

  function dayHeading(d) {
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${WEEKDAYS[d.getDay()]}`
  }
  function clockOf(iso) {
    const d = new Date(iso)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  function durText(sec) {
    if (sec == null) return ''
    if (sec < 60) return `${sec}秒`
    const m = Math.floor(sec / 60)
    if (m < 60) return `${m}分钟`
    return `${Math.floor(m / 60)}小时${m % 60 ? (m % 60) + '分' : ''}`
  }

  function buildDocText(entries, categories) {
    const catMap = {}
    categories.forEach((c) => { catMap[c.id] = c.name })
    const now = new Date()
    let text = '时间日志（由时间追踪工具自动同步生成，请勿手动编辑）\n'
    text += `最后同步：${dayHeading(now)} ${clockOf(now.toISOString())}\n\n`

    let lastDay = ''
    entries.forEach((e) => {
      const d = new Date(e.start_time)
      const heading = dayHeading(d)
      if (heading !== lastDay) {
        lastDay = heading
        text += `【${heading}】\n`
      }
      const cat = catMap[e.category_id] || '未分类'
      const title = (e.title || '').trim() || '（未填写内容）'
      text += `${clockOf(e.start_time)}-${clockOf(e.end_time)}｜${cat}｜${title}｜${durText(e.duration_sec)}\n`
    })
    if (!entries.length) text += '（暂无记录）\n'
    return text
  }

  /* ---------- 全量重写同步（幂等，无索引漂移/重复风险） ---------- */
  async function syncNow(fetchData) {
    if (!isConfigured()) { report('未配置 Google 同步', true); return }
    if (syncing) return syncing
    syncing = (async () => {
      try {
        report('同步中…')
        const { entries, categories } = await fetchData()
        const text = buildDocText(entries, categories)
        const doc = await docsRequest('', 'GET')
        const content = (doc.body && doc.body.content) || []
        const endIndex = content.length ? content[content.length - 1].endIndex : 2
        const requests = []
        if (endIndex > 2) {
          requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } } })
        }
        requests.push({ insertText: { location: { index: 1 }, text } })
        await docsRequest(':batchUpdate', 'POST', { requests })
        localStorage.setItem(LS_LAST, new Date().toISOString())
        report(`已同步（${entries.length} 条记录）`)
      } catch (e) {
        console.error('[GSync] sync failed', e)
        report('同步失败：' + errText(e), true)
      } finally {
        syncing = null
      }
    })()
    return syncing
  }

  /* 防抖调度：停止/编辑/删除记录后 3 秒触发 */
  function scheduleSync(fetchData) {
    if (!isConfigured()) return
    clearTimeout(debounce)
    debounce = setTimeout(() => syncNow(fetchData), 3000)
  }

  /* ---------- 分步自检：① 密钥 → ② 授权 → ③ 读文档 → ④ 写权限 ---------- */
  async function diagnose() {
    const steps = []

    // ① 解析配置与密钥
    const cfg = getConfig()
    if (!cfg || !cfg.docId || !cfg.sa) {
      steps.push({ ok: false, name: '解析配置', message: '配置不完整', suggestion: '请填写 Doc ID 并粘贴服务账号 JSON 全文后保存' })
      return steps
    }
    try {
      normalizePrivateKey(cfg.sa.private_key)
      if (!cfg.sa.client_email) throw new Error('缺少 client_email')
      steps.push({ ok: true, name: '解析密钥', message: `服务账号：${cfg.sa.client_email}` })
    } catch (e) {
      steps.push({ ok: false, name: '解析密钥', message: errText(e), suggestion: '到 GCP 控制台重新下载服务账号 JSON 密钥，原样粘贴全文（不要改动任何字符）' })
      return steps
    }

    // ② Google 授权
    try {
      tokenCache = { token: null, exp: 0 } // 强制重新换 token
      await getToken()
      steps.push({ ok: true, name: 'Google 授权', message: '已成功换取访问令牌' })
    } catch (e) {
      steps.push({ ok: false, name: 'Google 授权', message: errText(e), suggestion: explainGoogleError(errText(e)) || '检查密钥 JSON 是否完整、网络代理是否开启' })
      return steps
    }

    // ③ 读取文档
    let doc
    try {
      doc = await docsRequest('', 'GET')
      steps.push({ ok: true, name: '读取文档', message: `文档「${(doc.title || '').slice(0, 30)}」读取成功` })
    } catch (e) {
      steps.push({ ok: false, name: '读取文档', message: errText(e), suggestion: explainGoogleError(errText(e)) || '检查 Doc ID 与文档共享设置' })
      return steps
    }

    // ④ 写入权限（追加一行立即删除）
    try {
      const content = (doc.body && doc.body.content) || []
      const endIndex = content.length ? content[content.length - 1].endIndex : 2
      const probe = '【同步自检】写入测试\n'
      await docsRequest(':batchUpdate', 'POST', {
        requests: [{ insertText: { location: { index: endIndex - 1 }, text: probe } }],
      })
      const doc2 = await docsRequest('', 'GET')
      const c2 = (doc2.body && doc2.body.content) || []
      const end2 = c2.length ? c2[c2.length - 1].endIndex : 2
      await docsRequest(':batchUpdate', 'POST', {
        requests: [{ deleteContentRange: { range: { startIndex: end2 - 1 - probe.length, endIndex: end2 - 1 } } }],
      })
      steps.push({ ok: true, name: '写入权限', message: '试写成功并已清理' })
    } catch (e) {
      steps.push({ ok: false, name: '写入权限', message: errText(e), suggestion: '请把文档共享给服务账号邮箱时选择「编辑者」而非「查看者」' })
      return steps
    }

    return steps
  }

  return { getConfig, saveConfig, isConfigured, lastSyncAt, onStatus, syncNow, scheduleSync, diagnose }
})()
