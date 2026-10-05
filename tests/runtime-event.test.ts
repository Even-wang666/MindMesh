// Phase 1 step 5 (review round 2): the RuntimeEvent pipeline.
//
// Three layers are pinned here against the production code — no local copies:
//   1. The real RuntimeEventBuffer throttle (time window, batch ceiling,
//      immediate lifecycle flush).
//   2. The adapter's pure helpers: toolPreview (redaction + preview cap) and
//      mapTurnEndReason (terminal-state mapping).
//   3. The adapter → event pipeline: a mocked harness drives the onNotification
//      callback so the adapter's mapping (sessionId/seq/conversationId routing,
//      tool redaction/truncation, stranded-tool aborts, endReason) is exercised
//      through the same path the renderer consumes.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeEvent, RunEndReason } from '../src/shared/contracts'
import {
  EVENT_BATCH_LIMIT,
  EVENT_FLUSH_MS,
  RuntimeEventBuffer,
} from '../src/main/services'
import { mapTurnEndReason, toolPreview } from '../src/main/harness-adapter'

// ─── 1. The production buffer ──────────────────────────────────────────────

function deltaEvent(text: string, index: number): RuntimeEvent {
  return {
    type: 'text:delta',
    requestId: 'r1',
    sessionId: 's1',
    seq: index,
    conversationId: 'private:a',
    agentId: 'a',
    time: 0,
    text: `${text}-${index}`,
  }
}

function lifecycleEvent(type: 'run:start' | 'run:end' | 'error' | 'usage'): RuntimeEvent {
  const base = {
    requestId: 'r1',
    conversationId: 'private:a',
    agentId: 'a',
  }
  switch (type) {
    case 'run:start':
      return {
        ...base,
        type: 'run:start',
        agentName: 'PM',
        executionId: 'e1',
        triggerMessageId: 'm1',
        time: 0,
      }
    case 'run:end':
      return { ...base, type: 'run:end', reason: 'completed' }
    case 'error':
      return { ...base, type: 'error', message: 'fail' }
    case 'usage':
      return {
        ...base,
        type: 'usage',
        sessionId: 's1',
        seq: 1,
        time: 0,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
      }
  }
}

describe('RuntimeEventBuffer (production)', () => {
  it('flushes delta events after the time window', () => {
    vi.useFakeTimers()
    const buffer = new RuntimeEventBuffer()
    const batches: RuntimeEvent[][] = []
    buffer.onFlush((events) => batches.push(events))

    buffer.add(deltaEvent('t', 1))
    buffer.add(deltaEvent('t', 2))
    expect(batches).toEqual([])

    vi.advanceTimersByTime(EVENT_FLUSH_MS)
    expect(batches).toEqual([[deltaEvent('t', 1), deltaEvent('t', 2)]])
    buffer.dispose()
    vi.useRealTimers()
  })

  it('flushes immediately when the batch limit is reached', () => {
    vi.useFakeTimers()
    const buffer = new RuntimeEventBuffer()
    const batches: RuntimeEvent[][] = []
    buffer.onFlush((events) => batches.push(events))

    for (let i = 0; i < EVENT_BATCH_LIMIT; i++) buffer.add(deltaEvent('t', i))
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(EVENT_BATCH_LIMIT)
    buffer.dispose()
    vi.useRealTimers()
  })

  it('flushes lifecycle events immediately, pushing queued deltas first', () => {
    vi.useFakeTimers()
    const buffer = new RuntimeEventBuffer()
    const batches: RuntimeEvent[][] = []
    buffer.onFlush((events) => batches.push(events))

    buffer.add(deltaEvent('t', 1))
    buffer.add(lifecycleEvent('run:end'))
    // The queued delta comes out first, then the lifecycle event alone.
    expect(batches).toHaveLength(2)
    expect(batches[0]).toEqual([deltaEvent('t', 1)])
    expect(batches[1]).toEqual([lifecycleEvent('run:end')])
    buffer.dispose()
    vi.useRealTimers()
  })
})

// ─── 2. Pure helpers ────────────────────────────────────────────────────────

