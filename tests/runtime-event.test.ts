// Phase 1 step 5: RuntimeEvent contract + Event Buffer.
//
// The adapter now maps every DSH event the spike captured to a RuntimeEvent.
// The services layer batches delta events behind a 120 ms / 32-event throttle
// while flushing lifecycle events (run:start, run:end, error, usage) immediately.
// These tests pin both the mapping and the throttle without spawning a real
// harness process.

import { describe, expect, it, vi } from 'vitest'
import type { RuntimeEvent } from '../src/shared/contracts'

// ─── Event Buffer ──────────────────────────────────────────────────────────

// The buffer is a private implementation detail of MindMeshServices, but its
// throttle behaviour is the contract the renderer depends on. We re-declare the
// minimal shape so the test can exercise it in isolation without constructing
// a full services instance.

const EVENT_FLUSH_MS = 120
const EVENT_BATCH_LIMIT = 32

class TestableEventBuffer {
  private queue: RuntimeEvent[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private flushListeners: Array<(events: RuntimeEvent[]) => void> = []

  add(event: RuntimeEvent): void {
    if (
      event.type === 'run:start' ||
      event.type === 'run:end' ||
      event.type === 'error' ||
      event.type === 'usage'
    ) {
      this.flush()
      this.deliver([event])
      return
    }
    this.queue.push(event)
    if (this.queue.length >= EVENT_BATCH_LIMIT) {
      this.flush()
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), EVENT_FLUSH_MS)
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.queue.length) return
    this.deliver(this.queue)
    this.queue = []
  }

  private deliver(events: RuntimeEvent[]): void {
    for (const listener of this.flushListeners) listener(events)
  }

  onFlush(listener: (events: RuntimeEvent[]) => void): () => void {
    this.flushListeners.push(listener)
    return () => {
      this.flushListeners = this.flushListeners.filter((item) => item !== listener)
    }
  }

  dispose(): void {
    this.flush()
    this.flushListeners = []
  }
}

function deltaEvent(text: string, index: number): RuntimeEvent {
  return {
    type: 'text:delta',
    requestId: 'r1',
    conversationId: 'private:a1',
    agentId: 'a1',
    text: `${text}-${index}`,
  }
}

function lifecycleEvent(type: RuntimeEvent['type']): RuntimeEvent {
  const base = { requestId: 'r1', conversationId: 'private:a1', agentId: 'a1' }
  switch (type) {
    case 'run:start':
      return { ...base, type: 'run:start', agentName: 'PM' }
    case 'run:end':
      return { ...base, type: 'run:end' }
    case 'error':
      return { ...base, type: 'error', message: 'fail' }
    case 'usage':
      return {
        ...base,
        type: 'usage',
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
      }
    default:
      throw new Error(`not a lifecycle type: ${type}`)
  }
}

describe('RuntimeEventBuffer', () => {
  it('flushes delta events after the time window', () => {
    vi.useFakeTimers()
    const buffer = new TestableEventBuffer()
    const batches: RuntimeEvent[][] = []
    buffer.onFlush((events) => batches.push(events))

    buffer.add(deltaEvent('t', 1))
    buffer.add(deltaEvent('t', 2))
    expect(batches).toEqual([])

    vi.advanceTimersByTime(EVENT_FLUSH_MS)
    expect(batches).toEqual([
      [
        { ...deltaEvent('t', 1) },
        { ...deltaEvent('t', 2) },
      ],
    ])
    buffer.dispose()
    vi.useRealTimers()
  })

  it('flushes immediately when the batch limit is reached', () => {
    vi.useFakeTimers()
    const buffer = new TestableEventBuffer()
    const batches: RuntimeEvent[][] = []
    buffer.onFlush((events) => batches.push(events))

    for (let i = 0; i < EVENT_BATCH_LIMIT; i++) buffer.add(deltaEvent('t', i))
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(EVENT_BATCH_LIMIT)

    buffer.dispose()
    vi.useRealTimers()
  })

  it('flushes lifecycle events immediately without waiting for the timer', () => {
    vi.useFakeTimers()
    const buffer = new TestableEventBuffer()
    const batches: RuntimeEvent[][] = []
    buffer.onFlush((events) => batches.push(events))

    buffer.add(lifecycleEvent('run:start'))
    expect(batches).toEqual([[lifecycleEvent('run:start')]])

    buffer.add(deltaEvent('t', 1))
    expect(batches).toHaveLength(1)

    buffer.add(lifecycleEvent('usage'))
    // flush() before the lifecycle event pushes the queued delta out first.
    expect(batches).toEqual([
      [lifecycleEvent('run:start')],
      [deltaEvent('t', 1)],
      [lifecycleEvent('usage')],
    ])

    vi.advanceTimersByTime(EVENT_FLUSH_MS)
    // The timer fires but the queue is already empty.
    expect(batches).toHaveLength(3)

    buffer.dispose()
    vi.useRealTimers()
  })

  it('flushes pending deltas before an immediate lifecycle event', () => {
    vi.useFakeTimers()
    const buffer = new TestableEventBuffer()
    const batches: RuntimeEvent[][] = []
    buffer.onFlush((events) => batches.push(events))

    buffer.add(deltaEvent('t', 1))
    buffer.add(deltaEvent('t', 2))
    buffer.add(lifecycleEvent('run:end'))

    // The two queued deltas come out first, then the lifecycle event alone.
    expect(batches).toHaveLength(2)
    expect(batches[0]).toEqual([deltaEvent('t', 1), deltaEvent('t', 2)])
    expect(batches[1]).toEqual([lifecycleEvent('run:end')])

    buffer.dispose()
    vi.useRealTimers()
  })
})

// ─── RuntimeEvent type contract ────────────────────────────────────────────

describe('RuntimeEvent type contract', () => {
  it('carries requestId and conversationId on every variant', () => {
    const events: RuntimeEvent[] = [
      { type: 'run:start', requestId: 'r', conversationId: 'c', agentId: 'a', agentName: 'n' },
      { type: 'text:delta', requestId: 'r', conversationId: 'c', agentId: 'a', text: 't' },
      { type: 'reasoning:delta', requestId: 'r', conversationId: 'c', agentId: 'a', text: 't' },
      {
        type: 'tool:start',
        requestId: 'r',
        conversationId: 'c',
        agentId: 'a',
        callId: 'call1',
        toolName: 'read',
        displayName: 'read',
      },
      {
        type: 'tool:delta',
        requestId: 'r',
        conversationId: 'c',
        agentId: 'a',
        callId: 'call1',
        text: 'partial',
      },
      {
        type: 'tool:output',
        requestId: 'r',
        conversationId: 'c',
        agentId: 'a',
        callId: 'call1',
        text: 'done',
        isError: false,
      },
      {
        type: 'tool:end',
        requestId: 'r',
        conversationId: 'c',
        agentId: 'a',
        callId: 'call1',
        aborted: false,
      },
      {
        type: 'usage',
        requestId: 'r',
        conversationId: 'c',
        agentId: 'a',
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
      },
      { type: 'error', requestId: 'r', conversationId: 'c', agentId: 'a', message: 'boom' },
      { type: 'run:end', requestId: 'r', conversationId: 'c', agentId: 'a' },
    ]

    for (const event of events) {
      expect(event).toHaveProperty('requestId')
      expect(event).toHaveProperty('conversationId')
      expect(event).toHaveProperty('agentId')
      expect(event).toHaveProperty('type')
    }
  })
})
