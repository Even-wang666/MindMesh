// Phase 1 step 6: execution-history persistence and crash recovery.
//
// Pins the new database methods (executions / runs / tool_calls) and the
// startup recovery that folds a crash's `running` rows into `interrupted`.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { MindMeshDatabase } from '../src/main/database'

const dirs: string[] = []
function fixture(): MindMeshDatabase {
  const directory = mkdtempSync(join(tmpdir(), 'mindmesh-execution-'))
  dirs.push(directory)
  return new MindMeshDatabase(join(directory, 'mindmesh.sqlite'))
}
function cleanup(): void {
  for (const dir of dirs.splice(0))
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch {
      /* ignore */
    }
}

function rows(db: MindMeshDatabase, sql: string, ...params: Array<string | number>): Array<Record<string, unknown>> {
  const internal = (db as unknown as { db: DatabaseSync }).db
  return internal.prepare(sql).all(...params) as Array<Record<string, unknown>>
}

describe('execution-history persistence', () => {
  it('writes an execution, its runs and tool calls end to end', () => {
    const db = fixture()
    try {
      const agent = db.listAgents()[0]
      const conversationId = db.conversationIdFor('private', agent.id)
      const trigger = db.addMessage({
        scope: 'private',
        scopeId: agent.id,
        authorType: 'user',
        authorName: '你',
        content: '请分析',
      })
      db.createExecution({ id: 'e1', conversationId, triggerMessageId: trigger.id })
      db.createRun({
        id: 'r1',
        executionId: 'e1',
        conversationId,
        triggerMessageId: trigger.id,
        agentId: agent.id,
        provider: agent.provider,
        model: agent.model,
        permission: 'chat',
      })
      db.addToolCall({ id: 'c1', runId: 'r1', toolName: 'read', displayName: '读取文件' })
      db.finishToolCall({ id: 'c1', status: 'ok', outputPreview: '文件内容' })
      db.accumulateRunUsage('r1', {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
      })
      db.markRunFirstOutput('r1')
      const reply = db.addMessage({
        scope: 'private',
        scopeId: agent.id,
        authorType: 'agent',
        authorId: agent.id,
        authorName: agent.name,
        content: '分析结果',
      })
      db.finishRun('r1', 'completed', reply.id)
      db.finishExecution('e1', 'completed')

      const run = rows(db, 'SELECT * FROM runs WHERE id = ?', 'r1')[0]
      expect(run).toMatchObject({
        id: 'r1',
        executionId: 'e1',
        status: 'completed',
        responseMessageId: reply.id,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
      })
      expect(run.firstOutputAt).toBeTruthy()
      const toolCall = rows(db, 'SELECT * FROM tool_calls WHERE id = ?', 'c1')[0]
      expect(toolCall).toMatchObject({
        runId: 'r1',
        status: 'ok',
        outputPreview: '文件内容',
      })
      const execution = rows(db, 'SELECT * FROM executions WHERE id = ?', 'e1')[0]
      expect(execution).toMatchObject({ id: 'e1', status: 'completed' })
    } finally {
      db.close()
      cleanup()
    }
  })

  it('recovery folds running runs, executions and tool calls into terminal states', () => {
    const db = fixture()
    try {
      const agent = db.listAgents()[0]
      const conversationId = db.conversationIdFor('private', agent.id)
      const trigger = db.addMessage({
        scope: 'private',
        scopeId: agent.id,
        authorType: 'user',
        authorName: '你',
        content: '请分析',
      })
      db.createExecution({ id: 'e1', conversationId, triggerMessageId: trigger.id })
      db.createRun({
        id: 'r1',
        executionId: 'e1',
        conversationId,
        triggerMessageId: trigger.id,
        agentId: agent.id,
        provider: agent.provider,
        model: agent.model,
        permission: 'chat',
      })
      db.addToolCall({ id: 'c1', runId: 'r1', toolName: 'read', displayName: '读取文件' })

      // Simulate a crash: everything is still `running`.
      db.markInterruptedRecovery()

      expect(rows(db, 'SELECT status FROM runs WHERE id = ?', 'r1')[0].status).toBe(
        'interrupted'
      )
      expect(rows(db, 'SELECT status FROM tool_calls WHERE id = ?', 'c1')[0].status).toBe(
        'aborted'
      )
      expect(rows(db, 'SELECT status FROM executions WHERE id = ?', 'e1')[0].status).toBe(
        'interrupted'
      )
    } finally {
      db.close()
      cleanup()
    }
  })

  it('attaches the persisted tool trail to the reply message it belongs to', () => {
    const db = fixture()
    try {
      const agent = db.listAgents()[0]
      const conversationId = db.conversationIdFor('private', agent.id)
      const trigger = db.addMessage({
        scope: 'private',
        scopeId: agent.id,
        authorType: 'user',
        authorName: '你',
        content: '请分析',
      })
      db.createExecution({ id: 'e1', conversationId, triggerMessageId: trigger.id })
      db.createRun({
        id: 'r1',
        executionId: 'e1',
        conversationId,
        triggerMessageId: trigger.id,
        agentId: agent.id,
        provider: agent.provider,
        model: agent.model,
        permission: 'chat',
      })
      db.addToolCall({ id: 'c1', runId: 'r1', toolName: 'read', displayName: '读取文件' })
      db.finishToolCall({ id: 'c1', status: 'ok', outputPreview: '文件内容' })
      db.addToolCall({ id: 'c2', runId: 'r1', toolName: 'write', displayName: '写入文件' })
      db.finishToolCall({ id: 'c2', status: 'error', errorPreview: '写入失败' })
      const reply = db.addMessage({
        scope: 'private',
        scopeId: agent.id,
        authorType: 'agent',
        authorId: agent.id,
        authorName: agent.name,
        content: '分析结果',
      })
      db.finishRun('r1', 'completed', reply.id)
      db.finishExecution('e1', 'completed')

      // Reopening the history returns the reply with its tool trail attached.
      const history = db.listMessages(conversationId)
      const replyMessage = history.find((message) => message.id === reply.id)
      expect(replyMessage?.toolCalls).toEqual([
        {
          id: 'c1',
          toolName: 'read',
          displayName: '读取文件',
          status: 'ok',
          output: '文件内容',
          isError: false,
        },
        {
          id: 'c2',
          toolName: 'write',
          displayName: '写入文件',
          status: 'error',
          output: '写入失败',
          isError: true,
        },
      ])
      // The user message has no tool trail.
      const userMessage = history.find((message) => message.id === trigger.id)
      expect(userMessage?.toolCalls ?? []).toEqual([])
    } finally {
      db.close()
      cleanup()
    }
  })
})
