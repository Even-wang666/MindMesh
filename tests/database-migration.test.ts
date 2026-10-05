import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { MindMeshDatabase } from '../src/main/database'

// Phase 1 migration coverage: build a database at each historical schema version,
// let MindMeshDatabase migrate it, and assert the resulting shape. The messages
// rebuild is destructive, so every case also checks that history survived and that
// no foreign key was left dangling.
//
// Each case owns its directory and removes it inline. A shared afterEach would hit
// "EBUSY: resource busy" because the SQLite handles are released per test, not per
// file, and Windows may still hold the WAL sidecar open.

function makeDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'mindmesh-migrate-'))
}

function cleanup(directory: string): void {
  try {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {
    // A locked handle must not fail an otherwise passing migration assertion.
  }
}

/**
 * Replay the pre-Phase-1 schema so each migration path is exercised for real.
 *
 * The v0 case is the important one: a fresh database only gets the base tables from
 * migrate(), and the v2/v3/v4 tables are created by the later guarded steps. Getting
 * that ordering wrong is exactly the bug this suite is meant to catch.
 */
function seedLegacySchema(version: number, path: string): void {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
  db.exec('CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  db.exec(`CREATE TABLE agents (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, role TEXT NOT NULL, persona TEXT NOT NULL,
    provider TEXT NOT NULL, model TEXT NOT NULL, skills TEXT NOT NULL DEFAULT '[]',
    tools TEXT NOT NULL DEFAULT '[]', createdAt TEXT NOT NULL${version >= 1 ? ', reasoningEffort TEXT' : ''}
  )`)
  db.exec(`CREATE TABLE spaces (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, context TEXT NOT NULL,
    createdAt TEXT NOT NULL
  )`)
  db.exec(`CREATE TABLE space_members (
    spaceId TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    agentId TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (spaceId, agentId)
  )`)
  db.exec(`CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK(scope IN ('private', 'space')),
    scopeId TEXT NOT NULL,
    authorType TEXT NOT NULL CHECK(authorType IN ('user', 'agent', 'system')),
    authorId TEXT, authorName TEXT NOT NULL, content TEXT NOT NULL,
    reasoning TEXT, attachments TEXT NOT NULL DEFAULT '[]',
    stopped INTEGER NOT NULL DEFAULT 0, sequence INTEGER NOT NULL, createdAt TEXT NOT NULL
  )`)
  db.exec('CREATE UNIQUE INDEX messages_scope_sequence ON messages(scope, scopeId, sequence)')
  db.exec(`CREATE TABLE runtime_sessions (
    contextKey TEXT PRIMARY KEY, harnessSessionId TEXT NOT NULL, capabilityHash TEXT NOT NULL,
    agentSnapshot TEXT, lastConsumedMessageSequence INTEGER NOT NULL DEFAULT 0
  )`)
  db.exec(
    'CREATE TABLE user_profile (id INTEGER PRIMARY KEY CHECK(id = 1), name TEXT NOT NULL, avatar TEXT)'
  )

  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO agents (id, name, role, persona, provider, model, skills, tools, createdAt)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run('a1', 'PM', 'pm', 'p', 'deepseek-official', 'm', '[]', '[]', now)
  db.exec(`INSERT INTO spaces VALUES ('s1', 'Squad', 'd', 'c', '${now}')`)
  db.exec("INSERT INTO space_members VALUES ('s1', 'a1', 0)")
  db.exec(`INSERT INTO messages (id, scope, scopeId, authorType, authorId, authorName, content,
      reasoning, attachments, stopped, sequence, createdAt)
    VALUES ('m1', 'private', 'a1', 'user', NULL, 'Me', 'hello', NULL, '[]', 0, 1, '${now}'),
           ('m2', 'space', 's1', 'agent', 'a1', 'PM', 'reply', 'thinking', '[]', 0, 2, '${now}')`)

  if (version >= 2)
    db.exec(`CREATE TABLE installed_plugins (
      package_name TEXT PRIMARY KEY, resolved_version TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), config_json TEXT NOT NULL,
      compatibility TEXT NOT NULL DEFAULT 'sdk-compatible', source TEXT NOT NULL DEFAULT 'npm',
      installed_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`)
  if (version >= 3)
    db.exec(`CREATE TABLE agent_sources (
      agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
      source TEXT NOT NULL, source_id TEXT NOT NULL, revision TEXT NOT NULL,
      repository TEXT NOT NULL, content TEXT NOT NULL, license TEXT NOT NULL,
      license_text TEXT NOT NULL, UNIQUE(source, source_id)
    )`)
  if (version >= 4)
    db.exec(`CREATE TABLE space_sources (
      space_id TEXT PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE,
      source TEXT NOT NULL, source_id TEXT NOT NULL, revision TEXT NOT NULL, manifest TEXT NOT NULL,
      UNIQUE(source, source_id)
    )`)
  if (version >= 5) {
    // A v5 database has already been through the conversations rebuild, so it must
    // not be replayed with the legacy (scope, scopeId) messages shape.
    db.exec(`CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK(scope IN ('private', 'space')),
      scopeId TEXT NOT NULL,
      title TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      archivedAt TEXT
    )`)
    db.exec('CREATE INDEX conversations_scope ON conversations(scope, scopeId, updatedAt DESC)')
    db.exec(`CREATE TABLE messages_v2 (
      id TEXT PRIMARY KEY,
      conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      authorType TEXT NOT NULL CHECK(authorType IN ('user', 'agent', 'system')),
      authorId TEXT, authorName TEXT NOT NULL, content TEXT NOT NULL,
      reasoning TEXT, attachments TEXT NOT NULL DEFAULT '[]',
      stopped INTEGER NOT NULL DEFAULT 0, sequence INTEGER NOT NULL, createdAt TEXT NOT NULL
    )`)
    db.exec(
      `INSERT INTO conversations VALUES ('private:a1', 'private', 'a1', 'PM', '${now}', '${now}', NULL)`
    )
    db.exec(
      `INSERT INTO conversations VALUES ('space:s1', 'space', 's1', 'Squad', '${now}', '${now}', NULL)`
    )
    db.exec(`INSERT INTO messages_v2 VALUES
      ('m1', 'private:a1', 'user', NULL, 'Me', 'hello', NULL, '[]', 0, 1, '${now}'),
      ('m2', 'space:s1', 'agent', 'a1', 'PM', 'reply', 'thinking', '[]', 0, 2, '${now}')`)
    db.exec('DROP TABLE messages')
    db.exec('ALTER TABLE messages_v2 RENAME TO messages')
    db.exec(
      'CREATE UNIQUE INDEX messages_conversation_sequence ON messages(conversationId, sequence)'
    )
  }

  db.prepare('INSERT INTO app_meta(key, value) VALUES (?, ?)').run(
    'schema_version',
    String(version)
  )
  db.close()
}

function columnsOf(db: DatabaseSync, table: string): Set<string> {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((r) => r.name as string)
  )
}

describe('schema migration to conversations and executions', () => {
  for (const version of [0, 2, 3, 4, 5]) {
    it(`migrates a v${version} database without losing history`, () => {
      const directory = makeDirectory()
      const path = join(directory, `v${version}.db`)
      seedLegacySchema(version, path)

      const db = new MindMeshDatabase(path)
      const raw = new DatabaseSync(path)
      raw.exec('PRAGMA foreign_keys = ON;')

      // conversations replaces scope/scopeId as the unit that owns messages.
      const conversationColumns = columnsOf(raw, 'conversations')
      expect([...conversationColumns]).toEqual(
        expect.arrayContaining([
          'id',
          'scope',
          'scopeId',
          'title',
          'createdAt',
          'updatedAt',
          'archivedAt',
        ])
      )

      const messageColumns = columnsOf(raw, 'messages')
      expect(messageColumns.has('conversationId')).toBe(true)
      expect(messageColumns.has('scope')).toBe(false)
      expect(messageColumns.has('scopeId')).toBe(false)
      // Columns the rebuild must preserve.
      expect(messageColumns.has('reasoning')).toBe(true)
      expect(messageColumns.has('attachments')).toBe(true)
      expect(messageColumns.has('stopped')).toBe(true)

      const messageIndexes = raw
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='messages'")
        .all()
        .map((r) => r.name as string)
      expect(messageIndexes).toContain('messages_conversation_sequence')
      expect(messageIndexes).not.toContain('messages_scope_sequence')

      // One default conversation per agent and per space, including the ones seeded
      // after the migration — the delete paths enumerate conversations, so "every
      // scope owns its default conversation" has to hold for newly created rows too.
      const conversations = raw
        .prepare('SELECT id, scope FROM conversations ORDER BY id')
        .all() as Array<{ id: string; scope: string }>
      expect(conversations).toEqual(
        expect.arrayContaining([
          { id: 'private:a1', scope: 'private' },
          { id: 'space:s1', scope: 'space' },
        ])
      )
      const agentIds = (raw.prepare('SELECT id FROM agents').all() as Array<{ id: string }>).map(
        (row) => row.id
      )
      const spaceIds = (raw.prepare('SELECT id FROM spaces').all() as Array<{ id: string }>).map(
        (row) => row.id
      )
      expect(conversations).toHaveLength(agentIds.length + spaceIds.length)
      for (const id of agentIds) {
        expect(conversations).toContainEqual({ id: `private:${id}`, scope: 'private' })
      }
      for (const id of spaceIds) {
        expect(conversations).toContainEqual({ id: `space:${id}`, scope: 'space' })
      }

      // History survives and maps onto the right conversation.
      const messages = raw
        .prepare('SELECT id, conversationId, sequence, reasoning FROM messages ORDER BY id')
        .all()
      expect(messages).toEqual([
        { id: 'm1', conversationId: 'private:a1', sequence: 1, reasoning: null },
        { id: 'm2', conversationId: 'space:s1', sequence: 2, reasoning: 'thinking' },
      ])

      expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([])

      raw.close()
      db.close()
      cleanup(directory)
    })
  }

  it('creates execution history tables with lineage owned by executions', () => {
    const directory = makeDirectory()
    const path = join(directory, 'exec.db')
    const db = new MindMeshDatabase(path)
    const raw = new DatabaseSync(path)

    const executionColumns = columnsOf(raw, 'executions')
    expect([...executionColumns]).toEqual(
      expect.arrayContaining([
        'conversationId',
        'triggerMessageId',
        'status',
        'workflowSnapshot',
        'generationIndex',
        'regeneratedFromExecutionId',
        'startedAt',
        'endedAt',
      ])
    )
    // A space execution fans out to several runs, so lineage must not live on runs.
    const runColumns = columnsOf(raw, 'runs')
    expect(runColumns.has('executionId')).toBe(true)
    expect(runColumns.has('regeneratedFromRunId')).toBe(false)
    expect(runColumns.has('generationIndex')).toBe(false)

    const toolCallColumns = columnsOf(raw, 'tool_calls')
    expect([...toolCallColumns]).toEqual(
      expect.arrayContaining(['runId', 'sequence', 'toolName', 'status', 'elapsedMs'])
    )

    // §4.6: runs hold the authoritative per-agent usage, executions the summary.
    const runUsageColumns = columnsOf(raw, 'runs')
    expect([...runUsageColumns]).toEqual(
      expect.arrayContaining([
        'inputTokens',
        'outputTokens',
        'cacheReadTokens',
        'cacheWriteTokens',
      ])
    )

    const version = raw.prepare("SELECT value FROM app_meta WHERE key='schema_version'").get()
    expect(version?.value).toBe('8')

    raw.close()
    db.close()
    cleanup(directory)
  })

  it('refuses a database written by a newer build', () => {
    const directory = makeDirectory()
    const path = join(directory, 'future.db')
    const db = new MindMeshDatabase(path)
    db.close()
    const raw = new DatabaseSync(path)
    raw.prepare('UPDATE app_meta SET value = ? WHERE key = ?').run('99', 'schema_version')
    raw.close()
    expect(() => new MindMeshDatabase(path)).toThrow(/Unsupported database schema version/)
    cleanup(directory)
  })
})
