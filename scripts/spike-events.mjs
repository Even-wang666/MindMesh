// Phase 0 / S0.1 + S0.2: capture raw DSH session.event notifications.
//
// Read-only diagnostic: it starts a real harness against a temporary DSH_HOME,
// records every session.event payload verbatim, then shuts down. Nothing in the
// repository is modified and no key is ever printed.
//
// Exit codes: 0 = capture completed, 1 = handshake/model failure (report is still
// written), 2 = unexpected internal error.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const runtimeRoot = process.env.MINDMESH_SMOKE_RUNTIME_ROOT
const { DeepSeekHarness } = await import(
  runtimeRoot
    ? pathToFileURL(join(runtimeRoot, '@deepseek-ai', 'dsh-sdk-client', 'lib', 'index.js')).href
    : '@deepseek-ai/dsh-sdk-client'
)

const outDir = process.env.MINDMESH_SPIKE_OUT ?? join(root, 'logs', 'spike')
// Create the output directory up front: a completed model request must never lose
// its evidence to ENOENT.
await mkdir(outDir, { recursive: true })
const dshHome = await mkdtemp(join(tmpdir(), 'mindmesh-spike-'))

const systemNames = new Set([
  'APPDATA',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMSPEC',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'OS',
  'PATH',
  'PATHEXT',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PSMODULEPATH',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'WINDIR',
])
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name, value]) => value !== undefined && systemNames.has(name.toUpperCase())
  )
)

const prompt =
  process.env.MINDMESH_SPIKE_PROMPT ??
  'Use the shell tool to run "echo spike-marker", then reply with the word done.'

const harness = new DeepSeekHarness({
  ...(runtimeRoot ? { dshBin: join(runtimeRoot, '@deepseek-ai', 'dsh', 'lib', 'bin.js') } : {}),
  profile: 'sdk',
  provider: 'deepseek-official',
  model: process.env.MINDMESH_SPIKE_MODEL ?? 'deepseek-v4-flash',
  cwd: root,
  processCwd: root,
  dshHome,
  initializeTimeoutMs: 60_000,
  env: {
    ...env,
    DEEPSEEK_API_KEY: process.env.MINDMESH_SPIKE_KEY ?? process.env.DEEPSEEK_API_KEY ?? '',
    DSH_HOME: dshHome,
    ELECTRON_RUN_AS_NODE: '1',
  },
})

/** @type {any[]} */
const notifications = []
/** @type {any[]} */
const methods = []
let finished = false
let sawAssistantMessage = false
let failure = null

try {
  await harness.start()
  console.log('[spike] handshake OK')

  const result = await harness.run(prompt, {
    sessionId: `spike-${Date.now()}`,
    onNotification: (notification) => {
      const method = notification?.method
      methods.push(method)
      if (method !== 'session.event') {
        // Keep non-event frames too: they reveal the transport shape.
        notifications.push({ __method: method, __raw: notification })
        return
      }
      const event = notification?.params?.event
      // params.sessionId is the authoritative Session identity. The SDK subscribes
      // to the whole Session tree, so subagent child Sessions arrive here too and
      // their `seq` values restart from the beginning — never treat our own
      // requestId as the Session identity.
      notifications.push({
        __method: method,
        __sessionId: notification?.params?.sessionId ?? null,
        __event: event,
      })
      const type = event?.type
      if (type === 'tool/call' || type === 'tool/result') {
        console.log(`[spike] ${type}`, JSON.stringify(event).slice(0, 400))
      }
      if (type === 'assistant/message') {
        sawAssistantMessage = true
        const usage = event?.data?.usage ?? event?.data?.message?.usage ?? null
        if (usage) console.log('[spike] usage seen:', JSON.stringify(usage))
      }
      if (type === 'turn/end' || type === 'run_end') finished = true
    },
  })

  console.log('[spike] run returned; text length =', String(result?.text ?? '').length)

  // A turn can end without any assistant message (e.g. auth rejected upstream).
  // That is not a valid experiment even though the run resolved successfully.
  if (!sawAssistantMessage) {
    failure = {
      message: 'no assistant/message observed — run resolved but produced no model output',
      stack: [],
    }
    console.error('[spike] 无效试验：', failure.message)
  }
} catch (error) {
  failure = {
    message: String(error?.message ?? error),
    stack: String(error?.stack ?? '')
      .split('\n')
      .slice(0, 6),
  }
  console.error('[spike] run failed:', failure.message)
} finally {
  // Cleanup must run even if writing the report fails, so the runtime subprocess
  // and the temporary DSH_HOME are always released. Evidence writing is therefore
  // wrapped separately and its failure is recorded rather than thrown.
  try {
    const typeCounts = {}
    const sessionIds = new Set()
    for (const entry of notifications) {
      const key = entry.__event?.type ?? `method:${entry.__method}`
      typeCounts[key] = (typeCounts[key] ?? 0) + 1
      if (entry.__sessionId) sessionIds.add(entry.__sessionId)
    }

    await writeFile(
      join(outDir, 's0-notifications.json'),
      `${JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          dshVersion: process.env.MINDMESH_SPIKE_DSH_VERSION ?? 'unknown',
          model: process.env.MINDMESH_SPIKE_MODEL ?? 'deepseek-v4-flash',
          prompt,
          finished,
          sawAssistantMessage,
          failure,
          sessionIds: [...sessionIds],
          // Proof that (sessionId, seq) — not seq alone — is the dedup key.
          seqRanges: [...sessionIds].map((id) => {
            const seqs = notifications
              .filter((n) => n.__sessionId === id && typeof n.__event?.seq === 'number')
              .map((n) => n.__event.seq)
            return {
              sessionId: id,
              count: seqs.length,
              min: Math.min(...seqs),
              max: Math.max(...seqs),
            }
          }),
          methodCounts: methods.reduce((acc, m) => {
            acc[m] = (acc[m] ?? 0) + 1
            return acc
          }, {}),
          eventTypeCounts: typeCounts,
          notifications,
        },
        null,
        2
      )}\n`,
      'utf8'
    )
    console.log('[spike] event type counts:', JSON.stringify(typeCounts, null, 2))
    console.log('[spike] wrote', join(outDir, 's0-notifications.json'))
  } catch (writeError) {
    process.exitCode = 2
    console.error('[spike] 报告写入失败:', String(writeError?.message ?? writeError))
  }

  try {
    await harness.close()
  } catch (error) {
    console.error('[spike] close failed:', String(error?.message ?? error))
  }

  // Refuse recursive cleanup outside the verified temporary directory. Reported
  // rather than thrown: a throw here would skip nothing (rm is the last step) but
  // keeps the finally block free of control-flow escapes.
  const dshHomeInsideTmp = resolve(dshHome).startsWith(resolve(tmpdir()) + sep)
  if (dshHomeInsideTmp) {
    await rm(dshHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  } else {
    console.error('[spike] 拒绝清理非临时目录:', dshHome)
    process.exitCode = 2
  }
}

// A failed handshake or model request is not a valid experiment: exit non-zero so
// automated re-verification can tell a real result from an unfinished one.
if (failure) process.exitCode = 1
