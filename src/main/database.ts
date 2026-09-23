import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Agent, CreateAgentInput, CreateSpaceInput, Message, Space, UserProfile } from '../shared/contracts'
import { createSkillReference } from '../shared/skill-reference'
import { getAgentCapabilityHash } from './agent-capability'

type AgentRow = Omit<Agent, 'skills' | 'tools'> & { skills: string; tools: string }
type SpaceRow = Omit<Space, 'memberIds'>
type RuntimeSessionRow = {
  harnessSessionId: string
  capabilityHash: string
  agentSnapshot: string | null
  lastConsumedMessageSequence: number
}

const starterSkillUpgrades = {
  'starter-v2-product-manager': { previous: ['需求分析', '任务拆解'], current: [
    createSkillReference('mindmesh-builtin-user-story-writer-v1', '用户故事'),
    createSkillReference('mindmesh-builtin-project-planner-v1', '项目规划'),
  ] },
  'starter-v2-project-coordinator': { previous: ['项目计划', '任务拆解'], current: [
    createSkillReference('mindmesh-builtin-project-planner-v1', '项目规划'),
  ] },
  'starter-v2-study-coach': { previous: ['学习计划', '知识梳理'], current: [
    createSkillReference('mindmesh-builtin-study-plan-builder-v1', '学习计划'),
  ] },
  'starter-v2-english-tutor': { previous: ['语言学习', '写作反馈'], current: [
    createSkillReference('mindmesh-builtin-language-tutor-v1', '语言辅导'),
  ] },
  'starter-v2-fitness-coach': { previous: ['训练计划'], current: [
    createSkillReference('mindmesh-builtin-workout-planner-v1', '训练计划'),
  ] },
  'starter-v2-meal-planner': { previous: ['餐单规划', '清单整理'], current: [
    createSkillReference('mindmesh-builtin-meal-plan-builder-v1', '餐单规划'),
  ] },
  'starter-v2-travel-planner': { previous: ['行程规划', '清单整理'], current: [
    createSkillReference('mindmesh-builtin-trip-planner-v1', '旅行规划'),
  ] },
} as const

