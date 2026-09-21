import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Agent, CreateAgentInput, CreateSpaceInput, Message, Space } from '../shared/contracts'

type AgentRow = Omit<Agent, 'skills' | 'tools'> & { skills: string; tools: string }
type SpaceRow = Omit<Space, 'memberIds'>

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
        updatedAt TEXT NOT NULL
      );
    `)
  }

  private seed(): void {
    const count = this.db.prepare('SELECT COUNT(*) AS count FROM agents').get() as { count: number }
    if (count.count > 0) return

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

  listMessages(scope: Message['scope'], scopeId: string): Message[] {
    return this.db.prepare('SELECT * FROM messages WHERE scope = ? AND scopeId = ? ORDER BY sequence ASC')
      .all(scope, scopeId) as unknown as Message[]
  }

  addMessage(input: Omit<Message, 'id' | 'sequence' | 'createdAt'>): Message {
    const next = this.db.prepare(
      'SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM messages WHERE scope = ? AND scopeId = ?',
    ).get(input.scope, input.scopeId) as { sequence: number }
    const message: Message = {
      ...input,
      id: randomUUID(),
      sequence: next.sequence,
      createdAt: new Date().toISOString(),
    }
    this.db.prepare(`
      INSERT INTO messages (id, scope, scopeId, authorType, authorId, authorName, content, sequence, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(message.id, message.scope, message.scopeId, message.authorType, message.authorId ?? null,
      message.authorName, message.content, message.sequence, message.createdAt)
    return message
  }

  close(): void {
    this.db.close()
  }
}
