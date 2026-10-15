# -*- coding: utf-8 -*-
r"""弧排静态快照生成器：从 app.js 抽取 ARC-PICK:PURE 块 + fmtMS + ARC_LERP，
按 paintArc 同口径渲染两个状态（落定 / 滚动中）的 SVG，打印到 stdout。
用途：迁移后不依赖浏览器的外观自检（数据形态 = 正式组件的 fmtMS 时长）。
"""
import io, re, subprocess, os, sys

_HERE = os.path.dirname(os.path.abspath(__file__))
s = io.open(os.path.join(os.path.dirname(_HERE), 'app.js'), encoding='utf-8').read()

pure = re.search(r'/\* ═══ ARC-PICK:PURE-BEGIN.*?═══ ARC-PICK:PURE-END ═══ \*/', s, re.S).group(0)
fmtms = re.search(r'function fmtMS\(totalSec\) \{.*?\n\}', s, re.S).group(0)

snap = r'''
''' + fmtms + r'''

''' + pure + r'''

/* ---- 快照数据（正式组件口径：fmtMS 时长、含未分类与新增项目）---- */
const ITEMS = [
  { id: 'c1', name: '工作',   color: '#4F8CFF', durText: fmtMS(7835) },
  { id: 'c2', name: '学习',   color: '#9B6DFF', durText: fmtMS(2700) },
  { id: 'c3', name: '运动',   color: '#2FBF71', durText: fmtMS(1200) },
  { id: 'c4', name: '生活',   color: '#F2A93B', durText: fmtMS(3900) },
  { id: 'c5', name: '阅读',   color: '#23B8D5', durText: fmtMS(2100) },
  { id: 'c6', name: '写作',   color: '#F06EAA', durText: fmtMS(600) },
  { id: 'c7', name: '摸鱼',   color: '#8a91a3', durText: fmtMS(300) },
  { id: 'c8', name: '超长分类名称测试', color: '#FF5A5A', durText: fmtMS(35999) },
  { id: '__none__', name: '未分类', color: '#6b7280', durText: fmtMS(1234) },
  { id: '__add__', name: '新增项目', color: null, durText: '' },
]
const N = ITEMS.length
const ink = (hex) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''))
  if (!m) return 'rgba(255,255,255,.72)'
  const L = (0.299 * parseInt(m[1], 16) + 0.587 * parseInt(m[2], 16) + 0.114 * parseInt(m[3], 16)) / 255
  return L > 0.62 ? 'rgba(12,14,18,.9)' : 'rgba(255,255,255,.97)'
}
function esc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }

/* 渲染一个表盘（frac = 带子位置的小数部分；prog = 确认进度 0..1；focusIdx = 焦点项） */
function renderDial(frac, prog, focusIdx) {
  const copies = Math.max(2, Math.ceil((N + ARC_VISIBLE * 2 + 2) / N))
  let out = ''
  for (let k = 0; k < N * copies; k++) {
    const dRaw = (k - ARC_VISIBLE) - frac
    if (Math.abs(dRaw) > ARC_VISIBLE + 0.5) continue
    const it = ITEMS[k % N]
    const s = arcRowSolve(dRaw, { id: it.id, name: it.name, durText: it.durText })
    const isAdd = it.id === '__add__'
    const fill = isAdd ? 'rgba(255,255,255,.10)' : (it.color || '#5a5d64')
    const yc = dRaw * ARC_ROW_H                       // 视觉中心（app 里由 row g 的 translate 负责）
    const d = arcCapsulePath(yc - s.p.h / 2, yc + s.p.h / 2, s.xL, s.xL + s.w)
    const op = Math.round(s.p.op * 20) / 20
    out += `<path d="${d}" fill="${fill}" opacity="${op}"` +
      (s.a < 0.5 ? ' stroke="rgba(255,255,255,.34)" stroke-width="1.5"' : '') + '/>'
    if (s.a < 1.5) {
      const txtOp = Math.round((1 - s.fadeT) * 20) / 20
      const ic = isAdd ? 'rgba(255,255,255,.72)' : ink(it.color)
      const nmK = Math.round(s.p.nm * 2) / 2, duK = Math.round(s.p.du * 2) / 2
      out += `<text x="${(s.xL + 6).toFixed(2)}" y="${yc.toFixed(2)}" font-size="${nmK}" font-weight="600" fill="${ic}" opacity="${txtOp}" dominant-baseline="central">${esc(s.nm)}</text>`
      if (!isAdd) out += `<text x="${(s.xL + s.w - 6).toFixed(2)}" y="${yc.toFixed(2)}" font-size="${duK}" font-weight="500" fill="${ic}" opacity="${(Math.round(0.78 * txtOp * 20) / 20).toFixed(2)}" text-anchor="end" dominant-baseline="central">${esc(s.du)}</text>`
    }
    if (k % N === focusIdx && prog > 0 && s.a < 0.5) {
      const lay = arcProgLayout(s.xL, s.p.h, s.w, prog)
      out += `<rect x="${lay.x.toFixed(2)}" y="${(yc + lay.y).toFixed(2)}" width="${lay.w.toFixed(2)}" height="${lay.h}" rx="1.2" fill="rgba(255,255,255,.92)"/>`
    }
  }
  return out
}

/* 两个状态：① 落定（焦点=工作 → frac=(0-2) mod 10=8，确认进度 55%）② 滚动中（frac=8.5，工作→学习中途） */
const dial = (cx, frac, prog, fi) =>
  `<g transform="translate(${cx},0)">
    <circle r="76" fill="rgba(18,19,22,.92)"/>
    <circle r="75" fill="none" stroke="rgba(255,255,255,.10)"/>
    ${renderDial(frac, prog, fi)}
  </g>`

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-190 -92 380 184" font-family="'SF Pro Display',-apple-system,'Segoe UI',system-ui,sans-serif">
  <rect x="-190" y="-92" width="380" height="184" rx="16" fill="#101216"/>
  ${dial(-95, 8, 0.55, 0)}
  ${dial(95, 8.5, 0, 1)}
  <text x="-95" y="84" text-anchor="middle" font-size="11" fill="rgba(255,255,255,.55)">落定 · 焦点「工作」· 确认进度 55%</text>
  <text x="95" y="84" text-anchor="middle" font-size="11" fill="rgba(255,255,255,.55)">滚动中 · frac=0.5 · 连续插值</text>
</svg>`
console.log(svg)
'''

tmp = os.path.join(_HERE, 'tmp_snap.js')
io.open(tmp, 'w', encoding='utf-8').write(snap)
r = subprocess.run(['node', tmp], capture_output=True, text=True)
if r.returncode != 0:
    print(r.stderr); sys.exit(1)
out = os.path.join(_HERE, 'arc_snapshot.svg')
io.open(out, 'w', encoding='utf-8').write(r.stdout)
print('written:', out, len(r.stdout), 'bytes')
