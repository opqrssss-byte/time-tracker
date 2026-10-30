# -*- coding: utf-8 -*-
# 生成 design/vector/00-知识图谱画布.vectorcraft（单文件 5 画板）并导出 png/pdf。
# 用法：python design/vector/build_workbook.py
# 依赖：VectorCraft 0.18.0 的 vectorcraft-cli.exe（无界面跑，不需要开 GUI）
#
# 铁律（改动前先读）：
#   1. paint.setStroke 只传 color；weight/cap/dash/arrow 全走 stroke.set
#   2. 箭头一律 stroke.set 的 endArrow + arrowAlign:"tip"，禁止三角多边形拼
#   3. 居中一律 ctext()（justify:"center"），禁止手算字宽
#   4. 不用 emoji，对勾/叉号/算子/序号全用几何路径或字符
#   5. 每个画板最底层铺满 900x620 纯白矩形
#   6. 语义单元编组、底图与说明文字锁定（见下方"编组与锁定"）
#
# 编组与锁定（2026-10-30 起，推翻了此前的"零编组"铁律）：
#   零编组是为了"零件能单独框选复制"，但副作用是拖一个节点只动框、文字留在原地，
#   完全没法用。现在改为：一个语义单元 = 一个 group；底图和说明文字 = 锁定。
#   03 里的每个零件仍然是独立 group，框选/复制依然是整体拿走，比散装更好用。
#
#   id 推算说明：画板 id 是独立序列(1..5)，对象 id 与 layer 共用序列，
#   首个对象 id=2 且严格连续递增，所以"第 n 个创建的对象 id = n+1"可以精确预测。
#   所有 group / lock 命令必须放在最后统一发，否则会打乱后续 id。
import json, os, math, subprocess
from contextlib import contextmanager

OUTDIR = os.path.dirname(os.path.abspath(__file__))
TMP = os.path.join(os.environ.get("TEMP", r"C:\Windows\Temp"), "vc-build")
os.makedirs(TMP, exist_ok=True)
CLI = r"C:\Users\zhangzining\AppData\Local\Programs\ArtCraft\VectorCraft\vectorcraft-cli.exe"

# ---------------- 苹果系统色 ----------------
BG     = "#FFFFFF"
INK    = "#1D1D1F"
SUB    = "#6E6E73"
TERT   = "#8E8E93"
GRAY2  = "#AEAEB2"
GRAY3  = "#C7C7CC"
GRAY4  = "#D1D1D6"
HAIR   = "#E5E5EA"
GRAY6  = "#F2F2F7"
BLUE   = "#007AFF"
BLUEL  = "#EAF3FF"
GREEN  = "#34C759"
ORANGE = "#FF9500"
RED    = "#FF3B30"
REDL   = "#FFF5F4"
REDB   = "#FFD6D1"
PURPLE = "#AF52DE"

# 字体（2026-10-30 换）：Source Sans 3 没有中文字形，Windows 上回退到宋体（衬线），
# 画板一直是"宋体版"而不是苹果该有的黑体。Noto Sans SC 字形最接近苹方，实测：
#   纯中文 Regular +0.3% / 纯中文 Bold +8.7% / 含拉丁 +13.8%
# 所以换完之后所有左对齐长句都会变长，必须逐张查溢出。
FONT = "Noto Sans SC"

# ---------------- id 追踪 + 编组/锁定收集 ----------------
_NEXT = [1]      # 已分配的最大 id；第一个图形对象拿到 2
_CUR = [None]    # 当前收集器，None = 不收集
_GROUPS = []     # [[id, id, ...], ...]
_LOCKS = []

def _new_obj():
    _NEXT[0] += 1
    i = _NEXT[0]
    if _CUR[0] is not None:
        _CUR[0].append(i)
    return i

@contextmanager
def grp():
    """把块内创建的对象编成一组。单成员不组（组一个对象没有意义）。"""
    prev = _CUR[0]
    _CUR[0] = []
    try:
        yield
    finally:
        cur = _CUR[0]
        _CUR[0] = prev
        if cur and len(cur) > 1:
            _GROUPS.append(cur)

@contextmanager
def locked():
    """把块内创建的对象标记为锁定：不能选中、不能拖动。用于底图和说明文字。"""
    prev = _CUR[0]
    _CUR[0] = []
    try:
        yield
    finally:
        cur = _CUR[0]
        _CUR[0] = prev
        if cur:
            _LOCKS.append(cur)

