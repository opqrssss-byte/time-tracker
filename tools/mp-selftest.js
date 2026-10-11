/* ============================================================================
   小程序本机层冒烟测试（Node 里跑，不需要微信开发者工具）
   ----------------------------------------------------------------------------
   跑法：node tools/mp-selftest.js
   覆盖：store 的首启种子/切换不变量/今日口径/删除与重名，以及 merge 的
        **幂等性**、分类重名重映射、两条进行中的裁决、duration 回填。
   ========================================================================== */
const path = require('path')
const ROOT = path.join(__dirname, '..', 'miniprogram')

let pass = 0, fail = 0
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log('✓ ' + name) }
  else { fail++; console.log('✗ ' + name + '  ' + JSON.stringify(extra)) }
}

/* ---- wx 桩：内存版本地存储 ---- */
const mem = {}
global.wx = {
  getStorageSync: (k) => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)) },
  removeStorageSync: (k) => { delete mem[k] },
}

/* 只清模块缓存（模拟"重新打开小程序"），本地存储保留 */
const reload = () => {
  delete require.cache[require.resolve(path.join(ROOT, 'utils/store.js'))]
  return require(path.join(ROOT, 'utils/store.js'))
}
/* 连存储一起清（模拟"全新安装"） */
const fresh = () => { Object.keys(mem).forEach((k) => delete mem[k]); return reload() }
const merge = require(path.join(ROOT, 'utils/merge.js'))

const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString()

/* ═══════════════ 一、store ═══════════════ */

