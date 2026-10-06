import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { MindMeshDatabase } from '../src/main/database'
import { MindMeshServices } from '../src/main/services'
import type { CreateSpaceInput } from '../src/shared/contracts'
import { mockHarness, mockProviderSettings } from './service-mocks'

describe('sequential Space workflow', () => {
  it('keeps empty-space feedback without creating an execution or starting a run', async () => {
    const db = new MindMeshDatabase(':memory:')
    const harness = mockHarness()
    const service = new MindMeshServices(db, harness, mockProviderSettings(), () => undefined)
    try {
      const space = db.createSpace({ name: 'Empty', description: '', context: '', memberIds: [] })
      const raw = (db as unknown as { db: DatabaseSync }).db
      const counts = () =>
        raw
          .prepare(`SELECT
        (SELECT COUNT(*) FROM executions) AS executions,
        (SELECT COUNT(*) FROM runs) AS runs`)
          .get()
      const before = counts()
      const messages = await service.sendSpace(space.id, 'review this task')
      expect(messages).toEqual([
        expect.objectContaining({ authorType: 'user', content: 'review this task' }),
        expect.objectContaining({
          authorType: 'system',
          content: '空间没有可执行的智能体，请先添加成员。',
        }),
      ])
      expect(counts()).toEqual(before)
      expect(harness.run).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })
  it('migrates schema 9 without losing order and persists detached execution snapshots', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-workflow-'))
    const path = join(directory, 'workflow.db')
    let db = new MindMeshDatabase(path)
    try {
      const ordered = db
        .listAgents()
        .slice(0, 3)
        .map((item) => item.id)
        .reverse()
      const space = db.createSpace({
        name: 'Legacy',
        description: '',
        context: '',
        memberIds: ordered,
      })
      const message = db.addMessage({
        scope: 'space',
        scopeId: space.id,
        authorType: 'user',
        authorName: 'U',
        content: 'review',
      })
      db.createExecution({
        id: 'execution',
        conversationId: db.conversationIdFor('space', space.id),
        triggerMessageId: message.id,
        workflowSnapshot: {
          mode: 'sequential',
          spaceId: space.id,
          orderedAgentIds: ordered,
          selectedAgentIds: [ordered[1]],
        },
      })
      db.close()
      const raw = new DatabaseSync(path)
      raw.exec('ALTER TABLE spaces DROP COLUMN executionMode')
      raw.prepare("UPDATE app_meta SET value = '9' WHERE key = 'schema_version'").run()
      raw.close()
      db = new MindMeshDatabase(path)
      expect(db.getSpace(space.id)).toMatchObject({
        executionMode: 'sequential',
        memberIds: ordered,
      })
      const snapshot = db.getExecutionWorkflowSnapshot('execution')!
      expect(snapshot).toMatchObject({ orderedAgentIds: ordered, selectedAgentIds: [ordered[1]] })
      snapshot.orderedAgentIds.reverse()
      expect(db.getExecutionWorkflowSnapshot('execution')!.orderedAgentIds).toEqual(ordered)
    } finally {
      db.close()
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
  it('uses workflow order, defaults to everyone, and freezes an in-flight plan', async () => {
    const db = new MindMeshDatabase(':memory:')
    const members = db.listAgents().slice(0, 3)
    const calls: string[] = []
    let executionId = ''
    let spaceId = ''
    const run = vi.fn(async (...args: Parameters<ReturnType<typeof mockHarness>['run']>) => {
      calls.push(args[0].id)
      executionId = args[7]!.executionId
      if (calls.length === 1) {
        const current = db.getSpace(spaceId)!
        db.updateSpace(spaceId, { ...current, memberIds: [members[2].id, members[0].id] })
      }
      return { text: args[0].name, sessionId: `session-${args[0].id}` }
    })
    const service = new MindMeshServices(
      db,
      mockHarness({ run }),
      mockProviderSettings(),
      () => undefined
    )
    try {
      const original = [members[1].id, members[0].id, members[2].id]
      const space = db.createSpace({
        name: 'Workflow',
        description: '',
        context: '',
        memberIds: original,
      })
      spaceId = space.id
      await service.sendSpace(space.id, `@${members[2].name} @${members[1].name} review`)
      expect(calls).toEqual([members[1].id, members[2].id])
      expect(db.getExecutionWorkflowSnapshot(executionId)).toEqual({
        mode: 'sequential',
        spaceId: space.id,
        orderedAgentIds: original,
        selectedAgentIds: [members[1].id, members[2].id],
      })
      const firstExecution = executionId
      calls.length = 0
      await service.sendSpace(space.id, 'all members review')
      expect(calls).toEqual([members[2].id, members[0].id])
      expect(db.getExecutionWorkflowSnapshot(firstExecution)?.orderedAgentIds).toEqual(original)
    } finally {
      db.close()
    }
  })
  it('defaults every creation path to sequential and rejects parallel at the backend', () => {
    const db = new MindMeshDatabase(':memory:')
    try {
      const input = { name: 'Workflow', description: '', context: '', memberIds: [] }
      const space = db.createSpace(input)
      expect(space.executionMode).toBe('sequential')
      expect(db.listSpaces().every((item) => item.executionMode === 'sequential')).toBe(true)
      const unsupported = { ...input, executionMode: 'parallel' } as unknown as CreateSpaceInput
      expect(() => db.createSpace(unsupported)).toThrow('并行执行暂未开放')
      expect(() => db.updateSpace(space.id, unsupported)).toThrow('并行执行暂未开放')
      expect(db.getSpace(space.id)?.executionMode).toBe('sequential')
    } finally {
      db.close()
    }
  })
})