# ---------------- 绘制原语 ----------------
S = []
def P(d, closed=True):
    S.append({"id": "path.create", "params": {"d": d, "closed": closed}})
    return _new_obj()

def fill(c=None):
    S.append({"id": "paint.setFill", "params": {"color": c} if c else {"none": True}})

def stroke(c=None, w=1.0, dash=None, cap="round", arrow=None, align="tip"):
    S.append({"id": "paint.setStroke", "params": {"color": c} if c else {"none": True}})
    if c:
        pr = {"weight": w, "cap": cap}
        if dash is not None:
            pr["dash"] = dash
        if arrow:
            pr["endArrow"] = arrow
            pr["arrowAlign"] = align
        S.append({"id": "stroke.set", "params": pr})

def rect(x, y, w, h, f, st=None, r=0, dash=None, sw=0.8):
    if r:
        d = (f"M{x+r} {y} H{x+w-r} A{r} {r} 0 0 1 {x+w} {y+r} V{y+h-r} "
             f"A{r} {r} 0 0 1 {x+w-r} {y+h} H{x+r} A{r} {r} 0 0 1 {x} {y+h-r} "
             f"V{y+r} A{r} {r} 0 0 1 {x+r} {y} Z")
    else:
        d = f"M{x} {y} H{x+w} V{y+h} H{x} Z"
    i = P(d); fill(f)
    if st:
        stroke(st, sw, dash)
    else:
        stroke(None)
    return i

def circle(cx, cy, r, f, st=None, sw=1.0):
    i = P(f"M{cx-r} {cy} a{r} {r} 0 1 0 {2*r} 0 a{r} {r} 0 1 0 {-2*r} 0 Z"); fill(f)
    if st:
        stroke(st, sw)
    else:
        stroke(None)
    return i

def capsule(x, y, w, h, f, st=None, sw=1.0):
    """胶囊 = 半圆端矩形，圆角取 h/2。"""
    return rect(x, y, w, h, f, st, r=h/2, sw=sw)

def text(x, y, s, size=14, color=INK, style=None, justify=None):
    pr = {"x": x, "y": y, "text": s, "size": size, "color": color, "font": FONT}
    if style:
        pr["style"] = style
    if justify:
        pr["justify"] = justify
    S.append({"id": "text.create", "params": pr})
    return _new_obj()

def ctext(cx, y, s, size=14, color=INK, style=None):
    return text(cx, y, s, size, color, style, justify="center")

def mid(cx, cy, s, size=12, color=INK, style=None):
    """在 (cx, cy) 的几何中心放一行字（text 的 y 是基线，约 0.35 字号偏下）。"""
    return ctext(cx, cy + size * 0.35, s, size, color, style)

def tline(x1, y1, x2, y2, w, color):
    dx, dy = x2 - x1, y2 - y1
    L = math.hypot(dx, dy) or 1
    nx, ny = -dy / L * w / 2, dx / L * w / 2
    return P(f"M{x1+nx:.2f} {y1+ny:.2f} L{x2+nx:.2f} {y2+ny:.2f} "
             f"L{x2-nx:.2f} {y2-ny:.2f} L{x1-nx:.2f} {y1-ny:.2f} Z")

def arrow_r(x1, y, ln=44, color=INK, w=1.6, head="Arrow"):
    i = P(f"M{x1} {y} H{x1+ln}", closed=False)
    fill(None)
    stroke(color, w, arrow=head)
    return i

def check(cx, cy, s, color, w=1.8):
    """几何对勾，单对象折线。"""
    i = P(f"M{cx-s*0.46:.2f} {cy+s*0.02:.2f} L{cx-s*0.12:.2f} {cy+s*0.38:.2f} "
          f"L{cx+s*0.48:.2f} {cy-s*0.40:.2f}", closed=False)
    fill(None); stroke(color, w)
    return i

def cross(cx, cy, s, color, w=1.8):
    """几何叉号，一条路径两段。"""
    i = P(f"M{cx-s:.2f} {cy-s:.2f} L{cx+s:.2f} {cy+s:.2f} "
          f"M{cx+s:.2f} {cy-s:.2f} L{cx-s:.2f} {cy+s:.2f}", closed=False)
    fill(None); stroke(color, w)
    return i

