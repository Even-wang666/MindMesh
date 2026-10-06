import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startPluginModelFixture } from './plugin-model-fixture.mjs'
import { startPluginFixtureRegistry } from './plugin-fixture-registry.mjs'

const workspace = resolve(fileURLToPath(new URL('..', import.meta.url)))
const userData = mkdtempSync(join(tmpdir(), 'mindmesh-e2e-'))
const executable = process.env.MINDMESH_E2E_EXE ?? (await import('electron')).default
const agencyOnly = process.argv.includes('--agency-agents')
const teamsOnly = process.argv.includes('--teams')
const pluginUi = process.argv.includes('--plugin-marketplace')
const bundledPluginUi = process.argv.includes('--bundled-plugins')
const pluginCatalogOnly = process.argv.includes('--plugin-catalog')
const artifactsOnly = process.argv.includes('--artifacts')
const conversationControlLive = process.argv.includes('--conversation-control-live')
const conversationControlOnly =
  process.argv.includes('--conversation-control') || conversationControlLive
const securityOnly =
  process.argv.includes('--security-only') ||
  agencyOnly ||
  teamsOnly ||
  pluginUi ||
  bundledPluginUi ||
  pluginCatalogOnly ||
  conversationControlOnly ||
  artifactsOnly
const keepUserData = process.env.MINDMESH_E2E_KEEP_USER_DATA === '1'
const key = process.env.DEEPSEEK_API_KEY
const providerOverride = process.env.MINDMESH_E2E_PROVIDER
const modelOverride = process.env.MINDMESH_E2E_MODEL
if (!key && (!securityOnly || conversationControlLive || artifactsOnly))
  throw new Error('请先设置 DEEPSEEK_API_KEY')
if (Boolean(providerOverride) !== Boolean(modelOverride)) {
  throw new Error('MINDMESH_E2E_PROVIDER 与 MINDMESH_E2E_MODEL 必须同时设置')
}