describe('toolPreview', () => {
  it('redacts secrets from a tool result', () => {
    const { text, truncated } = toolPreview('curl -H "Authorization: Bearer sk-abcdef123456" x')
    expect(text).not.toContain('sk-abcdef123456')
    expect(text).toContain('[REDACTED]')
    expect(truncated).toBe(false)
  })

  it('caps a 100k-character output to a preview and flags the cut', () => {
    const huge = 'x'.repeat(100_000)
    const { text, truncated } = toolPreview(huge)
    expect(text.length).toBeLessThan(10_000)
    expect(text.length).toBeLessThan(huge.length)
    expect(truncated).toBe(true)
  })

  it('leaves short output untouched', () => {
    const { text, truncated } = toolPreview('short output')
    expect(text).toBe('short output')
    expect(truncated).toBe(false)
  })
})

describe('mapTurnEndReason', () => {
  const cases: Array<[RunEndReason, Parameters<typeof mapTurnEndReason>[0]]> = [
    ['completed', { kind: 'completed' }],
    ['stopped', { kind: 'aborted', reason: { kind: 'legacy' } }],
    ['error', { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } }],
    ['blocked', { kind: 'blocked' }],
    ['max-tokens', { kind: 'max-tokens' }],
    ['interrupted', { kind: 'interrupted' }],
    ['completed', { kind: 'forked' }],
  ]
  for (const [expected, reason] of cases) {
    it(`maps ${reason.kind} to ${expected}`, () => {
      expect(mapTurnEndReason(reason)).toBe(expected)
    })
  }
})

// ─── 3. Adapter → event pipeline (mocked harness) ──────────────────────────

const sdk = vi.hoisted(() => ({
  events: [] as Array<Record<string, unknown>>,
  finalResponse: 'done',
}))
vi.mock('@deepseek-ai/dsh-sdk-client', () => ({
  DeepSeekHarness: class {
    async start() {}
    async run(_input: unknown, options?: { sessionId?: string; onNotification?: (n: unknown) => void }) {
      for (const raw of sdk.events) {
        options?.onNotification?.({
          method: 'session.event',
          params: { sessionId: options.sessionId ?? 's1', event: raw },
        })
      }
      return { finalResponse: sdk.finalResponse, sessionId: options?.sessionId ?? 's1' }
    }
    async close() {}
  },
  JsonRpcResponseError: class extends Error {},
}))

import { DeepSeekHarnessAdapter } from '../src/main/harness-adapter'
import { mockProviderSettings } from './service-mocks'
import type { Agent } from '../src/shared/contracts'

const dirs: string[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  sdk.events.length = 0
  sdk.finalResponse = 'done'
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mindmesh-event-'))
  dirs.push(directory)
  const adapter = new DeepSeekHarnessAdapter(
    directory,
    directory,
    mockProviderSettings({
      getProvider: (id: string) =>
        id === 'deepseek-official' ? { id, name: id, apiKey: 'secret' } : undefined,
      configuredProviders: () => [
        { id: 'deepseek-official', name: 'DeepSeek', apiKey: 'secret' },
      ],
    })
  )
  const agent: Agent = {
    id: 'a',
    name: 'A',
    role: '',
    persona: 'A',
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    skills: [],
    tools: [],
    createdAt: '',
  }
  return { adapter, agent }
}

/** Build a minimal DSH event with the fields the adapter reads. */
function sessionEvent(
  type: string,
  data: Record<string, unknown>,
  seq: number
): Record<string, unknown> {
  return { type, seq, time: 1000 + seq, data }
}

