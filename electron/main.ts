/**
 * Electron 主进程
 *
 * 职责：
 *  1. 以子进程方式启动后端 Fastify 服务（编译后的 server/dist/server.js）
 *     —— 通过 ELECTRON_RUN_AS_NODE=1 让 Electron 二进制以纯 Node 模式运行后端，
 *        无需单独打包 Node 运行时。Electron 43 内置 Node 24，原生支持 node:sqlite。
 *  2. 创建主窗口加载前端
 *     —— 开发模式：加载 Vite Dev Server（http://localhost:3200）
 *     —— 打包模式：通过自定义 app:// 协议加载 client/dist，
 *        并把 /api、/uploads 请求代理到后端（前端用相对路径，file:// 下会失效）
 *  3. 把数据库、上传目录重定向到 app.getPath('userData')，保证打包后可写
 *  4. PowerMill PowerShell 脚本由 build:electron 复制到 server/dist/scripts/，
 *        后端 powermill.ts 通过相对路径找到它；asar 关闭以便 powershell.exe 执行
 */

import { app, BrowserWindow, protocol, net, dialog } from 'electron'
import { spawn, execSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { ChildProcess } from 'node:child_process'

// ---------- 调试日志（打包后 console 不可见，写入文件诊断启动问题）----------
// 使用 userData 目录确保打包后可写；避免在 app ready 前读取 home 路径在某些 Electron 版本下异常
const DEBUG_LOG = path.join(app.getPath('userData'), 'mtf-debug.log')
try { fs.writeFileSync(DEBUG_LOG, '') } catch {}
function dlog(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { fs.appendFileSync(DEBUG_LOG, line) } catch {}
}
dlog('=== main.ts 模块加载 ===')
dlog(`execPath=${process.execPath}`)
dlog(`platform=${process.platform} arch=${process.arch}`)
dlog(`isPackaged=${app.isPackaged}`)
dlog(`appPath=${app.getAppPath()}`)

// ---------- 常量 ----------
const BACKEND_PORT = 3100
const DEV_SERVER_URL = 'http://localhost:3200'
const BACKEND_ORIGIN = `http://127.0.0.1:${BACKEND_PORT}`
const BACKEND_HEALTH_URL = `${BACKEND_ORIGIN}/api/health`

/** 开发模式判定：未打包即为开发模式（同时受 ELECTRON_DEV 显式开关控制） */
const isDev = !app.isPackaged

// ---------- 运行时状态 ----------
let backendProcess: ChildProcess | null = null
let mainWindow: BrowserWindow | null = null
let backendReady = false

// ---------- 路径辅助 ----------
function getBackendJsPath(): string {
  return path.join(app.getAppPath(), 'server', 'dist', 'server.js')
}

function getClientDistPath(): string {
  return path.join(app.getAppPath(), 'client', 'dist')
}

// ---------- 自定义协议注册（必须在 app ready 之前调用）----------
// app:// 协议：打包模式下加载前端，并把 /api、/uploads 请求代理到后端
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
])

// ---------- 启动页（加载后端/Vite 期间展示）----------
const LOADING_HTML =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(
    `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>启动中</title>
<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;
font-family:'Segoe UI',system-ui,sans-serif;color:#3a4252;background:#f5f7fa}
.box{text-align:center}.spinner{width:44px;height:44px;border:4px solid #dbe3ec;
border-top-color:#1565c0;border-radius:50%;animation:sp 1s linear infinite;margin:0 auto 18px}
@keyframes sp{to{transform:rotate(360deg)}}p{margin:0;font-size:14px}</style></head>
<body><div class="box"><div class="spinner"></div><p>正在启动 CNC 图纸智能匹配系统…</p></div></body></html>`,
  )

