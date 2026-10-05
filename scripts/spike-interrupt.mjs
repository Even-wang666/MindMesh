// Phase 0 / S0.1 follow-up: does an interrupted turn leave a dangling tool/call?
//
// Read-only diagnostic. Starts a real harness, tears the runtime down mid-tool
// (the same way RuntimeSupervisor.stop does), then reports whether tool/call
// events were paired with tool/result events.
//
// Note: DeepSeekHarness (SDK client) exposes no stop(); cancellation is
// implemented by RuntimeSupervisor.stop() retiring the lease and closing the
// subprocess. We reproduce that by closing the harness while a run is in flight.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

const { DeepSeekHarness } = await import('@deepseek-ai/dsh-sdk-client')
const dshHome = await mkdtemp(join(tmpdir(), 'spike-int-'))

const sysEnv = {}
for (const n of [
  'SYSTEMROOT',
  'PATH',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'COMSPEC',
  'PATHEXT',
  'WINDIR',
  'HOME',
  'OS',
]) {
  if (process.env[n] !== undefined) sysEnv[n] = process.env[n]
}

const harness = new DeepSeekHarness({
  profile: 'sdk',
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  cwd: process.cwd(),
  processCwd: process.cwd(),
  dshHome,
  initializeTimeoutMs: 60_000,
  env: {
    ...sysEnv,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? '',
    DSH_HOME: dshHome,
    ELECTRON_RUN_AS_NODE: '1',
  },
})

const seen = []
/** Resolves once a real tool/call is observed (or rejects on timeout). */
let notifyToolCall
const toolCallObserved = new Promise((resolvePromise) => {
  notifyToolCall = resolvePromise
})
const observeTimeoutMs = Number(process.env.MINDMESH_SPIKE_INT_TIMEOUT_MS ?? 60_000)

let invalidReason = null
let runSettled = false
let turnEnded = false
let closeStarted = false
/** Timer handle for the observe window; cleared in finally so it never holds the loop. */
let observeTimer = null
/** Rejection of the in-flight run that arrives *before* we close the runtime. */
let preCloseRunError = null
let run = null

try {
  await harness.start()
  console.log('[int] handshake OK')
  const requestId = `int-${Date.now()}`

  run = harness
    .run(process.env.MINDMESH_SPIKE_INT_PROMPT ?? 'Run "sleep 25" via the shell, then reply ok.', {
      sessionId: requestId,
      onNotification: (notification) => {
        if (notification?.method !== 'session.event') {
          seen.push({ m: notification?.method })
          return
        }
        const event = notification?.params?.event
        seen.push({
          t: event?.type,
          seq: event?.seq,
          sessionId: notification?.params?.sessionId ?? null,
          callId: event?.data?.callId ?? event?.data?.message?.toolCallId,
        })
        // Only arm the interrupt once a tool call is really in flight. A timer
        // started before handshake can fire before any tool/call exists, which
        // makes the experiment inconclusive rather than a valid negative result.
        if (event?.type === 'tool/call') {
          notifyToolCall?.()
        }
        // A turn/end means the Runtime finished the turn on its own. Record it now
        // so a run that completes by itself is never mistaken for one we stopped.
        if (event?.type === 'turn/end') {
          turnEnded = true
        }
      },
    })
    // Success and failure handlers are attached to the *same* promise. Using
    // .then(...).catch(...) would defer the failure path by one extra microtask,
    // so a run that failed just before we closed could set closeStarted first and
    // then be misread as "we stopped it" (a false positive).
    .then(
      (value) => {
        runSettled = true
        return value
      },
      (error) => {
        runSettled = true
        // Record *when* it failed: a protocol failure that happens before we close
        // the runtime is not the dangling-call effect we are trying to measure.
        if (!closeStarted) preCloseRunError = String(error?.message ?? error)
        console.log('[int] run 结束:', String(error?.message ?? error).slice(0, 140))
        return null
      }
    )

  // Give up (invalid experiment) if no tool/call shows up in time.
  const timeout = new Promise((resolvePromise) => {
    observeTimer = setTimeout(() => resolvePromise('timeout'), observeTimeoutMs)
  })
  const outcome = await Promise.race([toolCallObserved.then(() => 'tool-call'), timeout])
  // Promise.race does not cancel the loser; without this the 60s timer keeps the
  // event loop alive long after the experiment is over.
  if (observeTimer) {
    clearTimeout(observeTimer)
    observeTimer = null
  }

  if (outcome === 'timeout') {
    invalidReason = `no tool/call observed within ${observeTimeoutMs}ms`
    console.log('[int] 无效试验：', invalidReason)
  }

  // Cancellation path: closing the runtime mid-tool, as RuntimeSupervisor.stop does.
  // Decide *before* closing. Consult all three signals directly rather than relying
  // on handler ordering: a run that already finished (successfully or not) on its own
  // cannot demonstrate an interrupt, and closing afterwards would retroactively look
  // like the cause of any dangling call.
  if (runSettled || turnEnded || preCloseRunError) {
    invalidReason = `run already finished on its own (runSettled=${runSettled}, turnEnded=${turnEnded}, preCloseError=${Boolean(preCloseRunError)}) before the interrupt could be issued`
    console.log('[int] 无效试验：', invalidReason)
  } else {
    closeStarted = true
    console.log('[int] 关闭 runtime（模拟 stop 的 retire 路径）')
    const closed = await harness.close().then(
      () => true,
      () => false
    )
    if (!closed) {
      invalidReason = 'harness.close() failed — cannot confirm the runtime was interrupted'
      console.log('[int] 无效试验：', invalidReason)
    }
    await run
    runSettled = true
  }
} catch (error) {
  invalidReason = `unexpected error: ${String(error?.message ?? error).slice(0, 160)}`
  console.log('[int] ERR:', String(error?.message ?? error).slice(0, 160))
} finally {
  if (observeTimer) clearTimeout(observeTimer)
  await harness.close().catch(() => {})
}

const calls = seen.filter((x) => x.t === 'tool/call').map((x) => x.callId)
const results = seen.filter((x) => x.t === 'tool/result').map((x) => x.callId)
const dangling = calls.filter((c) => !results.includes(c))
console.log('[int] tool/call ids   :', JSON.stringify(calls))
console.log('[int] tool/result ids :', JSON.stringify(results))
console.log('[int] 悬空(call 无 result):', JSON.stringify(dangling))
console.log(
  '[int] 事件序列:',
  seen
    .filter((x) => x.t)
    .map((x) => x.t)
    .join(' > ')
)

if (!resolve(dshHome).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unexpected directory')
await rm(dshHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })

// A protocol failure that happened before we closed the runtime produced the same
// dangling callId, but for a different reason — that is not evidence that an
// interrupt leaves a tool call dangling. (Normally already caught by the pre-close
// decision above; this is a belt-and-braces check for a failure racing the close.)
if (preCloseRunError && !invalidReason) {
  invalidReason = `run failed before the interrupt was issued: ${preCloseRunError.slice(0, 120)}`
  console.error('[int] 无效试验：', invalidReason)
}

// Exit non-zero unless we actually observed a dangling tool call, so automated
// re-verification cannot mistake an inconclusive run for a negative result.
if (invalidReason) {
  process.exitCode = 1
} else if (dangling.length === 0) {
  console.error('[int] 无效试验：未产生悬空 tool/call，无法验证 aborted 路径')
  process.exitCode = 1
}
