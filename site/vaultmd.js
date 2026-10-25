/* ============================================================
 * VaultMD — 时间记录 → Obsidian 日记渲染器
 * 纯函数：无 DOM、无 IO、无状态。
 * 与 gsync.js 是两条独立管道：那边产纯文本喂 NotebookLM，
 * 这边产带 frontmatter 与双链的 Markdown 给人看。
 * ============================================================ */
const VaultMD = (() => {
  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const NOTE_DIR = '日记'
  const STUB_DIR = '笔记'

  const pad = (n) => String(n).padStart(2, '0')

  /* 本地日期键。绝不能用 toISOString：那是 UTC，东八区凌晨会串到前一天 */
  function dayOf(iso) {
    const d = new Date(iso)
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }

  function weekdayOf(iso) {
    return WEEKDAYS[new Date(iso).getDay()]
  }

  function clockOf(iso) {
    const d = new Date(iso)
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  function durText(sec) {
    if (sec == null || Number.isNaN(sec)) return ''
    const s = Math.round(Number(sec))
    if (s < 60) return `${s}秒`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}分钟`
    return `${Math.floor(m / 60)}小时${m % 60 ? (m % 60) + '分' : ''}`
  }

  /* 分类名既要当文件名，又要当双链文本，两边必须用同一套清洗规则，
     否则日记里的 [[xxx]] 会链不到笔记/xxx.md */
  function safeName(name) {
    const s = String(name == null ? '' : name)
      .replace(/[\\/:*?"<>|#^[\]]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
    return s || '未命名'
  }

  function pathForDay(day) { return `${NOTE_DIR}/${day}.md` }
  function pathForStub(name) { return `${STUB_DIR}/${safeName(name)}.md` }

  /* 结束时间标签：跨天补「次日」前缀 */
  function endLabel(e) {
    if (!e.end_time) return '…'
    const sameDay = dayOf(e.start_time) === dayOf(e.end_time)
    return (sameDay ? '' : '次日 ') + clockOf(e.end_time)
  }

  /* 按天分组。
     入参可能来自任意顺序（现有 fetchSyncData 是 start_time 倒序），
     这里显式升序排序，绝不依赖调用方顺序 */
  function groupByDay(entries) {
    const sorted = (entries || [])
      .filter((e) => e && e.start_time)
      .slice()
      .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))

    const map = new Map()
    sorted.forEach((e) => {
      const day = dayOf(e.start_time)
      if (!map.has(day)) {
        map.set(day, {
          day,
          weekday: weekdayOf(e.start_time),
          items: [],
          totalSec: 0,
          catTotals: new Map(),
        })
      }
      const g = map.get(day)
      g.items.push(e)
      const sec = Number(e.duration_sec) || 0
      g.totalSec += sec
      const key = e.category_id || '__none__'
      const ct = g.catTotals.get(key) || { sec: 0, count: 0 }
      ct.sec += sec
      ct.count += 1
      g.catTotals.set(key, ct)
    })

    return Array.from(map.values())
  }

  function buildDailyNote(group, categories) {
    const catMap = {}
    ;(categories || []).forEach((c) => { catMap[c.id] = c.name })

    const lines = []
    lines.push('---')
    lines.push(`created: ${group.day}`)
    lines.push('tags: [日记, 时间日志]')
    lines.push(`date: ${group.day}`)
    lines.push(`weekday: ${group.weekday}`)
    lines.push(`records: ${group.items.length}`)
    lines.push(`total_minutes: ${Math.round(group.totalSec / 60)}`)
    lines.push('source: buddy小屋')
    lines.push('---')
    lines.push('')
    lines.push(`# ${group.day} ${group.weekday}`)
    lines.push('')
    lines.push('> [!warning] 自动生成，勿手改')
    lines.push('> 本文件由「时间追踪」按云端记录全量重写，手动修改会在下次同步时丢失。')
    lines.push('')
    lines.push('## 概览')
    lines.push('')
    lines.push(`**${durText(group.totalSec)}** · ${group.items.length} 条记录`)
    lines.push('')

    const cats = Array.from(group.catTotals.entries())
      .map(([key, v]) => ({
        name: key === '__none__' ? null : (catMap[key] || key),
        sec: v.sec,
        count: v.count,
      }))
      .sort((a, b) => b.sec - a.sec)

    cats.forEach((c) => {
      const label = c.name ? `[[${safeName(c.name)}]]` : '未分类'
      lines.push(`- ${label} — ${durText(c.sec)}（${c.count} 条）`)
    })

    lines.push('')
    lines.push('## 明细')
    lines.push('')

    group.items.forEach((e) => {
      const cat = e.category_id ? catMap[e.category_id] : null
      const catLabel = cat ? `[[${safeName(cat)}]]` : '未分类'
      const title = (e.title || '').trim()
      const parts = [`\`${clockOf(e.start_time)}–${endLabel(e)}\``, catLabel]
      if (title) parts.push(title)
      parts.push(durText(Number(e.duration_sec) || 0))
      lines.push('- ' + parts.join(' · '))

      const note = (e.note || '').trim()
      if (note) {
        note.split(/\r?\n/).forEach((ln) => {
          if (ln.trim()) lines.push('  - ' + ln.trim())
        })
      }
    })

    lines.push('')
    return lines.join('\n')
  }

  function buildCategoryStub(name, createdDay) {
    const n = safeName(name)
    return [
      '---',
      `created: ${createdDay}`,
      'tags: [分类]',
      '---',
      '',
      `# ${n}`,
      '',
      `「时间追踪」日记里 \`[[${n}]]\` 这个双链的落点。反向链接面板里能看到所有引用本分类的日记。`,
      '',
    ].join('\n')
  }

  return {
    groupByDay,
    buildDailyNote,
    buildCategoryStub,
    pathForDay,
    pathForStub,
    safeName,
    durText,
    clockOf,
    dayOf,
    weekdayOf,
  }
})()