def plus(cx, cy, s, color, w=1.8):
    i = P(f"M{cx-s:.2f} {cy} L{cx+s:.2f} {cy} M{cx} {cy-s:.2f} L{cx} {cy+s:.2f}", closed=False)
    fill(None); stroke(color, w)
    return i

def hair(x, y, w, color=HAIR, weight=0.8):
    return rect(x, y, w, weight, color)

# ---------------- 画板布局 ----------------
AB = [
    ("01-四种连线", 0, 0, 900, 620, BG),
    ("02-你画我改闭环", 940, 0, 900, 620, BG),
    ("03-工具库", 1880, 0, 900, 620, BG),
    ("04-空白画布 01（四象限引导）", 0, 680, 900, 620, BG),
    ("05-空白画布 02（自由作图）", 940, 680, 900, 620, BG),
]

S.append({"id": "artboard.setProps", "params": {"index": 0, "x": AB[0][1], "y": AB[0][2],
                                                "width": AB[0][3], "height": AB[0][4],
                                                "name": AB[0][0], "color": AB[0][5]}})
for name, x, y, w, h, c in AB[1:]:
    S.append({"id": "artboard.new", "params": {"x": x, "y": y, "width": w, "height": h, "name": name, "color": c}})

# =====================================================================
# 画板 01 · 四种连线（2x2 Bento）
# 底图与标题锁定；每张 Bento 卡编成一组，拖一张卡 = 整体移动
# =====================================================================
ox, oy = 0, 0
with locked():
    rect(ox, oy, 900, 620, BG)
    text(ox+60, oy+86, "你只需要画四种连线", 32, INK, "Bold")
    text(ox+62, oy+116, "节点只写短词，不写句子；线只表达关系，不表达内容", 14, SUB)

# --- 左上：定层级 ---
cx, cy = 60, 120
with grp():
    rect(ox+cx, oy+cy, 382, 222, GRAY6, HAIR, 14)
    circle(ox+cx+30, oy+cy+26, 12, BLUE); mid(ox+cx+30, oy+cy+26, "1", 11, BG, "Bold")
    text(ox+cx+50, oy+cy+31, "定层级 · 包含与从属", 17, INK, "Bold")
    text(ox+cx+18, oy+cy+56, "区分核心目的与末梢工具，拒绝目录式扁平罗列", 11, TERT)
    # 三层嵌套：外框 > 中框 > 两个胶囊。标注做成左侧阶梯引线
    rect(ox+cx+130, oy+cy+78, 234, 98, BG, GRAY2, 10, sw=1.2)
    rect(ox+cx+142, oy+cy+92, 210, 72, BLUEL, BLUE, 8, sw=1.2)
    capsule(ox+cx+154, oy+cy+106, 88, 26, INK, None)
    mid(ox+cx+198, oy+cy+119, "末梢 A", 10, BG)
    capsule(ox+cx+252, oy+cy+106, 88, 26, BG, INK, 1.2)
    mid(ox+cx+296, oy+cy+119, "末梢 B", 10, INK)
    # 引线起点右移到 60：黑体比宋体宽，标签占 18..54，线从 44 起会穿过文字
    tline(ox+cx+60, oy+cy+94,  ox+cx+128, oy+cy+94,  0.7, GRAY3); text(ox+cx+18, oy+cy+97,  "顶层心法", 9, SUB)
    tline(ox+cx+60, oy+cy+112, ox+cx+140, oy+cy+112, 0.7, GRAY3); text(ox+cx+18, oy+cy+115, "主干阶段", 9, BLUE)
    tline(ox+cx+60, oy+cy+130, ox+cx+152, oy+cy+130, 0.7, GRAY3); text(ox+cx+18, oy+cy+133, "末梢工具", 9, SUB)

