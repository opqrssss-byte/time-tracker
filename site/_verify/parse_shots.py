# -*- coding: utf-8 -*-
"""运行 html skill 的 shot.py 自检并解析 overlappingText 明细。
用法：python site\_verify\parse_shots.py
注意：
- PowerShell 重定向会污染 stdout（UTF-8 BOM），必须用 subprocess capture 而不是 > 重定向
- shot.py 路径若在本机失效，按 html skill 的 SKILL.md 重新定位 scripts/shot.py
- 本机 playwright python 包未装时 shot.py 会走 chrome_cli 降级模式（engineDegraded=true），可用
"""
import subprocess, json, io, os

_HERE = os.path.dirname(os.path.abspath(__file__))
SHOT_PY = r'C:\Users\zhangzining\AppData\Local\Doubao\User Data\Profile 1\.doubao\agent_mode\workspace\.skills\html\scripts\shot.py'
HTML = os.path.join(os.path.dirname(_HERE), 'lab-arc.html')   # site\lab-arc.html

out = subprocess.run(
    ['python', SHOT_PY, HTML],
    capture_output=True, text=True, encoding='utf-8', errors='replace')
print('exit:', out.returncode)
try:
    d = json.loads(out.stdout)
    for name in ('desktop', 'mobile'):
        shot = d['shots'][name]
        print('==', name, '== consoleErrors:', shot['consoleErrors'])
        ov = shot.get('overlappingText', [])
        print('overlapping count:', len(ov))
        for o in ov:
            a, b = o['a'], o['b']
            print('  [%s|%s] rect=%s x [%s|%s] rect=%s  cover=%s' % (
                a['tag'], a['text'], a['rect'], b['tag'], b['text'], b['rect'], o['coverRatio']))
except Exception as e:
    print('PARSE FAIL:', e)
    print(out.stdout[:2000])