// ---------- 启动后端 ----------
function startBackend(): boolean {
  const serverJs = getBackendJsPath()
  const userData = app.getPath('userData')
  dlog(`startBackend: serverJs=${serverJs} exists=${fs.existsSync(serverJs)}`)
  dlog(`startBackend: userData=${userData}`)

  if (!fs.existsSync(serverJs)) {
    dialog.showErrorBox(
      '后端未构建',
      `找不到后端入口：\n${serverJs}\n\n请先运行：npm run build:server`,
    )
    return false
  }

  // 确保数据库目录存在
  const dbDir = path.join(userData, 'data')
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true })
    dlog(`创建数据库目录: ${dbDir}`)
  }
  // 确保上传目录存在
  const uploadDir = path.join(userData, 'uploads')
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true })
    dlog(`创建上传目录: ${uploadDir}`)
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // 用 Electron 自带 Node 运行后端脚本
    ELECTRON_RUN_AS_NODE: '1',
    // 后端监听端口（与 Vite 代理目标一致）
    MTF_PORT: String(BACKEND_PORT),
    // 数据库 & 上传目录重定向到 userData（用户独立、可写）
    MTF_DB_PATH: path.join(dbDir, 'templates.db'),
    MTF_UPLOAD_DIR: uploadDir,
    MTF_CONFIG_PATH: path.join(dbDir, 'config.json'),
    // 把 API 配置透传给后端（开发时来自 .env，打包后也可由 .env 或用户配置覆盖）
    MTF_SILICONFLOW_API_KEY: process.env.MTF_SILICONFLOW_API_KEY || '',
    MTF_SILICONFLOW_BASE_URL: process.env.MTF_SILICONFLOW_BASE_URL || 'https://api.siliconflow.cn/v1',
    MTF_EMBEDDING_MODEL: process.env.MTF_EMBEDDING_MODEL || 'Qwen/Qwen3-VL-Embedding-8B',
  }

  console.log('[electron] 启动后端：', serverJs)
  let stderrBuffer = ''
  // cwd 设为 Electron 可执行文件所在目录，避免 ELECTRON_RUN_AS_NODE=1 时找不到 icudtl.dat 等资源文件
  const backendCwd = path.dirname(process.execPath)
  dlog(`后端 cwd=${backendCwd}`)
  backendProcess = spawn(process.execPath, [serverJs], {
    env,
    cwd: backendCwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  dlog(`后端进程已 spawn, pid=${backendProcess.pid}`)

  backendProcess.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(`[backend] ${chunk}`)
  })
  backendProcess.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    process.stderr.write(`[backend] ${text}`)
    stderrBuffer += text
  })

  backendProcess.on('exit', (code, signal) => {
    console.log(`[electron] 后端退出 code=${code} signal=${signal}`)
    dlog(`后端进程退出 code=${code} signal=${signal}`)
    dlog(`后端 stderr: ${stderrBuffer.trim().substring(0, 500)}`)
    backendProcess = null
    if (!backendReady && !(app as any).isQuitting) {
      dialog.showErrorBox(
        '后端启动失败',
        `后端进程异常退出（code=${code}）。

错误输出:
${stderrBuffer.trim().substring(0, 1000) || '(无 stderr 输出)'}`,
      )
    }
  })

  return true
}

