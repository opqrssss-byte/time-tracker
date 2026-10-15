# -*- coding: utf-8 -*-
r"""lab-arc.html 验证（口径 = v16.7 已验收基线）：
1) 抽出 <script> 做 node 语法检查
2) 纯函数穷举：56 个 frac 采样 × 14 条 = 287 行断言
   四角 fit / 无穿心(贴弦) / w>16 / 文字余量 / 有符号 dRaw 垂直间距 / 分类不重复 / yOuter<=LIMIT
用法：python site\_verify\verify_arc.py
依赖：node（在 PATH）、python 标准库。lab-arc.html 位置 = 本文件上级目录的 site\lab-arc.html
（docstring 中反斜杠仅作展示，无转义含义）
"""
import io, re, subprocess, os

_HERE = os.path.dirname(os.path.abspath(__file__))
path = os.path.join(os.path.dirname(_HERE), 'lab-arc.html')   # site\lab-arc.html
tmp = os.path.join(_HERE, 'tmp_check.js')

s = io.open(path, encoding='utf-8').read()
m = re.search(r'<script>(.*?)</script>', s, re.S)
io.open(tmp, 'w', encoding='utf-8').write(m.group(1))
r = subprocess.run(['node', '--check', tmp], capture_output=True, text=True)
print('== node --check == exit:', r.returncode)
if r.stderr: print(r.stderr)

test = r'''
const LIMIT = 72, ROW_H = 24, N = 7, VISIBLE = 2;
const CATS = [ {name:'工作',color:'#4F8CFF',dur:'2:15'},{name:'学习',color:'#9B6DFF',dur:'45m'},{name:'运动',color:'#2FBF71',dur:'20m'},{name:'生活',color:'#F2A93B',dur:'1:05'},{name:'阅读',color:'#23B8D5',dur:'35m'},{name:'写作',color:'#F06EAA',dur:'10m'},{name:'摸鱼',color:'#8a91a3',dur:'5m'} ];
const LV = [{h:24,nm:13,du:11,op:1.00,blur:0.0},{h:20,nm:11,du:9,op:0.94,blur:0.0},{h:16,nm:10,du:8.5,op:0.60,blur:1.6},{h:14,nm:9,du:8,op:0.30,blur:2.6}];
function paramsAt(a){const i=Math.min(2,Math.floor(a));const t=a-i;const A=LV[i],B=LV[i+1];
  return {h:A.h+(B.h-A.h)*t, nm:A.nm+(B.nm-A.nm)*t, du:A.du+(B.du-A.du)*t, op:A.op+(B.op-A.op)*t, blur:A.blur+(B.blur-A.blur)*t};}
const inC=(x,y)=>x*x+y*y<=LIMIT*LIMIT+1e-6;
function fitsAll(x,yT,yB,w){return inC(x,yT)&&inC(x+w,yT)&&inC(x,yB)&&inC(x+w,yB);}

let fails=0, checked=0, visMin=99, visMax=0;
for (let fi=0; fi<56; fi++){
  const frac=fi/8; let vis=0; const seen=new Set(); const rows=[];
  for (let k=0; k<N*2; k++){
    const dRaw=(k-VISIBLE)-frac; const a=Math.abs(dRaw);
    if (a>VISIBLE+0.5) continue;
    vis++;
    if (seen.has(k%N)){fails++;console.log('FAIL dup-cat frac='+frac+' k='+k);}
    seen.add(k%N);
    const c=CATS[k%N]; const p=paramsAt(a);
    const yT=-p.h/2, yB=p.h/2;
    const wName=c.name.length*p.nm+3;
    const wDur=c.dur.length*p.du*0.6+3;
    const wText=wName+wDur+14;
    const fadeT=Math.max(0,Math.min(1,(a-0.9)/0.6));
    const shrinkT=Math.max(0,Math.min(1,(a-1.5)/0.3));
    const wantW=a<1.5?wText:wText+(26-wText)*shrinkT;
    const realY=dRaw*ROW_H;
    const ryT=realY-p.h/2, ryB=realY+p.h/2;
    const yOuter=Math.max(Math.abs(ryT),Math.abs(ryB));
    if (yOuter>LIMIT){fails++;console.log('FAIL out-of-circle frac='+frac+' k='+k+' yOuter='+yOuter.toFixed(1));}
    const xL=-Math.sqrt(Math.max(0,LIMIT*LIMIT-yOuter*yOuter));
    let w=wantW; while (w>16 && !fitsAll(xL,ryT,ryB,w)) w-=1;
    if (xL>-2){fails++;console.log('FAIL pierce frac='+frac+' k='+k+' xL='+xL.toFixed(1));}
    if (!fitsAll(xL,ryT,ryB,w)){fails++;console.log('FAIL fit frac='+frac+' k='+k+' w='+w);}
    if (w<=16){fails++;console.log('FAIL narrow frac='+frac+' k='+k+' w='+w);}
    if (a<1.5 && w<wText){fails++;console.log('FAIL text-overflow frac='+frac+' k='+k+' w='+w.toFixed(1)+' wText='+wText.toFixed(1));}
    if (a<1.5 && w-wName-wDur-12 < 0){fails++;console.log('FAIL text-gap frac='+frac+' k='+k);}
    rows.push({k,d:dRaw,h:p.h});
    checked++;
  }
  for (let i=0;i<rows.length;i++) for (let j=0;j<rows.length;j++){
    if (i===j) continue;
    const gap=Math.abs(rows[i].d-rows[j].d)*ROW_H;
    const sum=(rows[i].h+rows[j].h)/2;
    if (gap<sum-0.01){fails++;console.log('FAIL v-overlap frac='+frac+' rows '+rows[i].k+','+rows[j].k+' gap='+gap.toFixed(2)+' sum='+sum.toFixed(2));}
  }
  visMin=Math.min(visMin,vis); visMax=Math.max(visMax,vis);
}
console.log('rows checked: '+checked+'  visible per frame: min='+visMin+' max='+visMax);
console.log(fails===0?'PASS':'FAILS: '+fails);
'''
tp = os.path.join(_HERE, 'tmp_check.test.js')
io.open(tp, 'w', encoding='utf-8').write(test)
r2 = subprocess.run(['node', tp], capture_output=True, text=True)
print('== pure-function test == exit:', r2.returncode)
print(r2.stdout)
if r2.stderr: print(r2.stderr)
