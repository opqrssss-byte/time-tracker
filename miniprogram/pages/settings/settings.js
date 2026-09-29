const { cloud } = require('../../utils/cloud')
const { ensureSession } = require('../../utils/util')

Page({
  data: {
    categories: [],
    newCatName: '',
    newCatColor: '#4F8CFF',
    presetColors: ['#4F8CFF', '#9B6DFF', '#2FBF71', '#F2A93B', '#FF5A5A', '#8a91a3'],
    userEmail: '',
  },

  async onShow() {
    const session = await ensureSession()
    if (!session) return
    const email = session.user && session.user.email
    this.setData({ userEmail: email ? `当前账号：${email}` : '' })
    await this.loadCategories()
  },

  async loadCategories() {
    const { data, error } = await cloud.database
      .from('categories').select('*').order('sort_order', { ascending: true })
    if (error) { wx.showToast({ title: '分类加载失败', icon: 'none' }); return }
    this.setData({ categories: data || [] })
  },

  onNewCatName(e) { this.setData({ newCatName: e.detail.value }) },
  pickColor(e) { this.setData({ newCatColor: e.currentTarget.dataset.color }) },

  async addCategory() {
    const name = this.data.newCatName.trim()
    if (!name) { wx.showToast({ title: '请输入分类名称', icon: 'none' }); return }
    const maxSort = this.data.categories.reduce((m, c) => Math.max(m, c.sort_order || 0), 0)
    const { error } = await cloud.database.from('categories')
      .insert({ name, color: this.data.newCatColor, sort_order: maxSort + 1 }).select()
    if (error) {
      wx.showToast({ title: error.code === '23505' ? '同名分类已存在' : '添加失败', icon: 'none' })
      return
    }
    this.setData({ newCatName: '' })
    wx.showToast({ title: '已添加', icon: 'success' })
    this.loadCategories()
  },

  deleteCategory(e) {
    const { id, name } = e.currentTarget.dataset
    wx.showModal({
      title: '删除分类',
      content: `删除分类「${name}」？该分类下的记录会保留但变为未分类。`,
      confirmColor: '#FF5A5A',
      success: async (res) => {
        if (!res.confirm) return
        const { data, error } = await cloud.database
          .from('categories').delete().eq('id', id).select()
        if (error || !data || data.length === 0) {
          wx.showToast({ title: '删除失败', icon: 'none' })
          return
        }
        wx.showToast({ title: '已删除', icon: 'success' })
        this.loadCategories()
      },
    })
  },

  async signOut() {
    await cloud.auth.signOut()
    wx.redirectTo({ url: '/pages/login/login' })
  },
})