const delay = (ms) => new Promise((done) => setTimeout(done, ms))
async function until(task, timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      const result = await task()
      if (result) return result
    } catch {
      /* App and CDP may still be starting. */
    }
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
  if (conversationControlOnly && !conversationControlLive) delete env.DEEPSEEK_API_KEY
  if (pluginUi || bundledPluginUi || process.env.MINDMESH_E2E_NO_EXTERNAL_PNPM === '1')
    env.PATH = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
  const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`]
  if (pluginUi) args.push(`--plugin-market-fixture=${join(userData, 'plugin-market-fixture.json')}`)
  const app = spawn(executable, process.env.MINDMESH_E2E_EXE ? args : ['.', ...args], {
    cwd: workspace,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  app.stdout.on('data', (chunk) => {
    log += chunk.toString()
  })
  app.stderr.on('data', (chunk) => {
    log += chunk.toString()
  })
  let client
  try {
    const page = await until(async () => {
      if (app.exitCode !== null) throw new Error(`Electron 已退出：${app.exitCode}`)
      const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      return pages.find((item) => item.type === 'page' && item.url.includes('renderer/index.html'))
    }, 30_000)
    client = await connect(page.webSocketDebuggerUrl)
    const evaluate = async (expression) => {
      const reply = await client.call('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })
      if (reply.exceptionDetails)
        throw new Error(
          reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text
        )
      return reply.result.value
    }
    await until(() =>
      evaluate('Boolean(window.mindmesh?.chat && document.querySelector(".composer textarea"))')
    )
    if (process.env.MINDMESH_E2E_SECOND_INSTANCE === '1') {
      const duplicateArgs = [`--user-data-dir=${userData}`]
      const duplicate = spawn(
        executable,
        process.env.MINDMESH_E2E_EXE ? duplicateArgs : ['.', ...duplicateArgs],
        {
          cwd: workspace,
          env,
          windowsHide: true,
          stdio: 'ignore',
        }
      )
      try {
        await until(() => duplicate.exitCode !== null, 20_000)
        assert.equal(duplicate.exitCode, 0)
        assert.equal(app.exitCode, null)
        assert.equal(await evaluate('Boolean(window.mindmesh?.chat)'), true)
        console.log('Electron duplicate instance exits; primary remains available: OK')
      } finally {
        if (duplicate.exitCode === null) duplicate.kill()
      }
    }
    if (artifactsOnly) {
      const outputDirectory = join(userData, 'outputs')
      mkdirSync(outputDirectory, { recursive: true })
      if (round === 1) {
        await evaluate(
          `window.mindmesh.settings.chooseWorkspace(${JSON.stringify(outputDirectory)})`
        )
        const saved = await evaluate(`(async () => {
          const agent = (await window.mindmesh.agents.list())[0]
          await window.mindmesh.agents.update(agent.id, { ...agent, tools: ['文件'] })
          const conversation = await window.mindmesh.chat.createConversation('private', agent.id)
          await window.mindmesh.chat.renameConversation(conversation.id, 'Artifact test')
          const options = { conversationId: conversation.id, permission: 'workspace' }
          await window.mindmesh.chat.sendPrivate(agent.id, 'Use the write tool to create phase3-report.md containing exactly PHASE3_ALPHA. Do not just describe a file. Reply briefly after using the tool.', [], options)
          await window.mindmesh.chat.sendPrivate(agent.id, 'Use the edit tool to replace PHASE3_ALPHA with PHASE3_BETA in phase3-report.md. Reply briefly after using the tool.', [], options)
          const privateArtifacts = await window.mindmesh.chat.artifacts(conversation.id)
          const members = (await window.mindmesh.agents.list()).slice(0, 2)
          for (const member of members) await window.mindmesh.agents.update(member.id, { ...member, tools: ['文件'] })
          const space = await window.mindmesh.spaces.create({ name: 'Phase3 collaboration', description: '', context: '', memberIds: members.map(item => item.id) })
          const spaceConversation = (await window.mindmesh.chat.conversations('space', space.id))[0]
          const task = 'Use the write tool to create a file containing PHASE3_SPACE. ' + members[0].name + ' must write phase3-plan.md; ' + members[1].name + ' must write phase3-review.md. Each member writes only its own file. Reply briefly after using the tool.'
          await window.mindmesh.chat.sendSpace(space.id, task, [], { conversationId: spaceConversation.id, permission: 'workspace' })
          return { privateArtifacts, spaceArtifacts: await window.mindmesh.chat.artifacts(spaceConversation.id), messages: await window.mindmesh.chat.messages('private', agent.id, conversation.id) }
        })()`)
        assert.deepEqual(
          saved.privateArtifacts.map((item) => item.type),
          ['generated_file', 'modified_file']
        )
        assert.equal(new Set(saved.privateArtifacts.map((item) => item.runId)).size, 2)
        assert.equal(saved.messages.filter((item) => item.artifacts?.length).length, 2)
        assert.equal(saved.spaceArtifacts.length, 2)
        assert.equal(new Set(saved.spaceArtifacts.map((item) => item.executionId)).size, 1)
        assert.equal(new Set(saved.spaceArtifacts.map((item) => item.agentId)).size, 2)
        assert.match(readFileSync(join(outputDirectory, 'phase3-report.md'), 'utf8'), /PHASE3_BETA/)
      } else {
        const retained = await evaluate(`(async () => {
          const agent = (await window.mindmesh.agents.list())[0]
          const conversation = (await window.mindmesh.chat.conversations('private', agent.id)).find(item => item.title === 'Artifact test')
          return await window.mindmesh.chat.artifacts(conversation.id)
        })()`)
        assert.deepEqual(
          retained.map((item) => item.type),
          ['generated_file', 'modified_file']
        )
      }
      await evaluate('setTimeout(() => location.reload(), 0)')
      await until(() =>
        evaluate('document.querySelectorAll(".chat-page .artifact-file").length === 2')
      )
      await evaluate('document.querySelector("[data-nav=spaces]").click()')
      await until(() =>
        evaluate(
          'Boolean(Array.from(document.querySelectorAll(".object-row")).find(item => item.textContent.includes("Phase3 collaboration")))'
        )
      )
      await evaluate(
        'Array.from(document.querySelectorAll(".object-row")).find(item => item.textContent.includes("Phase3 collaboration")).click()'
      )
      await until(() =>
        evaluate(
          'document.querySelector(".execution-outputs summary")?.textContent.includes("2 项")'
        )
      )
      assert.equal(
        await evaluate('document.querySelectorAll(".space-page .artifact-file").length'),
        4
      )
      assert.equal(
        await evaluate(
          'document.querySelector(".space-page .composer").getBoundingClientRect().bottom <= innerHeight'
        ),
        true
      )
      if (process.env.MINDMESH_E2E_SCREENSHOT) {
        const screenshot = await client.call('Page.captureScreenshot', { format: 'png' })
        writeFileSync(process.env.MINDMESH_E2E_SCREENSHOT, Buffer.from(screenshot.data, 'base64'))
      }
      console.log(
        `Electron Phase 3 real write/edit artifacts, Run outputs, Space aggregation and persistence round ${round}: OK`
      )
      return
    }
    if (conversationControlOnly) {
      await until(() => evaluate('Boolean(document.querySelector(".chat-page textarea"))'))
      const click = (text) =>
        evaluate(
          `Array.from(document.querySelectorAll('.conversation-controls button')).find(button => button.textContent.trim() === ${JSON.stringify(text)}).click()`
        )
      const send = async (text, expected = text) => {
        await evaluate(`(() => {
          const input = document.querySelector('.chat-page textarea')
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)})
          input.dispatchEvent(new Event('input', { bubbles: true }))
        })()`)
        await evaluate(
          `Array.from(document.querySelectorAll('.chat-page button')).find(button => button.getAttribute('aria-label') === '发送').click()`
        )
        await until(() =>
          evaluate(
            `document.querySelector('.chat-page .message.agent .message-body')?.textContent.includes(${JSON.stringify(expected)})`
          )
        )
      }
      if (round === 2) {
        assert.equal(
          await evaluate(`(async () => {
          const agent = (await window.mindmesh.agents.list())[0]
          const previous = (await window.mindmesh.chat.conversations('private', agent.id)).find(item => item.title === 'Phase 2 accepted' && item.archivedAt)
          return !!previous && (await window.mindmesh.chat.executions(previous.id)).length === 2 && (await window.mindmesh.chat.messages('private', agent.id, previous.id)).length === 3
        })()`),
          true
        )
      }
      const originalId = await evaluate('document.querySelector("[aria-label=切换对话]").value')
      await click('新对话')
      await until(() =>
        evaluate(
          `document.querySelector('[aria-label="切换对话"]').value !== ${JSON.stringify(originalId)}`
        )
      )
      const id = await evaluate('document.querySelector("[aria-label=切换对话]").value')
      await send('Reply exactly with: Phase 2 isolated task', 'Phase 2 isolated task')
      await click('重新生成最后一轮')
      await until(() =>
        evaluate('document.querySelector(".generation-controls")?.textContent.includes("2 / 2")')
      )
      assert.equal(
        await evaluate(
          `window.mindmesh.chat.executions(${JSON.stringify(id)}).then(items => items.length)`
        ),
        2
      )
      await evaluate('document.querySelector("[aria-label=上一回答版本]").click()')
      await until(() =>
        evaluate('document.querySelector(".generation-controls")?.textContent.includes("1 / 2")')
      )
      assert.equal(
        await evaluate(
          `window.mindmesh.chat.executions(${JSON.stringify(id)}).then(items => items.length)`
        ),
        2
      )
      await click('重命名')
      await evaluate(`(() => {
        const input = document.querySelector('[aria-label="对话名称"]')
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Phase 2 accepted')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })()`)
      await click('保存名称')
      await until(() =>
        evaluate(
          'document.querySelector("[aria-label=切换对话] option:checked")?.textContent === "Phase 2 accepted"'
        )
      )
      assert.equal(
        await evaluate(
          'document.querySelector(".chat-page .composer").getBoundingClientRect().bottom <= innerHeight'
        ),
        true
      )
      if (process.env.MINDMESH_E2E_SCREENSHOT) {
        const screenshot = await client.call('Page.captureScreenshot', { format: 'png' })
        writeFileSync(process.env.MINDMESH_E2E_SCREENSHOT, Buffer.from(screenshot.data, 'base64'))
      }
      await click('归档')
      await until(() =>
        evaluate(
          `document.querySelector('[aria-label="切换对话"]').value === ${JSON.stringify(originalId)}`
        )
      )
      await until(() => evaluate('document.querySelectorAll(".chat-page .message").length === 0'))
      const spaceResult = await evaluate(`(async () => {
        const space = (await window.mindmesh.spaces.list())[0]
        const conversation = await window.mindmesh.chat.createConversation('space', space.id)
        await window.mindmesh.chat.sendSpace(space.id, 'Phase 2 Space task', [], { conversationId: conversation.id })
        await window.mindmesh.chat.regenerate(conversation.id)
        return { memberCount: space.memberIds.length, executions: await window.mindmesh.chat.executions(conversation.id), messages: await window.mindmesh.chat.messages('space', space.id, conversation.id) }
      })()`)
      assert.deepEqual(
        spaceResult.executions.map((item) => item.generationIndex),
        [1, 2]
      )
      assert.ok(spaceResult.executions.every((item) => item.status === 'completed'))
      assert.equal(spaceResult.messages.filter((item) => item.authorType === 'user').length, 1)
      assert.equal(
        spaceResult.messages.filter((item) => item.authorType === 'agent').length,
        spaceResult.memberCount * 2
      )
      console.log(
        'Electron Phase 2 new/switch/rename/archive, regeneration, preserved generations and Space IPC: OK'
      )
      return
    }
    if (securityOnly) {
      const policy = await evaluate(
        'document.querySelector(\'meta[http-equiv="Content-Security-Policy"]\')?.content'
      )
      assert.match(policy, /script-src 'self'/)
      await evaluate('document.querySelector(\'[data-nav="marketplace"]\').click()')
      for (const kind of ['agents', 'teams', 'plugins']) {
        await until(() => evaluate(`Boolean(document.querySelector('#marketplace-${kind}'))`))
        await evaluate(`document.querySelector('#marketplace-${kind}').click()`)
        await until(() =>
          evaluate(
            `document.querySelector('#marketplace-panel')?.getAttribute('aria-busy') === 'false'`
          )
        )
        assert.equal(
          await evaluate(`window.mindmesh.marketplace.list('${kind}', true).then(x => x.kind)`),
          kind
        )
        assert.equal(
          await evaluate(
            `document.querySelector('#marketplace-${kind}').getAttribute('aria-selected')`
          ),
          'true'
        )
      }
      assert.equal(
        await evaluate(`window.mindmesh.marketplace.list('../bad').then(() => false, () => true)`),
        true
      )
      console.log('Electron Marketplace navigation, tabs and validated IPC: OK')
      assert.equal(
        await evaluate(
          `document.querySelector('[data-nav="marketplace"] svg').classList.contains('lucide-store')`
        ),
        true
      )
      assert.equal(
        await evaluate(
          `document.querySelector('[data-nav="spaces"] svg').classList.contains('lucide-boxes')`
        ),
        true
      )
      if (pluginCatalogOnly) {
        const catalog = await evaluate(`window.mindmesh.marketplace.list('plugins')`)
        assert.equal(catalog.state, 'fresh', catalog.error)
        assert.ok(catalog.items.length > 0)
        assert.ok(catalog.items.some((item) => item.plugin?.packageName && item.plugin.version))
        console.log(`Electron real community plugin catalog (${catalog.items.length} entries): OK`)
      }
      if (bundledPluginUi) {
        const catalog = await evaluate(`window.mindmesh.marketplace.list('plugins')`)
        assert.deepEqual(
          catalog.items.map((item) => item.sourceId),
          ['dsh-http-tools']
        )
        const card = `Array.from(document.querySelectorAll('[data-plugin-key]')).find(card => card.dataset.pluginKey === '["plugins","dsh","dsh-http-tools"]')`
        const readState = () => evaluate('window.mindmesh.plugins.state()')
        await until(() => evaluate(`Boolean(${card})`))
        assert.equal(
          await evaluate(
            `Array.from(document.querySelectorAll('button')).some(button => button.textContent === '检查兼容性')`
          ),
          false
        )
        if (round === 1) {
          await until(() =>
            evaluate(
              `Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'GitHub 导入')?.disabled === false`
            )
          )
          await evaluate(
            `Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'GitHub 导入').click()`
          )
          await until(() =>
            evaluate(`Boolean(document.querySelector('[aria-labelledby="github-plugin-title"]'))`)
          )
          assert.equal(
            await evaluate(
              `(() => { const rect = document.querySelector('[aria-labelledby="github-plugin-title"]').getBoundingClientRect(); return rect.width > 400 && rect.x >= 0 && rect.y >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight })()`
            ),
            true
          )
          await evaluate(
            `document.querySelector('[aria-labelledby="github-plugin-title"] input').focus()`
          )
          await client.call('Input.insertText', { text: 'http://127.0.0.1/plugin' })
          await until(() =>
            evaluate(
              `document.querySelector('[aria-labelledby="github-plugin-title"] button[type="submit"]')?.disabled === false`
            )
          )
          await evaluate(
            `document.querySelector('[aria-labelledby="github-plugin-title"] button[type="submit"]').click()`
          )
          const failure = await until(async () => {
            const state = await readState()
            return state.operation?.phase === 'failed' ? state : null
          })
          assert.match(failure.operation.message, /GitHub HTTPS/)
          assert.deepEqual(failure.installed, [])
        } else assert.equal((await readState()).installed[0]?.packageName, 'dsh-http-tools')
        const label = round === 1 ? '安装插件' : '移除插件'
        const before = (await readState()).operation?.requestId
        await until(() =>
          evaluate(
            `Array.from((${card}).querySelectorAll('button')).find(button => button.textContent === '${label}')?.disabled === false`
          )
        )
        await evaluate(
          `Array.from((${card}).querySelectorAll('button')).find(button => button.textContent === '${label}').click()`
        )
        const result = await until(async () => {
          const state = await readState()
          return state.operation?.requestId !== before &&
            ['succeeded', 'failed'].includes(state.operation?.phase)
            ? state
            : null
        }, 180_000)
        assert.equal(result.operation.phase, 'succeeded', result.operation.diagnostics)
        assert.equal(result.installed.length, round === 1 ? 1 : 0)
        console.log(
          `Bundled plugin UI round ${round}, GitHub error feedback, dialog and offline installation: OK`
        )
      }
      if (pluginUi) {
        const mainKey = JSON.stringify(['plugins', 'dsh', 'mindmesh-fixture-plugin'])
        const peerKey = JSON.stringify(['plugins', 'dsh', 'mindmesh-fixture-peer'])
        const buildKey = JSON.stringify(['plugins', 'dsh', 'mindmesh-fixture-build'])
        const readState = () => evaluate('window.mindmesh.plugins.state()')
        await evaluate(
          `window.__pluginPhases = []; window.mindmesh.plugins.onProgress(operation => window.__pluginPhases.push(operation.phase))`
        )
        async function action(key, label, expected = 'succeeded') {
          const before = (await readState()).operation?.requestId
          await until(() =>
            evaluate(
              `Array.from(document.querySelectorAll('[data-plugin-key]')).find(card => card.dataset.pluginKey === ${JSON.stringify(key)})?.textContent.includes(${JSON.stringify(label)})`
            )
          )
          assert.equal(
            await evaluate(
              `(() => { const card = Array.from(document.querySelectorAll('[data-plugin-key]')).find(card => card.dataset.pluginKey === ${JSON.stringify(key)}); const button = Array.from(card.querySelectorAll('button')).find(button => button.textContent === ${JSON.stringify(label)}); if (!button || button.disabled) return false; button.click(); return true; })()`
            ),
            true
          )
          const result = await until(async () => {
            const state = await readState()
            return state.operation &&
              state.operation.requestId !== before &&
              ['succeeded', 'failed', 'cancelled'].includes(state.operation.phase)
              ? state
              : null
          }, 180_000)
          assert.equal(result.operation.phase, expected, result.operation.diagnostics)
          console.log(`Plugin UI ${label}: ${expected}`)
          await until(() =>
            evaluate(
              `!Array.from(document.querySelectorAll('[data-plugin-key] button')).some(button => button.disabled)`
            )
          )
          return result
        }
        if (round === 1) {
          await action(mainKey, '安装插件')
          await action(peerKey, '安装插件')
          const beforeRemove = (await readState()).installed
          assert.deepEqual((await action(mainKey, '移除插件', 'failed')).installed, beforeRemove)
          await action(peerKey, '移除插件')
          await action(mainKey, '停用插件')
          await action(mainKey, '启用插件')
          assert.equal(
            await evaluate(
              `Array.from(document.querySelectorAll('[data-plugin-key]')).some(card => card.dataset.pluginKey === ${JSON.stringify(buildKey)})`
            ),
            false
          )
          assert.equal(
            await evaluate(
              `Array.from(document.querySelectorAll('button')).some(button => button.textContent === '检查兼容性')`
            ),
            false
          )
          assert.equal(existsSync(join(userData, 'fixtures', 'script-ran')), false)
          pluginRegistry.setCatalogVersion('1.0.1')
          await evaluate(
            `Array.from(document.querySelectorAll('button')).find(button => button.textContent === '刷新目录').click()`
          )
          await until(() =>
            evaluate(
              `document.querySelector('#marketplace-panel').getAttribute('aria-busy') === 'false' && document.querySelector('.plugin-marketplace').textContent.includes('目录版本：1.0.1')`
            )
          )
          await action(mainKey, '更新至 1.0.1')
        } else {
          assert.equal((await readState()).installed[0].version, '1.0.1')
          assert.equal((await readState()).installed[0].enabled, true)
          await until(() =>
            evaluate(
              `document.querySelector('.plugin-marketplace').textContent.includes('已安装 1.0.1')`
            )
          )
        }
        if (round === 2) {
          await action(mainKey, '停用插件')
          const beforeCancel = await readState()
          await evaluate(
            `Array.from(document.querySelectorAll('[data-plugin-key]')).find(card => card.dataset.pluginKey === ${JSON.stringify(mainKey)}).querySelector('button').click()`
          )
          await until(async () => {
            const operation = (await readState()).operation
            return (
              operation &&
              operation.requestId !== beforeCancel.operation?.requestId &&
              !['succeeded', 'failed', 'cancelled'].includes(operation.phase)
            )
          })
          await until(() =>
            evaluate(
              `Boolean(Array.from(document.querySelectorAll('button')).find(button => button.textContent === '取消操作'))`
            )
          )
          await evaluate(
            `Array.from(document.querySelectorAll('button')).find(button => button.textContent === '取消操作').click()`
          )
          await until(async () => (await readState()).operation?.phase === 'cancelled')
          assert.deepEqual((await readState()).installed, beforeCancel.installed)
          console.log('Plugin UI cancellation preserves installed set: OK')
          await action(mainKey, '启用插件')
        }
        if (process.env.MINDMESH_E2E_SCREENSHOT) {
          const screenshot = await client.call('Page.captureScreenshot', { format: 'png' })
          writeFileSync(process.env.MINDMESH_E2E_SCREENSHOT, Buffer.from(screenshot.data, 'base64'))
        }
        await evaluate(
          `window.mindmesh.settings.saveModelProvider({ id: 'custom', name: 'Plugin UI fixture', baseUrl: ${JSON.stringify(agencyModel.url)}, model: 'fixture-model', apiKey: 'fixture-key' })`
        )
        const agent = await evaluate(`window.mindmesh.agents.list().then(agents => agents[0])`)
        await evaluate(
          `window.mindmesh.agents.update(${JSON.stringify(agent.id)}, { ...${JSON.stringify(agent)}, provider: 'custom', model: 'fixture-model', tools: [] })`
        )
        const messages = await evaluate(
          `window.mindmesh.chat.sendPrivate(${JSON.stringify(agent.id)}, 'Call fixture tool', [], { permission: 'full' })`
        )
        assert.match(messages.at(-1).content, /fixture:1\.0\.1/)
        assert.equal(existsSync(join(userData, 'fixtures', 'tool-called-1.0.1')), true)
        if (round === 2) {
          await action(mainKey, '移除插件')
          assert.equal((await readState()).installed.length, 0)
        }
        assert.ok((await evaluate('window.__pluginPhases')).includes('booting'))
        console.log(
          `Electron plugin Marketplace automatic filtering/one-click install/update/enable/disable/dependency remove gate and real full tool call round ${round}: OK`
        )
      }
      if (teamsOnly) {
        const catalog = await evaluate(`window.mindmesh.marketplace.list('teams', true)`)
        assert.equal(catalog.state, 'fresh', catalog.error)
        assert.ok(catalog.items.length > 0)
        const item = catalog.items[0]
        // Preinstall a source Agent to prove Team install reuses it without changing edits.
        const agentsCatalog = await evaluate(`window.mindmesh.marketplace.list('agents')`)
        const firstItem = agentsCatalog.items.find(
          (agent) => agent.sourceId === 'engineering/engineering-frontend-developer.md'
        )
        assert.ok(firstItem)
        const reused = await evaluate(
          `window.mindmesh.marketplace.installAgent(${JSON.stringify(firstItem.key)}, ${JSON.stringify(firstItem.revision)})`
        )
        await evaluate(
          `window.mindmesh.agents.update(${JSON.stringify(reused.id)}, { ...${JSON.stringify(reused)}, persona: 'Team smoke user persona' })`
        )
        await evaluate(`document.querySelector('#marketplace-teams').click()`)
        await until(() => evaluate(`Boolean(document.querySelector('.marketplace-install'))`))
        assert.equal(item.team.members.length, 3)
        assert.ok(
          await evaluate(
            `document.querySelector('.catalog-grid').textContent.includes('成员：3 位智能体')`
          )
        )
        assert.ok(
          await evaluate(
            `document.querySelector('.catalog-grid').textContent.includes('成员预览：')`
          )
        )
        if (round === 1) {
          await evaluate(`document.querySelector('.marketplace-install').click()`)
          await until(() =>
            evaluate(
              `document.querySelector('.marketplace-install')?.textContent.includes('已安装')`
            )
          )
        } else {
          assert.equal(
            await evaluate(
              `document.querySelector('.marketplace-install').textContent.includes('已安装')`
            ),
            true
          )
        }
        const installed = await evaluate(
          `window.mindmesh.marketplace.installTeam(${JSON.stringify(item.key)}, ${JSON.stringify(item.revision)})`
        )
        assert.equal(installed.memberIds.length, 3)
        assert.equal(installed.memberIds[0], reused.id)
        const members = await evaluate(
          `window.mindmesh.agents.list().then(agents => ${JSON.stringify(installed.memberIds)}.map(id => agents.find(agent => agent.id === id)))`
        )
        assert.equal(members[0].persona, 'Team smoke user persona')
        assert.deepEqual(
          members.map((agent) => agent.source.sourceId),
          [
            'engineering/engineering-frontend-developer.md',
            'engineering/engineering-backend-architect.md',
            'testing/testing-api-tester.md',
          ]
        )
        assert.ok(members.every((agent) => agent.tools.length === 0 && agent.skills.length === 0))
        if (round > 1) assert.equal(installed.context, 'Team smoke user context')
        await evaluate(`document.querySelector('.marketplace-install').click()`)
        await until(() =>
          evaluate(
            `document.querySelector('.space-page h1')?.textContent === ${JSON.stringify(installed.name)}`
          )
        )
        await evaluate(
          `window.mindmesh.spaces.updateContext(${JSON.stringify(installed.id)}, 'Team smoke user context')`
        )
        await evaluate(
          `window.mindmesh.settings.saveModelProvider({ id: 'custom', name: 'Team smoke fixture', baseUrl: ${JSON.stringify(agencyModel.url)}, model: 'fixture-model', apiKey: 'fixture-key' })`
        )
        for (const member of members) {
          await evaluate(
            `window.mindmesh.agents.update(${JSON.stringify(member.id)}, { ...${JSON.stringify(member)}, provider: 'custom', model: 'fixture-model' })`
          )
        }
        const requestCount = agencyModel.requests.length
        const content = `${members.map((member) => `@${member.name}`).join(' ')} Team installation smoke round ${round}`
        const messages = await evaluate(
          `window.mindmesh.chat.sendSpace(${JSON.stringify(installed.id)}, ${JSON.stringify(content)})`
        )
        assert.deepEqual(
          messages
            .filter((message) => message.content === 'core-without-plugin')
            .slice(-3)
            .map((message) => message.authorId),
          installed.memberIds
        )
        assert.equal(agencyModel.requests.length - requestCount, 3)
        console.log(
          `Electron Team install, source reuse, ordered real DSH Space conversation and Open round ${round}: OK`
        )
      }
      if (agencyOnly) {
        const catalog = await evaluate(`window.mindmesh.marketplace.list('agents', true)`)
        assert.equal(catalog.state, 'fresh', catalog.error)
        assert.ok(catalog.items.length > 0)
        const item = catalog.items[0]
        assert.ok(catalog.items.every((entry) => entry.revision === item.revision))
        await evaluate(`document.querySelector('#marketplace-agents').click()`)
        await until(() => evaluate(`Boolean(document.querySelector('.marketplace-install'))`))
        await evaluate(`(() => {
          const input = document.querySelector('input[type="search"]');
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(item.name)});
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`)
        await until(() =>
          evaluate(
            `document.querySelector('.catalog-grid h3')?.textContent === ${JSON.stringify(item.name)}`
          )
        )
        assert.ok(
          await evaluate(`document.querySelector('.catalog-grid').textContent.includes('分类：')`)
        )
        assert.ok(
          await evaluate(`document.querySelector('.catalog-grid').textContent.includes('免费')`)
        )
        const alreadyInstalled = await evaluate(
          `document.querySelector('.marketplace-install').textContent.includes('已安装')`
        )
        if (!alreadyInstalled) {
          await evaluate(`document.querySelector('.marketplace-install').click()`)
          await until(() =>
            evaluate(
              `document.querySelector('.marketplace-install')?.textContent.includes('已安装')`
            )
          )
        }
        const installed = await evaluate(
          `window.mindmesh.agents.list().then(agents => agents.find(agent => agent.source?.sourceId === ${JSON.stringify(item.sourceId)}))`
        )
        assert.ok(installed)
        assert.deepEqual(installed.tools, [])
        assert.deepEqual(installed.skills, [])
        if (round === 1) {
          assert.equal(installed.provider, 'deepseek-official')
          assert.equal(installed.model, 'deepseek-flash')
        } else {
          assert.equal(installed.provider, 'custom', '重复安装不能覆盖用户的模型修改')
        }
        assert.equal(installed.source.revision, item.revision)
        assert.match(installed.source.licenseText, /MIT License/)
        assert.ok(installed.persona.length > 0)
        assert.equal(
          (
            await evaluate(
              `window.mindmesh.marketplace.installAgent(${JSON.stringify(item.key)}, ${JSON.stringify(item.revision)})`
            )
          ).id,
          installed.id
        )
        await evaluate(`document.querySelector('.marketplace-install').click()`)
        await until(() =>
          evaluate(
            `document.querySelector('.chat-page h1')?.textContent === ${JSON.stringify(installed.name)}`
          )
        )
        await evaluate(`window.mindmesh.settings.saveModelProvider({ id: 'custom', name: 'Agency smoke fixture',
          baseUrl: ${JSON.stringify(agencyModel.url)}, model: 'fixture-model', apiKey: 'fixture-key' })`)
        await evaluate(`window.mindmesh.agents.update(${JSON.stringify(installed.id)}, {
          ...${JSON.stringify(installed)}, provider: 'custom', model: 'fixture-model' })`)
        const requestCount = agencyModel.requests.length
        const messages = await evaluate(
          `window.mindmesh.chat.sendPrivate(${JSON.stringify(installed.id)}, 'Agency installation smoke')`
        )
        assert.ok(
          messages.some(
            (message) =>
              message.authorId === installed.id && message.content === 'core-without-plugin'
          )
        )
        assert.ok(agencyModel.requests.length > requestCount, '真实 SDK 必须到达本地模型 HTTP 边界')
        assert.ok(
          agencyModel.requests
            .at(-1)
            .messages.some(
              (message) =>
                typeof message.content === 'string' && message.content.includes(installed.persona)
            )
        )
        console.log(
          `Electron Agency pinned catalog (${catalog.items.length} templates, ${item.revision}), install/Open and real DSH private conversation round ${round}: OK`
        )
      }
      await evaluate('setTimeout(() => window.close(), 100)')
      await until(() => app.exitCode !== null, 20_000)
      console.log('Electron sandboxed preload and CSP: OK')
      return
    }
    assert.equal(await evaluate('window.mindmesh.runtime.status().then(x => x.state)'), 'ready')
    assert.equal(
      await evaluate('window.mindmesh.runtime.status().then(x => x.dshVersion)'),
      JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')).dependencies[
        '@deepseek-ai/dsh'
      ]
    )
    if (round === 1 && providerOverride && modelOverride) {
      const route = await evaluate(`(async () => {
        const agent = (await window.mindmesh.agents.list())[0]
        const updated = await window.mindmesh.agents.update(agent.id, {
          name: agent.name, role: agent.role, persona: agent.persona,
          provider: ${JSON.stringify(providerOverride)}, model: ${JSON.stringify(modelOverride)},
          skills: agent.skills, tools: agent.tools, reasoningEffort: agent.reasoningEffort,
        })
        return { provider: updated.provider, model: updated.model }
      })()`)
      assert.deepEqual(route, { provider: providerOverride, model: modelOverride })
      await client.call('Page.reload')
      await delay(500)
      await until(() =>
        evaluate('Boolean(window.mindmesh?.chat && document.querySelector(".composer textarea"))')
      )
      console.log(`Electron provider override ${providerOverride}/${modelOverride}: OK`)
    }
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
      await until(() =>
        evaluate('!document.querySelector(".composer-actions .send-button").disabled')
      )
      await evaluate('document.querySelector(".composer-actions .send-button").click()')
    }

    const privateMarker = `MM_PRIVATE_${Date.now()}`
    await sendFromComposer(`请只回复 ${privateMarker}`)
    try {
      const outcome = await until(
        () =>
          evaluate(`(() => {
        if (Array.from(document.querySelectorAll('.message.agent > div > .message-body')).some(x => x.textContent.includes(${JSON.stringify(privateMarker)}))) return 'ok'
        if (document.querySelector('.message.system')?.textContent.includes('回复失败')) return 'failed'
        return null
      })()`),
        75_000
      )
      assert.equal(outcome, 'ok', '私聊返回了失败消息')
    } catch (error) {
      console.error(
        'Private chat messages:',
        await evaluate(
          'Array.from(document.querySelectorAll(".messages .message")).map(x => x.textContent.slice(0, 240))'
        )
      )
      throw error
    }
    console.log('Electron private chat UI: OK')

    await evaluate(
      `Array.from(document.querySelectorAll('.primary-nav button')).find(button => button.textContent.trim() === '协作空间').click()`
    )
    await until(() => evaluate('Boolean(document.querySelector(".space-page .composer textarea"))'))
    if (round === 2)
      await until(() =>
        evaluate(
          'document.querySelectorAll(".space-page .message.agent > div > .message-body").length >= 2'
        )
      )
    const existingSpaceReplies = await evaluate(
      'document.querySelectorAll(".space-page .message.agent > div > .message-body").length'
    )
    const spaceMarker = `MM_SPACE_${Date.now()}`
    await sendFromComposer(`@Researcher @Developer 请分别只回复 ${spaceMarker}`)
    try {
      await until(
        () =>
          evaluate(
            `document.querySelectorAll(".space-page .message.agent > div > .message-body").length === ${existingSpaceReplies + 2}`
          ),
        180_000
      )
    } catch (error) {
      console.error(
        'Space agent messages:',
        await evaluate(`Array.from(document.querySelectorAll('.space-page .message.agent:has(header time)')).map(item => ({
        author: item.querySelector('header strong')?.textContent,
        content: item.querySelector('.message-body')?.textContent?.slice(0, 240) ?? '',
      }))`)
      )
      throw error
    }
    const spaceMessages = await evaluate(
      'Array.from(document.querySelectorAll(".space-page .message.agent > div > .message-body")).map(x => x.textContent)'
    )
    assert.equal(spaceMessages.length, existingSpaceReplies + 2, 'Space 双 Agent 回复失败')
    console.log(`Electron Space collaboration UI round ${round}: OK`)

    if (round === 2 || process.env.MINDMESH_E2E_RESTART !== '1') {
      await evaluate("document.querySelector('.space-page .drawer-toggle').click()")
      await until(() => evaluate('Boolean(document.querySelector(".space-page .drawer-edit"))'))
      await evaluate("document.querySelector('.space-page .drawer-edit').click()")
      await until(() => evaluate('Boolean(document.querySelector(".wizard.space-wizard input"))'))
      await evaluate(`(() => {
        const input = document.querySelector('.wizard.space-wizard input')
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'E2E 编辑空间')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })()`)
      await evaluate(
        'document.querySelector(\'.member-choices button[aria-label="Developer"]\').click()'
      )
      await until(() =>
        evaluate(
          'document.querySelector(\'.member-choices button[aria-label="Developer"]\')?.getAttribute("aria-pressed") === "false"'
        )
      )
      await evaluate(
        "document.querySelector('.wizard.space-wizard footer .primary-button').click()"
      )
      await until(() =>
        evaluate('document.querySelector(".space-page h1")?.textContent === "E2E 编辑空间"')
      )
      const edited = await evaluate(`(async () => {
        const space = (await window.mindmesh.spaces.list())[0]
        return { name: space.name, members: space.memberIds.length }
      })()`)
      assert.deepEqual(edited, { name: 'E2E 编辑空间', members: 1 })
      console.log('Electron Space edit UI: OK')

      await evaluate(
        `Array.from(document.querySelectorAll('.primary-nav button')).find(button => button.textContent.trim() === '对话').click()`
      )
      await until(() =>
        evaluate('Boolean(document.querySelector(".chat-page .chat-header button"))')
      )
      const agentCountBeforeDelete = await evaluate(
        'window.mindmesh.agents.list().then(agents => agents.length)'
      )
      await evaluate("document.querySelector('.chat-page .chat-header button').click()")
      await until(() => evaluate('Boolean(document.querySelector(".agent-drawer .danger-button"))'))
      await evaluate("document.querySelector('.agent-drawer .danger-button').click()")
      await until(() => evaluate('Boolean(document.querySelector(".confirm-dialog"))'))
      await evaluate("document.querySelector('.confirm-dialog .danger-button').click()")
      await until(() =>
        evaluate('document.querySelector(".chat-page h1")?.textContent === "Developer"')
      )
      assert.equal(
        await evaluate('window.mindmesh.agents.list().then(agents => agents.length)'),
        agentCountBeforeDelete - 1
      )
      console.log('Electron Agent delete UI: OK')

      await evaluate(
        `Array.from(document.querySelectorAll('.primary-nav button')).find(button => button.textContent.trim() === '协作空间').click()`
      )
      await until(() => evaluate('Boolean(document.querySelector(".space-page .drawer-toggle"))'))
      await evaluate("document.querySelector('.space-page .drawer-toggle').click()")
      await until(() => evaluate('Boolean(document.querySelector(".space-page .drawer-delete"))'))
      const spaceCountBeforeDelete = await evaluate(
        'window.mindmesh.spaces.list().then(spaces => spaces.length)'
      )
      await evaluate("document.querySelector('.space-page .drawer-delete').click()")
      await until(() => evaluate('Boolean(document.querySelector(".confirm-dialog"))'))
      await evaluate("document.querySelector('.confirm-dialog .danger-button').click()")
      await until(() =>
        evaluate(
          `window.mindmesh.spaces.list().then(spaces => spaces.length === ${spaceCountBeforeDelete - 1})`
        )
      )
      assert.equal(
        await evaluate('window.mindmesh.spaces.list().then(spaces => spaces.length)'),
        spaceCountBeforeDelete - 1
      )
      console.log('Electron Space delete UI: OK')

      await evaluate(
        `Array.from(document.querySelectorAll('.primary-nav button')).find(button => button.textContent.trim() === '设置').click()`
      )
      await until(() =>
        evaluate(
          'Boolean(Array.from(document.querySelectorAll(".settings-page button")).find(button => button.textContent.trim() === "选择文件夹"))'
        )
      )
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

const agencyModel = agencyOnly || teamsOnly || pluginUi ? await startPluginModelFixture() : null
const pluginRegistry = pluginUi
  ? await startPluginFixtureRegistry(join(userData, 'fixtures'))
  : null
if (pluginRegistry)
  writeFileSync(
    join(userData, 'plugin-market-fixture.json'),
    JSON.stringify({
      catalogUrl: `${pluginRegistry.url}plugins.json`,
      registry: pluginRegistry.url,
    })
  )
try {
  await runRound(1)
  if (process.env.MINDMESH_E2E_RESTART === '1') await runRound(2)
} finally {
  await agencyModel?.close()
  await pluginRegistry?.close()
  const tempRoot = resolve(tmpdir()) + sep
  if (keepUserData) console.error(`Electron user data preserved: ${userData}`)
  else if (resolve(userData).startsWith(tempRoot))
    rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
}
