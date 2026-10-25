/* ============================================================
 * vault-push.js — 把 Obsidian 库推到 GitHub
 *
 * 为什么需要它：WorkBuddy 的沙箱代理只放行 api.github.com，
 * github.com 整体不可达，git push 会报 "CONNECT tunnel failed, 502"。
 * 所以改走 GitHub Git Data API：先本地提交，再把同一棵树搬上去。
 *
 * 关键点：远端提交的 parent/tree/author/committer/message 与本地完全一致，
 * 因此推上去之后 SHA 也一致，两边历史不会分叉。
 *
 * 用法：
 *   node tools/vault-push.js                 # 自动提交工作区改动并推送
 *   node tools/vault-push.js -m "提交信息"    # 指定提交信息
 *   node tools/vault-push.js --dry           # 只报告要推什么，不实际推送
 * ============================================================ */
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const VAULT = process.env.VAULT_PATH || 'C:/Users/zhangzining/Documents/Obsidian Vault'
const REPO = process.env.VAULT_REPO || 'opqrssss-byte/obsidian-vault'
const BRANCH = 'main'

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: VAULT, encoding: 'utf8', ...opts })
}

function getToken() {
  const out = execFileSync('bash', ['-c', 'git credential fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  })
  const line = out.split('\n').find((l) => l.startsWith('password='))
  if (!line) throw new Error('取不到 GitHub 凭据，请先在本机 git push 一次以写入凭据管理器')
  return line.slice(9).trim()
}

function makeApi(token) {
  return function gh(method, p, body) {
    const args = [
      '-s', '-m', '60', '-X', method,
      '-H', `Authorization: token ${token}`,
      '-H', 'Accept: application/vnd.github+json',
    ]
    if (body !== undefined) args.push('-d', '@-')
    args.push('https://api.github.com' + p)
    const out = execFileSync('curl', args, {
      input: body !== undefined ? JSON.stringify(body) : undefined,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    try {
      return JSON.parse(out)
    } catch {
      throw new Error(`非 JSON 响应（${p}）：${out.slice(0, 300)}`)
    }
  }
}

/* ---------- ① 本地提交 ---------- */
function commitLocal(message) {
  const status = sh('git', ['status', '--porcelain']).trim()
  if (status) {
    sh('git', ['add', '-A'])
    sh('git', ['commit', '-q', '-m', message])
    console.log('本地已提交：' + message.split('\n')[0])
  } else {
    console.log('工作区干净，跳过提交')
  }
  return sh('git', ['rev-parse', 'HEAD']).trim()
}

/* ---------- ② 远端已有的 blob 集合（避免重复上传）---------- */
function remoteBlobSet(gh, headSha) {
  const set = new Set()
  try {
    let sha = headSha
    // 只比对 head 的完整树即可：树的递归列表里含所有 blob
    const t = gh('GET', `/repos/${REPO}/git/commits/${sha}`)
    const tree = gh('GET', `/repos/${REPO}/git/trees/${t.tree.sha}?recursive=1`)
    ;(tree.tree || []).forEach((e) => {
      if (e.type === 'blob') set.add(e.sha)
    })
  } catch {
    /* 空仓库或网络异常：当作全都要传 */
  }
  return set
}

async function main() {
  const argv = process.argv.slice(2)
  const dry = argv.includes('--dry')
  const mi = argv.indexOf('-m')
  const message = mi > -1 ? argv[mi + 1] : `sync: ${new Date().toLocaleString('zh-CN')}`

  const headSha = commitLocal(message)
  console.log('本地 HEAD：' + headSha.slice(0, 10))

  const token = getToken()
  const gh = makeApi(token)

  // 远端当前 head
  let remoteHead = null
  try {
    const ref = gh('GET', `/repos/${REPO}/git/ref/heads/${BRANCH}`)
    remoteHead = ref.object && ref.object.sha
  } catch {
    /* 空仓库 */
  }

  if (remoteHead === headSha) {
    console.log('远端已是最新，无需推送')
    return
  }

  const remoteBlobs = remoteBlobSet(gh, remoteHead)

  // 本地树（扁平全量 entry）
  const entries = sh('git', ['ls-tree', '-r', '-z', '--full-tree', headSha])
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t')
      const [mode, type, sha] = line.slice(0, tab).split(' ')
      return { path: line.slice(tab + 1), mode, type, sha }
    })

  const needUpload = entries.filter((e) => e.type === 'blob' && !remoteBlobs.has(e.sha))
  console.log(`文件 ${entries.length} 个，需上传 ${needUpload.length} 个`)

  if (dry) {
    needUpload.forEach((e) => console.log('  待传 ' + e.path))
    console.log('（--dry，未实际推送）')
    return
  }

  // 已有 blob 直接复用，只传缺的
  for (const e of needUpload) {
    const buf = fs.readFileSync(path.join(VAULT, e.path))
    const r = gh('POST', `/repos/${REPO}/git/blobs`, {
      content: buf.toString('base64'),
      encoding: 'base64',
    })
    if (!r.sha) throw new Error(`blob 失败：${e.path} → ${JSON.stringify(r).slice(0, 200)}`)
    console.log('  ↑ ' + e.path)
  }

  // 让远端生成树对象（不传 base_tree，用全量 entry，这样 SHA 与本地一致）
  const treeRes = gh('POST', `/repos/${REPO}/git/trees`, { tree: entries })
  if (!treeRes.sha) throw new Error('树创建失败：' + JSON.stringify(treeRes).slice(0, 300))

  const localTreeSha = sh('git', ['rev-parse', `${headSha}^{tree}`]).trim()
  if (treeRes.sha !== localTreeSha) {
    console.warn(`⚠ 远端树 ${treeRes.sha.slice(0, 10)} ≠ 本地树 ${localTreeSha.slice(0, 10)}，历史将与本地分叉`)
  }

  const meta = {
    name: sh('git', ['log', '-1', '--format=%an', headSha]).trim(),
    email: sh('git', ['log', '-1', '--format=%ae', headSha]).trim(),
    date: sh('git', ['log', '-1', '--format=%aI', headSha]).trim(),
    // 取原始 commit 对象的 message 段（含结尾换行）。
    // 不能只用 -m 的文本：git commit 会补一个尾换行，若这里去掉，
    // 远端生成的 SHA 就会与本地不同，两边历史分叉。
    msg: (() => {
      const raw = sh('git', ['cat-file', 'commit', headSha])
      const i = raw.indexOf('\n\n')
      return i > -1 ? raw.slice(i + 2) : raw
    })(),
  }

  const commit = gh('POST', `/repos/${REPO}/git/commits`, {
    message: meta.msg,
    tree: treeRes.sha,
    parents: remoteHead ? [remoteHead] : [],
    author: { name: meta.name, email: meta.email, date: meta.date },
    committer: { name: meta.name, email: meta.email, date: meta.date },
  })
  if (!commit.sha) throw new Error('提交失败：' + JSON.stringify(commit).slice(0, 300))

  if (remoteHead) {
    gh('PATCH', `/repos/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: true })
  } else {
    gh('POST', `/repos/${REPO}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: commit.sha })
  }

  sh('git', ['update-ref', `refs/remotes/origin/${BRANCH}`, commit.sha])

  console.log(`\n推送完成：${commit.sha.slice(0, 10)}${commit.sha === headSha ? '（与本地一致）' : `（本地 ${headSha.slice(0, 10)}，历史有差异）`}`)
}

main().catch((e) => {
  console.error('失败：' + (e.message || e))
  process.exit(1)
})
