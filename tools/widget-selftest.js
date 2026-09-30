/* 组件自测脚本 —— 供 ?widget=1&demo=1 页面内 eval 执行
 *
 * 用法（详见 docs/SETUP-NEW-MACHINE.md §3）：
 *   python -m http.server 8899 --directory web
 *   playwright-cli open "http://localhost:8899/index.html?widget=1&demo=1"
 *   playwright-cli resize 260 380          # 必须用真实窗口尺寸
 *   playwright-cli eval "fetch('/tools/widget-selftest.js').then(r=>r.text()).then(t=>eval(t))"
 *
 * 覆盖：滚轮选中/停顿自动确认/切换/循环回绕/同分类不误停/Esc 取消/面板禁用滚轮/
 *       新增分类内联错误/成功提示顺序/元素守恒/窗口内不溢出/（可选）点击穿透与拖动 IPC
 * 返回值：{ pass, fail, results: {...} }，同时在 console 打印逐项 ✓/✗
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const plate = document.getElementById('widget-plate')
  const wheel = (dy) => plate.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, deltaMode: 0, bubbles: true, cancelable: true }))
  const esc = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  const move = (x, y) => document.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }))
  const g = (id) => document.getElementById(id)
  const focusedId = () => { const el = document.querySelector('.ring-seg.focused'); return el ? el.getAttribute('data-cat') : null }
  const big = () => g('widget-time').textContent
  const state = () => g('widget-state-text').textContent
  const segCount = () => document.querySelectorAll('.ring-seg').length
  const rect = (id) => { const b = g(id).getBoundingClientRect(); return [Math.round(b.top), Math.round(b.bottom)] }

  const results = {}
  const check = (name, ok, extra) => {
    results[name] = ok === true ? true : (ok === false ? false : { value: ok, ...(extra || {}) })
    console.log((ok === true ? '✓ ' : '✗ ') + name + (extra ? '  ' + JSON.stringify(extra) : ''))
  }

  // ── 1. 滚轮：选中态出现，主读数不被顶掉 ──────────────────────────────
  wheel(120); await sleep(300)
  check('滚轮出现选中态', focusedId() !== null, { focusedId: focusedId() })
  check('选中态中心带 → 前缀', g('widget-hover').textContent.startsWith('→ '), { line: g('widget-hover').textContent })
  check('主读数不受选中影响', big() === '00:00', { big: big() })
  check('确认进度弧已显示', g('widget-ring').querySelector('.ring-confirm').style.display !== 'none')

  // ── 2. 停顿自动确认（空闲 → 开始计时）────────────────────────────────
  const firstCat = state()
  await sleep(1150)
  check('停顿后自动开始计时', big() !== '00:00' && state() !== '空闲', { state: state() })
  check('确认后清除选中态', focusedId() === null)

  // ── 3. 计时中滚动 → 主读数保持计时；停顿 → 切换（不弹标签栏）──────────
  wheel(120); await sleep(300)
  check('计时中主读数仍是计时', big() !== '00:00', { big: big() })
  await sleep(1150)
  check('停顿后完成切换', state() !== firstCat && state() !== '空闲', { from: firstCat, to: state() })
  check('切换不弹快速标签栏', g('widget-tagbar').classList.contains('hidden'))

  // ── 4. 滚到"正在计时的分类"停顿 → 无操作（不误停）────────────────────
  const cur = runningEntry ? (runningEntry.category_id || '__none__') : null
  let steps = 0
  while (focusedId() !== cur && steps < segCount() + 1) { wheel(120); await sleep(200); steps++ }
  const before = state()
  await sleep(1150)
  check('滚到运行中分类不误停', big() !== '00:00' && state() === before, { state: state() })

  // ── 5. 循环回绕 ─────────────────────────────────────────────────────
  wheel(120); await sleep(250)
  const start = focusedId()
  for (let i = 0; i < segCount(); i++) { wheel(120); await sleep(200) }
  check('连续滚动可循环回原位', focusedId() === start, { start, end: focusedId() })
  esc(); await sleep(180)
  check('Esc 取消选中', focusedId() === null)

  // ── 6. 新增分类：内联错误 + 成功路径（先收面板再弹提示）─────────────
  g('widget-add-cat').click(); await sleep(300)
  check('新增分类面板可打开', !g('widget-add-panel').classList.contains('hidden'))
  g('btn-widget-cat-save').click(); await sleep(250)
  check('空名给出内联错误', !g('widget-add-error').classList.contains('hidden') && g('widget-add-error').textContent.length > 0, { msg: g('widget-add-error').textContent })
  const input = g('widget-new-cat-name')
  input.value = '自测分类'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  check('重新输入即清除错误', g('widget-add-error').classList.contains('hidden'))
  const catsBefore = categories.length
  g('btn-widget-cat-save').click(); await sleep(400)
  check('添加成功后面板收起', g('widget-add-panel').classList.contains('hidden'))
  check('添加成功后提示条可见', !g('toast').classList.contains('hidden'), { text: g('toast').textContent })
  check('分类数 +1', categories.length === catsBefore + 1, { before: catsBefore, after: categories.length })
  esc(); g('toast').classList.add('hidden'); await sleep(150)

  // ── 7. 面板打开时滚轮被禁用 ─────────────────────────────────────────
  openOthersPanel(); await sleep(300)
  wheel(120); await sleep(250)
  check('面板打开时滚轮禁用', focusedId() === null)
  esc(); await sleep(200)

  // ── 8. 布局：所有可见元素都在窗口内 ────────────────────────────────
  const H = window.innerHeight, W = window.innerWidth
  const overflow = []
  document.querySelectorAll('#view-widget, #view-widget *').forEach((el) => {
    const b = el.getBoundingClientRect()
    if (b.width && b.height && (b.bottom > H + 1 || b.right > W + 1)) overflow.push((el.id || el.className || el.tagName) + `(${Math.round(b.bottom)},${Math.round(b.right)})`)
  })
  check('窗口内无元素溢出', overflow.length === 0, { overflow: overflow.slice(0, 5) })

  // ── 9. 元素守恒（未因新交互误增/重建）───────────────────────────────
  const n1 = segCount()
  await sleep(1200)
  check('扇区元素数稳定', segCount() === n1, { n: n1 })

  // ── 10.（可选）点击穿透与拖动 IPC —— 需注入 mock/真实 electronAPI ──
  const api = window.electronAPI
  if (api && api.ignoreMouse && Array.isArray(window.__ipc)) {
    window.__ipc.length = 0
    const pb = plate.getBoundingClientRect()
    move(pb.left + pb.width / 2, pb.top + pb.height / 2)
    check('指针在圆盘上 → 关闭穿透', JSON.stringify(window.__ipc).includes('false'), { ipc: window.__ipc.slice() })
    window.__ipc.length = 0
    move(2, H - 2)
    check('指针在透明区 → 开启穿透', JSON.stringify(window.__ipc).includes('true'))
    window.__ipc.length = 0
    plate.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, screenX: 100, screenY: 100 }))
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    check('按下/松开触发拖动 IPC', window.__ipc.some((x) => x[0] === 'dragStart') && window.__ipc.some((x) => x[0] === 'dragEnd'), { ipc: window.__ipc.slice() })
  } else {
    console.log('· 跳过穿透/拖动检查（未注入 mock electronAPI）')
  }

  const pass = Object.values(results).filter((v) => v === true).length
  const fail = Object.values(results).filter((v) => v === false).length
  console.log(`── 自测结果：通过 ${pass} 项，失败 ${fail} 项 ──`)
  return { pass, fail, results }
})()
