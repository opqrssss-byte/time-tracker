/* ============================================================================
   网页端 · 空间模型数据层（配对码 / 设备令牌 / rpc 数据面）
   ----------------------------------------------------------------------------
   背景：设备没有会话就拿不到 auth.uid()，RLS 会拦死 —— 所以**设备侧不能再用
   `from()`，必须走 rpc()**（函数内部用令牌解析出空间 ID）。这是唯一可行路径。

   与既有代码的接法（刻意最小改动）：
     本模块把拉取到的数据写回网页端**原有的全局变量**
     （`categories` / `todayStats` / `runningEntry`），并调用 `onData()` 回调。
     这样渲染层（renderRing / renderCenter / renderCategoryRow…）**一行都不用改** ——
     它们本来就只读这几个全局。

   未绑定（没有令牌）时本模块全程 no-op，网页仍走原来的账号登录路径，
   两套并存、互不干扰，可以分批切换。
   ========================================================================== */
(function (global) {
  'use strict'

  var TOKEN_KEY = 'tt-space-token-v1'

  function lsGet(k) { try { return localStorage.getItem(k) } catch (e) { return null } }
  function lsSet(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k) } catch (e) {} }

  var token = lsGet(TOKEN_KEY) || ''
  var spaceId = lsGet(TOKEN_KEY + '.space') || ''

  /* rpc 返回形状在实现间有差异（值 / [{...}] / 包一层 result），统一拆 */
  function unwrap(data) {
    if (Array.isArray(data)) data = data[0]
    if (data && typeof data === 'object' && data.result !== undefined) data = data.result
    return data
  }

  function call(name, args) {
    return global.cloud.database.rpc(name, args || {}).then(function (res) {
      if (res && res.error) return { ok: false, error: (res.error && res.error.message) || 'rpc_failed' }
      var d = unwrap(res && res.data)
      if (!d || typeof d !== 'object') return { ok: false, error: 'bad_response' }
      return d
    })
  }

  var Repo = {
    get bound() { return !!token },
    get spaceId() { return spaceId },

    /* ---------- 绑定 / 解绑 ---------- */

    /** 一次性迁移：以当前账号身份建空间，把 owner_id=uid 的数据认领进来，发首张令牌 */
    claim: function (deviceName) {
      var self = this
      return call('space_claim', { p_device_name: deviceName || '我的电脑' }).then(function (r) {
        if (r.ok) self._save(r.token, r.space_id)
        return r
      })
    },

    /** 全新空间（没有任何账号数据时用；第一台设备） */
    create: function (deviceName) {
      var self = this
      return call('space_create', { p_device_name: deviceName || '我的电脑' }).then(function (r) {
        if (r.ok) self._save(r.token, r.space_id)
        return r
      })
    },

    /** 输配对码加入已有空间 */
    redeem: function (code, deviceName) {
      var self = this
      return call('pair_redeem', { p_code: String(code || '').trim(), p_device_name: deviceName || '电脑' })
        .then(function (r) {
          if (r.ok) self._save(r.token, r.space_id)
          return r
        })
    },

    unbind: function () {
      var self = this
      if (!token) return Promise.resolve({ ok: true })
      return call('dev_unpair', { p_token: token }).then(function (r) {
        self._save('', '')
        return r
      })
    },

    _save: function (t, s) {
      token = t || ''
      spaceId = s || ''
      lsSet(TOKEN_KEY, token)
      lsSet(TOKEN_KEY + '.space', spaceId)
    },

    /* ---------- 配对码与设备 ---------- */

    makeCode: function (deviceName) {
      return call('pair_create_code', { p_token: token, p_device_name: deviceName || '新设备' })
    },
    devices: function () { return call('pair_list_devices', { p_token: token }) },
    revoke: function (id) { return call('pair_revoke_device', { p_token: token, p_device_id: id }) },

    /* ---------- 数据面 ---------- */

    pull: function () { return call('dev_pull', { p_token: token, p_since: null }) },

    putEntry: function (e) { return call('dev_put_entry', { p_token: token, p_entry: e }) },
    putCategory: function (c) { return call('dev_put_category', { p_token: token, p_cat: c }) },
    delEntry: function (id) { return call('dev_delete_entry', { p_token: token, p_id: id }) },
    delCategory: function (id) { return call('dev_delete_category', { p_token: token, p_id: id }) },

    /** 原子切换：关旧 + 开新在同一次调用里（服务端还会顺手把时长算准，免疫本机时钟偏移） */
    switchTo: function (closeId, categoryId, title, startIso) {
      return call('dev_switch', {
        p_token: token,
        p_close: closeId ? { id: closeId } : null,
        p_open: { category_id: categoryId || null, title: title || '', start_time: startIso || new Date().toISOString() },
      })
    },

    /**
     * 拉取并写回网页端原有的全局变量 —— 渲染层因此一行都不用改。
     * `todayStats` 的口径与原来完全一致：本机 0 点起、只算已结束的段、按 category_id 累加；
     * 正在计时那段不进 byCat，由渲染层用 now-start 单独叠加。
     */
    load: function (onData) {
      if (!token) return Promise.resolve({ ok: false, error: 'not_bound' })
      return this.pull().then(function (r) {
        if (!r.ok) return r
        global.categories = (r.categories || []).slice().sort(function (a, b) {
          return (a.sort_order || 0) - (b.sort_order || 0)
        })
        var entries = r.entries || []
        var start = new Date(); start.setHours(0, 0, 0, 0)
        var from = start.getTime()
        var byCat = {}, latest = {}
        entries.forEach(function (e) {
          if (!e.end_time) return
          if (new Date(e.start_time).getTime() < from) return
          var k = e.category_id || 'none'
          byCat[k] = (byCat[k] || 0) + Math.floor(e.duration_sec || 0)
          if (!latest[k]) latest[k] = (e.title || '').trim()
        })
        global.todayStats = { byCat: byCat, latest: latest }
        global.runningEntry = entries.filter(function (e) { return !e.end_time })[0] || null
        global.__allEntries = entries          // 历史页/统计页可直接用
        if (typeof onData === 'function') onData()
        return r
      })
    },
  }

  global.Repo = Repo
})(window)
