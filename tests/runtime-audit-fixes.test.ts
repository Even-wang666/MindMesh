import { describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { MindMeshDatabase } from '../src/main/database'
import { MindMeshServices } from '../src/main/services'
import { toolPreview } from '../src/main/harness-adapter'
import { mockHarness, mockProviderSettings } from './service-mocks'

describe('runtime audit regressions', () => {
  it('redacts nested Set-Cookie arrays without hiding ordinary output', () => {
    const preview = toolPreview(
      JSON.stringify({
        output: 'read successfully',
        headers: {
          'set-cookie': [
            'session=fixture-secret; secret=another-fixture-secret; HttpOnly',
            'csrf=fixture-secret-2',
          ],
        },
      })
    )
    expect(preview.text).not.toContain('fixture-secret')
    expect(preview.text).toContain('read successfully')
    expect(preview.text).toContain('[REDACTED]')
  })

  it('isolates reused native call IDs across runs and child sessions', async () => {
    const db = new MindMeshDatabase(':memory:')
    let attempt = 0
    const run = vi.fn(async (...args: Parameters<ReturnType<typeof mockHarness>['run']>) => {
      attempt++
      const owner = args[7]!
      const emit = args[8]!
      for (const sessionId of ['root', 'child']) {
        for (const step of [1, 2]) {
          const base = { ...owner, agentId: args[0].id, sessionId, seq: step * 3 - 2, time: 1 }
          emit({
            ...base,
            type: 'tool:start',
            callId: 'call_1',
            toolName: 'read',
            displayName: '读取文件',
          })
          emit({
            ...base,
            type: 'tool:output',
            seq: base.seq + 1,
            callId: 'call_1',
            text: `attempt-${attempt}-${sessionId}-${step}`,
            isError: false,
            truncated: false,
          })
          emit({ ...base, type: 'tool:end', seq: base.seq + 2, callId: 'call_1', aborted: false })
        }
      }
      return { text: `reply-${attempt}`, sessionId: 'root' }
    })
    const service = new MindMeshServices(
      db,
      mockHarness({ run }),
      mockProviderSettings(),
      () => undefined
    )
    try {
      const agent = db.listAgents()[0]
      await service.sendPrivate(agent.id, 'first')
      const history = await service.sendPrivate(agent.id, 'second')
      const replies = history.filter((message) => message.authorType === 'agent')
      expect(replies.map((reply) => reply.toolCalls?.map((call) => call.output))).toEqual([
        ['attempt-1-root-1', 'attempt-1-root-2', 'attempt-1-child-1', 'attempt-1-child-2'],
        ['attempt-2-root-1', 'attempt-2-root-2', 'attempt-2-child-1', 'attempt-2-child-2'],
      ])
    } finally {
      db.close()
    }
  })

  for (const scope of ['private', 'space'] as const) {
    for (const outcome of ['stopped', 'stopped-empty', 'error'] as const) {
      it(`keeps ${scope} ${outcome} tool history attached to its message`, async () => {
        const db = new MindMeshDatabase(':memory:')
        let rejectRun!: (error: Error) => void
        const run = vi.fn(async (...args: Parameters<ReturnType<typeof mockHarness>['run']>) => {
          const base = { ...args[7]!, agentId: args[0].id, sessionId: 'root', seq: 1, time: 1 }
          args[8]!({
            ...base,
            type: 'tool:start',
            callId: 'call_1',
            toolName: 'read',
            displayName: '读取文件',
          })
          if (outcome !== 'stopped-empty') args[3]!('partial', 'text')
          const abort = () =>
            args[8]!({ ...base, type: 'tool:end', seq: 2, callId: 'call_1', aborted: true })
          if (outcome === 'error') {
            abort()
            throw new Error('fixture failure')
          }
          return new Promise<{ text: string }>((_, reject) => {
            rejectRun = reject
          }).finally(abort)
        })
        const stop = vi.fn(async () => {
          rejectRun(new Error('fixture stop'))
          return true
        })
        const service = new MindMeshServices(
          db,
          mockHarness({ run, stop }),
          mockProviderSettings(),
          () => undefined
        )
        try {
          const agent = db.listAgents()[0]
          const space = db.createSpace({
            name: 'Audit',
            description: '',
            context: '',
            memberIds: [agent.id],
          })
          const id = scope === 'private' ? agent.id : space.id
          const pending =
            scope === 'private'
              ? service.sendPrivate(id, 'read')
              : service.sendSpace(id, `@${agent.name} read`)
          if (outcome !== 'error') await service.stop(scope, id)
          await pending
          const history = db.listMessages(db.conversationIdFor(scope, id))
          expect(history.at(-1)?.toolCalls).toHaveLength(1)
          expect(history.at(-1)?.toolCalls?.[0].status).toBe('aborted')
          const raw = (db as unknown as { db: DatabaseSync }).db
          expect(raw.prepare('SELECT responseMessageId FROM runs').get()?.responseMessageId).toBe(
            history.at(-1)?.id
          )
        } finally {
          db.close()
        }
      })
    }
  }

  for (const scope of ['private', 'space'] as const) {
    for (const reason of ['blocked', 'stopped', 'interrupted'] as const) {
      it(`does not aggregate a ${scope} native ${reason} run as completed`, async () => {
        const db = new MindMeshDatabase(':memory:')
        const run = vi.fn(async () => ({ text: 'partial', endReason: reason }))
        const service = new MindMeshServices(
          db,
          mockHarness({ run }),
          mockProviderSettings(),
          () => undefined
        )
        try {
          const agent = db.listAgents()[0]
          if (scope === 'private') await service.sendPrivate(agent.id, 'run')
          else {
            const space = db.createSpace({
              name: 'Audit',
              description: '',
              context: '',
              memberIds: [agent.id],
            })
            await service.sendSpace(space.id, `@${agent.name} run`)
          }
          const raw = (db as unknown as { db: DatabaseSync }).db
          expect(raw.prepare('SELECT status FROM executions').get()?.status).toBe(
            reason === 'blocked' ? 'error' : reason
          )
        } finally {
          db.close()
        }
      })
    }
  }

  it('keeps a shutdown execution recoverable instead of marking it completed', async () => {
    const db = new MindMeshDatabase(':memory:')
    let rejectRun!: (error: Error) => void
    const run = vi.fn(
      () =>
        new Promise<{ text: string }>((_, reject) => {
          rejectRun = reject
        })
    )
    const shutdownAll = vi.fn(async () => {
      rejectRun(new Error('fixture shutdown'))
    })
    const service = new MindMeshServices(
      db,
      mockHarness({ run, shutdownAll }),
      mockProviderSettings(),
      () => undefined
    )
    try {
      const agent = db.listAgents()[0]
      const space = db.createSpace({
        name: 'Audit',
        description: '',
        context: '',
        memberIds: [agent.id],
      })
      const pending = service.sendSpace(space.id, `@${agent.name} run`)
      await service.shutdown()
      await pending
      const raw = (db as unknown as { db: DatabaseSync }).db
      expect(raw.prepare('SELECT status FROM executions').get()?.status).toBe('running')
      db.markInterruptedRecovery()
      expect(raw.prepare('SELECT status FROM executions').get()?.status).toBe('interrupted')
      expect(raw.prepare('SELECT status FROM runs').get()?.status).toBe('interrupted')
    } finally {
      db.close()
    }
  })
})