# --- 右上：连路径 ---
cx, cy = 458, 120
with grp():
    rect(ox+cx, oy+cy, 382, 222, GRAY6, HAIR, 14)
    circle(ox+cx+30, oy+cy+26, 12, BLUE); mid(ox+cx+30, oy+cy+26, "2", 11, BG, "Bold")
    text(ox+cx+50, oy+cy+31, "连路径 · 流向与闭环", 17, INK, "Bold")
    text(ox+cx+18, oy+cy+56, "单向推进看先后，双向闭环看迭代", 11, TERT)
    capsule(ox+cx+18, oy+cy+74, 96, 26, BG, GRAY2, 1.1);  mid(ox+cx+66, oy+cy+87, "定标", 10, INK)
    arrow_r(ox+cx+118, oy+cy+87, 22, BLUE, 1.6)
    capsule(ox+cx+142, oy+cy+74, 96, 26, BG, GRAY2, 1.1); mid(ox+cx+190, oy+cy+87, "摸底", 10, INK)
    arrow_r(ox+cx+242, oy+cy+87, 22, BLUE, 1.6)
    capsule(ox+cx+266, oy+cy+74, 98, 26, BG, BLUE, 1.2);  mid(ox+cx+315, oy+cy+87, "前置 20%", 10, BLUE)
    capsule(ox+cx+18, oy+cy+112, 132, 26, BLUEL, BLUE, 1.1); mid(ox+cx+84, oy+cy+125, "Grok 主脑", 10, BLUE)
    P(f"M{ox+cx+154} {oy+cy+125} H{ox+cx+216}", closed=False)
    fill(None); stroke(BLUE, 1.6, arrow="DoubleArrow")
    capsule(ox+cx+220, oy+cy+112, 144, 26, BLUEL, BLUE, 1.1); mid(ox+cx+292, oy+cy+125, "豆包 / WorkBuddy", 10, BLUE)
    P(f"M{ox+cx+292} {oy+cy+138} V{oy+cy+168} H{ox+cx+84} V{oy+cy+146}", closed=False)
    fill(None); stroke(ORANGE, 1.4, dash=[6, 5], arrow="Arrow")
    text(ox+cx+124, oy+cy+182, "测试反馈调速", 10, ORANGE)

# --- 左下：标互斥 ---
cx, cy = 60, 358
with grp():
    rect(ox+cx, oy+cy, 382, 222, REDL, REDB, 14)
    circle(ox+cx+30, oy+cy+26, 12, RED); mid(ox+cx+30, oy+cy+26, "3", 11, BG, "Bold")
    text(ox+cx+50, oy+cy+31, "标互斥 · 取舍边界", 17, INK, "Bold")
    text(ox+cx+18, oy+cy+56, "新方案出现后，必须砍掉哪个旧习惯或劣质工具", 11, TERT)
    capsule(ox+cx+18, oy+cy+86, 152, 38, BLUEL, BLUE, 1.2)
    circle(ox+cx+38, oy+cy+105, 10, GREEN); check(ox+cx+38, oy+cy+105, 5.5, BG, 1.8)
    text(ox+cx+54, oy+cy+109, "亲手画图谱", 11, BLUE)
    P(f"M{ox+cx+178} {oy+cy+105} H{ox+cx+236}", closed=False)
    fill(None); stroke(RED, 1.8, dash=[5, 4], arrow="Bar")
    text(ox+cx+186, oy+cy+96, "互斥", 10, RED)
    # 10px 小字扛不住任何贯穿线，删除线一律去掉；"淘汰"靠红叉 + 浅红底表达
    capsule(ox+cx+242, oy+cy+86, 124, 38, BG, REDB, 1.2)
    text(ox+cx+254, oy+cy+109, "AI 直出导图", 10, SUB)
    cross(ox+cx+340, oy+cy+105, 10, RED, 1.8)
    text(ox+cx+18, oy+cy+152, "留下来的是你亲手搭的；划掉的是转手的", 10, TERT)

# --- 右下：标平替 ---
cx, cy = 458, 358
with grp():
    rect(ox+cx, oy+cy, 382, 222, GRAY6, HAIR, 14)
    circle(ox+cx+30, oy+cy+26, 12, BLUE); mid(ox+cx+30, oy+cy+26, "4", 11, BG, "Bold")
    text(ox+cx+50, oy+cy+31, "标平替 · 组合关系", 17, INK, "Bold")
    text(ox+cx+18, oy+cy+56, "= 可以互换，+ 必须绑在一起才成立", 11, TERT)
    capsule(ox+cx+18, oy+cy+86, 74, 30, BG, GRAY2, 1.1); mid(ox+cx+55, oy+cy+101, "豆包桌面", 9, INK)
    circle(ox+cx+108, oy+cy+101, 14, PURPLE); mid(ox+cx+108, oy+cy+101, "=", 13, BG, "Bold")
    capsule(ox+cx+136, oy+cy+86, 74, 30, BG, GRAY2, 1.1); mid(ox+cx+173, oy+cy+101, "WorkBuddy", 9, INK)
    text(ox+cx+18, oy+cy+140, "任选其一即可", 10, TERT)
    capsule(ox+cx+216, oy+cy+86, 66, 30, BLUEL, BLUE, 1.1); mid(ox+cx+249, oy+cy+101, "爬抖音", 9, BLUE)
    circle(ox+cx+298, oy+cy+101, 14, GREEN); plus(ox+cx+298, oy+cy+101, 5.5, BG, 2.0)
    capsule(ox+cx+318, oy+cy+86, 50, 30, BLUEL, BLUE, 1.1); mid(ox+cx+343, oy+cy+101, "公众号", 9, BLUE)
    text(ox+cx+216, oy+cy+140, "必须绑在一起", 10, TERT)
    rect(ox+cx+213, oy+cy+74, 0.8, 86, HAIR)
    text(ox+cx+18, oy+cy+186, "判据：换掉其中一个，图还成不成立。", 10, TERT)

