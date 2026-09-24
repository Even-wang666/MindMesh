import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import electron from 'electron'

const workspace = resolve(import.meta.dirname, '..')
const output = join(workspace, 'docs', 'screenshots')
const userData = mkdtempSync(join(tmpdir(), 'mindmesh-readme-'))
mkdirSync(output, { recursive: true })

const delay = (ms) => new Promise((done) => setTimeout(done, ms))
async function until(task, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      const value = await task()
      if (value) return value
    } catch { /* Electron may still be starting. */ }
    await delay(200)
  }
  throw new Error('等待 MindMesh 截图页面超时')
}

async function freePort() {
  const server = createServer()
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  await new Promise((done) => server.close(done))
  return port
}

async function connect(url) {
  const socket = new WebSocket(url)
  await new Promise((resolveReady, reject) => {
    socket.addEventListener('open', resolveReady, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let nextId = 0
  const pending = new Map()
  socket.addEventListener('message', ({ data }) => {
    const reply = JSON.parse(data)
    const request = pending.get(reply.id)
    if (!request) return
    pending.delete(reply.id)
    if (reply.error) request.reject(new Error(reply.error.message))
    else request.resolve(reply.result)
  })
  return {
    socket,
    call(method, params = {}) {
      const id = ++nextId
      return new Promise((resolveCall, reject) => {
        pending.set(id, { resolve: resolveCall, reject })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
  }
}

const port = await freePort()
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.DEEPSEEK_API_KEY
const app = spawn(electron, ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], {
  cwd: workspace, env, windowsHide: true, stdio: 'ignore',
})
let client
try {
  const page = await until(async () => {
    const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
    return pages.find((item) => item.type === 'page' && item.url.includes('renderer/index.html'))
  })
  client = await connect(page.webSocketDebuggerUrl)
  const call = (method, params) => client.call(method, params)
  const evaluate = async (expression) => {
    const reply = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.text)
    return reply.result.value
  }
  await call('Page.enable')
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 960, deviceScaleFactor: 1, mobile: false,
  })
  await until(() => evaluate('Boolean(window.mindmesh && document.querySelector(".app-shell"))'))
  await delay(500)

  async function capture(name) {
    const screenshot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
    writeFileSync(join(output, name), Buffer.from(screenshot.data, 'base64'))
  }
  async function openNav(label, selector) {
    await evaluate(`Array.from(document.querySelectorAll('.primary-nav button')).find(button => button.textContent.trim() === ${JSON.stringify(label)}).click()`)
    await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`))
    await delay(300)
  }

  await capture('private-chat.png')
  await openNav('协作空间', '.space-page')
  await capture('collaboration-space.png')
  await openNav('智能体', '.management-page .agent-table-row')
  await capture('agent-management.png')
  await openNav('技能', '.catalog-grid article')
  await capture('skill-library.png')
  await openNav('工具', '.catalog-grid article')
  await capture('tool-library.png')
  await openNav('设置', '.settings-page')
  await capture('settings.png')
} finally {
  client?.socket.close()
  if (app.exitCode === null) {
    app.kill()
    await new Promise((done) => app.once('exit', done))
  }
  const tempRoot = resolve(tmpdir()) + sep
  if (resolve(userData).startsWith(tempRoot)) {
    rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}