describe('adapter event mapping', () => {
  it('routes conversationId as the renderer-facing value, not the contextKey', async () => {
    const { adapter, agent } = fixture()
    sdk.events = [
      sessionEvent('assistant/message', { message: { content: [{ type: 'text', text: 'hello' }] } }, 1),
      sessionEvent('turn/end', { reason: { kind: 'completed' } }, 2),
    ]
    const emitted: RuntimeEvent[] = []
    const result = await adapter.run(
      agent,
      'hi',
      'session-1',
      undefined,
      [],
      adapter.prepareRun(agent, 'chat'),
      false,
      {
        contextKey: 'conversation:private:a:a',
        requestId: 'r1',
        conversationId: 'private:a',
        recoveryPrompt: () => '',
      },
      (event) => emitted.push(event)
    )
    expect(emitted[0]).toMatchObject({ type: 'text:delta', conversationId: 'private:a' })
    expect(emitted[0]).not.toMatchObject({ conversationId: 'conversation:private:a:a' })
    expect(result.endReason).toBe('completed')
    await adapter.shutdownAll()
  })

  it('carries sessionId, seq and time on streamed events', async () => {
    const { adapter, agent } = fixture()
    sdk.events = [
      sessionEvent(
        'assistant/message',
        { message: { content: [{ type: 'text', text: 'hi' }] }, usage: { inputTokens: 7, outputTokens: 2 } },
        4
      ),
    ]
    const emitted: RuntimeEvent[] = []
    await adapter.run(
      agent,
      'hi',
      'session-9',
      undefined,
      [],
      adapter.prepareRun(agent, 'chat'),
      true,
      { contextKey: 'c', requestId: 'r1', conversationId: 'private:a', recoveryPrompt: () => '' },
      (event) => emitted.push(event)
    )
    const textDelta = emitted.find((event) => event.type === 'text:delta')
    const usage = emitted.find((event) => event.type === 'usage')
    expect(textDelta).toMatchObject({ sessionId: 'session-9', seq: 4, time: 1004 })
    expect(usage).toMatchObject({ inputTokens: 7, outputTokens: 2 })
    await adapter.shutdownAll()
  })

  it('deduplicates a re-delivered (sessionId, seq) pair', async () => {
    const { adapter, agent } = fixture()
    const assistant = sessionEvent(
      'assistant/message',
      { message: { content: [{ type: 'text', text: 'once' }] } },
      3
    )
    // The same event is delivered twice, as a child-session re-delivery would.
    sdk.events = [assistant, assistant]
    const emitted: RuntimeEvent[] = []
    await adapter.run(
      agent,
      'hi',
      's',
      undefined,
      [],
      adapter.prepareRun(agent, 'chat'),
      false,
      { contextKey: 'c', requestId: 'r1', conversationId: 'private:a', recoveryPrompt: () => '' },
      (event) => emitted.push(event)
    )
    expect(emitted.filter((event) => event.type === 'text:delta')).toHaveLength(1)
    await adapter.shutdownAll()
  })

  it('redacts and truncates a tool result and marks a stranded call aborted', async () => {
    const { adapter, agent } = fixture()
    sdk.events = [
      sessionEvent('tool/call', { callId: 'c1', name: 'read', arguments: '{}' }, 1),
      sessionEvent(
        'tool/result',
        {
          message: {
            toolCallId: 'c1',
            content: [{ type: 'text', text: `token=sk-abc123\n${'x'.repeat(5000)}` }],
            isError: false,
          },
        },
        2
      ),
      // A second call that never gets a result — the adapter must abort it.
      sessionEvent('tool/call', { callId: 'c2', name: 'write', arguments: '{}' }, 3),
    ]
    const emitted: RuntimeEvent[] = []
    await adapter.run(
      agent,
      'hi',
      's',
      undefined,
      [],
      adapter.prepareRun(agent, 'chat'),
      false,
      { contextKey: 'c', requestId: 'r1', conversationId: 'private:a', recoveryPrompt: () => '' },
      (event) => emitted.push(event)
    )
    const output = emitted.find((event) => event.type === 'tool:output')
    expect(output).toMatchObject({ callId: 'c1', truncated: true })
    expect((output as { text: string }).text).not.toContain('sk-abc123')
    // c1 closes normally, c2 is aborted because its tool/result never arrived.
    const ends = emitted.filter((event) => event.type === 'tool:end')
    expect(ends).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ callId: 'c1', aborted: false }),
        expect.objectContaining({ callId: 'c2', aborted: true }),
      ])
    )
    await adapter.shutdownAll()
  })
})