# =====================================================================
# 画板 02 · 人机协同四步 + 正反对照
# 每张卡一组；卡间箭头独立（它是关系，不属于任何一张卡）
# =====================================================================
ox, oy = 940, 0
with locked():
    rect(ox, oy, 900, 620, BG)
    text(ox+60, oy+86, "闭环：你画一张，AI 只改三处", 32, INK, "Bold")
    text(ox+62, oy+116, "主动权在你手里——AI 不许先画，它只能在你画完之后开口", 14, SUB)

STEP_X = [60, 263, 466, 669]
CARD_Y, CARD_W, CARD_H = 138, 170, 152
steps = [
    ("01", "凭记忆手绘", ["不翻原文，凭印象", "在 04 / 05 画布", "搭 4 大区块与连线"]),
    ("02", "AI 四维扫描", None),
    ("03", "靶向重构修正", ["修正错位层级", "补齐断掉的链", "文字转空间坐标"]),
    ("04", "MCP 落盘归档", ["写入 Obsidian", "本地大本营", "跨模型记忆解耦"]),
]
for i, (num, title, body) in enumerate(steps):
    x = ox + STEP_X[i]
    with grp():
        rect(x, oy+CARD_Y, CARD_W, CARD_H, BG, HAIR, 14)
        rect(x+12, oy+CARD_Y+12, 26, 20, BLUE, None, 6)
        mid(x+25, oy+CARD_Y+22, num, 10, BG, "Bold")
        text(x+12, oy+CARD_Y+50, title, 13, INK, "Bold")
        if body:
            for j, ln in enumerate(body):
                text(x+12, oy+CARD_Y+72+j*17, ln, 10, SUB)
        # Step 02 的四个微型胶囊属于这张卡
        if i == 1:
            for j, lb in enumerate(["① 查遗漏 Missing", "② 查层级 Hierarchy",
                                    "③ 查断链 Connection", "④ 压速查表 Cheat"]):
                capsule(x+10, oy+CARD_Y+62+j*20, 150, 17, BLUEL, BLUE, 0.8)
                text(x+18, oy+CARD_Y+74+j*20, lb, 8.5, BLUE)
    if i < 3:
        arrow_r(x+CARD_W+5, oy+CARD_Y+CARD_H/2, 23, BLUE, 1.6)

# 回环反馈：单对象直角折线 + 标注，编成一组
with grp():
    P(f"M{ox+STEP_X[2]+CARD_W/2} {oy+CARD_Y+CARD_H} V{oy+322} "
      f"H{ox+STEP_X[0]+CARD_W/2} V{oy+CARD_Y+CARD_H+14}", closed=False)
    fill(None); stroke(ORANGE, 1.5, dash=[6, 5], arrow="Arrow")
    text(ox+205, oy+338, "暴露知识缺口 · 迭代重画", 11, ORANGE)

# 正反对照双卡
with grp():
    rect(ox+60, oy+380, 380, 170, GRAY6, None, 14)
    circle(ox+84, oy+404, 11, GREEN); check(ox+84, oy+404, 6, BG, 1.8)
    text(ox+102, oy+409, "主动空间向量化（真掌握）", 15, INK, "Bold")
    for j, ln in enumerate(["大脑主动归档空间位置，而不是线性抄写",
                            "画到卡住的地方，就是真实盲区暴露的地方",
                            "考前 5 分钟扫一眼，整张结构瞬间点亮"]):
        text(ox+80, oy+446+j*30, ln, 11, SUB)

