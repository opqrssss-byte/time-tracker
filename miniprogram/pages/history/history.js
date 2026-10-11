const { fmtClock, fmtDurMin, dateLabel } = require('../../utils/util')
const store = require('../../utils/store')
const sync = require('../../utils/sync')

Page({
  data: { groups: [] },

  /* 免登录：**没有登录守卫**，数据全部来自本机 store。
     配对过的话 sync 会把远端差异对齐过来（merge 顺带把本机缺的推上去）。 */
  async onShow() {
    await store.ready()
    this.load()
    sync.syncSoon(0)
    if (!this._unsub) this._unsub = store.subscribe(() => this.load())
  },

  onUnload() {
    if (this._unsub) { this._unsub(); this._unsub = null }
  },

  load() {
    const catMap = {}
    store.getCategories().forEach((c) => { catMap[c.id] = c })
    const entries = store.getEntries()
      .filter((en) => en.end_time)                                 // 只列已结束的段
      .sort((a, b) => new Date(b.start_time) - new Date(a.start_time))
      .slice(0, 100)

    const groups = []
    let current = null
    entries.forEach((en) => {
      const label = dateLabel(en.start_time)
      if (!current || current.label !== label) {
        current = { label, items: [] }
        groups.push(current)
      }
      const cat = catMap[en.category_id]
      current.items.push({
        id: en.id,
        title: en.title,
        categoryColor: cat ? cat.color : '',
        rangeText: `${fmtClock(en.start_time)} - ${fmtClock(en.end_time)}`,
        durationText: fmtDurMin(en.duration_sec),
      })
    })
    this.setData({ groups })
  },

  deleteEntry(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删除记录',
      content: '确定删除这段记录吗？',
      confirmColor: '#FF5A5A',
      success: (res) => {
        if (!res.confirm) return
        const r = store.deleteEntry(id)
        if (!r.ok) { wx.showToast({ title: '删除失败', icon: 'none' }); return }
        wx.showToast({ title: '已删除', icon: 'success' })
        this.load()
        /* ⚠️ 本轮**不做删除的跨端同步**（需要墓碑标记，见下一步）。
           所以配对状态下本机删掉的记录，下次 pull 会被远端"复活"。 */
        sync.syncSoon()
      },
    })
  },
})
