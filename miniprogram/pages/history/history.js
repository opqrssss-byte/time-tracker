const { cloud } = require('../../utils/cloud')
const { fmtClock, fmtDurMin, dateLabel, ensureSession } = require('../../utils/util')

Page({
  data: { groups: [] },

  async onShow() {
    const session = await ensureSession()
    if (!session) return
    await this.load()
  },

  async load() {
    const [cats, entries] = await Promise.all([
      cloud.database.from('categories').select('*'),
      cloud.database.from('time_entries').select('*')
        .not('end_time', 'is', null)
        .order('start_time', { ascending: false }).limit(100),
    ])
    if (entries.error) { wx.showToast({ title: '记录加载失败', icon: 'none' }); return }
    const catMap = {}
    ;(cats.data || []).forEach((c) => { catMap[c.id] = c })

    const groups = []
    let current = null
    ;(entries.data || []).forEach((en) => {
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
      success: async (res) => {
        if (!res.confirm) return
        const { data, error } = await cloud.database
          .from('time_entries').delete().eq('id', id).select()
        if (error || !data || data.length === 0) {
          wx.showToast({ title: '删除失败', icon: 'none' })
          return
        }
        wx.showToast({ title: '已删除', icon: 'success' })
        this.load()
      },
    })
  },
})
