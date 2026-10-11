const store = require('../../utils/store')
const sync = require('../../utils/sync')

Page({
  data: {
    categories: [],
    newCatName: '',
    newCatColor: '#4F8CFF',
    presetColors: ['#4F8CFF', '#9B6DFF', '#2FBF71', '#F2A93B', '#FF5A5A', '#8a91a3'],
    // 同步状态
    mode: 'local',                 // 'local' 本机模式 / 'paired' 已连接
    modeText: '本机模式 · 数据只在这台手机',
    pairCode: '',
    pairing: false,
  },

  /* 免登录：**没有登录守卫**。本机模式是默认路径，配对是可选增强。 */
  async onShow() {
    await store.ready()
    this.refresh()
    if (!this._unsub) this._unsub = store.subscribe(() => this.refresh())
    if (!this._modeUnsub) this._modeUnsub = store.onModeChange(() => this.refresh())
    sync.syncSoon(0)
  },

  onUnload() {
    if (this._unsub) { this._unsub(); this._unsub = null }
    if (this._modeUnsub) { this._modeUnsub(); this._modeUnsub = null }
  },

  refresh() {
    const paired = sync.isPaired()
    this.setData({
      categories: store.getCategories(),
      mode: paired ? 'paired' : 'local',
      modeText: paired ? '已连接 · 与你的其他设备自动同步' : '本机模式 · 数据只在这台手机',
    })
  },

  onNewCatName(e) { this.setData({ newCatName: e.detail.value }) },
  pickColor(e) { this.setData({ newCatColor: e.currentTarget.dataset.color }) },

  addCategory() {
    const name = this.data.newCatName.trim()
    if (!name) { wx.showToast({ title: '请输入分类名称', icon: 'none' }); return }
    const r = store.addCategory(name, this.data.newCatColor)
    if (!r.ok) {
      wx.showToast({ title: r.error === 'duplicate_name' ? '同名分类已存在' : '添加失败', icon: 'none' })
      return
    }
    this.setData({ newCatName: '' })
    wx.showToast({ title: '已添加', icon: 'success' })
    this.refresh()
    sync.syncSoon()
  },

  deleteCategory(e) {
    const { id, name } = e.currentTarget.dataset
    wx.showModal({
      title: '删除分类',
      content: `删除分类「${name}」？该分类下的记录会保留但变为未分类。`,
      confirmColor: '#FF5A5A',
      success: (res) => {
        if (!res.confirm) return
        if (!store.deleteCategory(id).ok) { wx.showToast({ title: '删除失败', icon: 'none' }); return }
        wx.showToast({ title: '已删除', icon: 'success' })
        this.refresh()
        sync.syncSoon()
      },
    })
  },

  /* ---------- 配对 ---------- */

  onPairCode(e) { this.setData({ pairCode: e.detail.value }) },

  async doPair() {
    const code = String(this.data.pairCode || '').trim()
    if (!/^[0-9]{6}$/.test(code)) {
      wx.showToast({ title: '请输入 6 位数字配对码', icon: 'none' })
      return
    }
    this.setData({ pairing: true })
    wx.showLoading({ title: '配对中', mask: true })
    const r = await sync.redeem(code, '手机')
    wx.hideLoading()
    this.setData({ pairing: false })
    if (!r.ok) {
      const MSG = {
        invalid: '配对码不对，或已经过期／用过了',
        expired: '配对码过期了，请在电脑上重新生成',
        rate_limited: '尝试太频繁，等一分钟再试',
      }
      wx.showModal({
        title: '配对失败',
        content: MSG[r.error] || '网络异常，请稍后重试',
        showCancel: false,
      })
      return
    }
    this.setData({ pairCode: '' })
    wx.showModal({
      title: '配对成功',
      content: '本机已有的记录已并入，之后会自动同步。',
      showCancel: false,
    })
    this.refresh()
  },

  unpair() {
    wx.showModal({
      title: '断开配对',
      content: '断开后本机数据保留，但不再与其他设备同步。',
      confirmColor: '#FF5A5A',
      success: async (res) => {
        if (!res.confirm) return
        await sync.unpair()
        this.refresh()
        wx.showToast({ title: '已断开', icon: 'success' })
      },
    })
  },

  syncNow() {
    wx.showLoading({ title: '同步中', mask: true })
    sync.sync().then((r) => {
      wx.hideLoading()
      wx.showToast({
        title: r.ok ? `已同步（上传 ${r.pushed || 0} 条）` : '同步失败，请稍后重试',
        icon: 'none',
      })
      this.refresh()
    })
  },
})
