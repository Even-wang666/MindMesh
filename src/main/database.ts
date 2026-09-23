import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Agent, CreateAgentInput, CreateSpaceInput, Message, Space, UserProfile } from '../shared/contracts'
import { getAgentCapabilityHash } from './agent-capability'

type AgentRow = Omit<Agent, 'skills' | 'tools'> & { skills: string; tools: string }
type SpaceRow = Omit<Space, 'memberIds'>
type RuntimeSessionRow = {
  harnessSessionId: string
  capabilityHash: string
  agentSnapshot: string | null
  lastConsumedMessageSequence: number
}

export type RuntimeSession = {
  harnessSessionId: string
  agent: Agent
  lastConsumedMessageSequence: number
}

export class MindMeshDatabase {
  private readonly db: DatabaseSync

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.migrate()
    this.seed()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL,
        persona TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        skills TEXT NOT NULL DEFAULT '[]',
        tools TEXT NOT NULL DEFAULT '[]',
        createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS spaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        context TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS space_members (
        spaceId TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        agentId TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (spaceId, agentId)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK(scope IN ('private', 'space')),
        scopeId TEXT NOT NULL,
        authorType TEXT NOT NULL CHECK(authorType IN ('user', 'agent', 'system')),
        authorId TEXT,
        authorName TEXT NOT NULL,
        content TEXT NOT NULL,
        reasoning TEXT,
        sequence INTEGER NOT NULL,
        createdAt TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS messages_scope_sequence
        ON messages(scope, scopeId, sequence);
      CREATE TABLE IF NOT EXISTS runtime_sessions (
        contextKey TEXT PRIMARY KEY,
        harnessSessionId TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        capabilityHash TEXT NOT NULL,
        agentSnapshot TEXT,
        lastConsumedMessageSequence INTEGER NOT NULL DEFAULT 0,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_profile (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        name TEXT NOT NULL,
        avatar TEXT
      );
      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
    const columns = this.db.prepare('PRAGMA table_info(runtime_sessions)').all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === 'agentSnapshot')) {
      this.db.exec('ALTER TABLE runtime_sessions ADD COLUMN agentSnapshot TEXT')
    }
    if (!columns.some((column) => column.name === 'lastConsumedMessageSequence')) {
      this.db.exec('ALTER TABLE runtime_sessions ADD COLUMN lastConsumedMessageSequence INTEGER NOT NULL DEFAULT 0')
    }
    const messageColumns = this.db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
    if (!messageColumns.some((column) => column.name === 'reasoning')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN reasoning TEXT')
    }
  }

  private seed(): void {
    if (this.db.prepare("SELECT value FROM app_meta WHERE key = 'seeded'").get()) return
    const count = this.db.prepare('SELECT COUNT(*) AS count FROM agents').get() as { count: number }
    const spaces = this.db.prepare('SELECT COUNT(*) AS count FROM spaces').get() as { count: number }
    if (count.count > 0 || spaces.count > 0) {
      this.db.prepare("INSERT INTO app_meta (key, value) VALUES ('seeded', '1')").run()
      return
    }

    const researcher = this.createAgent({
      name: 'Researcher',
      role: '研究分析专家',
      persona: '你是一名严谨的研究分析专家。优先使用事实与证据，输出结构化结论。',
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      skills: ['研究分析', '报告撰写'],
      tools: ['网页搜索', '文件'],
    })
    const developer = this.createAgent({
      name: 'Developer',
      role: '软件工程师',
      persona: '你是一名务实的软件工程师。先澄清约束，再给出可验证的实现。',
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      skills: ['代码审查'],
      tools: ['文件', 'Shell'],
    })
    this.createSpace({
      name: 'AI Product Research',
      description: '讨论和研究 Multi-Agent 产品设计。',
      context: '当前目标：完成 MindMesh MVP。优先验证 Agent 创建、私聊和 Space 协作。',
      memberIds: [researcher.id, developer.id],
    })
    this.db.prepare("INSERT INTO app_meta (key, value) VALUES ('seeded', '1')").run()
  }

  listAgents(): Agent[] {
    const rows = this.db.prepare('SELECT * FROM agents ORDER BY createdAt ASC').all() as unknown as AgentRow[]
    return rows.map((row) => ({ ...row, skills: JSON.parse(row.skills), tools: JSON.parse(row.tools) }))
  }

  getAgent(id: string): Agent | undefined {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined
    return row ? { ...row, skills: JSON.parse(row.skills), tools: JSON.parse(row.tools) } : undefined
  }

  createAgent(input: CreateAgentInput): Agent {
    const agent: Agent = { ...input, id: randomUUID(), createdAt: new Date().toISOString() }
    this.db.prepare(`
      INSERT INTO agents (id, name, role, persona, provider, model, skills, tools, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(agent.id, agent.name, agent.role, agent.persona, agent.provider, agent.model,
      JSON.stringify(agent.skills), JSON.stringify(agent.tools), agent.createdAt)
    return agent
  }

  updateAgent(id: string, input: CreateAgentInput): Agent {
    const existing = this.getAgent(id)
    if (!existing) throw new Error('智能体不存在')
    if (!input.name.trim() || !input.persona.trim()) throw new Error('名称和身份设定不能为空')
    const agent: Agent = {
      ...existing,
      name: input.name.trim(),
      role: input.role.trim(),
      persona: input.persona.trim(),
      provider: input.provider,
      model: input.model,
      skills: input.skills,
      tools: input.tools,
    }
    this.db.prepare(`
      UPDATE agents SET name = ?, role = ?, persona = ?, provider = ?, model = ?, skills = ?, tools = ?
      WHERE id = ?
    `).run(agent.name, agent.role, agent.persona, agent.provider, agent.model,
      JSON.stringify(agent.skills), JSON.stringify(agent.tools), id)
    return agent
  }

  removeAgent(id: string): void {
    this.db.prepare('DELETE FROM agents WHERE id = ?').run(id)
  }

  listSpaces(): Space[] {
    const rows = this.db.prepare('SELECT * FROM spaces ORDER BY createdAt ASC').all() as unknown as SpaceRow[]
    const members = this.db.prepare('SELECT agentId FROM space_members WHERE spaceId = ? ORDER BY position ASC')
    return rows.map((row) => ({
      ...row,
      memberIds: (members.all(row.id) as unknown as Array<{ agentId: string }>).map((item) => item.agentId),
    }))
  }

  getSpace(id: string): Space | undefined {
    return this.listSpaces().find((space) => space.id === id)
  }

  getUserProfile(): UserProfile {
    return this.db.prepare('SELECT name, avatar FROM user_profile WHERE id = 1').get() as UserProfile | undefined
      ?? { name: '你', avatar: null }
  }

  getWorkspacePath(): string | undefined {
    return (this.db.prepare("SELECT value FROM app_meta WHERE key = 'workspacePath'").get() as { value: string } | undefined)?.value
  }

  changeWorkspace(path: string): void {
    this.db.exec('BEGIN')
    try {
      this.db.prepare("INSERT INTO app_meta (key, value) VALUES ('workspacePath', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(path)
      this.db.prepare('DELETE FROM runtime_sessions').run()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  saveUserProfile(input: UserProfile): UserProfile {
    const name = typeof input?.name === 'string' ? input.name.trim() : ''
    if (!name || name.length > 40) throw new Error('昵称需为 1–40 个字符')
    const avatar = input.avatar
    if (avatar !== null && (typeof avatar !== 'string' || avatar.length > 1_500_000 ||
      !/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(avatar))) {
      throw new Error('请选择不超过 1 MB 的 PNG、JPEG、WebP 或 GIF 图片')
    }
    this.db.prepare(`INSERT INTO user_profile (id, name, avatar) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, avatar = excluded.avatar`).run(name, avatar)
    return { name, avatar }
  }

  updateSpaceContext(id: string, context: string): Space {
    const result = this.db.prepare('UPDATE spaces SET context = ? WHERE id = ?').run(context, id)
    if (result.changes === 0) throw new Error('协作空间不存在')
    return this.getSpace(id)!
  }

  createSpace(input: CreateSpaceInput): Space {
    const space: Space = { ...input, id: randomUUID(), createdAt: new Date().toISOString() }
    this.db.exec('BEGIN')
    try {
      this.db.prepare('INSERT INTO spaces (id, name, description, context, createdAt) VALUES (?, ?, ?, ?, ?)')
        .run(space.id, space.name, space.description, space.context, space.createdAt)
      const addMember = this.db.prepare('INSERT INTO space_members (spaceId, agentId, position) VALUES (?, ?, ?)')
      space.memberIds.forEach((agentId, index) => addMember.run(space.id, agentId, index))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return space
  }

  updateSpace(id: string, input: CreateSpaceInput): Space {
    if (!this.getSpace(id)) throw new Error('协作空间不存在')
    if (!input.name.trim()) throw new Error('空间名称不能为空')
    if (new Set(input.memberIds).size !== input.memberIds.length) throw new Error('成员不能重复')
    this.db.exec('BEGIN')
    try {
      this.db.prepare('UPDATE spaces SET name = ?, description = ?, context = ? WHERE id = ?')
        .run(input.name.trim(), input.description.trim(), input.context.trim(), id)
      this.db.prepare('DELETE FROM space_members WHERE spaceId = ?').run(id)
      const addMember = this.db.prepare('INSERT INTO space_members (spaceId, agentId, position) VALUES (?, ?, ?)')
      input.memberIds.forEach((agentId, index) => addMember.run(id, agentId, index))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.getSpace(id)!
  }

  removeSpace(id: string): void {
    if (!this.getSpace(id)) throw new Error('协作空间不存在')
    this.db.exec('BEGIN')
    try {
      this.db.prepare("DELETE FROM messages WHERE scope = 'space' AND scopeId = ?").run(id)
      this.db.prepare('DELETE FROM runtime_sessions WHERE contextKey LIKE ?').run(`space:${id}:%`)
      this.db.prepare('DELETE FROM space_members WHERE spaceId = ?').run(id)
      this.db.prepare('DELETE FROM spaces WHERE id = ?').run(id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  listMessages(scope: Message['scope'], scopeId: string): Message[] {
    return this.db.prepare('SELECT * FROM messages WHERE scope = ? AND scopeId = ? ORDER BY sequence ASC')
      .all(scope, scopeId) as unknown as Message[]
  }

  listMessagesSince(scope: Message['scope'], scopeId: string, sequence: number): Message[] {
    return this.db.prepare(`
      SELECT * FROM messages WHERE scope = ? AND scopeId = ? AND sequence > ?
      ORDER BY sequence ASC
    `).all(scope, scopeId, sequence) as unknown as Message[]
  }

  lastAgentMessageSequence(spaceId: string, agentId: string): number {
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) AS sequence FROM messages
      WHERE scope = 'space' AND scopeId = ? AND authorId = ?
    `).get(spaceId, agentId) as { sequence: number }
    return row.sequence
  }

  getOrCreateRuntimeSession(
    contextKey: string, agent: Agent, sessionId: string, capabilityHash: string, initialSequence = 0,
  ): RuntimeSession {
    const row = this.db.prepare(`
      SELECT harnessSessionId, capabilityHash, agentSnapshot, lastConsumedMessageSequence
      FROM runtime_sessions WHERE contextKey = ?
    `).get(contextKey) as RuntimeSessionRow | undefined
    if (row) {
      const snapshot = row.agentSnapshot ? JSON.parse(row.agentSnapshot) as Agent : agent
      const snapshotHash = row.agentSnapshot ? getAgentCapabilityHash(snapshot) : capabilityHash
      if (!row.agentSnapshot || row.capabilityHash !== snapshotHash) {
        this.db.prepare(`UPDATE runtime_sessions
          SET harnessSessionId = ?, provider = ?, model = ?, capabilityHash = ?, agentSnapshot = ?, updatedAt = ?
          WHERE contextKey = ?`)
          .run(sessionId, snapshot.provider, snapshot.model, snapshotHash, JSON.stringify(snapshot),
            new Date().toISOString(), contextKey)
        return { harnessSessionId: sessionId, agent: snapshot,
          lastConsumedMessageSequence: row.lastConsumedMessageSequence }
      }
      return {
        harnessSessionId: row.harnessSessionId,
        agent: snapshot,
        lastConsumedMessageSequence: row.lastConsumedMessageSequence,
      }
    }
    this.db.prepare(`
      INSERT INTO runtime_sessions
        (contextKey, harnessSessionId, provider, model, capabilityHash, agentSnapshot,
         lastConsumedMessageSequence, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(contextKey, sessionId, agent.provider, agent.model, capabilityHash,
      JSON.stringify(agent), initialSequence, new Date().toISOString())
    return { harnessSessionId: sessionId, agent, lastConsumedMessageSequence: initialSequence }
  }

  saveRuntimeSessionProgress(contextKey: string, sessionId: string, sequence: number): void {
    this.db.prepare(`
      UPDATE runtime_sessions SET harnessSessionId = ?, lastConsumedMessageSequence = ?, updatedAt = ?
      WHERE contextKey = ?
    `).run(sessionId, sequence, new Date().toISOString(), contextKey)
  }

  referencedCapabilityHashes(): string[] {
    return (this.db.prepare('SELECT DISTINCT capabilityHash FROM runtime_sessions').all() as Array<{ capabilityHash: string }>)
      .map((row) => row.capabilityHash)
  }

  addMessage(input: Omit<Message, 'id' | 'sequence' | 'createdAt'>): Message {
    const next = this.db.prepare(
      'SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM messages WHERE scope = ? AND scopeId = ?',
    ).get(input.scope, input.scopeId) as { sequence: number }
    const message: Message = {
      ...input,
      reasoning: input.reasoning ?? null,
      id: randomUUID(),
      sequence: next.sequence,
      createdAt: new Date().toISOString(),
    }
    this.db.prepare(`
      INSERT INTO messages (id, scope, scopeId, authorType, authorId, authorName, content, reasoning, sequence, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(message.id, message.scope, message.scopeId, message.authorType, message.authorId ?? null,
      message.authorName, message.content, message.reasoning ?? null, message.sequence, message.createdAt)
    return message
  }

  close(): void {
    this.db.close()
  }
}