/** 终止后端进程树（Windows 下递归杀掉，含 PowerShell 子进程） */
function killBackend(): void {
  if (!backendProcess || backendProcess.pid == null) return
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${backendProcess.pid} /T /F`, { stdio: 'ignore' })
    } else {
      process.kill(backendProcess.pid, 'SIGTERM')
    }
  } catch (err) {
    console.error('[electron] 终止后端失败：', err)
  }
  backendProcess = null
}

// ---------- 等待服务就绪 ----------
async function waitForUrl(url: string, timeoutMs = 30000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await net.fetch(url, { method: 'GET' })
      if (res.ok) return true
    } catch {
      // 尚未就绪，继续重试
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  return false
}

// ---------- MIME 类型 ----------
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
}

/** 读取 client/dist 下的静态文件并返回带正确 Content-Type 的响应 */
async function serveFile(filePath: string): Promise<Response> {
  const ext = path.extname(filePath).toLowerCase()
  const contentType = MIME[ext] || 'application/octet-stream'
  const body = await fs.promises.readFile(filePath)
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': contentType },
  })
}

// ---------- 注册 app:// 协议处理器 ----------
function registerAppProtocol(): void {
  const clientDist = getClientDistPath()
  const base = path.resolve(clientDist)

  protocol.handle('app', async (request) => {
    const reqUrl = new URL(request.url)
    let pathname = decodeURIComponent(reqUrl.pathname)
    if (pathname === '' || pathname === '/') pathname = '/index.html'

    // 1) /api 与 /uploads 代理到后端
    if (
      pathname === '/api' ||
      pathname.startsWith('/api/') ||
      pathname.startsWith('/uploads/')
    ) {
      const target = `${BACKEND_ORIGIN}${reqUrl.pathname}${reqUrl.search}`
      const init = {
        method: request.method,
        headers: request.headers,
      } as RequestInit
      const hasBody =
        request.method !== 'GET' &&
        request.method !== 'HEAD' &&
        !!request.body
      if (hasBody) {
        // 转发请求体（multipart / JSON 等），流式透传
        ;(init as any).body = request.body as any
        ;(init as any).duplex = 'half'
      }
      try {
        const upstream = await net.fetch(target, init)
        return new Response(upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: upstream.headers,
        })
      } catch (err) {
        return new Response(`后端请求失败: ${(err as Error).message}`, {
          status: 502,
        })
      }
    }

    // 2) 其余请求：返回 client/dist 下的静态文件
    const file = path.resolve(base, '.' + pathname) // pathname 以 / 开头
    if (!file.startsWith(base + path.sep)) {
      return new Response('Forbidden', { status: 403 })
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      // 单页应用回退到 index.html
      const indexFile = path.join(base, 'index.html')
      if (fs.existsSync(indexFile)) return serveFile(indexFile)
      return new Response('Not Found', { status: 404 })
    }
    return serveFile(file)
  })
}

// ---------- 创建主窗口 ----------
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    resizable: true,
    title: 'CNC 图纸智能匹配系统',
    backgroundColor: '#f5f7fa',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/** 加载真正的前端页面（开发/打包分支） */
async function loadMainWindow(): Promise<void> {
  if (!mainWindow) return
  if (isDev) {
    await mainWindow.loadURL(DEV_SERVER_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    await mainWindow.loadURL('app://localhost/index.html')
  }
}

// ---------- 单实例锁（避免重复启动导致后端端口冲突）----------
const gotLock = app.requestSingleInstanceLock()
dlog(`requestSingleInstanceLock=${gotLock}`)

if (!gotLock) {
  dlog('未获取到单实例锁，退出')
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  // ---------- 应用入口 ----------
  app.whenReady().then(async () => {
    dlog('app.whenReady 触发')

    // 仅打包模式需要 app:// 协议
    if (!isDev) {
      const clientDist = getClientDistPath()
      const indexPath = path.join(clientDist, 'index.html')
      dlog(`检查前端入口: ${indexPath} exists=${fs.existsSync(indexPath)}`)
      if (!fs.existsSync(indexPath)) {
        dialog.showErrorBox(
          '前端未构建',
          `找不到前端入口：\n${indexPath}\n\n请先运行：npm run build:client`,
        )
      }
      try {
        registerAppProtocol()
        dlog('registerAppProtocol 完成')
      } catch (err) {
        dlog(`registerAppProtocol 异常: ${(err as Error).stack}`)
      }
    }

    // 启动后端
    dlog('准备启动后端')
    if (!startBackend()) {
      dlog('startBackend 返回 false，退出')
      app.quit()
      return
    }
    dlog('startBackend 返回 true')

    // 创建窗口并先显示启动页
    try {
      createWindow()
      dlog('createWindow 完成')
    } catch (err) {
      dlog(`createWindow 异常: ${(err as Error).stack}`)
    }
    if (mainWindow) {
      try {
        await mainWindow.loadURL(LOADING_HTML)
        dlog('loading 页加载完成')
      } catch (err) {
        dlog(`loading 页加载异常: ${(err as Error).message}`)
      }
    }

    // 等待后端就绪
    dlog(`开始等待后端: ${BACKEND_HEALTH_URL}`)
    const backendOk = await waitForUrl(BACKEND_HEALTH_URL, 30000)
    backendReady = backendOk
    dlog(`后端就绪=${backendOk}`)
    if (!backendOk) {
      dialog.showErrorBox(
        '后端启动超时',
        `在 30 秒内未收到后端健康检查响应（${BACKEND_HEALTH_URL}）。\n请查看控制台日志。`,
      )
      app.quit()
      return
    }

    // 开发模式：等待 Vite Dev Server
    if (isDev) {
      const devOk = await waitForUrl(DEV_SERVER_URL, 60000)
      if (!devOk) {
        dialog.showErrorBox(
          '前端开发服务器未就绪',
          `未能连接 ${DEV_SERVER_URL}\n请确认 Vite 已启动。`,
        )
      }
    }

    try {
      await loadMainWindow()
      dlog('loadMainWindow 完成')
    } catch (err) {
      dlog(`loadMainWindow 异常: ${(err as Error).stack}`)
      dialog.showErrorBox(
        '主界面加载失败',
        `无法加载应用主界面：${(err as Error).message}\n\n详细日志：${DEBUG_LOG}`,
      )
      app.quit()
      return
    }
  })

  app.on('window-all-closed', () => {
    dlog('window-all-closed 触发')
    // macOS 上习惯保留进程，其余平台直接退出
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
      void loadMainWindow()
    }
  })

  app.on('before-quit', () => {
    ;(app as any).isQuitting = true
    killBackend()
  })

  process.on('uncaughtException', (err) => {
    console.error('[electron] uncaughtException:', err)
    dlog(`uncaughtException: ${err.stack || err.message}`)
  })
}
