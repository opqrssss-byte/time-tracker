# -*- coding: utf-8 -*-
r"""app.js 弧排（正式组件迁移版）验证：
1) app.js 整文件 node --check 语法检查
2) 从 app.js 抽取 ARC-PICK:PURE 纯几何块 + fmtMS + ARC_LERP，node 穷举断言：
   - 映射：pickGoal = gi-VISIBLE → 落定时中心行就是 gi（防 off-by-one）
   - 几何：可见条数恒 5~6 / 四角 fitsAll / w>16 / yOuter<=LIMIT / 无穿心(xL<=-2)
   - 文字：a<1.5 时 w>=wText（v16.7 文字驱动、不撑满——v16.8 已否决）且余量>=12；
           截断自洽（估算宽不超预算）；__add__ 无时长
   - 刚性体：有符号 dRaw 垂直间距 → 任意两可见条零重叠
   - 窗内分类不重复（n>6）；LERP 追赶单调不过冲、有限步落定
   - n ∈ {1,2,3,4,5,6,7,8,10,15,20,31} × 数据形态（长名/ASCII/大数据/全幽灵/__none__/__add__）
      × frac 64 采样（step 0.125，覆盖 [0,8)）
用法：python site\_verify\verify_arc_pick.py
依赖：node（PATH）、python 标准库。
lab-arc.html 样品基线仍由 verify_arc.py 负责（两个都跑）。
"""
import io, re, subprocess, os, sys

_HERE = os.path.dirname(os.path.abspath(__file__))
path = os.path.join(os.path.dirname(_HERE), 'app.js')   # site\app.js
tmp = os.path.join(_HERE, 'tmp_arc_pick.js')

s = io.open(path, encoding='utf-8').read()

r = subprocess.run(['node', '--check', path], capture_output=True, text=True)
print('== node --check app.js == exit:', r.returncode)
if r.stderr: print(r.stderr)
if r.returncode != 0: sys.exit(1)

# 纯几何块（含起止标记注释，node 当注释忽略）
m = re.search(r'/\* ═══ ARC-PICK:PURE-BEGIN.*?═══ ARC-PICK:PURE-END ═══ \*/', s, re.S)
if not m:
    print('FATAL: ARC-PICK:PURE block not found in app.js'); sys.exit(1)
pure = m.group(0)

m2 = re.search(r'function fmtMS\(totalSec\) \{.*?\n\}', s, re.S)
if not m2:
    print('FATAL: fmtMS not found in app.js'); sys.exit(1)
fmtms = m2.group(0)

m3 = re.search(r'const ARC_LERP = [0-9.]+', s)
if not m3:
    print('FATAL: ARC_LERP not found in app.js'); sys.exit(1)
lerp = m3.group(0)

