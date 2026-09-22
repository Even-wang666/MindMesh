import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { MindMeshDatabase } from '../src/main/database'

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
    old.close()
    try {
      const db = new MindMeshDatabase(path)
      try {
        const agent = db.listAgents()[0]
        expect(db.getOrCreateRuntimeSession('private:old', agent, 'old-session', 'hash'))
          .toMatchObject({ harnessSessionId: 'old-session', lastConsumedMessageSequence: 0 })
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
    db.getOrCreateRuntimeSession(key, agent, 'original-session', 'hash')
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
})
