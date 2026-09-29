const { cloud } = require('../../utils/cloud')

Page({
  data: {
    mode: 'otp',
    email: '',
    code: '',
    password: '',
    needPassword: false,
    codeSent: false,
    sending: false,
    countdown: 0,
    errorMsg: '',
  },

  onShow() {
    // 已登录直接进入
    cloud.auth.getSession().then(({ data: session }) => {
      if (session) wx.switchTab({ url: '/pages/timer/timer' })
    })
  },

  switchMode(e) {
    this.setData({ mode: e.currentTarget.dataset.mode, errorMsg: '' })
  },
  onEmailInput(e) { this.setData({ email: e.detail.value.trim() }) },
  onCodeInput(e) { this.setData({ code: e.detail.value.trim() }) },
  onPasswordInput(e) { this.setData({ password: e.detail.value }) },

  startCountdown() {
    this.setData({ countdown: 60 })
    this._timer = setInterval(() => {
      const left = this.data.countdown - 1
      this.setData({ countdown: left })
      if (left <= 0) clearInterval(this._timer)
    }, 1000)
  },

  async sendCode() {
    const { email } = this.data
    if (!email) { this.setData({ errorMsg: '请先输入邮箱地址' }); return }
    this.setData({ sending: true, errorMsg: '' })
    const sent = await cloud.auth.sendOtp({ email })
    this.setData({ sending: false })
    if (sent.error) {
      this.setData({ errorMsg: sent.error.message || '验证码发送失败，请稍后重试' })
      return
    }
    this._pending = {
      email,
      verificationId: sent.data.verificationId,
      isExistingUser: sent.data.isExistingUser,
    }
    this.setData({
      codeSent: true,
      needPassword: !sent.data.isExistingUser,
    })
    wx.showToast({ title: '验证码已发送', icon: 'success' })
    this.startCountdown()
  },

  async submitOtp() {
    const { email, code, password } = this.data
    const pending = this._pending
    if (!pending || pending.email !== email) {
      this.setData({ errorMsg: '请先获取当前邮箱的验证码' }); return
    }
    if (!code) { this.setData({ errorMsg: '请输入验证码' }); return }
    if (!pending.isExistingUser && password.length < 6) {
      this.setData({ errorMsg: '首次登录请设置至少 6 位密码' }); return
    }
    this.setData({ errorMsg: '' })
    const completed = await cloud.auth.verifyOtp({
      email: pending.email,
      verificationId: pending.verificationId,
      isExistingUser: pending.isExistingUser,
      token: code,
      password: pending.isExistingUser ? undefined : password,
    })
    if (completed.error) {
      this.setData({ errorMsg: completed.error.message || '验证码错误或已过期' })
      return
    }
    this._pending = null
    wx.switchTab({ url: '/pages/timer/timer' })
  },

  async submitPassword() {
    const { email, password } = this.data
    if (!email || !password) { this.setData({ errorMsg: '请输入邮箱和密码' }); return }
    this.setData({ errorMsg: '' })
    const { error } = await cloud.auth.signInWithPassword({ email, password })
    if (error) { this.setData({ errorMsg: '账号或密码错误' }); return }
    wx.switchTab({ url: '/pages/timer/timer' })
  },

  onUnload() { if (this._timer) clearInterval(this._timer) },
  onHide() { if (this._timer) clearInterval(this._timer) },
})