;(async () => {
  {
    const store = fresh()
    await store.ready()
    check('首启种子 4 个默认分类', store.getCategories().length === 4 &&
      store.getCategories().map((c) => c.name).join(',') === '工作,学习,运动,生活')
    check('首启没有任何记录在进行', store.getRunning() === null, { run: store.getRunning() })
  }

  {
    const store = fresh()
    await store.ready()
    const [work, study] = store.getCategories()

    const r1 = store.switchTo(work.id)
    check('空闲切换 → 开一条', r1.ok && !r1.closed, { r1 })
    check('恰好一条进行中', store.getEntries().filter((e) => !e.end_time).length === 1)

    const r2 = store.switchTo(study.id)
    const closed = r2.closed
    check('再切 → 关旧开新，仍只有一条进行中',
      r2.ok && !!closed && store.getEntries().filter((e) => !e.end_time).length === 1)
    check('关旧时 end_time **正好等于**新段 start_time（无空档）',
      closed.end_time === r2.entry.start_time, { end: closed.end_time, start: r2.entry.start_time })
    check('关旧时补了 duration_sec', closed.duration_sec >= 1, { d: closed.duration_sec })

    const same = store.switchTo(study.id)
    check('切到"正在计时的那一类" → 拒绝（防误停）', same.ok === false && same.error === 'same')

    store.stopEntry()
    check('停止后没有进行中的段', store.getRunning() === null)
  }

  {
    const store = fresh()
    await store.ready()
    const cats = store.getCategories()

    /* 今日口径：只算已结束、且 start_time 在今日 0 点之后的段 */
    const past = new Date(); past.setDate(past.getDate() - 1)
    store.putEntry({ id: 'old', category_id: cats[0].id, start_time: past.toISOString(),
      end_time: past.toISOString(), duration_sec: 9999, created_at: past.toISOString(), updated_at: past.toISOString() })
    store.putEntry({ id: 'today', category_id: cats[0].id, start_time: iso(60),
      end_time: iso(30), duration_sec: 1800, created_at: iso(60), updated_at: iso(30) })
    const byCat = store.todayByCat()
    check('今日口径：只累计今日已结束的段', byCat[cats[0].id] === 1800, { byCat })
    check('昨日的不计入今日', Object.values(byCat).reduce((a, b) => a + b, 0) === 1800)

    check('分类重名被拒', store.addCategory('工作', '#fff').error === 'duplicate_name')
    check('新增分类成功', store.addCategory('写作', '#F06EAA').ok === true)
    check('分类数变为 5', store.getCategories().length === 5)

    const del = store.deleteCategory(cats[0].id)
    check('删分类后，它名下的记录落成未分类（对齐 ON DELETE SET NULL）',
      del.ok && store.getEntries().find((e) => e.id === 'today').category_id === null,
      { e: store.getEntries().find((e) => e.id === 'today') })

    store.deleteEntry('old')
    check('删除记录生效', !store.getEntries().some((e) => e.id === 'old'))
  }

  /* 跨进程持久化：同一份存储再读一次，数据还在 */
  {
    const store = fresh()
    await store.ready()
    store.addCategory('冥想', '#23B8D5')
    const again = reload()                // 保留存储 → 模拟重新打开
    await again.ready()
    check('落盘可恢复（重新载入后分类还在）', again.getCategories().some((c) => c.name === '冥想'),
      { names: again.getCategories().map((c) => c.name) })
    check('恢复后仍满足"至多一条进行中"',
      again.getEntries().filter((e) => !e.end_time).length <= 1)
  }

  /* ═══════════════ 二、merge ═══════════════ */

  const catA = { id: 'local-a', name: '工作', color: '#4F8CFF', sort_order: 1, created_at: iso(500) }
  const catB = { id: 'local-b', name: '写作', color: '#F06EAA', sort_order: 5, created_at: iso(400) }
  const remote = {
    categories: [
      { id: 'remote-a', name: '工作', color: '#4F8CFF', sort_order: 1, created_at: iso(900) },
      { id: 'remote-c', name: '阅读', color: '#23B8D5', sort_order: 3, created_at: iso(800) },
    ],
    entries: [
      { id: 'e-remote', category_id: 'remote-a', title: '远端段', start_time: iso(300),
        end_time: iso(200), duration_sec: 6000, created_at: iso(300), updated_at: iso(200) },
    ],
  }
  const local = {
    categories: [catA, catB],
    entries: [
      { id: 'e-local', category_id: 'local-b', title: '本机段', start_time: iso(120),
        end_time: iso(60), duration_sec: 3600, created_at: iso(120), updated_at: iso(60) },
      // 引用的是"同名分类"，合并后应被重映射到远端 id
      { id: 'e-remap', category_id: 'local-a', title: '要重映射', start_time: iso(90),
        end_time: iso(80), duration_sec: 600, created_at: iso(90), updated_at: iso(80) },
      // 两台设备各有一条"进行中" → 应保留 start_time 最晚的
      { id: 'e-run-old', category_id: 'local-a', title: '旧的进行中', start_time: iso(40),
        end_time: null, duration_sec: null, created_at: iso(40), updated_at: iso(40) },
      { id: 'e-run-new', category_id: 'local-b', title: '新的进行中', start_time: iso(10),
        end_time: null, duration_sec: null, created_at: iso(10), updated_at: iso(10) },
    ],
  }

  {
    const m1 = merge.mergeStates(local, remote)
    const st = m1.state
    check('合并后分类：同名不重复（工作只有一条）',
      st.categories.filter((c) => c.name === '工作').length === 1,
      { names: st.categories.map((c) => c.name) })
    check('合并后分类：本机独有的（写作）进来了',
      st.categories.some((c) => c.name === '写作'))
    check('本机独有分类进了回推队列', m1.ops.categoryIds.includes('local-b'))

    check('条目：两侧独有的都保留',
      st.entries.some((e) => e.id === 'e-local') && st.entries.some((e) => e.id === 'e-remote'))
    check('重名分类被重映射到远端 id',
      st.entries.find((e) => e.id === 'e-remap').category_id === 'remote-a',
      { got: st.entries.find((e) => e.id === 'e-remap').category_id })

    const running = st.entries.filter((e) => !e.end_time)
    check('两条进行中 → 只留一条', running.length === 1, { n: running.length, ids: running.map((e) => e.id) })
    check('留下的是 start_time 最晚的那条', running[0].id === 'e-run-new', { id: running[0] && running[0].id })
    const closed = st.entries.find((e) => e.id === 'e-run-old')
    check('被裁决掉的那条在胜者开始处封口',
      closed.end_time === running[0].start_time, { end: closed.end_time, start: running[0].start_time })
    check('封口时补了 duration_sec', closed.duration_sec >= 1, { d: closed.duration_sec })

    /* 幂等：把合并结果当输入再合一次（同一份远端），状态必须一模一样 */
    const m2 = merge.mergeStates(m1.state, remote)
    const same = JSON.stringify(m2.state.categories.map((c) => c.id).sort()) ===
                 JSON.stringify(st.categories.map((c) => c.id).sort()) &&
                 JSON.stringify(m2.state.entries.map((e) => [e.id, e.end_time, e.duration_sec]).sort()) ===
                 JSON.stringify(st.entries.map((e) => [e.id, e.end_time, e.duration_sec]).sort())
    check('合并幂等：再合一次状态完全不变', same)

    /* 真的把两边的数据都回推给远端后，第二次合并的 ops 应为空 */
    const pushed = {
      categories: st.categories,
      entries: st.entries,
    }
    const m3 = merge.mergeStates(pushed, pushed)
    check('数据已同步到两边后，再无待回推项', merge.isEmptyOps(m3.ops), { ops: m3.ops })
  }

  {
    /* duration 回填 */
    const r = merge.mergeStates({ categories: [], entries: [] }, {
      categories: [],
      entries: [{ id: 'x', start_time: '2026-10-11T10:00:00.000Z', end_time: '2026-10-11T10:05:00.000Z',
        duration_sec: null, created_at: '2026-10-11T10:00:00.000Z', updated_at: '2026-10-11T10:05:00.000Z' }],
    })
    check('缺 duration_sec 的段被补齐（5 分钟 = 300 秒）',
      r.state.entries[0].duration_sec === 300, { d: r.state.entries[0].duration_sec })
    check('补齐项进了回推队列', r.ops.entryIds.includes('x'))
  }

  {
    /* 空数据不炸 */
    const r = merge.mergeStates(null, null)
    check('空输入安全', r.state.categories.length === 0 && merge.isEmptyOps(r.ops))
  }

  console.log(`\n── 小程序本机层冒烟：通过 ${pass}，失败 ${fail} ──`)
  process.exit(fail ? 1 : 0)
})()
