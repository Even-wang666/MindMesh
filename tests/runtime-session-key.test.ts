// Phase 1 step 4: a harness session must belong to one conversation, not to an
// agent. These tests pin the isolation property directly — two conversations in
// the same scope must not share a harness session, and the consumption cursor
// must not leak across them.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  MindMeshDatabase,
  agentRuntimeKeyPattern,
  conversationRuntimeKey,
  conversationRuntimeKeyPattern,
  conversationRuntimeKeyPrefix,
  runtimeContextKey,
  runtimeSessionId,
} from '../src/main/database'
import { getAgentCapabilityHash } from '../src/main/agent-capability'
import type { Agent, Message } from '../src/shared/contracts'

function makeDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'mindmesh-runtimekey-'))
}

/** Close the database before removing the directory; SQLite keeps the file locked. */
function withDb<T>(body: (db: MindMeshDatabase) => T): T {
  const directory = makeDirectory()
  const db = new MindMeshDatabase(join(directory, 'a.db'))
  try {
    return body(db)
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
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

function agentMessage(
  db: MindMeshDatabase,
  agentId: string,
  spaceId: string,
  content: string
): Message {
  return db.addMessage({
    scope: 'space',
    scopeId: spaceId,
    authorType: 'agent',
    authorId: agentId,
    authorName: 'PM',
    reasoning: null,
    attachments: [],
    stopped: false,
    content,
  })
}

describe('runtime session key construction', () => {
  it('scopes a key to both the conversation and the agent', () => {
    expect(runtimeContextKey('space:s1', 'a1')).toBe('conversation:space:s1:a1')
    expect(runtimeContextKey('private:a1', 'a1')).toBe('conversation:private:a1:a1')
  })

  it('gives different keys to two conversations of the same agent', () => {
    expect(runtimeContextKey('private:a1', 'a1')).not.toBe(runtimeContextKey('space:s1', 'a1'))
  })

  it('produces a filesystem-safe harness session id', () => {
    // The harness session id becomes a directory name under DSH_HOME on Windows.
    expect(runtimeSessionId('space:s1', 'a1')).toBe('conversation-space-s1-a1')
    expect(runtimeSessionId('space:s1', 'a1')).not.toContain(':')
  })

  it('anchors an agent pattern on the agent segment', () => {
    // A LIKE pattern must not let agent "a" also match agent "ab".
    expect(agentRuntimeKeyPattern('a')).toBe('conversation:%:a')
    expect(agentRuntimeKeyPattern('ab')).toBe('conversation:%:ab')
  })

  it('prefix and pattern helpers agree on the same conversation', () => {
    expect(conversationRuntimeKeyPrefix('space:s1')).toBe('conversation:space:s1:')
    expect(conversationRuntimeKeyPattern('space:s1')).toBe('conversation:space:s1:%')
  })
})

describe('migrating legacy runtime session keys', () => {
  it('maps a private key onto its conversation', () => {
    expect(conversationRuntimeKey('private:a1')).toBe('conversation:private:a1:a1')
  })

  it('maps a space key onto its conversation and agent', () => {
    expect(conversationRuntimeKey('space:s1:a1')).toBe('conversation:space:s1:a1')
  })

  it('leaves already-migrated keys alone', () => {
    expect(conversationRuntimeKey('conversation:space:s1:a1')).toBeNull()
  })

  it('refuses keys it cannot attribute rather than guessing', () => {
    expect(conversationRuntimeKey('private:')).toBeNull()
    expect(conversationRuntimeKey('space:s1')).toBeNull()
    expect(conversationRuntimeKey('legacy-agent')).toBeNull()
  })
})

describe('runtime sessions are conversation scoped', () => {
  it('does not let a second conversation resume the first conversation session', () => {
    withDb((db) => {
      const agent = seedAgent(db)
      const first = runtimeContextKey('private:a1', agent.id)
      const second = runtimeContextKey('private:a1-second', agent.id)

      const hash = getAgentCapabilityHash(agent)
      db.getOrCreateRuntimeSession(first, agent, 'harness-first', hash)
      db.getOrCreateRuntimeSession(second, agent, 'harness-second', hash)

      // Re-entering each conversation must still find its own session.
      expect(db.getOrCreateRuntimeSession(first, agent, 'ignored', hash).harnessSessionId).toBe(
        'harness-first'
      )
      expect(db.getOrCreateRuntimeSession(second, agent, 'ignored', hash).harnessSessionId).toBe(
        'harness-second'
      )
    })
  })

  it('keeps the consumption cursor inside its own conversation', () => {
    withDb((db) => {
      const agent = seedAgent(db)
      const space = db.createSpace({
        name: 'Squad',
        description: 'd',
        context: 'c',
        memberIds: [agent.id],
      })

      agentMessage(db, agent.id, space.id, 'first')
      agentMessage(db, agent.id, space.id, 'second')
      expect(db.lastAgentMessageSequence(`space:${space.id}`, agent.id)).toBe(2)

      // The cursor is keyed by conversation, not by space or agent: another
      // conversation reads 0 rather than inheriting the space's high-water mark.
      expect(db.lastAgentMessageSequence('private:a1', agent.id)).toBe(0)
    })
  })

  it('re-keys existing sessions on upgrade instead of dropping them', () => {
    const directory = makeDirectory()
    const path = join(directory, 'legacy.db')
    try {
      const raw = new DatabaseSync(path)
      raw.exec('CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      raw.exec(`CREATE TABLE agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, role TEXT NOT NULL, persona TEXT NOT NULL,
        provider TEXT NOT NULL, model TEXT NOT NULL, skills TEXT NOT NULL DEFAULT '[]',
        tools TEXT NOT NULL DEFAULT '[]', createdAt TEXT NOT NULL, reasoningEffort TEXT
      )`)
      raw.exec(`CREATE TABLE spaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
        context TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL
      )`)
      raw.exec(`CREATE TABLE space_members (
        spaceId TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        agentId TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (spaceId, agentId)
      )`)
      raw.exec(`CREATE TABLE space_sources (
        space_id TEXT PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE,
        source TEXT NOT NULL, source_id TEXT NOT NULL, revision TEXT NOT NULL, manifest TEXT NOT NULL,
        UNIQUE(source, source_id)
      )`)
      raw.exec(`CREATE TABLE agent_sources (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
        source TEXT NOT NULL, source_id TEXT NOT NULL, revision TEXT NOT NULL,
        repository TEXT NOT NULL, content TEXT NOT NULL, license TEXT NOT NULL,
        license_text TEXT NOT NULL, UNIQUE(source, source_id)
      )`)
      raw.exec(`CREATE TABLE installed_plugins (
        package_name TEXT PRIMARY KEY, resolved_version TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), config_json TEXT NOT NULL,
        compatibility TEXT NOT NULL DEFAULT 'sdk-compatible', source TEXT NOT NULL DEFAULT 'npm',
        installed_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`)
      raw.exec(`CREATE TABLE runtime_sessions (
        contextKey TEXT PRIMARY KEY, harnessSessionId TEXT NOT NULL, provider TEXT NOT NULL,
        model TEXT NOT NULL, capabilityHash TEXT NOT NULL, agentSnapshot TEXT,
        lastConsumedMessageSequence INTEGER NOT NULL DEFAULT 0, updatedAt TEXT NOT NULL
      )`)
      raw.exec(`CREATE TABLE messages (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, scopeId TEXT NOT NULL, authorType TEXT NOT NULL,
        authorId TEXT, authorName TEXT NOT NULL, content TEXT NOT NULL, reasoning TEXT,
        attachments TEXT NOT NULL DEFAULT '[]', stopped INTEGER NOT NULL DEFAULT 0,
        sequence INTEGER NOT NULL, createdAt TEXT NOT NULL
      )`)
      raw.exec('CREATE UNIQUE INDEX messages_scope_sequence ON messages(scope, scopeId, sequence)')
      raw.prepare('INSERT INTO app_meta(key, value) VALUES (?, ?)').run('schema_version', '4')
      const now = new Date().toISOString()
      raw
        .prepare(
          'INSERT INTO agents (id, name, role, persona, provider, model, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .run('a1', 'PM', 'product', 'p', 'deepseek-official', 'deepseek-v4-flash', now)
      const legacyAgent: Agent = {
        id: 'a1',
        name: 'PM',
        role: 'product',
        persona: 'p',
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        skills: [],
        tools: [],
        createdAt: now,
      }
      raw
        .prepare(
          `INSERT INTO runtime_sessions
             (contextKey, harnessSessionId, provider, model, capabilityHash, agentSnapshot, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'private:a1',
          'harness-legacy',
          'deepseek-official',
          'deepseek-v4-flash',
          getAgentCapabilityHash(legacyAgent),
          JSON.stringify(legacyAgent),
          now
        )
      raw.close()

      const db = new MindMeshDatabase(path)
      try {
        const agent = db.getAgent('a1')!
        const migrated = db.getOrCreateRuntimeSession(
          runtimeContextKey('private:a1', 'a1'),
          agent,
          'ignored',
          getAgentCapabilityHash(agent)
        )
        // The user's live session survives the upgrade instead of silently resetting.
        expect(migrated.harnessSessionId).toBe('harness-legacy')
      } finally {
        db.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('clears one agent sessions without touching a same-prefix agent', () => {
    withDb((db) => {
      seedAgent(db, 'PM')
      seedAgent(db, 'PM2')
      const pm = db.listAgents().find((agent) => agent.name === 'PM')!
      const pm2 = db.listAgents().find((agent) => agent.name === 'PM2')!
      const hp = getAgentCapabilityHash(pm)
      const hp2 = getAgentCapabilityHash(pm2)

      db.getOrCreateRuntimeSession(runtimeContextKey('private:a1', pm.id), pm, 'h1', hp)
      db.getOrCreateRuntimeSession(runtimeContextKey('private:a1', pm2.id), pm2, 'h2', hp2)

      db.removeAgent(pm.id)
      expect(
        db.getOrCreateRuntimeSession(runtimeContextKey('private:a1', pm2.id), pm2, 'x', hp2)
          .harnessSessionId
      ).toBe('h2')
    })
  })

  it('drops every session of a deleted space', () => {
    withDb((db) => {
      const agent = seedAgent(db)
      const space = db.createSpace({
        name: 'Squad',
        description: 'd',
        context: 'c',
        memberIds: [agent.id],
      })
      const hash = getAgentCapabilityHash(agent)
      db.getOrCreateRuntimeSession(
        runtimeContextKey(`space:${space.id}`, agent.id),
        agent,
        'space-h',
        hash
      )
      db.getOrCreateRuntimeSession(runtimeContextKey('private:a1', agent.id), agent, 'priv-h', hash)

      db.removeSpace(space.id)
      // The space session goes; the agent's private chat is untouched.
      expect(
        db.getOrCreateRuntimeSession(runtimeContextKey('private:a1', agent.id), agent, 'x', hash)
          .harnessSessionId
      ).toBe('priv-h')
    })
  })
})
