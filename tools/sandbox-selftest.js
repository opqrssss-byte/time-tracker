/* 沙盒模式自测 —— 供 ?widget=1&sandbox=1 页面内 eval 执行
 *
 * 用法：
 *   playwright-cli open "http://localhost:8899/site/index.html?widget=1&sandbox=1"
 *   playwright-cli resize 260 380
 *   playwright-cli eval "fetch('/tools/sandbox-selftest.js').then(r=>r.text()).then(t=>eval(t))"
 *
 * 校验：空数据起步 / 开始 / 停止并弹标签栏 / 面板打开时扇区被拦 / 改标签的时长迁移 /
 *       新增分类 / 切换累计 / 落盘内容完整性
 * 注意：会在页面内清空 tt-sandbox-v1 并重来，跑完把页面留在"有记录"状态；
 *       给用户用之前记得用 ?widget=1&sandbox=1&reset=1 或 __sandboxReset() 清空。
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const g = (id) => document.getElementById(id)
  const big = () => g('widget-time').textContent
  const stateText = () => g('widget-state-text').textContent
  const panelOpen = () => !g('widget-tagbar').classList.contains('hidden')
  const segCount = () => document.querySelectorAll('.ring-seg').length
  const ghostCount = () => document.querySelectorAll('.ring-seg.ghost').length
  const sum = (byCat) => Object.values(byCat).reduce((a, b) => a + b, 0)
  const cat = (i) => categories[i]
  const id = (i) => categories[i] && categories[i].id

  const results = {}
  const check = (name, ok, extra) => {
    results[name] = ok === true ? true : (ok === false ? false : { value: ok, ...(extra || {}) })
    console.log((ok === true ? '✓ ' : '✗ ') + name + (extra ? '  ' + JSON.stringify(extra) : ''))
  }

  // ── 0. 归零重来：全新沙盒 = 4 个默认分类、零记录 ────────────────
  try { localStorage.removeItem('tt-sandbox-v1') } catch (e) {}
  enterSandbox()
  await sleep(200)
  check('起步：4 个默认分类', categories.length === 4 && categories.map((c) => c.name).join(',') === '工作,学习,运动,生活', { cats: categories.map((c) => c.name).join(',') })
  check('起步：零记录', sum(todayStats.byCat) === 0 && JSON.stringify(todayStats.byCat) === '{}', { byCat: todayStats.byCat })
  check('起步：空闲读数', big() === '00:00' && stateText() === '空闲', { big: big(), state: stateText() })
  check('起步：全部是幽灵扇区', segCount() === 4 && ghostCount() === 4, { seg: segCount(), ghost: ghostCount() })

  // ── 1. 开始计时 ────────────────────────────────────────────────
  await applySectorAction(id(0), { viaWheel: false })
  check('点击扇区开始计时', !!runningEntry && stateText() === '工作', { state: stateText() })
  // 读数每秒才刷一次（tick 在 1s 边界），轮询等它离开 0:00，避免时序假失败
  for (let i = 0; i < 25 && big() === '0:00'; i++) await sleep(200)
  check('大字在走', big() !== '00:00' && big() !== '0:00', { big: big() })

  // ── 2. 再点同一扇区 = 停止 + 弹快速标签栏 ──────────────────────
  await applySectorAction(id(0), { viaWheel: false })
  const secOfWork = todayStats.byCat[id(0)] || 0
  check('停止后回到空闲', !runningEntry && stateText() === '空闲')
  check('停止后弹出快速标签栏', panelOpen())
  check('停止的时长记到该分类', secOfWork >= 1, { 工作: secOfWork })

  // ── 3. 面板打开时，扇区点击被拦（与正式流程一致）────────────────
  await applySectorAction(id(1), { viaWheel: false })
  check('标签栏打开时点扇区无效', !runningEntry, { state: stateText() })

  // ── 4. 改标签：时长从原分类迁到新分类 ─────────────────────────
  await applyQuickTag(id(1))
  check('改标签后标签栏收起', !panelOpen())
  check('时长迁到学习', (todayStats.byCat[id(1)] || 0) >= secOfWork, { byCat: todayStats.byCat })
  check('原分类被扣净', !todayStats.byCat[id(0)], { byCat: todayStats.byCat })

  // ── 5. 新增分类 ────────────────────────────────────────────────
  openWidgetAddPanel()
  g('widget-new-cat-name').value = '写作'
  await saveWidgetCategory()
  check('新增分类成功', categories.length === 5 && categories[4].name === '写作', { cats: categories.map((c) => c.name).join(',') })
  check('新增后面板收起', g('widget-add-panel').classList.contains('hidden'))

  // ── 6. 切换：停旧开新，累计不丢 ────────────────────────────────
  await applySectorAction(id(2), { viaWheel: false })
  await sleep(1100)
  await applySectorAction(id(3), { viaWheel: false })
  check('切换后运行的是生活', !!runningEntry && runningEntry.category_id === id(3), { state: stateText() })
  check('切换不弹标签栏', !panelOpen())
  check('被切走的运动已累计', (todayStats.byCat[id(2)] || 0) >= 1, { byCat: todayStats.byCat })

  // ── 7. 落盘：刷新后要能原样恢复 ────────────────────────────────
  const saved = JSON.parse(localStorage.getItem('tt-sandbox-v1') || 'null')
  check('已写入本机存档', !!saved && saved.v === 1)
  check('存档含全部分类', !!saved && saved.categories.length === 5)
  check('存档含正在计时', !!saved && !!saved.running && saved.running.category_id === id(3), { running: saved && saved.running && saved.running.category_id })
  check('存档含今日累计', !!saved && JSON.stringify(saved.byCat) === JSON.stringify(todayStats.byCat))

  const pass = Object.values(results).filter((v) => v === true).length
  const fail = Object.values(results).filter((v) => v === false).length
  console.log(`── 沙盒自测：通过 ${pass} 项，失败 ${fail} 项 ──`)
  return { pass, fail, results }
})()
