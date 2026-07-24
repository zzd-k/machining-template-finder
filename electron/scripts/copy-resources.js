/**
 * 复制 PowerMill PowerShell 脚本到 server/dist/scripts/
 *
 * 原因：后端 services/powermill.ts 通过 __dirname 相对路径查找
 *   server/dist/scripts/powermill.ps1（编译后位置）。
 * tsc 只编译 .ts，不会把 .ps1 复制到 dist，因此需要在构建后手动复制，
 * 保证开发模式（运行 server/dist/server.js）与打包模式都能找到脚本。
 *
 * 由根 package.json 的 build:electron 脚本调用：
 *   tsc -p electron/tsconfig.json && node electron/scripts/copy-resources.js
 */
const fs = require('fs')
const path = require('path')

const SRC_DIR = path.join(__dirname, '..', '..', 'server', 'src', 'scripts')
const DEST_DIR = path.join(__dirname, '..', '..', 'server', 'dist', 'scripts')

function copyScripts() {
  if (!fs.existsSync(SRC_DIR)) {
    console.warn('[copy-resources] 源脚本目录不存在：', SRC_DIR)
    return
  }

  fs.mkdirSync(DEST_DIR, { recursive: true })

  const files = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.ps1'))
  if (files.length === 0) {
    console.warn('[copy-resources] 未在源目录找到 .ps1 脚本')
    return
  }

  for (const file of files) {
    const src = path.join(SRC_DIR, file)
    const dest = path.join(DEST_DIR, file)
    fs.copyFileSync(src, dest)
    console.log(
      `[copy-resources] ${path.relative(process.cwd(), src)} -> ${path.relative(process.cwd(), dest)}`,
    )
  }

  console.log(`[copy-resources] 已复制 ${files.length} 个 PowerShell 脚本到 server/dist/scripts/`)
}

copyScripts()
