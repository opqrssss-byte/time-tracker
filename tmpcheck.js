
const ROW_H=28, n=7, VISIBLE=2
const norm=(i,off)=>{let d=i-off;return d-n*Math.round(d/n)}
let bad=0, teleports=[]
for(let i=0;i<n;i++){
  let prev=null
  for(let off=-20;off<=30;off++){
    const d=norm(i,off), vis=Math.abs(d)<=VISIBLE+0.5
    if(!vis){ prev=null; continue }              // 隐藏 → 断开序列（跳变允许发生在这里）
    if(prev!==null && Math.abs(d-prev)>1) { bad++; teleports.push('分类'+i+' off='+off+' y:'+(prev*ROW_H)+'→'+(d*ROW_H)) }
    prev=d
  }
}
console.log('可见期间的位移超一格次数 =', bad, bad===0?'✔ 零跳跃':'✘')
if(bad) console.log(teleports.join('
'))
const counts=[]
for(let off=0;off<=30;off++){let c=0;for(let i=0;i<n;i++)if(Math.abs(norm(i,off))<=VISIBLE+0.5)c++;counts.push(c)}
console.log('可见条数范围 =', Math.min(...counts), '~', Math.max(...counts), (Math.min(...counts)>=4?'✔ 始终≥4条':'✘ 会变少'))
