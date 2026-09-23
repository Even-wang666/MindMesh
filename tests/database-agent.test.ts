import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { MindMeshDatabase } from '../src/main/database'
import { getAgentCapabilityHash } from '../src/main/agent-capability'

describe('updateAgent', () => {
  it('updates editable fields without changing the agent ID or space membership', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-agent-'))
    const db = new MindMeshDatabase(join(directory, 'mindmesh.sqlite'))
    try {
      const original = db.listAgents()[0]
      const space = db.listSpaces()[0]
      const updated = db.updateAgent(original.id, {
        name: 'Research Lead',
        role: '高级研究员',
        persona: '优先核查证据。',
        provider: original.provider,
        model: original.model,
        skills: original.skills,
        tools: original.tools,
      })

      expect(updated.id).toBe(original.id)
      expect(updated.createdAt).toBe(original.createdAt)
      expect(db.getAgent(original.id)?.name).toBe('Research Lead')
      expect(db.listSpaces().find((item) => item.id === space.id)?.memberIds).toContain(original.id)
    } finally {
      db.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('updateSpaceContext', () => {
  it('persists the new background without changing members or messages', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-space-'))
    const path = join(directory, 'mindmesh.sqlite')
    const db = new MindMeshDatabase(path)
    const space = db.listSpaces()[0]
    db.addMessage({ scope: 'space', scopeId: space.id, authorType: 'user', authorName: '你', content: '已有消息' })
    try {
      try {
        const updated = db.updateSpaceContext(space.id, '新的背景')
        expect(updated).toMatchObject({ id: space.id, context: '新的背景', memberIds: space.memberIds })
        expect(db.listMessages('space', space.id)).toHaveLength(1)
      } finally {
        db.close()
      }
      const reopened = new MindMeshDatabase(path)
      try {
        expect(reopened.getSpace(space.id)?.context).toBe('新的背景')
      } finally {
        reopened.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('space membership and agent deletion', () => {
  it('deletes only the selected space, its messages, and runtime sessions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-space-delete-'))
    const db = new MindMeshDatabase(join(directory, 'mindmesh.sqlite'))
    try {
      const first = db.listSpaces()[0]
      const second = db.createSpace({ name: '另一个空间', description: '', context: '', memberIds: first.memberIds })
      const agent = db.getAgent(first.memberIds[0])!
      db.addMessage({ scope: 'space', scopeId: first.id, authorType: 'user', authorName: '你', content: '删除我' })
      db.addMessage({ scope: 'space', scopeId: second.id, authorType: 'user', authorName: '你', content: '保留我' })
      db.addMessage({ scope: 'private', scopeId: agent.id, authorType: 'user', authorName: '你', content: '私聊' })
      const capabilityHash = getAgentCapabilityHash(agent)
      db.getOrCreateRuntimeSession(`space:${first.id}:${agent.id}`, agent, 'first-session', capabilityHash)
      db.getOrCreateRuntimeSession(`space:${second.id}:${agent.id}`, agent, 'second-session', capabilityHash)
      db.removeSpace(first.id)
      expect(db.getSpace(first.id)).toBeUndefined()
      expect(db.listMessages('space', first.id)).toEqual([])
      expect(db.listMessages('space', second.id)).toHaveLength(1)
      expect(db.listMessages('private', agent.id)).toHaveLength(1)
      expect(db.getOrCreateRuntimeSession(`space:${second.id}:${agent.id}`, agent, 'new', capabilityHash).harnessSessionId).toBe('second-session')
      expect(db.getOrCreateRuntimeSession(`space:${first.id}:${agent.id}`, agent, 'new', capabilityHash).harnessSessionId).toBe('new')
    } finally {
      db.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('updates space details and members atomically while preserving messages', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-space-edit-'))
    const path = join(directory, 'mindmesh.sqlite')
    const db = new MindMeshDatabase(path)
    try {
      const space = db.listSpaces()[0]
      const originalMembers = space.memberIds
      const message = db.addMessage({ scope: 'space', scopeId: space.id, authorType: 'user', authorName: '你', content: '历史' })
      const updated = db.updateSpace(space.id, { name: '新空间', description: '新简介', context: '新背景', memberIds: [originalMembers[1]] })
      expect(updated).toMatchObject({ id: space.id, name: '新空间', description: '新简介', context: '新背景', memberIds: [originalMembers[1]] })
      expect(db.listMessages('space', space.id)).toMatchObject([message])
      expect(() => db.updateSpace(space.id, { ...updated, name: '不应保存', memberIds: ['missing-agent'] })).toThrow()
      expect(db.getSpace(space.id)).toEqual(updated)
      const restored = db.updateSpace(space.id, { ...updated, memberIds: originalMembers })
      expect(restored.memberIds).toEqual(originalMembers)
      db.removeAgent(originalMembers[0])
      expect(db.getSpace(space.id)?.memberIds).toEqual([originalMembers[1]])
      expect(db.listMessages('space', space.id)).toMatchObject([message])
    } finally {
      db.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not recreate default agents after the last one is deleted', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-delete-last-'))
    const path = join(directory, 'mindmesh.sqlite')
    const db = new MindMeshDatabase(path)
    db.listAgents().forEach((item) => db.removeAgent(item.id))
    db.close()
    try {
      const reopened = new MindMeshDatabase(path)
      try { expect(reopened.listAgents()).toEqual([]) }
      finally { reopened.close() }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not restore starter data after the last Space and Agent are deleted', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-delete-all-'))
    const path = join(directory, 'mindmesh.sqlite')
    const db = new MindMeshDatabase(path)
    db.listSpaces().forEach((item) => db.removeSpace(item.id))
    db.listAgents().forEach((item) => db.removeAgent(item.id))
    db.close()
    try {
      const reopened = new MindMeshDatabase(path)
      try { expect(reopened.listSpaces()).toEqual([]); expect(reopened.listAgents()).toEqual([]) }
      finally { reopened.close() }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('workspace selection', () => {
  it('persists the selected path and starts fresh runtime sessions while keeping messages', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-workspace-'))
    const path = join(directory, 'mindmesh.sqlite')
    const db = new MindMeshDatabase(path)
    const agent = db.listAgents()[0]
    const capabilityHash = getAgentCapabilityHash(agent)
    db.getOrCreateRuntimeSession(`private:${agent.id}`, agent, 'old-session', capabilityHash)
    db.addMessage({ scope: 'private', scopeId: agent.id, authorType: 'user', authorName: '你', content: '历史' })
    db.changeWorkspace(directory)
    db.close()
    try {
      const reopened = new MindMeshDatabase(path)
      try {
        expect(reopened.getWorkspacePath()).toBe(directory)
        expect(reopened.getOrCreateRuntimeSession(`private:${agent.id}`, agent, 'new-session', capabilityHash).harnessSessionId).toBe('new-session')
        expect(reopened.listMessages('private', agent.id)[0].content).toBe('历史')
      } finally { reopened.close() }
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})

describe('user profile', () => {
  it('validates and persists a nickname and image', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-profile-'))
    const path = join(directory, 'mindmesh.sqlite')
    const db = new MindMeshDatabase(path)
    const avatar = 'data:image/png;base64,aGVsbG8='
    try {
      expect(db.getUserProfile()).toEqual({ name: '你', avatar: null })
      expect(db.saveUserProfile({ name: '  小明  ', avatar })).toEqual({ name: '小明', avatar })
      expect(() => db.saveUserProfile({ name: '  ', avatar })).toThrow('昵称')
      expect(() => db.saveUserProfile({ name: '小明', avatar: 'data:image/svg+xml;base64,PHN2Zz4=' })).toThrow('图片')
    } finally {
      db.close()
    }
    const reopened = new MindMeshDatabase(path)
    try {
      expect(reopened.getUserProfile()).toEqual({ name: '小明', avatar })
    } finally {
      reopened.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('runtime sessions', () => {
  it('adds snapshot and cursor columns to an existing database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-migration-'))
    const path = join(directory, 'mindmesh.sqlite')
    const old = new DatabaseSync(path)
    old.exec(`CREATE TABLE runtime_sessions (
      contextKey TEXT PRIMARY KEY, harnessSessionId TEXT NOT NULL,
      provider TEXT NOT NULL, model TEXT NOT NULL, capabilityHash TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )`)
    old.prepare(`INSERT INTO runtime_sessions
      (contextKey, harnessSessionId, provider, model, capabilityHash, updatedAt)
      VALUES ('private:old', 'stale-session', 'deepseek-official', 'old-model', 'stale-hash', '2026-01-01')`).run()
    old.close()
    try {
      const db = new MindMeshDatabase(path)
      try {
        const agent = db.listAgents()[0]
        expect(db.getOrCreateRuntimeSession('private:old', agent, 'new-session', 'current-hash'))
          .toMatchObject({ harnessSessionId: 'new-session', agent, lastConsumedMessageSequence: 0 })
        expect(db.referencedCapabilityHashes()).toEqual(['current-hash'])
      } finally {
        db.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('restores the original agent snapshot and consumed sequence after reopening the database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-session-'))
    const path = join(directory, 'mindmesh.sqlite')
    const db = new MindMeshDatabase(path)
    const agent = db.listAgents()[0]
    const key = `space:example:${agent.id}`
    db.getOrCreateRuntimeSession(key, agent, 'original-session', getAgentCapabilityHash(agent))
    db.saveRuntimeSessionProgress(key, 'saved-session', 7)
    db.close()
    try {
      const reopened = new MindMeshDatabase(path)
      try {
        const restored = reopened.getOrCreateRuntimeSession(key,
          { ...agent, persona: '新身份' }, 'new-session', 'new-hash')
        expect(restored).toMatchObject({
          harnessSessionId: 'saved-session',
          lastConsumedMessageSequence: 7,
          agent: { persona: agent.persona },
        })
      } finally {
        reopened.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('resets a session whose stored hash does not match its snapshot', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-session-mismatch-'))
    const path = join(directory, 'mindmesh.sqlite')
    const snapshot = {
      id: 'legacy', name: 'Legacy', role: '', persona: '冻结身份', provider: 'deepseek-official',
      model: 'deepseek-v4-flash', skills: [], tools: [], createdAt: '',
    }
    const old = new DatabaseSync(path)
    old.exec(`CREATE TABLE runtime_sessions (
      contextKey TEXT PRIMARY KEY, harnessSessionId TEXT NOT NULL,
      provider TEXT NOT NULL, model TEXT NOT NULL, capabilityHash TEXT NOT NULL,
      agentSnapshot TEXT, lastConsumedMessageSequence INTEGER NOT NULL DEFAULT 0,
      updatedAt TEXT NOT NULL
    )`)
    old.prepare(`INSERT INTO runtime_sessions
      (contextKey, harnessSessionId, provider, model, capabilityHash, agentSnapshot,
       lastConsumedMessageSequence, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('space:legacy', 'stale-session', snapshot.provider, snapshot.model, 'stale-hash',
        JSON.stringify(snapshot), 9, '2026-01-01')
    old.close()
    try {
      const db = new MindMeshDatabase(path)
      try {
        const current = db.listAgents()[0]
        const restored = db.getOrCreateRuntimeSession('space:legacy', current, 'new-session', 'current-hash')
        expect(restored).toMatchObject({ harnessSessionId: 'new-session', agent: snapshot,
          lastConsumedMessageSequence: 9 })
        expect(db.referencedCapabilityHashes()).toEqual([getAgentCapabilityHash(snapshot)])
      } finally { db.close() }
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})

describe('message reasoning', () => {
  it('upgrades existing messages and keeps new reasoning after reopening', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-reasoning-'))
    const path = join(directory, 'mindmesh.sqlite')
    const old = new DatabaseSync(path)
    old.exec(`CREATE TABLE messages (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, scopeId TEXT NOT NULL,
      authorType TEXT NOT NULL, authorId TEXT, authorName TEXT NOT NULL,
      content TEXT NOT NULL, sequence INTEGER NOT NULL, createdAt TEXT NOT NULL
    )`)
    old.prepare(`INSERT INTO messages (id, scope, scopeId, authorType, authorName, content, sequence, createdAt)
      VALUES ('old', 'private', 'agent', 'user', '你', '旧消息', 1, '2026-01-01')`).run()
    old.close()
    try {
      const db = new MindMeshDatabase(path)
      expect(db.listMessages('private', 'agent')[0]).toMatchObject({ content: '旧消息', reasoning: null })
      db.addMessage({ scope: 'private', scopeId: 'agent', authorType: 'agent',
        authorName: 'Agent', content: '回答', reasoning: '先分析\n\n再回答' })
      db.close()
      const reopened = new MindMeshDatabase(path)
      try {
        expect(reopened.listMessages('private', 'agent')[1]).toMatchObject({
          content: '回答', reasoning: '先分析\n\n再回答',
        })
      } finally { reopened.close() }
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