with grp():
    rect(ox+458, oy+380, 382, 170, REDL, REDB, 14)
    circle(ox+482, oy+404, 11, RED); cross(ox+482, oy+404, 5.5, BG, 1.8)
    text(ox+500, oy+409, "让 AI 直接生成导图（假努力）", 15, INK, "Bold")
    for j, ln in enumerate(["那是 AI 的脑内结构，不是你的",
                            "零思考阻力 = 零留存，看着爽明天全忘",
                            "最终沦为收藏夹里吃灰的一堆图"]):
        text(ox+478, oy+446+j*30, ln, 11, SUB)

# =====================================================================
# 画板 03 · 工具库（四带 + 右侧色板）
# 底图/分类标签/分隔线锁定；每个零件单独一组，复制走就是完整零件
# =====================================================================
ox, oy = 1880, 0
with locked():
    rect(ox, oy, 900, 620, BG)
    text(ox+60, oy+86, "工具库 · 复制就能画", 32, INK, "Bold")
    text(ox+62, oy+116, "选中 → Ctrl+C → 切到 04 / 05 → Ctrl+V；每种部件都是一个可编辑对象", 13, SUB)
    text(ox+60, oy+152, "节点", 12, TERT, "Bold")
    text(ox+60, oy+266, "连线", 12, TERT, "Bold")
    text(ox+60, oy+412, "算子与角标", 12, TERT, "Bold")
    text(ox+60, oy+492, "容器 · 分组", 12, TERT, "Bold")
    text(ox+700, oy+152, "Apple 语义色", 12, TERT, "Bold")
    hair(ox+60, oy+244, 606)
    hair(ox+60, oy+390, 606)
    hair(ox+60, oy+470, 606)

# --- 带 1：节点（4 个带文字的编组；2 个圆形本身就是一个对象，不组）---
NODE_Y, NODE_H = 184, 40
with grp():
    rect(ox+60, oy+NODE_Y, 96, NODE_H, INK, None, 12); mid(ox+108, oy+NODE_Y+20, "核心节点", 10, BG)
with grp():
    rect(ox+162, oy+NODE_Y, 96, NODE_H, BLUEL, BLUE, 10, sw=1.6); mid(ox+210, oy+NODE_Y+20, "强调节点", 10, BLUE)
with grp():
    rect(ox+264, oy+NODE_Y, 96, NODE_H, BG, GRAY2, 8, sw=1.5); mid(ox+312, oy+NODE_Y+20, "知识节点", 10, INK)
with grp():
    rect(ox+366, oy+NODE_Y, 96, NODE_H, GRAY6, GRAY2, 8, sw=1.0); mid(ox+414, oy+NODE_Y+20, "叶片节点", 10, SUB)
with grp():
    rect(ox+468, oy+NODE_Y, 96, NODE_H, REDL, REDB, 8, sw=1.0); mid(ox+516, oy+NODE_Y+20, "淘汰节点", 10, RED)
circle(ox+588, oy+NODE_Y+20, 18, BLUE)
circle(ox+630, oy+NODE_Y+20, 18, BG, GRAY2, 1.2)

# --- 带 2：连线（每条都是单对象，本身就能整体复制）---
CON_X = [60, 214, 368, 522]
LW = 96
arrow_r(ox+CON_X[0], oy+296, LW, INK, 1.8)
text(ox+CON_X[0], oy+316, "主干箭头", 9.5, TERT)
arrow_r(ox+CON_X[1], oy+296, LW, BLUE, 2.0)
text(ox+CON_X[1], oy+316, "核心流向", 9.5, TERT)
P(f"M{ox+CON_X[2]} {oy+296} H{ox+CON_X[2]+LW}", closed=False)
fill(None); stroke(BLUE, 1.8, arrow="DoubleArrow")
text(ox+CON_X[2], oy+316, "双向协同", 9.5, TERT)
P(f"M{ox+CON_X[3]} {oy+296} H{ox+CON_X[3]+LW}", closed=False)
fill(None); stroke(SUB, 1.6, dash=[6, 5], arrow="ArrowOpen")
text(ox+CON_X[3], oy+316, "虚线反馈", 9.5, TERT)