const localizedStarterSkills = {
  'starter-v2-product-manager': ['用户故事', '项目规划'],
  'starter-v2-project-coordinator': ['项目规划'],
  'starter-v2-study-coach': ['学习计划'],
  'starter-v2-english-tutor': ['语言辅导'],
  'starter-v2-fitness-coach': ['训练计划'],
  'starter-v2-meal-planner': ['餐单规划'],
  'starter-v2-travel-planner': ['旅行规划'],
} as const

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
    const seeded = Boolean(this.db.prepare("SELECT value FROM app_meta WHERE key = 'seeded'").get())
    let seedMode = (this.db.prepare("SELECT value FROM app_meta WHERE key = 'starterSeedMode'").get() as
      { value: string } | undefined)?.value
    if (!seeded && !seedMode) {
      const count = this.db.prepare('SELECT COUNT(*) AS count FROM agents').get() as { count: number }
      const spaces = this.db.prepare('SELECT COUNT(*) AS count FROM spaces').get() as { count: number }
      seedMode = count.count === 0 && spaces.count === 0 ? 'fresh' : 'upgrade'
      this.db.prepare("INSERT INTO app_meta (key, value) VALUES ('starterSeedMode', ?)").run(seedMode)
    }
    this.seedStarterExamples(!seeded && seedMode === 'fresh')
    this.upgradeStarterSkills()
    this.upgradeStarterSkillReferences()
    if (!seeded) this.db.prepare("INSERT INTO app_meta (key, value) VALUES ('seeded', '1')").run()
    this.db.prepare("DELETE FROM app_meta WHERE key = 'starterSeedMode'").run()
  }

  private seedStarterExamples(includeLegacyExamples: boolean): void {
    if (this.db.prepare("SELECT value FROM app_meta WHERE key = 'starterExamplesV2'").get()) return
    const base = { provider: 'deepseek-official' as const, model: 'deepseek-v4-flash' }
    if (includeLegacyExamples) {
      const researcher = this.ensureStarterAgent('starter-v1-researcher', { ...base, name: 'Researcher', role: '研究分析专家',
        persona: '你是一名严谨的研究分析专家。优先使用事实与证据，输出结构化结论。',
        skills: ['研究分析', '报告撰写'], tools: ['网页搜索', '文件'] })
      const developer = this.ensureStarterAgent('starter-v1-developer', { ...base, name: 'Developer', role: '软件工程师',
        persona: '你是一名务实的软件工程师。先澄清约束，再给出可验证的实现。',
        skills: ['代码审查'], tools: ['文件', 'Shell'] })
      this.ensureStarterSpace('starter-v1-ai-product-research', {
        name: 'AI Product Research', description: '讨论和研究 Multi-Agent 产品设计。',
        context: '当前目标：完成 MindMesh MVP。优先验证 Agent 创建、私聊和 Space 协作。',
        memberIds: [researcher.id, developer.id],
      })
    }
    const productManager = this.ensureStarterAgent('starter-v2-product-manager', { ...base, name: 'Product Manager', role: '产品经理',
      persona: '你负责澄清用户问题、范围和优先级。将讨论收敛为明确决策、验收标准和下一步。',
      skills: [...starterSkillUpgrades['starter-v2-product-manager'].current], tools: ['文件'] })
    const projectCoordinator = this.ensureStarterAgent('starter-v2-project-coordinator', { ...base, name: 'Project Coordinator', role: '项目协调员',
      persona: '你负责把目标拆成里程碑、任务和负责人，识别依赖与风险，并用简洁的进度清单推动执行。',
      skills: [...starterSkillUpgrades['starter-v2-project-coordinator'].current], tools: ['文件'] })
    const studyCoach = this.ensureStarterAgent('starter-v2-study-coach', { ...base, name: 'Study Coach', role: '学习教练',
      persona: '你会根据学习目标、截止时间和每日可用时间制定计划，用主动回忆、间隔复习和小测验跟踪进度。',
      skills: [...starterSkillUpgrades['starter-v2-study-coach'].current], tools: ['文件'] })
    const englishTutor = this.ensureStarterAgent('starter-v2-english-tutor', { ...base, name: 'English Tutor', role: '英语教练',
      persona: '你帮助用户练习实用英语。先给出自然表达，再简明解释错误，并提供可立即完成的对话或写作练习。',
      skills: [...starterSkillUpgrades['starter-v2-english-tutor'].current], tools: [] })
    const fitnessCoach = this.ensureStarterAgent('starter-v2-fitness-coach', { ...base, name: 'Fitness Coach', role: '健身教练',
      persona: '你根据时间、场地、设备和运动经验制定安全、可持续的训练计划，并给出热身、进阶和恢复建议。',
      skills: [...starterSkillUpgrades['starter-v2-fitness-coach'].current], tools: [] })
    const mealPlanner = this.ensureStarterAgent('starter-v2-meal-planner', { ...base, name: 'Meal Planner', role: '饮食规划师',
      persona: '你结合预算、口味、烹饪时间和忌口安排易执行的餐单，同时整理采购清单和备餐顺序。',
      skills: [...starterSkillUpgrades['starter-v2-meal-planner'].current], tools: ['文件'] })
    const travelPlanner = this.ensureStarterAgent('starter-v2-travel-planner', { ...base, name: 'Travel Planner', role: '旅行规划师',
      persona: '你根据出发地、日期、预算和兴趣制定节奏合理的行程，优先核对交通、营业时间和预订条件。',
      skills: [...starterSkillUpgrades['starter-v2-travel-planner'].current], tools: ['网页搜索', '文件'] })

    this.ensureStarterSpace('starter-v2-product-delivery', { name: 'Product Delivery Squad', description: '从需求澄清到项目推进的工作协作组。',
      context: '请提供目标、用户、截止时间和已知限制。Product Manager 收敛范围与验收标准，Project Coordinator 拆解里程碑、依赖和负责人。',
      memberIds: [productManager.id, projectCoordinator.id] })
    this.ensureStarterSpace('starter-v2-study-growth', { name: 'Study Growth Circle', description: '制定学习计划、讲解难点并进行语言练习。',
      context: '请先说明学习目标、当前水平、截止时间和每周可用时间。Study Coach 负责计划和检查点，English Tutor 负责英语练习。',
      memberIds: [studyCoach.id, englishTutor.id] })
    this.ensureStarterSpace('starter-v2-healthy-living', { name: 'Healthy Living Plan', description: '把运动和日常饮食整合成可执行的生活计划。',
      context: '请说明作息、运动基础、饮食偏好、忌口和预算。Fitness Coach 安排训练，Meal Planner 安排饮食与采购清单。',
      memberIds: [fitnessCoach.id, mealPlanner.id] })
    this.ensureStarterSpace('starter-v2-weekend-trip', { name: 'Weekend Trip Crew', description: '用有限时间和预算规划一次轻松的短途旅行。',
      context: '请提供出发地、日期、人数、预算和兴趣。Travel Planner 负责行程与交通，Meal Planner 补充用餐建议和预算。',
      memberIds: [travelPlanner.id, mealPlanner.id] })
    this.db.prepare("INSERT INTO app_meta (key, value) VALUES ('starterExamplesV2', '1')").run()
  }

  private upgradeStarterSkills(): void {
    if (this.db.prepare("SELECT value FROM app_meta WHERE key = 'starterSkillsV3'").get()) return
    for (const [id, skills] of Object.entries(starterSkillUpgrades)) {
      const agent = this.getAgent(id)
      if (!agent || JSON.stringify(skills.previous) === JSON.stringify(skills.current) ||
        JSON.stringify(agent.skills) !== JSON.stringify(skills.previous)) continue
      this.db.prepare('UPDATE agents SET skills = ? WHERE id = ?').run(JSON.stringify(skills.current), id)
      this.db.prepare('DELETE FROM runtime_sessions WHERE contextKey = ? OR contextKey LIKE ?')
        .run(`private:${id}`, `space:%:${id}`)
    }
    this.db.prepare("INSERT INTO app_meta (key, value) VALUES ('starterSkillsV3', '1')").run()
  }

  private upgradeStarterSkillReferences(): void {
    if (this.db.prepare("SELECT value FROM app_meta WHERE key = 'starterSkillRefsV4'").get()) return
    for (const [id, previous] of Object.entries(localizedStarterSkills)) {
      const agent = this.getAgent(id)
      if (!agent || JSON.stringify(agent.skills) !== JSON.stringify(previous)) continue
      const current = starterSkillUpgrades[id as keyof typeof starterSkillUpgrades].current
      this.db.prepare('UPDATE agents SET skills = ? WHERE id = ?').run(JSON.stringify(current), id)
      this.db.prepare('DELETE FROM runtime_sessions WHERE contextKey = ? OR contextKey LIKE ?')
        .run(`private:${id}`, `space:%:${id}`)
    }
    this.db.prepare("INSERT INTO app_meta (key, value) VALUES ('starterSkillRefsV4', '1')").run()
  }

  private ensureStarterAgent(id: string, input: CreateAgentInput): Agent {
    const existing = this.getAgent(id)
    if (existing) return existing
    const names = new Set(this.listAgents().map((agent) => agent.name))
    let name = input.name
    for (let suffix = 1; names.has(name); suffix += 1) name = `${input.name} (示例${suffix > 1 ? ` ${suffix}` : ''})`
    return this.createAgent({ ...input, name }, id)
  }

  private ensureStarterSpace(id: string, input: CreateSpaceInput): Space {
    const existing = this.getSpace(id)
    if (existing) return existing
    const names = new Set(this.listSpaces().map((space) => space.name))
    let name = input.name
    for (let suffix = 1; names.has(name); suffix += 1) name = `${input.name} (示例${suffix > 1 ? ` ${suffix}` : ''})`
    return this.createSpace({ ...input, name }, id)
  }

  listAgents(): Agent[] {
    const rows = this.db.prepare('SELECT * FROM agents ORDER BY createdAt ASC').all() as unknown as AgentRow[]
    return rows.map((row) => ({ ...row, skills: JSON.parse(row.skills), tools: JSON.parse(row.tools) }))
  }

  getAgent(id: string): Agent | undefined {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined
    return row ? { ...row, skills: JSON.parse(row.skills), tools: JSON.parse(row.tools) } : undefined
  }

  createAgent(input: CreateAgentInput, id: string = randomUUID()): Agent {
    const agent: Agent = { ...input, id, createdAt: new Date().toISOString() }
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
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM runtime_sessions WHERE contextKey = ? OR contextKey LIKE ?')
        .run(`private:${id}`, `space:%:${id}`)
      this.db.prepare('DELETE FROM agents WHERE id = ?').run(id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
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

  createSpace(input: CreateSpaceInput, id: string = randomUUID()): Space {
    const space: Space = { ...input, id, createdAt: new Date().toISOString() }
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
