/* ============================================================================
   网页端 · 空间模型数据层（免登录：设备令牌 + rpc 数据面）
   ----------------------------------------------------------------------------
   背景：设备没有账号会话就拿不到 auth.uid()，RLS 会拦死 —— 所以设备侧不能再靠
   `from()` 的会话身份。改为：令牌存本机，读写全部走 rpc（SECURITY DEFINER 函数
   内部用令牌解析出空间 ID）。客户端永远不传身份，**也就没有"登录过期"这回事**。

   与既有代码的接法（刻意把改动面压到最小）：
     **不改调用点**，而是拦截 `cloud.database.from` —— 命中后返回一个**本地镜像垫片**，
     它把链式调用（select/order/eq/is/not/gte/limit/maybeSingle/insert/update/delete）
     翻译成"内存过滤 + rpc 写入"。17 处调用点一行都不用改。

   为什么垫片可行：个人级数据量（几千条），全量拉到内存里过滤完全够；
   写入仍一条条走 rpc，服务端有唯一约束与原子切换兜底。
   ========================================================================== */
(function (global) {
  'use strict'

  var TOKEN_KEY = 'tt-space-token-v1'
  var DEVICE_NAME = '我的电脑'

  function lsGet(k) { try { return localStorage.getItem(k) } catch (e) { return null } }
  function lsSet(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k) } catch (e) {} }

  function uuid() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID()
    var h = '0123456789abcdef', s = ''
    for (var i = 0; i < 36; i++) {
      if (i === 8 || i === 13 || i === 18 || i === 23) s += '-'
      else if (i === 14) s += '4'
      else if (i === 19) s += h[(Math.random() * 4 | 0) + 8]
      else s += h[Math.random() * 16 | 0]
    }
    return s
  }
  var nowIso = function () { return new Date().toISOString() }

  var token = lsGet(TOKEN_KEY) || ''
  var spaceId = lsGet(TOKEN_KEY + '.space') || ''

  /* rpc 返回形状在实现间有差异（值 / [{...}] / 包一层 result），统一拆 */
  function unwrap(data) {
    if (Array.isArray(data)) data = data[0]
    if (data && typeof data === 'object' && data.result !== undefined) data = data.result
    return data
  }

  function call(name, args) {
    if (!global.cloud || !global.cloud.database || !global.cloud.database.rpc) {
      return Promise.resolve({ ok: false, error: 'sdk_missing' })
    }
    return global.cloud.database.rpc(name, args || {}).then(function (res) {
      if (res && res.error) return { ok: false, error: (res.error && res.error.message) || 'rpc_failed' }
      var d = unwrap(res && res.data)
      if (!d || typeof d !== 'object') return { ok: false, error: 'bad_response' }
      return d
    }, function (e) {
      return { ok: false, error: (e && e.message) || 'network' }
    })
  }

  /* ---------- 本地镜像 ---------- */
  var mirror = { categories: [], entries: [] }
  var loaded = false
  var loading = null

  function rowsOf(table) { return table === 'categories' ? mirror.categories : mirror.entries }

  function load() {
    if (!token) return Promise.resolve({ ok: false, error: 'not_bound' })
    if (loading) return loading
    loading = call('dev_pull', { p_token: token, p_since: null }).then(function (r) {
      if (r.ok) {
        mirror.categories = (r.categories || []).slice()
        mirror.entries = (r.entries || []).slice()
        loaded = true
        /* todayStats 口径与改造前完全一致：本机 0 点起、只算已结束的段、按 category_id 累加。
           正在计时那段不含在内 —— 由渲染层用 elapsed 叠加。 */
        var start = new Date(); start.setHours(0, 0, 0, 0)
        var from = start.getTime()
        var byCat = {}, latest = {}
        mirror.entries.forEach(function (e) {
          if (!e.end_time) return
          if (new Date(e.start_time).getTime() < from) return
          var k = e.category_id || 'none'
          byCat[k] = (byCat[k] || 0) + Math.floor(e.duration_sec || 0)
          if (!latest[k]) latest[k] = (e.title || '').trim()
        })
        global.todayStats = { byCat: byCat, latest: latest }
        global.__allEntries = mirror.entries
      } else if (r.error === 'invalid_token') {
        token = ''; spaceId = ''
        lsSet(TOKEN_KEY, ''); lsSet(TOKEN_KEY + '.space', '')
      }
      loading = null
      return r
    }, function () { loading = null; return { ok: false, error: 'network' } })
    return loading
  }

  function ensure() { return loaded ? Promise.resolve({ ok: true }) : load() }

  function pushRow(table, row) {
    return table === 'categories'
      ? call('dev_put_category', { p_token: token, p_cat: row })
      : call('dev_put_entry', { p_token: token, p_entry: row })
  }
  function dropRow(table, id) {
    return table === 'categories'
      ? call('dev_delete_category', { p_token: token, p_id: id })
      : call('dev_delete_entry', { p_token: token, p_id: id })
  }
  /* 顺序推送：保证"先关旧、再开新"这类调用点的时序正确 */
  function pushSeq(table, list) {
    return list.reduce(function (p, r) {
      return p.then(function (prev) {
        return prev || pushRow(table, r).then(function (res) { return res.ok ? null : res })
      })
    }, Promise.resolve(null))
  }

  /* ---------- from() 兼容垫片 ----------
     链式 API 做成"惰性 + thenable"：调用点 await 它时才真正执行，
     所以 await 和 .then() 两种用法都成立，与原来完全一致。 */
  function shimFrom(table) {
    var q = { table: table, op: 'select', filters: [], orders: [], limit: 0, one: false, payload: null }
    var api = {}
    function chain(f) { return function () { f.apply(null, arguments); return api } }

    api.select = chain(function () {})   // 两种用法（选列 / 写后返回行）都不需要额外处理
    api.order = chain(function (col, opt) { q.orders.push({ col: col, asc: !opt || opt.ascending !== false }) })
    api.limit = chain(function (n) { q.limit = n })
    api.eq = chain(function (c, v) { q.filters.push(function (r) { return r[c] === v }) })
    api.is = chain(function (c, v) { q.filters.push(function (r) { return (r[c] == null) === (v == null) }) })
    api.not = chain(function (c, op, v) { q.filters.push(function (r) { return op === 'is' && v == null ? r[c] != null : true }) })
    api.gte = chain(function (c, v) { q.filters.push(function (r) { return r[c] >= v }) })
    api.maybeSingle = chain(function () { q.one = true })
    api.insert = function (p) { q.op = 'insert'; q.payload = p; return api }
    api.update = function (p) { q.op = 'update'; q.payload = p; return api }
    api.delete = function () { q.op = 'delete'; return api }
    api.then = function (res, rej) { return run(q).then(res, rej) }
    return api
  }

  function match(list, filters) {
    return list.filter(function (r) {
      for (var i = 0; i < filters.length; i++) if (!filters[i](r)) return false
      return true
    })
  }

  function run(q) {
    return ensure().then(function () {
      var list = rowsOf(q.table)

      if (q.op === 'select') {
        var out = match(list, q.filters)
        q.orders.forEach(function (o) {
          out = out.slice().sort(function (a, b) {
            var x = a[o.col], y = b[o.col]
            if (x === y) return 0
            var c = (x == null ? '' : x) < (y == null ? '' : y) ? -1 : 1
            return o.asc ? c : -c
          })
        })
        if (q.limit) out = out.slice(0, q.limit)
        return { data: q.one ? (out[0] || null) : out, error: null }
      }

      if (q.op === 'insert') {
        var items = Array.isArray(q.payload) ? q.payload : [q.payload]
        var added = items.map(function (x) {
          return Object.assign({}, x, {
            id: x.id || uuid(),
            created_at: x.created_at || nowIso(),
          })
        })
        added.forEach(function (r) { list.push(r) })
        return pushSeq(q.table, added).then(function (err) {
          if (err) {   // 回滚乐观写入
            added.forEach(function (r) { var i = list.indexOf(r); if (i >= 0) list.splice(i, 1) })
            return { data: null, error: err }
          }
          return { data: added, error: null }
        })
      }

      if (q.op === 'update') {
        var hit = match(list, q.filters)
        var before = hit.map(function (r) { return Object.assign({}, r) })
        hit.forEach(function (r) { Object.assign(r, q.payload) })
        return pushSeq(q.table, hit).then(function (err) {
          if (err) { hit.forEach(function (r, i) { Object.assign(r, before[i]) }); return { data: null, error: err } }
          return { data: hit, error: null }
        })
      }

      if (q.op === 'delete') {
        var gone = match(list, q.filters)
        gone.forEach(function (r) { var i = list.indexOf(r); if (i >= 0) list.splice(i, 1) })
        if (q.table === 'categories') {   // 对齐云端 ON DELETE SET NULL
          var ids = gone.map(function (g) { return g.id })
          mirror.entries.forEach(function (e) { if (ids.indexOf(e.category_id) >= 0) e.category_id = null })
        }
        return gone.reduce(function (p, r) {
          return p.then(function (prev) { return prev || dropRow(q.table, r.id).then(function (res) { return res.ok ? null : res }) })
        }, Promise.resolve(null)).then(function (err) {
          return err ? { data: null, error: err } : { data: gone, error: null }
        })
      }

      return { data: null, error: { message: 'unsupported_op' } }
    })
  }

  /* ---------- 拦截 cloud.database.from ---------- */
  var intercepted = false
  function intercept() {
    if (intercepted) return
    var db = global.cloud && global.cloud.database
    if (!db || typeof db.from !== 'function') return
    var realFrom = db.from.bind(db)
    db.from = function (table) {
      if (!token) return realFrom(table)          // 还没绑定：退回原路径
      if (table !== 'categories' && table !== 'time_entries') return realFrom(table)
      return shimFrom(table)
    }
    intercepted = true
  }

  /* ---------- 对外 ---------- */
  var Repo = {
    get bound() { return !!token },
    get spaceId() { return spaceId },
    get mirror() { return mirror },

    _save: function (t, s) {
      token = t || ''; spaceId = s || ''
      lsSet(TOKEN_KEY, token); lsSet(TOKEN_KEY + '.space', spaceId)
    },

    claim: function (name) {
      var self = this
      return call('space_claim', { p_device_name: name || DEVICE_NAME }).then(function (r) {
        if (r.ok) self._save(r.token, r.space_id)
        return r
      })
    },
    create: function (name) {
      var self = this
      return call('space_create', { p_device_name: name || DEVICE_NAME }).then(function (r) {
        if (r.ok) self._save(r.token, r.space_id)
        return r
      })
    },
    redeem: function (code, name) {
      var self = this
      return call('pair_redeem', { p_code: String(code || '').trim(), p_device_name: name || '新设备' })
        .then(function (r) { if (r.ok) self._save(r.token, r.space_id); return r })
    },
    unbind: function () {
      var self = this
      var p = token ? call('dev_unpair', { p_token: token }) : Promise.resolve({ ok: true })
      return p.then(function (r) { self._save('', ''); intercepted = false; return r })
    },
    makeCode: function (name) { return call('pair_create_code', { p_token: token, p_device_name: name || '新设备' }) },
    devices: function () { return call('pair_list_devices', { p_token: token }) },
    revoke: function (id) { return call('pair_revoke_device', { p_token: token, p_device_id: id }) },

    load: load,
    reload: function () { loaded = false; return load() },

    /**
     * 启动引导 —— **免登录的关键**
     *   有令牌            → 直接用
     *   没令牌 + 有账号会话 → claim：把账号名下已有数据迁进空间（老用户不丢数据）
     *   没令牌 + 无会话     → create：开一个全新空间（新用户，全程不需要注册）
     * claim/create 都失败才算失败；之后一律走令牌，界面上再也不出现登录。
     */
    bootstrap: function (name) {
      var self = this
      if (token) {
        return self.load().then(function (r) {
          if (r.ok) { intercept(); return { ok: true, mode: 'paired' } }
          self._save('', '')                       // 令牌失效 → 当作新设备重建，绝不让用户卡住
          return self.bootstrap(name)
        })
      }
      return self.claim(name).then(function (r) {
        if (r.ok) return afterBind('claimed', r)
        return self.create(name).then(function (r2) {
          if (!r2.ok) return r2
          return afterBind('created', r2)
        })
      })

      function afterBind(mode, r) {
        return self.load().then(function () {
          intercept()
          return { ok: true, mode: mode, migrated: r.migrated || null }
        })
      }
    },
  }

  global.Repo = Repo
})(window)