P(f"M{ox+CON_X[0]} {oy+352} H{ox+CON_X[0]+LW}", closed=False)
fill(None); stroke(RED, 1.8, dash=[5, 4], arrow="Bar")
text(ox+CON_X[0], oy+372, "互斥切断", 9.5, TERT)
P(f"M{ox+CON_X[1]} {oy+352} H{ox+CON_X[1]+LW}", closed=False)
fill(None); stroke(INK, 1.6, arrow="CircleOpen")
text(ox+CON_X[1], oy+372, "挂载归属", 9.5, TERT)
P(f"M{ox+CON_X[2]} {oy+366} V{oy+340} H{ox+CON_X[2]+LW}", closed=False)
fill(None); stroke(INK, 1.6, arrow="Arrow")
text(ox+CON_X[2], oy+372, "L 型分支", 9.5, TERT)
P(f"M{ox+CON_X[3]} {oy+338} V{oy+360} H{ox+CON_X[3]+LW-16} V{oy+342}", closed=False)
fill(None); stroke(SUB, 1.6, dash=[6, 5], arrow="Arrow")
text(ox+CON_X[3], oy+372, "U 型回环", 9.5, TERT)

# --- 带 3：算子与序号 ---
# 序号字符 ①②③④⑤ 自带圆圈，再加圆底就成双圈 —— 所以序号不铺底，直接放大字符
ops = [("①", None, INK), ("②", None, INK), ("③", None, INK), ("④", None, INK), ("⑤", None, INK),
       ("=", PURPLE, BG), ("+", GREEN, BG), ("×", RED, BG), ("!", ORANGE, BG)]
for i, (ch, bgc, fgc) in enumerate(ops):
    cxx = ox + 74 + i * 34
    if bgc:
        with grp():
            circle(cxx, oy+442, 13, bgc)
            mid(cxx, oy+442, ch, 12, fgc, "Bold")
    else:
        mid(cxx, oy+442, ch, 16, fgc, "Bold")
text(ox+380, oy+446, "序号贴在流程节点旁；算子是关系标记，不是连线", 10, TERT)

# --- 带 4：容器 ---
with grp():
    rect(ox+60, oy+512, 180, 76, GRAY6, HAIR, 14, sw=0.8)
    text(ox+60, oy+602, "模块容器", 10, TERT)
with grp():
    rect(ox+250, oy+512, 180, 76, None, GRAY2, 14, dash=[8, 6], sw=1.4)
    text(ox+250, oy+602, "虚线边界", 10, TERT)
with grp():
    rect(ox+440, oy+512, 180, 76, BLUEL, BLUE, 14, sw=1.0)
    text(ox+440, oy+602, "高亮容器", 10, TERT)

# --- 右侧色板：色块 + 色值 + 语义，一组一个颜色 ---
swatches = [(INK, "#1D1D1F", "主干 / 核心"), (BLUE, "#007AFF", "重点 / 主脑"),
            (GREEN, "#34C759", "正向 / 通过"), (ORANGE, "#FF9500", "警示 / 回环"),
            (RED, "#FF3B30", "淘汰 / 互斥"), (PURPLE, "#AF52DE", "平替 / 并列"),
            (GRAY6, "#F2F2F7", "分组 / 背景"), (BLUEL, "#EAF3FF", "强调底 / 高亮"),
            (REDL, "#FFF5F4", "否决底 / 避坑")]
for i, (col, hexv, sem) in enumerate(swatches):
    yy = oy + 172 + i * 40
    with grp():
        if col == GRAY6:
            rect(ox+700, yy, 20, 20, col, GRAY3, 5, sw=0.8)
        else:
            rect(ox+700, yy, 20, 20, col, None, 5)
        text(ox+728, yy+9, hexv, 8.5, SUB)
        text(ox+728, yy+21, sem, 8.5, TERT)

# =====================================================================
# 画板 04 · 四象限空间锚点
# 底图、十字线、象限标题全部锁定；只有中心锚点框可拖动
# =====================================================================
ox, oy = 0, 680
with locked():
    rect(ox, oy, 900, 620, BG)
    text(ox+60, oy+56, "四象限 · 把散点先按空间归位", 20, INK, "Bold")
    text(ox+60, oy+78, "先想「它属于哪个区块」，再动笔。位置错了，连线越画越乱。", 12, TERT)
    P(f"M{ox+450} {oy+100} V{oy+280}", closed=False); fill(None); stroke(HAIR, 1, dash=[6, 6])
    P(f"M{ox+450} {oy+340} V{oy+560}", closed=False); fill(None); stroke(HAIR, 1, dash=[6, 6])
    P(f"M{ox+60} {oy+310} H{ox+380}", closed=False);  fill(None); stroke(HAIR, 1, dash=[6, 6])
    P(f"M{ox+520} {oy+310} H{ox+840}", closed=False); fill(None); stroke(HAIR, 1, dash=[6, 6])

