import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

const workspace = resolve(fileURLToPath(new URL('..', import.meta.url)))
const userData = mkdtempSync(join(tmpdir(), 'mindmesh-e2e-'))
const executable = process.env.MINDMESH_E2E_EXE ?? electron
const securityOnly = process.argv.includes('--security-only')
const key = process.env.DEEPSEEK_API_KEY
if (!key && !securityOnly) throw new Error('请先设置 DEEPSEEK_API_KEY')

const delay = (ms) => new Promise((done) => setTimeout(done, ms))
async function until(task, timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      const result = await task()
      if (result) return result
    } catch { /* App and CDP may still be starting. */ }
    await delay(300)
  }
  throw new Error('等待 Electron 响应超时')
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
    if (!reply.id) return
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

async function runRound(round) {
  const port = await freePort()
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`]
  const app = spawn(executable, process.env.MINDMESH_E2E_EXE ? args : ['.', ...args], {
    cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  app.stdout.on('data', (chunk) => { log += chunk.toString() })
  app.stderr.on('data', (chunk) => { log += chunk.toString() })
  let client
  try {
    const page = await until(async () => {
      if (app.exitCode !== null) throw new Error(`Electron 已退出：${app.exitCode}`)
      const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      return pages.find((item) => item.type === 'page' && item.url.includes('renderer/index.html'))
    }, 30_000)
    client = await connect(page.webSocketDebuggerUrl)
    const evaluate = async (expression) => {
      const reply = await client.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text)
      return reply.result.value
    }
    await until(() => evaluate('Boolean(window.mindmesh?.chat && document.querySelector(".composer textarea"))'))
    if (securityOnly) {
      const policy = await evaluate('document.querySelector(\'meta[http-equiv="Content-Security-Policy"]\')?.content')
      assert.match(policy, /script-src 'self'/)
      await evaluate('setTimeout(() => window.close(), 100)')
      await until(() => app.exitCode !== null, 20_000)
      console.log('Electron sandboxed preload and CSP: OK')
      return
    }
    assert.equal(await evaluate('window.mindmesh.runtime.status().then(x => x.state)'), 'ready')
    if (round === 2) {
      const previous = await evaluate(`(async () => {
        const agent = (await window.mindmesh.agents.list())[0]
        return window.mindmesh.chat.messages('private', agent.id).then(messages => messages.length)
      })()`)
      assert.ok(previous >= 2, '重启后私聊记录丢失')
    }

    async function sendFromComposer(message) {
      await evaluate(`(() => {
        const input = document.querySelector('.composer textarea')
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
        setter.call(input, ${JSON.stringify(message)})
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })()`)
      await until(() => evaluate('!document.querySelector(".composer-actions button").disabled'))
      await evaluate('document.querySelector(".composer-actions button").click()')
    }

    const privateMarker = `MM_PRIVATE_${Date.now()}`
    await sendFromComposer(`请只回复 ${privateMarker}`)
    try {
      const outcome = await until(() => evaluate(`(() => {
        if (Array.from(document.querySelectorAll('.message.agent > div > .message-body')).some(x => x.textContent.includes(${JSON.stringify(privateMarker)}))) return 'ok'
        if (document.querySelector('.message.system')?.textContent.includes('回复失败')) return 'failed'
        return null
      })()`), 75_000)
      assert.equal(outcome, 'ok', '私聊返回了失败消息')
    } catch (error) {
      console.error('Private chat messages:', await evaluate('Array.from(document.querySelectorAll(".messages .message")).map(x => x.textContent.slice(0, 240))'))
      throw error
    }
    console.log('Electron private chat UI: OK')

    await evaluate(`Array.from(document.querySelectorAll('.primary-nav button')).find(button => button.textContent.trim() === '协作空间').click()`)
    await until(() => evaluate('Boolean(document.querySelector(".space-page .composer textarea"))'))
    if (round === 2) await until(() => evaluate('document.querySelectorAll(".space-page .message.agent").length >= 2'))
    const existingSpaceReplies = await evaluate('document.querySelectorAll(".space-page .message.agent").length')
    const spaceMarker = `MM_SPACE_${Date.now()}`
    await sendFromComposer(`@Researcher @Developer 请分别只回复 ${spaceMarker}`)
    await until(() => evaluate(`document.querySelectorAll(".space-page .message.agent:has(header time)").length === ${existingSpaceReplies + 2}`), 180_000)
    const spaceMessages = await evaluate('Array.from(document.querySelectorAll(".space-page .message.agent > div > .message-body")).map(x => x.textContent)')
    assert.equal(spaceMessages.length, existingSpaceReplies + 2, 'Space 双 Agent 回复失败')
    console.log(`Electron Space collaboration UI round ${round}: OK`)

    if (round === 2 || process.env.MINDMESH_E2E_RESTART !== '1') {
      await evaluate("document.querySelector('.space-page .chat-header button').click()")
      await until(() => evaluate('Boolean(document.querySelector(".wizard.compact input"))'))
      await evaluate(`(() => {
        const input = document.querySelector('.wizard.compact input')
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'E2E 编辑空间')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })()`)
      await evaluate('document.querySelector(\'.member-choices button[aria-label="Developer"]\').click()')
      await until(() => evaluate('document.querySelector(\'.member-choices button[aria-label="Developer"]\')?.getAttribute("aria-pressed") === "false"'))
      await evaluate("document.querySelector('.wizard.compact footer .primary-button').click()")
      await until(() => evaluate('document.querySelector(".space-page h1")?.textContent === "E2E 编辑空间"'))
      const edited = await evaluate(`(async () => {
        const space = (await window.mindmesh.spaces.list())[0]
        return { name: space.name, members: space.memberIds.length }
      })()`)
      assert.deepEqual(edited, { name: 'E2E 编辑空间', members: 1 })
      console.log('Electron Space edit UI: OK')

      await evaluate(`Array.from(document.querySelectorAll('.primary-nav button')).find(button => button.textContent.trim() === '对话').click()`)
      await until(() => evaluate('Boolean(document.querySelector(".chat-page .chat-header button"))'))
      const agentCountBeforeDelete = await evaluate('window.mindmesh.agents.list().then(agents => agents.length)')
      await evaluate("document.querySelector('.chat-page .chat-header button').click()")
      await until(() => evaluate('Boolean(document.querySelector(".agent-drawer .danger-button"))'))
      await evaluate("window.confirm = () => true; document.querySelector('.agent-drawer .danger-button').click()")
      await until(() => evaluate('document.querySelector(".chat-page h1")?.textContent === "Developer"'))
      assert.equal(await evaluate('window.mindmesh.agents.list().then(agents => agents.length)'), agentCountBeforeDelete - 1)
      console.log('Electron Agent delete UI: OK')

      await evaluate(`Array.from(document.querySelectorAll('.primary-nav button')).find(button => button.textContent.trim() === '协作空间').click()`)
      await until(() => evaluate('Boolean(document.querySelector(".space-page .danger-button"))'))
      const spaceCountBeforeDelete = await evaluate('window.mindmesh.spaces.list().then(spaces => spaces.length)')
      await evaluate("document.querySelector('.space-page .danger-button').click()")
      await until(() => evaluate(`window.mindmesh.spaces.list().then(spaces => spaces.length === ${spaceCountBeforeDelete - 1})`))
      assert.equal(await evaluate('window.mindmesh.spaces.list().then(spaces => spaces.length)'), spaceCountBeforeDelete - 1)
      console.log('Electron Space delete UI: OK')

      await evaluate(`Array.from(document.querySelectorAll('.primary-nav button')).find(button => button.textContent.trim() === '设置').click()`)
      await until(() => evaluate('Boolean(Array.from(document.querySelectorAll(".settings-page button")).find(button => button.textContent.trim() === "选择文件夹"))'))
      assert.ok(await evaluate('window.mindmesh.settings.workspace()'))
      console.log('Electron local workspace settings UI: OK')
    }

    await evaluate('setTimeout(() => window.close(), 100)')
    await until(() => app.exitCode !== null, 20_000)
    console.log(`Electron graceful exit round ${round}: OK`)
  } catch (error) {
    console.error(String(error))
    console.error(log.replaceAll(key ?? '__absent__', '<REDACTED>').slice(-5000))
    throw error
  } finally {
    client?.socket.close()
    if (app.exitCode === null) app.kill()
    await until(() => app.exitCode !== null, 10_000).catch(() => undefined)
  }
}

try {
  await runRound(1)
  if (process.env.MINDMESH_E2E_RESTART === '1') await runRound(2)
} finally {
  const tempRoot = resolve(tmpdir()) + sep
  if (resolve(userData).startsWith(tempRoot)) rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
}
