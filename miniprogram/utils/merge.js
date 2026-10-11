/* ============================================================================
   合并：本机 ⊕ 空间 → 新状态 + 需要回推的 ops
   ----------------------------------------------------------------------------
   纯函数，零依赖（不 require wx、不 require store），可以在 Node 里直接单测。
   必须**幂等**：重复配对/重复合并不能产生重复数据。

   规则（用户拍板"本机记录并入"）：
     1. 分类按 name 去重 —— 两侧都种子过「工作/学习/运动/生活」时不重复
     2. 条目按 id 合并（uuid 天然不撞）；同 id 用 updated_at 较新者胜
     3. 合并后"进行中"最多一条 —— start_time 最晚者胜，其余在它开始处封口
     4. end_time 有而 duration_sec 缺的，按时间差补上
   ========================================================================== */

const ts = (v) => (v ? new Date(v).getTime() : 0)
const secs = (a, b) => Math.max(1, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000))
const uniq = (a) => Array.from(new Set(a))

function mergeStates(local, remote) {
  const L = local || {}
  const R = remote || {}
  const cats = (R.categories || []).map((c) => Object.assign({}, c))
  const ents = (R.entries || []).map((e) => Object.assign({}, e))
  const opCats = []
  const opEnts = []

  /* 1. 分类：按 name 去重。同名 → 本机那条丢弃，并把引用重映射到远端 id；
        不同名 → 保留本机 id（uuid 不撞）并回推。 */
  const byName = new Map()
  cats.forEach((c) => byName.set(c.name, c.id))
  const remap = new Map()
  ;(L.categories || []).forEach((c) => {
    const hit = byName.get(c.name)
    if (hit) {
      remap.set(c.id, hit)
    } else {
      const copy = Object.assign({}, c)
      remap.set(c.id, c.id)
      byName.set(c.name, c.id)
      cats.push(copy)
      opCats.push(copy.id)
    }
  })

  /* 2. 条目：按 id 合并，同 id 用 updated_at 新的胜（LWW） */
  const byId = new Map()
  ents.forEach((e) => byId.set(e.id, e))
  ;(L.entries || []).forEach((e) => {
    const copy = Object.assign({}, e)
    if (copy.category_id) copy.category_id = remap.get(copy.category_id) || copy.category_id
    const hit = byId.get(copy.id)
    if (!hit) {
      byId.set(copy.id, copy)
      ents.push(copy)
      opEnts.push(copy.id)
    } else if (ts(copy.updated_at) > ts(hit.updated_at)) {
      Object.assign(hit, copy)
      opEnts.push(hit.id)
    }
  })

  /* 3. 进行中最多一条（对齐云端 (owner_id) WHERE end_time IS NULL 的唯一部分索引） */
  const running = ents.filter((e) => !e.end_time).sort((a, b) => ts(b.start_time) - ts(a.start_time))
  if (running.length > 1) {
    const keep = running[0]
    running.slice(1).forEach((e) => {
      e.end_time = keep.start_time
      e.duration_sec = secs(e.start_time, keep.start_time)
      e.updated_at = keep.start_time
      opEnts.push(e.id)
    })
  }

  /* 4. duration_sec 回填 */
  ents.forEach((e) => {
    if (e.end_time && (!e.duration_sec || !isFinite(e.duration_sec))) {
      e.duration_sec = secs(e.start_time, e.end_time)
      opEnts.push(e.id)
    }
  })

  return {
    state: { categories: cats, entries: ents },
    ops: { categoryIds: uniq(opCats), entryIds: uniq(opEnts) },
  }
}

/** 从合并后的状态里取出要回推的对象（供 sync.pushOps 用） */
function pickOps(mergedState, ops) {
  const cats = (mergedState.categories || []).filter((c) => ops.categoryIds.indexOf(c.id) >= 0)
  const ents = (mergedState.entries || []).filter((e) => ops.entryIds.indexOf(e.id) >= 0)
  return { categories: cats, entries: ents }
}

const isEmptyOps = (ops) => (!ops || ((ops.categoryIds || []).length === 0 && (ops.entryIds || []).length === 0))

module.exports = { mergeStates, pickOps, isEmptyOps }
