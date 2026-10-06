import { describe, expect, it, vi } from 'vitest'
import { MindMeshDatabase, runtimeContextKey } from '../src/main/database'
import { MindMeshServices } from '../src/main/services'
import { mockHarness, mockProviderSettings } from './service-mocks'
import type { DeepSeekHarnessAdapter } from '../src/main/harness-adapter'

function setup() {
  const db = new MindMeshDatabase(':memory:')
  let count = 0
  const run = vi.fn<DeepSeekHarnessAdapter['run']>(async (_agent, _prompt, sessionId) => ({
    text: `reply-${++count}`,
    sessionId,
    endReason: 'completed',
  }))
  const harness = mockHarness({ run })
  const service = new MindMeshServices(db, harness, mockProviderSettings(), () => undefined)
  return { db, run, harness, service }
}

describe('Phase 2 conversation control', () => {
  it('isolates messages, sessions and runs, then retains archived history', async () => {
    const { db, run, service } = setup()
    try {
      const agent = db.listAgents()[0]
      const first = db.conversationIdFor('private', agent.id)
      const second = service.createConversation('private', agent.id)
      await service.sendPrivate(agent.id, 'first task')
      await service.sendPrivate(agent.id, 'second task', [], { conversationId: second.id })
      expect(service.messages('private', agent.id, second.id).map((m) => m.content)).toEqual([
        'second task',
        'reply-2',
      ])
      expect(run.mock.calls[1][1]).not.toContain('first task')
      expect(run.mock.calls[1][7]?.contextKey).toBe(runtimeContextKey(second.id, agent.id))
      expect(run.mock.calls[1][7]?.conversationId).toBe(second.id)
      expect(service.executions(second.id)).toHaveLength(1)
      expect(service.renameConversation(second.id, 'Plan').title).toBe('Plan')
      expect(() => service.renameConversation(second.id, ' ')).toThrow()
      const space = db.listSpaces()[0]
      expect(() => service.sendSpace(space.id, 'bad', [], { conversationId: second.id })).toThrow()
      await service.archiveConversation(second.id)
      expect(service.messages('private', agent.id, second.id)).toHaveLength(2)
      expect(() =>
        service.sendPrivate(agent.id, 'bad', [], { conversationId: second.id })
      ).toThrow()
      expect(service.messages('private', agent.id, first)).toHaveLength(2)
      service.renameConversation(first, 'Custom title')
      db.updateAgent(agent.id, { ...agent, name: 'Renamed Agent' })
      expect(db.getConversation(first).title).toBe('Custom title')
    } finally {
      db.close()
    }
  })

  it('regenerates only the last trigger on fresh sessions and never deletes older generations', async () => {
    const { db, run, service } = setup()
    try {
      const agent = db.listAgents()[0]
      const id = db.conversationIdFor('private', agent.id)
      await service.sendPrivate(agent.id, 'earlier question')
      await service.sendPrivate(agent.id, 'last question')
      const oldMessages = service.messages('private', agent.id)
      const before = service.executions(id)
      await service.regenerate(id)
      await service.regenerate(id)
      const executions = service.executions(id)
      expect(executions.map((e) => e.generationIndex)).toEqual([1, 1, 2, 3])
      expect(executions[2].regeneratedFromExecutionId).toBe(before[1].id)
      expect(executions[3].regeneratedFromExecutionId).toBe(executions[2].id)
      expect(
        service.messages('private', agent.id).filter((m) => m.authorType === 'user')
      ).toHaveLength(2)
      expect(service.messages('private', agent.id).slice(0, 4)).toEqual(oldMessages)
      expect(run.mock.calls[2][1]).toContain('reply-1')
      expect(run.mock.calls[2][1]).not.toContain('reply-2')
      expect(run.mock.calls[3][1]).not.toContain('reply-3')
      expect(run.mock.calls[2][2]).not.toBe(run.mock.calls[1][2])
      expect(run.mock.calls[2][6]).toBe(true)
      expect(run.mock.calls[2][7]?.contextKey).toBe(run.mock.calls[1][7]?.contextKey)
      await service.sendPrivate(agent.id, 'next question')
      const active = db.listActiveMessages(id).map((m) => m.content)
      expect(active).toContain('reply-4')
      expect(active).not.toContain('reply-2')
      expect(active).not.toContain('reply-3')
    } finally {
      db.close()
    }
  })

  it('reuses the original Space participant order despite workflow edits and excludes old replies', async () => {
    const { db, run, service } = setup()
    try {
      const agents = db.listAgents().slice(0, 2)
      const space = db.createSpace({
        name: 'Team',
        description: '',
        context: '',
        memberIds: agents.map((a) => a.id),
      })
      const id = db.conversationIdFor('space', space.id)
      await service.sendSpace(space.id, 'task')
      const original = service.executions(id)[0]
      db.updateSpace(space.id, { ...space, memberIds: [agents[1].id] })
      await service.regenerate(id)
      expect(run.mock.calls.map(([a]) => a.id)).toEqual([
        agents[0].id,
        agents[1].id,
        agents[0].id,
        agents[1].id,
      ])
      expect(db.getExecutionWorkflowSnapshot(service.executions(id)[1].id)).toEqual(
        db.getExecutionWorkflowSnapshot(original.id)
      )
      expect(run.mock.calls[2][1]).not.toContain('reply-1')
      expect(run.mock.calls[3][1]).toContain('reply-3')
      expect(run.mock.calls[3][1]).not.toContain('reply-2')
      expect(service.messages('space', space.id)).toHaveLength(5)
      expect(service.executions(id).map((e) => e.generationIndex)).toEqual([1, 2])
      expect(run.mock.calls[2][2]).not.toBe(run.mock.calls[0][2])
    } finally {
      db.close()
    }
  })

  it('blocks regeneration and archival during an active execution', async () => {
    const { db, service, run } = setup()
    let complete!: (value: Awaited<ReturnType<DeepSeekHarnessAdapter['run']>>) => void
    run.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    try {
      const agent = db.listAgents()[0]
      const id = db.conversationIdFor('private', agent.id)
      const pending = service.sendPrivate(agent.id, 'task')
      await expect(service.regenerate(id)).rejects.toThrow()
      await expect(service.archiveConversation(id)).rejects.toThrow()
      expect(service.messages('private', agent.id)).toHaveLength(1)
      complete({ text: 'done' })
      await pending
    } finally {
      db.close()
    }
  })

  it('keeps a partial failed Space generation available and closes its execution', async () => {
    const { db, service, harness } = setup()
    try {
      const agents = db.listAgents().slice(0, 2)
      const space = db.createSpace({
        name: 'Failure team',
        description: '',
        context: '',
        memberIds: agents.map((a) => a.id),
      })
      const id = db.conversationIdFor('space', space.id)
      await service.sendSpace(space.id, 'task')
      const prepare = harness.prepareRun
      let count = 0
      harness.prepareRun = (agent, permission) => {
        if (++count === 2) throw new Error('Preparation failed')
        return prepare(agent, permission)
      }
      await expect(service.regenerate(id)).rejects.toThrow('Preparation failed')
      expect(service.executions(id)[1]).toMatchObject({
        generationIndex: 2,
        status: 'completed_with_errors',
      })
      expect(service.messages('space', space.id)).toHaveLength(4)
      expect(db.listActiveMessages(id).map((m) => m.content)).toEqual(['task', 'reply-3'])
    } finally {
      db.close()
    }
  })
})