quads = [
    ("区块 A · 底层前提与心法", ["普通人 3 条件：敢学 / 愿学 / 会学", "先解决「为什么学」，再谈怎么学"], 76, 118),
    ("区块 B · 工具基建工作台", ["国产主控 / Grok 主脑 / 垂直爬虫", "Obsidian 做落盘，不做展示"], 470, 118),
    ("区块 C · 五步实战流水线", ["定标 → 摸底 → 20% 前置", "→ 死磕测试 → MCP 落盘"], 76, 452),
    ("区块 D · 顺应人性外挂", ["小成品与集章哄自己继续", "文字图形化 + 视觉纠错"], 470, 452),
]
with locked():
    for title, lines, qx, qy in quads:
        text(ox+qx, oy+qy, title, 13, INK, "Bold")
        for j, ln in enumerate(lines):
            text(ox+qx, oy+qy+20+j*17, ln, 10, TERT)

# 中心锚点：唯一可拖动的对象
with grp():
    rect(ox+380, oy+280, 140, 60, BG, GRAY2, 12, dash=[5, 4], sw=1.2)
    ctext(ox+450, oy+305, "核心命题", 11, INK, "Bold")
    ctext(ox+450, oy+323, "AI 10 倍速学习链路", 9.5, SUB)

# =====================================================================
# 画板 05 · 自由作图（整张锁定，留给用户画）
# =====================================================================
ox, oy = 940, 680
with locked():
    rect(ox, oy, 900, 620, BG)
    for i in range(1, 9):
        xx = ox + i * 100
        rect(xx, oy, 0.8, 8, HAIR); rect(xx, oy+612, 0.8, 8, HAIR)
    for i in range(1, 6):
        yy = oy + i * 100
        rect(ox, yy, 8, 0.8, HAIR); rect(ox+892, yy, 8, 0.8, HAIR)
    text(ox+60, oy+72, "在这里画你自己的图谱", 20, GRAY2, "Bold")
    text(ox+60, oy+96, "从「03-工具库」复制节点和连线，Ctrl+V 贴过来。别回看原文，凭印象画。", 12, GRAY3)

# =====================================================================
# 编组 + 锁定（必须放在所有对象创建之后，否则会打乱 id 推算）
# =====================================================================
for ids in _GROUPS:
    S.append({"id": "object.group", "params": {"ids": ids}})
for ids in _LOCKS:
    S.append({"id": "object.lock", "params": {"ids": ids}})

# =====================================================================
# 保存 + 导出
# =====================================================================
S.append({"id": "file.saveAs", "params": {"path": os.path.join(OUTDIR, "00-知识图谱画布.vectorcraft"), "format": "vectorcraft"}})
for i, (name, *_rest) in enumerate(AB):
    S.append({"id": "document.export", "params": {"path": os.path.join(OUTDIR, f"00-总览-{name}.png"),
                                                  "format": "png", "scale": 2, "artboard": i}})
S.append({"id": "document.export", "params": {"path": os.path.join(OUTDIR, "00-知识图谱画布.pdf"),
                                              "format": "pdf", "range": "all"}})

steps_path = os.path.join(TMP, "workspace_steps.json")
with open(steps_path, "w", encoding="utf-8") as f:
    json.dump(S, f, ensure_ascii=False)
print("steps:", len(S), "| objects:", _NEXT[0]-1, "| groups:", len(_GROUPS),
      "| lock batches:", len(_LOCKS), "| locked objs:", sum(len(x) for x in _LOCKS))

r = subprocess.run([CLI, "run", "--commands", steps_path], capture_output=True, text=True,
                   encoding="utf-8", timeout=280)
for line in r.stdout.splitlines():
    try:
        d = json.loads(line)
        if "error" in json.dumps(d):
            print("ERR:", json.dumps(d, ensure_ascii=False)[:220])
    except Exception:
        pass
print("exit:", r.returncode)
for f in sorted(os.listdir(OUTDIR)):
    if f.startswith("00-"):
        print(" ", f, os.path.getsize(os.path.join(OUTDIR, f)))