test = r'''
''' + fmtms + r'''

''' + pure + r'''

''' + lerp + r'''

/* ===== 穷举断言 ===== */
let fails = 0, checked = 0, visMin = 99, visMax = 0
function ok(cond, msg) { if (!cond) { fails++; if (fails <= 30) console.log('FAIL ' + msg) } }

const NAME_POOL = ['工作', '学习', '运动', '生活', '阅读', '写作', '摸鱼', '工作会议', '深度学习',
  '周末放松时间', '超长分类名称测试用例', 'Work', 'AB', '设计评审会']
const COLOR_POOL = ['#4F8CFF', '#9B6DFF', '#2FBF71', '#F2A93B', '#FF5A5A', '#23B8D5', '#F06EAA', '#8a91a3', '#6b7280']
const SEC_POOL = [0, 5, 45, 135, 3600, 7835, 35999]
function mkList(n, opt) {
  const out = []
  for (let i = 0; i < n; i++) {
    out.push({
      id: 'c' + i,
      name: NAME_POOL[i % NAME_POOL.length] + (i >= NAME_POOL.length ? i : ''),
      color: COLOR_POOL[i % COLOR_POOL.length],
      durText: fmtMS(SEC_POOL[i % SEC_POOL.length]),
    })
  }
  if (opt.none) out.push({ id: '__none__', name: '未分类', color: '#6b7280', durText: fmtMS(1234) })
  if (opt.add) out.push({ id: '__add__', name: '新增项目', color: null, durText: '' })
  return out
}

for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 10, 15, 20, 31]) {
  const items = mkList(n, { none: n > 4, add: true })
  const N = items.length
  const copies = Math.max(2, Math.ceil((N + ARC_VISIBLE * 2 + 2) / N))
  for (let fi = 0; fi < N * 8; fi++) {                 // frac = pickPos mod N，真实范围 [0,N)
    const frac = fi / 8
    const rows = []
    for (let k = 0; k < N * copies; k++) {
      const dRaw = (k - ARC_VISIBLE) - frac
      if (Math.abs(dRaw) > ARC_VISIBLE + 0.5) continue     // 窗外（paintArc 直接藏行）
      const s = arcRowSolve(dRaw, items[k % N])
      checked++
      rows.push({ k, d: dRaw, h: s.p.h, s })
      ok(s.visible, 'visible-flag N=' + N + ' frac=' + frac + ' k=' + k)
      ok(arcFitsAll(s.xL, s.yT, s.yB, s.w), 'fit N=' + N + ' frac=' + frac + ' k=' + k + ' w=' + s.w.toFixed(1))
      ok(s.w > 16, 'narrow N=' + N + ' frac=' + frac + ' k=' + k + ' w=' + s.w)
      ok(Math.abs(s.yT) <= ARC_LIMIT && Math.abs(s.yB) <= ARC_LIMIT, 'yOuter N=' + N + ' frac=' + frac + ' k=' + k)
      ok(s.xL <= -2, 'pierce N=' + N + ' frac=' + frac + ' k=' + k + ' xL=' + s.xL.toFixed(1))
      const a = Math.abs(dRaw)
      if (a < 1.5) {
        ok(s.w >= s.wText - 1e-9, 'text-overflow N=' + N + ' frac=' + frac + ' k=' + k + ' w=' + s.w.toFixed(1) + ' wText=' + s.wText.toFixed(1))
        ok(s.w - s.wName - s.wDur - 12 >= -1e-9, 'text-gap N=' + N + ' frac=' + frac + ' k=' + k)
        ok(arcTextW(s.nm, s.p.nm) <= s.wName + 1e-9, 'trunc-nm N=' + N + ' frac=' + frac + ' k=' + k)
        ok(arcTextW(s.du, s.p.du) <= s.wDur + 1e-9, 'trunc-du N=' + N + ' frac=' + frac + ' k=' + k)
      }
      if (a < 1e-9) {
        ok(Math.abs(s.w - s.wText) < 1e-9, 'center-stretch(v16.8?) N=' + N + ' frac=' + frac + ' k=' + k)
        ok(Math.abs(s.p.h - 24) < 1e-9, 'center-h N=' + N + ' frac=' + frac + ' k=' + k)
      }
      if (items[k % N].id === '__add__') ok(s.du === '', 'add-dur N=' + N + ' frac=' + frac + ' k=' + k)
    }
    ok(rows.length >= 5 && rows.length <= 6, 'vis-count N=' + N + ' frac=' + frac + ' vis=' + rows.length)
    visMin = Math.min(visMin, rows.length); visMax = Math.max(visMax, rows.length)
    if (N > 6) {
      const seen = new Set()
      for (const r of rows) {
        const id = items[r.k % N].id
        ok(!seen.has(id), 'dup-cat N=' + N + ' frac=' + frac + ' id=' + id)
        seen.add(id)
      }
    }
    for (let i = 0; i < rows.length; i++) for (let j = 0; j < rows.length; j++) {
      if (i === j) continue
      const gap = Math.abs(rows[i].d - rows[j].d) * ARC_ROW_H
      const sum = (rows[i].h + rows[j].h) / 2
      ok(gap >= sum - 0.01, 'v-overlap N=' + N + ' frac=' + frac + ' rows ' + rows[i].k + ',' + rows[j].k +
        ' gap=' + gap.toFixed(2) + ' sum=' + sum.toFixed(2))
    }
  }
}

/* 映射：落定时中心行（dRaw=0）必须就是焦点分类 —— pickGoal=gi-VISIBLE 的口径验证 */
for (const n of [2, 3, 7, 8, 15, 31]) {
  const copies = Math.max(2, Math.ceil((n + ARC_VISIBLE * 2 + 2) / n))
  for (let gi = 0; gi < n; gi++) {
    const pos = gi - ARC_VISIBLE                  // = 首次打开时 updatePickOverlay 写进去的 pickGoal
    const frac = ((pos % n) + n) % n
    const K = frac + ARC_VISIBLE                  // dRaw = K - VISIBLE - frac = 0
    ok(K < n * copies, 'map-row-missing n=' + n + ' gi=' + gi + ' K=' + K + ' rows=' + (n * copies))
    ok(K % n === gi, 'map n=' + n + ' gi=' + gi + ' K%n=' + (K % n))
  }
}

/* 无限滚动连续性（2026-10-15 真机"弹回第一个"修复的锁）：
   任意步进序列（跨首尾、双向、多整圈）下，arcFoldGoal 每次只推进 ±1 格
   （绝不是 -(n-1) 整圈回跳），且折叠后居中项仍是新焦点。 */
for (const n of [3, 5, 7, 10, 31]) {
  let goal = -ARC_VISIBLE
  let gi = 0
  const seq = []
  for (let s = 0; s < n * 3 + 2; s++) seq.push(1)       // 向下滚三圈多
  for (let s = 0; s < n * 2 + 1; s++) seq.push(-1)      // 再向上滚两圈多
  for (const dir of seq) {
    gi = ((gi + dir) % n + n) % n
    const prev = goal
    goal = arcFoldGoal(goal, gi - ARC_VISIBLE, n)
    ok(goal - prev === dir, 'fold-delta n=' + n + ' dir=' + dir + ' delta=' + (goal - prev))
    const frac = ((goal % n) + n) % n
    ok(frac === (((gi - ARC_VISIBLE) % n) + n) % n, 'fold-frac n=' + n + ' gi=' + gi + ' frac=' + frac)
  }
}

/* 运动：LERP 追赶单调不过冲、有限步落定（v16.7 滑动过渡的核心性质） */
for (const dist of [1, 2, 4, 8, 16, -3]) {
  let pos = 0, frames = 0
  while (Math.abs(dist - pos) >= 0.005 && frames < 600) {
    const nv = pos + (dist - pos) * ARC_LERP
    ok(nv >= Math.min(0, dist, pos) - 1e-9 && nv <= Math.max(0, dist, pos) + 1e-9, 'overshoot dist=' + dist)
    pos = nv; frames++
  }
  ok(frames < 600, 'settle dist=' + dist + ' frames=' + frames)
}

console.log('rows checked: ' + checked + '  visible per frame: min=' + visMin + ' max=' + visMax)
console.log(fails === 0 ? 'PASS' : 'FAILS: ' + fails)
process.exit(fails === 0 ? 0 : 1)
'''

io.open(tmp, 'w', encoding='utf-8').write(test)
r2 = subprocess.run(['node', tmp], capture_output=True, text=True)
print('== exhaustive test == exit:', r2.returncode)
print(r2.stdout)
if r2.stderr: print(r2.stderr)
sys.exit(r2.returncode)
