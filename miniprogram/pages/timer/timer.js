const { cloud } = require('../../utils/cloud')
const { fmtHMS, fmtClock, ensureSession } = require('../../utils/util')

const DEFAULT_CATEGORIES = [
  { name: '工作', color: '#4F8CFF', sort_order: 1 },
  { name: '学习', color: '#9B6DFF', sort_order: 2 },
  { name: '运动', color: '#2FBF71', sort_order: 3 },
  { name: '生活', color: '#F2A93B', sort_order: 4 },
]

Page({
  data: {
    elapsedText: '00:00:00',
    running: false,
    runningSince: '',
    title: '',
    categories: [],
    selectedCategoryId: null,
    showTagPanel: false,
    tagPanelInfo: '',
  },

  async onShow() {
    const session = await ensureSession()
    if (!session) return
    await this.loadCategories()
    await this.refreshRunning()
    this.startTicker()
    this.startPolling()
  },

  onHide() { this.clearTimers() },
  onUnload() { this.clearTimers() },

  clearTimers() {
    if (this._ticker) { clearInterval(this._ticker); this._ticker = null }
    if (this._poll) { clearInterval(this._poll); this._poll = null }
  },

  startTicker() {
    if (this._ticker) clearInterval(this._ticker)
    this._ticker = setInterval(() => this.updateElapsed(), 1000)
  },

  startPolling() {
    if (this._poll) clearInterval(this._poll)
    this._poll = setInterval(() => this.refreshRunning(), 30000)
  },

  async loadCategories() {
    let { data, error } = await cloud.database
      .from('categories').select('*').order('sort_order', { ascending: true })
    if (error) { wx.showToast({ title: '分类加载失败', icon: 'none' }); return }
    if (!data || data.length === 0) {
      const seeded = await cloud.database.from('categories').insert(DEFAULT_CATEGORIES).select()
      if (!seeded.error && seeded.data && seeded.data.length) data = seeded.data
    }
    this.setData({ categories: data || [] })
  },

  async refreshRunning() {
    const { data, error } = await cloud.database
      .from('time_entries').select('*').is('end_time', null).maybeSingle()
    if (error) return
    const wasRunning = this.data.running
    this._runningEntry = data || null
    if (this._runningEntry) {
      this.setData({
        running: true,
        runningSince: fmtClock(this._runningEntry.start_time),
        title: this._runningEntry.title || '',
        selectedCategoryId: this._runningEntry.category_id,
      })
      this.updateElapsed()
    } else {
      if (wasRunning) wx.showToast({ title: '计时已在其他设备停止', icon: 'none' })
      this.setData({ running: false, elapsedText: '00:00:00', title: '', selectedCategoryId: null })
    }
  },

  updateElapsed() {
    if (!this._runningEntry) return
    const sec = (Date.now() - new Date(this._runningEntry.start_time).getTime()) / 1000
    this.setData({ elapsedText: fmtHMS(sec) })
  },

  onTitleInput(e) { this.setData({ title: e.detail.value }) },

  onTitleBlur() { this.saveRunningEdits() },

  toggleCategory(e) {
    const id = e.currentTarget.dataset.id
    this.setData({ selectedCategoryId: this.data.selectedCategoryId === id ? null : id })
    if (this._runningEntry) this.saveRunningEdits()
  },

  async saveRunningEdits() {
    const entry = this._runningEntry
    if (!entry) return
    const { title, selectedCategoryId } = this.data
    if (title === (entry.title || '') && selectedCategoryId === entry.category_id) return
    await cloud.database.from('time_entries')
      .update({ title, category_id: selectedCategoryId, updated_at: new Date().toISOString() })
      .eq('id', entry.id)
    entry.title = title
    entry.category_id = selectedCategoryId
  },

  async toggleTimer() {
    if (this._runningEntry) await this.stopTimer()
    else await this.startTimer()
  },

  async startTimer() {
    await this.refreshRunning()
    if (this._runningEntry) {
      wx.showToast({ title: '已有一段计时在进行中', icon: 'none' })
      return
    }
    const { data, error } = await cloud.database.from('time_entries')
      .insert({
        title: this.data.title.trim(),
        category_id: this.data.selectedCategoryId,
        start_time: new Date().toISOString(),
      })
      .select()
    if (error) {
      if (error.code === '23505') {
        wx.showToast({ title: '另一台设备正在计时', icon: 'none' })
        await this.refreshRunning()
      } else {
        wx.showToast({ title: '开始失败，请重试', icon: 'none' })
      }
      return
    }
    this._runningEntry = data && data[0]
    this.setData({
      running: true,
      runningSince: fmtClock(this._runningEntry.start_time),
    })
    this.updateElapsed()
    wx.showToast({ title: '计时开始', icon: 'success' })
  },

  async stopTimer() {
    const entry = this._runningEntry
    if (!entry) return
    const end = new Date()
    const dur = Math.max(1, Math.round((end.getTime() - new Date(entry.start_time).getTime()) / 1000))
    const { data, error } = await cloud.database.from('time_entries')
      .update({
        title: this.data.title.trim(),
        category_id: this.data.selectedCategoryId,
        end_time: end.toISOString(),
        duration_sec: dur,
        updated_at: end.toISOString(),
      })
      .eq('id', entry.id)
      .select()
    if (error || !data || data.length === 0) {
      wx.showToast({ title: '停止失败，请重试', icon: 'none' })
      await this.refreshRunning()
      return
    }
    const saved = data[0]
    this._runningEntry = null
    this.setData({ running: false, elapsedText: '00:00:00', title: '', selectedCategoryId: null })
    wx.showToast({ title: '已记录', icon: 'success' })
    // 快速标签流程：停止后立即弹出分类选择
    const { fmtDurMin } = require('../../utils/util')
    this._tagEntry = saved
    this.setData({
      showTagPanel: true,
      tagPanelInfo: `${fmtClock(saved.start_time)} - ${fmtClock(saved.end_time)} · ${fmtDurMin(saved.duration_sec)}`,
    })
  },

  async applyTag(e) {
    const categoryId = e.currentTarget.dataset.id
    const entry = this._tagEntry
    this.setData({ showTagPanel: false })
    this._tagEntry = null
    if (!entry) return
    const { data, error } = await cloud.database.from('time_entries')
      .update({ category_id: categoryId, updated_at: new Date().toISOString() })
      .eq('id', entry.id).select()
    if (error || !data || data.length === 0) {
      wx.showToast({ title: '标签保存失败，可在记录页修改', icon: 'none' })
      return
    }
    wx.showToast({ title: '已标记', icon: 'success' })
  },

  skipTag() {
    this.setData({ showTagPanel: false })
    this._tagEntry = null
  },
})
