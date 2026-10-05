// Phase 1 CR round1: conversation isolation gaps left by the schema work.
//
// Three properties are pinned here, each of which was previously violated:
//   1. History reads must not concatenate two conversations of the same scope.
//   2. Deleting a space (or an agent) must remove every conversation it owns, plus
//      the runtime sessions keyed to those conversations.
//   3. `runs` must carry the authoritative per-run usage columns, both on a fresh
//      database and after upgrading a database created before v8.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { MindMeshDatabase, runtimeContextKey } from '../src/main/database'
import { getAgentCapabilityHash } from '../src/main/agent-capability'
import type { Agent } from '../src/shared/contracts'

function makeDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'mindmesh-convscope-'))
}

function cleanup(directory: string): void {
  try {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {
    // A locked handle must not fail an otherwise passing assertion; this is the
    // same Windows WAL release race database-migration.test.ts works around.
  }
}

/** Close the database before removing the directory; SQLite keeps the file locked. */
function withDb<T>(body: (db: MindMeshDatabase) => T): T {
  const directory = makeDirectory()
  const db = new MindMeshDatabase(join(directory, 'a.db'))
  try {
    return body(db)
  } finally {
    db.close()
    cleanup(directory)
  }
}

function seedAgent(db: MindMeshDatabase, name = 'PM'): Agent {
  return db.createAgent({
    name,
    role: 'product',
    persona: 'p',
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    skills: [],
    tools: [],
  })
}

/**
 * Insert a second conversation for the same scope.
 *
 * `addMessage` always resolves the scope-derived default conversation, so a second
 * one has to be written directly — that is exactly the state Phase 2 will produce,
 * and it is unreachable through the current single-conversation UI.
 */
function addSecondConversation(
  db: MindMeshDatabase,
  scope: 'private' | 'space',
  scopeId: string,
  conversationId: string,
  content: string
): void {
  const raw = (db as unknown as { db: DatabaseSync }).db
  const stamp = new Date().toISOString()
  raw
    .prepare(
      `INSERT INTO conversations (id, scope, scopeId, title, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(conversationId, scope, scopeId, conversationId, stamp, stamp)
  raw
    .prepare(
      `INSERT INTO messages (
         id, conversationId, authorType, authorName, content, attachments, stopped,
         sequence, createdAt
       ) VALUES (?, ?, 'user', 'U', ?, '[]', 0, 1, ?)`
    )
    .run(`${conversationId}-m1`, conversationId, content, stamp)
}

function conversationIds(db: MindMeshDatabase): string[] {
  const raw = (db as unknown as { db: DatabaseSync }).db
  return (
    raw.prepare('SELECT id FROM conversations ORDER BY id').all() as Array<{ id: string }>
  ).map((row) => row.id)
}

function runtimeKeys(db: MindMeshDatabase): string[] {
  const raw = (db as unknown as { db: DatabaseSync }).db
  return (
    raw.prepare('SELECT contextKey FROM runtime_sessions ORDER BY contextKey').all() as Array<{
      contextKey: string
    }>
  ).map((row) => row.contextKey)
}

/** Every conversation with its title, so default-row bookkeeping can be asserted. */
function conversationTitles(db: MindMeshDatabase): Array<{ id: string; title: string }> {
  const raw = (db as unknown as { db: DatabaseSync }).db
  return raw
    .prepare('SELECT id, title FROM conversations ORDER BY id')
    .all() as Array<{ id: string; title: string }>
}

describe('every scope owns its default conversation', () => {
  it('creates the default conversation when an agent is created', () => {
    withDb((db) => {
      const agent = seedAgent(db)
      expect(conversationTitles(db)).toContainEqual({
        id: db.conversationIdFor('private', agent.id),
        title: agent.name,
      })
    })
  })

  it('creates the default conversation when a space is created', () => {
    withDb((db) => {
      const agent = seedAgent(db)
      const space = db.createSpace({
        name: 'Squad',
        description: 'd',
        context: 'c',
        memberIds: [agent.id],
      })
      expect(conversationTitles(db)).toContainEqual({
        id: db.conversationIdFor('space', space.id),
        title: space.name,
      })
    })
  })

  it('renames the default conversation title along with its owner', () => {
    withDb((db) => {
      const agent = seedAgent(db)
      const space = db.createSpace({
        name: 'Squad',
        description: 'd',
        context: 'c',
        memberIds: [agent.id],
      })

      db.updateAgent(agent.id, {
        name: 'Renamed PM',
        role: agent.role,
        persona: agent.persona,
        provider: agent.provider,
        model: agent.model,
        skills: [],
        tools: [],
      })
      db.updateSpace(space.id, {
        name: 'Renamed Squad',
        description: 'd',
        context: 'c',
        memberIds: [agent.id],
      })

      const titles = conversationTitles(db)
      expect(titles).toContainEqual({
        id: db.conversationIdFor('private', agent.id),
        title: 'Renamed PM',
      })
      expect(titles).toContainEqual({
        id: db.conversationIdFor('space', space.id),
        title: 'Renamed Squad',
      })
    })
  })
})

describe('history reads are conversation scoped', () => {
  it('does not merge two conversations of the same agent', () => {
    withDb((db) => {
      const agent = seedAgent(db)
      const first = db.conversationIdFor('private', agent.id)
      db.addMessage({
        scope: 'private',
        scopeId: agent.id,
        authorType: 'user',
        authorName: 'U',
        content: 'first conversation',
      })
      addSecondConversation(db, 'private', agent.id, 'private:extra', 'second conversation')

      // The scope-derived id no longer resolves "all of this agent's messages";
      // it names exactly one conversation.
      expect(db.listMessages(first).map((message) => message.content)).toEqual([
        'first conversation',
      ])
      expect(db.listMessages('private:extra').map((message) => message.content)).toEqual([
        'second conversation',
      ])
      expect(db.listMessages(first)[0].scopeId).toBe(agent.id)
    })
  })

  it('does not merge two conversations of the same space', () => {
    withDb((db) => {
      const agent = seedAgent(db)
      const space = db.createSpace({
        name: 'Squad',
        description: 'd',
        context: 'c',
        memberIds: [agent.id],
      })
      const first = db.conversationIdFor('space', space.id)
      db.addMessage({
        scope: 'space',
        scopeId: space.id,
        authorType: 'user',
        authorName: 'U',
        content: 'space first',
      })
      addSecondConversation(db, 'space', space.id, 'space:extra', 'space second')

      expect(db.listMessages(first).map((message) => message.content)).toEqual(['space first'])
      expect(db.listMessages('space:extra').map((message) => message.content)).toEqual([
        'space second',
      ])
    })
  })

  it('keeps the consumption cursor consistent with the history it filters', () => {
    withDb((db) => {
      const agent = seedAgent(db)
      const space = db.createSpace({
        name: 'Squad',
        description: 'd',
        context: 'c',
        memberIds: [agent.id],
      })
      const first = db.conversationIdFor('space', space.id)
      for (const content of ['a', 'b', 'c']) {
        db.addMessage({
          scope: 'space',
          scopeId: space.id,
          authorType: 'agent',
          authorId: agent.id,
          authorName: 'PM',
          content,
        })
      }
      const cursor = db.lastAgentMessageSequence(first, agent.id)
      expect(cursor).toBe(3)

      // listMessagesSince must read the same conversation the cursor came from,
      // otherwise a second conversation's messages would leak into the prompt.
      db.addMessage({
        scope: 'space',
        scopeId: space.id,
        authorType: 'user',
        authorName: 'U',
        content: 'new turn',
      })
      addSecondConversation(db, 'space', space.id, 'space:extra', 'other conversation')
      const since = db.listMessagesSince(first, cursor)
      expect(since.map((message) => message.content)).toEqual(['new turn'])
    })
  })
})

describe('deleting a scope removes every conversation it owns', () => {
  it('removes a second space conversation and its runtime sessions', () => {
    withDb((db) => {
      const agent = seedAgent(db)
      const space = db.createSpace({
        name: 'Squad',
        description: 'd',
        context: 'c',
        memberIds: [agent.id],
      })
      addSecondConversation(db, 'space', space.id, 'space:extra', 'extra history')
      // A space's default conversation is created lazily by the first message, so
      // send one to get the two-conversation state Phase 2 will produce.
      db.addMessage({
        scope: 'space',
        scopeId: space.id,
        authorType: 'user',
        authorName: 'U',
        content: 'default conversation',
      })
      const hash = getAgentCapabilityHash(agent)
      db.getOrCreateRuntimeSession(
        runtimeContextKey('space:extra', agent.id),
        agent,
        'extra-h',
        hash
      )
      db.getOrCreateRuntimeSession(
        runtimeContextKey(db.conversationIdFor('space', space.id), agent.id),
        agent,
        'default-h',
        hash
      )
      db.getOrCreateRuntimeSession(
        runtimeContextKey(db.conversationIdFor('private', agent.id), agent.id),
        agent,
        'private-h',
        hash
      )
      expect(runtimeKeys(db)).toHaveLength(3)

      const removed = db.removeSpace(space.id)
      expect(removed.sort()).toEqual(['space:extra', `space:${space.id}`].sort())
      expect(conversationIds(db)).not.toContain('space:extra')
      expect(db.listMessages('space:extra')).toEqual([])
      // Space sessions go, including the one under a non-default conversation id;
      // the agent's own private chat must survive.
      expect(runtimeKeys(db)).toEqual([
        runtimeContextKey(db.conversationIdFor('private', agent.id), agent.id),
      ])
    })
  })

  it('cascades executions and runs of a second conversation', () => {
    withDb((db) => {
      const agent = seedAgent(db)
      const space = db.createSpace({
        name: 'Squad',
        description: 'd',
        context: 'c',
        memberIds: [agent.id],
      })
      addSecondConversation(db, 'space', space.id, 'space:extra', 'extra history')
      const raw = (db as unknown as { db: DatabaseSync }).db
      const stamp = new Date().toISOString()
      raw
        .prepare(
          `INSERT INTO executions (id, conversationId, triggerMessageId, status, startedAt)
           VALUES ('e1', 'space:extra', 'space:extra-m1', 'completed', ?)`
        )
        .run(stamp)
      raw
        .prepare(
          `INSERT INTO runs (id, executionId, conversationId, triggerMessageId, agentId,
             provider, model, permission, status, startedAt)
           VALUES ('r1', 'e1', 'space:extra', 'space:extra-m1', ?, 'deepseek-official',
             'deepseek-v4-flash', 'ask', 'completed', ?)`
        )
        .run(agent.id, stamp)

      db.removeSpace(space.id)
      expect(raw.prepare('SELECT COUNT(*) AS n FROM executions').get()).toEqual({ n: 0 })
      expect(raw.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 })
    })
  })

  it('removes a deleted agent private conversations and sessions', () => {
    withDb((db) => {
      const agent = seedAgent(db)
      const other = seedAgent(db, 'DEV')
      addSecondConversation(db, 'private', agent.id, 'private:extra', 'extra history')
      const hash = getAgentCapabilityHash(agent)
      db.getOrCreateRuntimeSession(runtimeContextKey('private:extra', agent.id), agent, 'h1', hash)
      db.getOrCreateRuntimeSession(
        runtimeContextKey(db.conversationIdFor('private', other.id), other.id),
        other,
        'h2',
        getAgentCapabilityHash(other)
      )

      db.removeAgent(agent.id)
      expect(conversationIds(db)).not.toContain('private:extra')
      expect(db.listMessages('private:extra')).toEqual([])
      expect(runtimeKeys(db)).toEqual([
        runtimeContextKey(db.conversationIdFor('private', other.id), other.id),
      ])
    })
  })
})

describe('runs carry authoritative usage columns', () => {
  const USAGE_COLUMNS = [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
  ] as const

  function runColumns(db: MindMeshDatabase): string[] {
    const raw = (db as unknown as { db: DatabaseSync }).db
    return (raw.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  }

  it('defines the usage columns on a fresh database', () => {
    withDb((db) => {
      expect(runColumns(db)).toEqual(expect.arrayContaining([...USAGE_COLUMNS]))
    })
  })

  it('adds the usage columns when upgrading a pre-v8 database', () => {
    const directory = makeDirectory()
    const path = join(directory, 'legacy.db')
    try {
      // Build a v7 database, then drop the usage columns so the upgrade path runs
      // for real instead of short-circuiting on an already-correct schema.
      const legacy = new MindMeshDatabase(path)
      legacy.close()
      const raw = new DatabaseSync(path)
      raw.exec('PRAGMA foreign_keys = ON;')
      raw.exec('BEGIN')
      raw.exec(`CREATE TABLE runs_v7 (
        id TEXT PRIMARY KEY,
        executionId TEXT NOT NULL,
        conversationId TEXT NOT NULL,
        triggerMessageId TEXT NOT NULL,
        responseMessageId TEXT,
        agentId TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        permission TEXT NOT NULL,
        status TEXT NOT NULL,
        startedAt TEXT NOT NULL,
        firstOutputAt TEXT,
        endedAt TEXT,
        agentSnapshot TEXT
      )`)
      raw.exec('DROP TABLE runs')
      raw.exec('ALTER TABLE runs_v7 RENAME TO runs')
      raw.exec(
        `INSERT INTO app_meta(key, value) VALUES ('schema_version', '7')
         ON CONFLICT(key) DO UPDATE SET value = '7'`
      )
      raw.exec('COMMIT')
      raw.close()

      const upgraded = new MindMeshDatabase(path)
      try {
        expect(runColumns(upgraded)).toEqual(expect.arrayContaining([...USAGE_COLUMNS]))
      } finally {
        upgraded.close()
      }
    } finally {
      cleanup(directory)
    }
  })

  it('stores per-run usage independently of the execution summary', () => {
    withDb((db) => {
      const agent = seedAgent(db)
      db.addMessage({
        scope: 'private',
        scopeId: agent.id,
        authorType: 'user',
        authorName: 'U',
        content: 'hi',
      })
      const conversationId = db.conversationIdFor('private', agent.id)
      const raw = (db as unknown as { db: DatabaseSync }).db
      const stamp = new Date().toISOString()
      const message = db.listMessages(conversationId)[0]
      raw
        .prepare(
          `INSERT INTO executions (id, conversationId, triggerMessageId, status, startedAt,
             inputTokens, outputTokens)
           VALUES ('e1', ?, ?, 'completed', ?, 900, 100)`
        )
        .run(conversationId, message.id, stamp)
      raw
        .prepare(
          `INSERT INTO runs (id, executionId, conversationId, triggerMessageId, agentId,
             provider, model, permission, status, startedAt, inputTokens, outputTokens,
             cacheReadTokens)
           VALUES ('r1', 'e1', ?, ?, ?, 'deepseek-official', 'deepseek-v4-flash', 'ask',
             'completed', ?, 500, 60, 40)`
        )
        .run(conversationId, message.id, agent.id, stamp)

      // The summary and the raw per-run numbers are stored side by side, so a wrong
      // execution total can always be recomputed from its runs.
      const execution = raw
        .prepare('SELECT inputTokens, outputTokens FROM executions WHERE id = ?')
        .get('e1') as { inputTokens: number; outputTokens: number }
      const run = raw
        .prepare('SELECT inputTokens, outputTokens, cacheReadTokens FROM runs WHERE id = ?')
        .get('r1') as { inputTokens: number; outputTokens: number; cacheReadTokens: number }
      expect(execution).toEqual({ inputTokens: 900, outputTokens: 100 })
      expect(run).toEqual({ inputTokens: 500, outputTokens: 60, cacheReadTokens: 40 })
      expect(run.inputTokens).not.toBe(execution.inputTokens)
    })
  })
})