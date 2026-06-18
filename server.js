/**
 * 本地HTTP服务器
 * 提供API让浏览器触发git分支抓取
 * 
 * 使用方法：
 * node server.js
 * 
 * 然后在浏览器中访问 http://localhost:3000
 */

const http = require('http')
const fs = require('fs')
const path = require('path')
const { execSync, exec } = require('child_process')
const url = require('url')

const PORT = 1949
const BASE_DIR = __dirname

// Windows兼容：在指定目录执行git命令
function gitExec(cwd, command) {
  const opts = { 
    encoding: 'utf8', 
    cwd: cwd,
    maxBuffer: 50 * 1024 * 1024
  }
  try {
    return execSync(command, opts).trim()
  } catch (e) {
    return ''
  }
}

// 计算近1个月的日期
function getThreeMonthsAgo() {
  const date = new Date()
  date.setMonth(date.getMonth() - 1)
  return date.toISOString().split('T')[0]
}

// 获取git分支（优化版：一条命令获取所有信息）
function fetchBranches(projectPath, gitUser) {
  const fullPath = path.resolve(projectPath)
  
  if (!fs.existsSync(fullPath)) {
    return { error: '路径不存在', path: fullPath }
  }
  
  const gitDir = path.join(fullPath, '.git')
  if (!fs.existsSync(gitDir)) {
    return { error: '不是git仓库', path: fullPath }
  }
  
  const dateStr = getThreeMonthsAgo()
  
  try {
    // 一次性获取所有分支的名称、最新commit hash、作者、日期、commit信息
    const refOutput = gitExec(fullPath,
      `git for-each-ref refs/remotes/origin/ refs/heads/ ` +
      `--format="%(refname:short)|%(objectname:short)|%(authorname)|%(authordate:short)|%(subject)" ` +
      `--sort=-authordate --count=300`
    )

    if (!refOutput) {
      return { error: '无法获取分支列表', path: fullPath }
    }

    const excludePatterns = /^(master|test|dev|main|release|staging|hotfix|uat)(\b|_)/
    const seen = new Set()
    const branches = []

    refOutput.split('\n').forEach(line => {
      const parts = line.split('|')
      if (parts.length < 5) return

      const refName = parts[0].trim()
      const hash = parts[1].trim()
      const author = parts[2].trim()
      const date = parts[3].trim()
      const message = parts.slice(4).join('|').trim()

      // 过滤非功能分支
      if (excludePatterns.test(refName)) return

      // 过滤 origin/ 开头及名为 origin 的分支
      if (refName === 'origin' || refName.startsWith('origin/')) return

      // 过滤日期（3个月前的数据不显示）
      if (date < dateStr) return

      // 过滤用户
      if (gitUser && author !== gitUser) return

      // 去重（同名分支只保留最新的）
      if (seen.has(refName)) return
      seen.add(refName)

      branches.push({
        branch: refName,
        author: author,
        date: date,
        message: message,
        isRemote: refName.includes('/')
      })
    })

    return {
      path: fullPath,
      branches: branches
    }
  } catch (e) {
    return { error: e.message, path: fullPath }
  }
}

// 处理HTTP请求
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true)
  const pathname = parsedUrl.pathname
  
  // 设置CORS头
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200)
    res.end()
    return
  }
  
  // API: 获取分支
  if (pathname === '/api/branches' && req.method === 'GET') {
    const projectPath = parsedUrl.query.path
    const gitUser = parsedUrl.query.user
    
    if (!projectPath) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: '缺少项目路径参数' }))
      return
    }
    
    const result = fetchBranches(projectPath, gitUser)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
    return
  }
  
  // API: 获取当前git用户
  if (pathname === '/api/git-user' && req.method === 'GET') {
    try {
      const gitUser = execSync('git config user.name', { encoding: 'utf8' }).trim()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ user: gitUser }))
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ user: null, error: '无法获取git用户名' }))
    }
    return
  }
  
  // 静态文件服务
  let filePath = pathname === '/' ? '/todo-release.html' : pathname
  filePath = decodeURIComponent(filePath)
  filePath = path.join(BASE_DIR, filePath)
  
  // 安全检查：防止访问上级目录
  if (!filePath.startsWith(BASE_DIR)) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }
  
  // 检查文件是否存在
  if (!fs.existsSync(filePath)) {
    res.writeHead(404)
    res.end('Not Found')
    return
  }
  
  // 读取并返回文件
  const ext = path.extname(filePath)
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
  }
  
  const contentType = mimeTypes[ext] || 'text/plain'
  res.writeHead(200, { 'Content-Type': contentType })
  res.end(fs.readFileSync(filePath))
})

function startServer(port) {
  server.listen(port, () => {
    console.log(`\n========================================`)
    console.log(`发版小助手本地服务器已启动`)
    console.log(`========================================`)
    console.log(`\n浏览器已自动打开: http://localhost:${port}`)
    console.log(`\n按 Ctrl+C 停止服务器\n`)

    const cmd = process.platform === 'win32'
      ? `start "" http://localhost:${port}`
      : process.platform === 'darwin'
        ? `open http://localhost:${port}`
        : `xdg-open http://localhost:${port}`
    exec(cmd, (err) => {
      if (err) console.log(`手动打开: http://localhost:${port}`)
    })
  })

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`端口 ${port} 已被占用，尝试端口 ${port + 1} ...`)
      server.close()
      startServer(port + 1)
    } else {
      console.error('服务器启动失败:', err.message)
      process.exit(1)
    }
  })
}

startServer(PORT)