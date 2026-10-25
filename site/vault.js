/* ============================================================
 * Vault — Obsidian 库写入适配器
 * 接口恒定，后端可换：fsa（File System Access）→ download（导出兜底）
 * 全部在 site/ 内完成，不碰主进程、不需要重打包 exe。
 *
 * 设计要点：
 *  1. 目录句柄存 IndexedDB，页面重载后尝试恢复（权限可能退回 prompt）
 *  2. 自动同步时没有用户手势，绝不能调 requestPermission（会抛 SecurityError），
 *     改为挂起任务，等下一次真实点击再补授权并冲刷
 *  3. 写前比对内容，未变则不写盘 —— 否则每次防抖都会让 git 产生假 diff
 * ============================================================ */
const Vault = (() => {
  const DB_NAME = 'buddyvault'
  const DB_VER = 1
  const STORE = 'handles'
  const KEY_ROOT = 'vault_root'
  const LS_LAST = 'vault_last_at'

  let rootHandle = null
  let state = 'unlinked' // unsupported | unlinked | need-grant | ready | denied
  let statusCb = null
  let syncing = null
  let debounce = null
  let pendingFetch = null
  let clickBound = false

  function onStatus(cb) { statusCb = cb }
  function report(msg, isError) { if (statusCb) statusCb(msg, !!isError) }
  function errText(e) {
    if (!e) return '未知错误'
    if (e.message) return String(e.message)
    return String(e)
  }

  /* ---------- 状态 ---------- */
  const STATE_TEXT = {
    unsupported: '当前环境不支持直接写入（需 Chrome/Edge 或桌面端）',
    unlinked: '未连接库',
    'need-grant': '待授权：点「重新授权」后继续',
    ready: '已连接',
    denied: '授权被拒绝，请在浏览器地址栏的权限设置里恢复',
  }
  function stateText() { return STATE_TEXT[state] || state }

  function backend() {
    if (typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function') return 'fsa'
    return 'download'
  }
  function canWrite() { return backend() === 'fsa' }
  function isReady() { return state === 'ready' && !!rootHandle }

  /* ---------- IndexedDB：句柄持久化 ---------- */
  function idbOpen() {
    return new Promise((resolve, reject) => {
      let req
      try { req = indexedDB.open(DB_NAME, DB_VER) } catch (e) { reject(e); return }
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }

  async function idbGet(key) {
    const db = await idbOpen()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(key)
      req.onsuccess = () => resolve(req.result || null)
      req.onerror = () => reject(req.error)
    })
  }

  async function idbSet(key, val) {
    const db = await idbOpen()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(val, key)
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => reject(tx.error)
    })
  }

  async function idbDel(key) {
    const db = await idbOpen()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(key)
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => reject(tx.error)
    })
  }

  /* ---------- 权限 ---------- */
  async function permissionOf(handle) {
    if (!handle || typeof handle.queryPermission !== 'function') return 'granted'
    try { return await handle.queryPermission({ mode: 'readwrite' }) } catch { return 'prompt' }
  }

  function applyPermission(p) {
    if (p === 'granted') { state = 'ready'; return true }
    state = p === 'denied' ? 'denied' : 'need-grant'
    return false
  }

  async function ensurePermission() {
    if (!rootHandle) { state = 'unlinked'; return false }
    return applyPermission(await permissionOf(rootHandle))
  }

  /* 只有真实用户手势才能调用，否则 SecurityError */
  async function requestPermission() {
    if (!rootHandle) return false
    try {
      const p = await rootHandle.requestPermission({ mode: 'readwrite' })
      return applyPermission(p)
    } catch (e) {
      console.warn('[Vault] requestPermission 失败', e)
      state = 'need-grant'
      return false
    }
  }

  /* ---------- 连接 ---------- */
  async function connect() {
    if (!canWrite()) throw new Error('当前环境不支持直接写入，请改用「导出今日 Markdown」')
    const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'buddy-vault' })
    rootHandle = handle
    try {
      await idbSet(KEY_ROOT, handle)
    } catch (e) {
      // DataCloneError / InvalidStateError：句柄存不下，本次会话仍可用
      console.warn('[Vault] 句柄持久化失败，下次启动需重新选择目录', e)
    }
    state = 'ready'
    report(`已连接：${handle.name}`)
    return true
  }

  async function disconnect() {
    rootHandle = null
    state = 'unlinked'
    try { await idbDel(KEY_ROOT) } catch { /* 忽略 */ }
    report('已断开库连接')
  }

  /* ---------- 文件读写 ---------- */
  async function ensureDir(segments) {
    let dir = rootHandle
    for (const seg of segments) {
      dir = await dir.getDirectoryHandle(seg, { create: true })
    }
    return dir
  }

  async function readFile(relPath) {
    if (!rootHandle) return null
    const segs = String(relPath).split('/')
    const fileName = segs.pop()
    let dir = rootHandle
    for (const seg of segs) dir = await dir.getDirectoryHandle(seg)
    try {
      const fh = await dir.getFileHandle(fileName)
      return await (await fh.getFile()).text()
    } catch {
      return null
    }
  }

  async function writeText(relPath, text) {
    if (!rootHandle) throw new Error('未连接库')
    const segs = String(relPath).split('/')
    const fileName = segs.pop()
    const dir = await ensureDir(segs)
    const fh = await dir.getFileHandle(fileName, { create: true })
    const w = await fh.createWritable()
    await w.write(text)
    await w.close()
  }

  /* 内容没变就不写盘 —— git 静谧性的关键 */
  async function writeIfChanged(relPath, text) {
    const old = await readFile(relPath)
    if (old === text) return { written: false, reason: 'unchanged' }
    await writeText(relPath, text)
    return { written: true, created: old === null }
  }

  /* ---------- 同步 ---------- */
  async function ensureCategoryStubs(categories, today) {
    if (!categories || !categories.length) return 0
    let created = 0
    for (const c of categories) {
      if (!c || !c.name) continue
      const p = VaultMD.pathForStub(c.name)
      const old = await readFile(p)
      if (old !== null) continue
      await writeText(p, VaultMD.buildCategoryStub(c.name, today))
      created += 1
    }
    return created
  }

  async function syncNow(fetchData) {
    if (syncing) return syncing
    syncing = (async () => {
      try {
        if (!canWrite()) { report('当前环境不支持直写：请用「导出」按钮', true); return }
        if (!rootHandle) { state = 'unlinked'; report('未连接 Obsidian 库', true); return }

        if (!(await ensurePermission())) {
          // 自动触发时无手势，挂起等点击
          pendingFetch = fetchData || pendingFetch
          report('待授权：点一下设置页的「重新授权」即可继续写库', false)
          return
        }

        report('写入库中…')
        const { entries, categories } = await fetchData()
        const groups = VaultMD.groupByDay(entries)
        const today = VaultMD.dayOf(new Date().toISOString())

        let written = 0
        let skipped = 0
        let failed = 0
        for (const g of groups) {
          try {
            const md = VaultMD.buildDailyNote(g, categories)
            const r = await writeIfChanged(VaultMD.pathForDay(g.day), md)
            if (r.written) written += 1
            else skipped += 1
          } catch (e) {
            failed += 1
            console.error('[Vault] 写入失败', g.day, e)
          }
        }

        const stubs = await ensureCategoryStubs(categories, today)
        localStorage.setItem(LS_LAST, new Date().toISOString())

        const tail = [
          `已写入 ${written} 天`,
          skipped ? `跳过 ${skipped} 天（未变）` : '',
          failed ? `失败 ${failed} 天` : '',
          stubs ? `新建分类 ${stubs} 个` : '',
        ].filter(Boolean).join(' · ')
        report(tail, failed > 0)
      } catch (e) {
        console.error('[Vault] sync failed', e)
        report('写入库失败：' + errText(e), true)
      } finally {
        syncing = null
      }
    })()
    return syncing
  }

  /* 8 秒防抖，与 gsync 的 3 秒错峰，避免两个请求同时拉同一张表 */
  function scheduleSync(fetchData) {
    if (!canWrite() || !rootHandle) return
    clearTimeout(debounce)
    debounce = setTimeout(() => syncNow(fetchData), 8000)
  }

  /* ---------- 降级：导出 .md ---------- */
  function saveTextFile(filename, text) {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1500)
  }

  async function exportDays(fetchData) {
    const { entries, categories } = await fetchData()
    const groups = VaultMD.groupByDay(entries)
    if (!groups.length) { report('没有可导出的记录', true); return 0 }
    for (const g of groups) {
      saveTextFile(`${g.day}.md`, VaultMD.buildDailyNote(g, categories))
      await new Promise((r) => setTimeout(r, 350)) // 浏览器多文件下载需要间隔
    }
    report(`已导出 ${groups.length} 天，请拖进库的「日记」目录`)
    return groups.length
  }

  function lastSyncAt() { return localStorage.getItem(LS_LAST) || '' }

  /* ---------- 初始化 ---------- */
  async function init() {
    if (!canWrite()) { state = 'unsupported'; return state }

    // 点击补授权：只在「有待办任务 + 缺权限」时才弹，避免乱弹窗
    if (!clickBound) {
      clickBound = true
      document.addEventListener('click', async () => {
        if (state !== 'need-grant' || !rootHandle) return
        const ok = await requestPermission()
        if (!ok) return
        report('授权已恢复')
        if (pendingFetch) {
          const f = pendingFetch
          pendingFetch = null
          syncNow(f)
        }
      }, { capture: true })
    }

    try {
      const h = await idbGet(KEY_ROOT)
      if (h) {
        rootHandle = h
        await ensurePermission()
      } else {
        state = 'unlinked'
      }
    } catch (e) {
      console.warn('[Vault] 恢复句柄失败', e)
      state = 'unlinked'
    }
    return state
  }

  return {
    init,
    backend,
    canWrite,
    isReady,
    getState: () => state,
    stateText,
    onStatus,
    connect,
    disconnect,
    ensurePermission,
    requestPermission,
    readFile,
    writeIfChanged,
    syncNow,
    scheduleSync,
    exportDays,
    lastSyncAt,
  }
})()
