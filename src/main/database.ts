import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  Agent,
  AgentSource,
  ChatImageAttachment,
  CreateAgentInput,
  CreateSpaceInput,
  ExecutionStatus,
  Message,
  RunStatus,
  Space,
  ToolCallRecord,
  ToolCallStatus,
  UserProfile,
} from '../shared/contracts'
import { DEFAULT_AGENT_MODEL } from '../shared/model-providers'
import type { AgencyTemplate } from './agency-provider'
import type { ResolvedTeam } from './team-provider'
import { createSkillReference } from '../shared/skill-reference'
import { getAgentCapabilityBaseHash, getAgentCapabilityHash } from './agent-capability'
import {
  pluginSetRevision,
  type InstalledPlugin,
  type PluginArtifact,
  type PluginSetSnapshot,
} from './plugins/plugin-set'

type AgentRow = Omit<Agent, 'skills' | 'tools' | 'reasoningEffort'> & {
  skills: string
  tools: string
  reasoningEffort: string | null
}
type SpaceRow = Omit<Space, 'memberIds'>
type RuntimeSessionRow = {
  harnessSessionId: string
  capabilityHash: string
  agentSnapshot: string | null
  lastConsumedMessageSequence: number
}

const MAX_SPACE_CONTEXT_LENGTH = 100_000

/**
 * The authoritative per-run usage columns, shared by table creation and the v8
 * upgrade so the two can never drift. `executions` mirrors these as a summary.
 */
const RUN_USAGE_COLUMNS = [
  ['inputTokens', 'INTEGER'],
  ['outputTokens', 'INTEGER'],
  ['cacheReadTokens', 'INTEGER'],
  ['cacheWriteTokens', 'INTEGER'],
] as const

/**
 * Bump when adding a migration step below. The migrator refuses to run against a
 * database written by a newer build, so this must never be lowered.
 */
const SCHEMA_VERSION = 9

function validateFieldLength(value: string, label: string, limit: number): void {
  if (value.length > limit)
    throw new Error(`${label}不能超过 ${limit.toLocaleString('en-US')} 个字符`)
}

function validateRecordId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !id.trim() || id.length > 256) throw new Error('记录 ID 无效')
}

/**
 * A runtime session belongs to one agent inside one conversation.
 *
 * The conversation id is part of the key so opening a second conversation starts a
 * separate harness session instead of resuming the first one.
 */
export function runtimeContextKey(conversationId: string, agentId: string): string {
  return `conversation:${conversationId}:${agentId}`
}

/** The harness-visible session id. Mirrors {@link runtimeContextKey} with filesystem-safe separators. */
export function runtimeSessionId(conversationId: string, agentId: string): string {
  return `conversation-${conversationId.replace(/:/g, '-')}-${agentId}`
}

/**
 * Translate a pre-Phase-1 runtime session key into the conversation-scoped form.
 * Returns null for keys that are already migrated or cannot be attributed.
 */
export function conversationRuntimeKey(legacyKey: string): string | null {
  if (legacyKey.startsWith('conversation:')) return null
  if (legacyKey.startsWith('private:')) {
    const agentId = legacyKey.slice('private:'.length)
    return agentId ? runtimeContextKey(`private:${agentId}`, agentId) : null
  }
  if (legacyKey.startsWith('space:')) {
    // space:<spaceId>:<agentId> — agent ids cannot contain ':' (validateRecordId).
    const separator = legacyKey.lastIndexOf(':')
    if (separator <= 'space:'.length) return null
    const spaceId = legacyKey.slice('space:'.length, separator)
    const agentId = legacyKey.slice(separator + 1)
    if (!spaceId || !agentId) return null
    return runtimeContextKey(`space:${spaceId}`, agentId)
  }
  return null
}

/**
 * The key prefix shared by every runtime session in one conversation. Used for
 * prefix matching (not SQL LIKE), so it carries no wildcard.
 */
export function conversationRuntimeKeyPrefix(conversationId: string): string {
  return runtimeContextKey(conversationId, '')
}

/**
 * Matches every runtime session inside one conversation, across all of its agents.
 */
export function conversationRuntimeKeyPattern(conversationId: string): string {
  return `${conversationRuntimeKeyPrefix(conversationId)}%`
}

/**
 * Matches every runtime session of an agent, across its private and space
 * conversations. `LIKE` treats `%` as a wildcard that also spans the ':' inside
 * a conversation id, so one pattern is enough.
 */
export function agentRuntimeKeyPattern(agentId: string): string {
  return `conversation:%:${agentId}`
}

function validateStringList(
  values: unknown,
  label: string,
  itemLimit = 2048
): asserts values is string[] {
  if (!Array.isArray(values)) throw new Error(`${label}数据无效`)
  if (values.length > 100) throw new Error(`${label}不能超过 100 项`)
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}数据无效`)
    validateFieldLength(value, `${label}条目`, itemLimit)
  }
}

function validateSpaceContext(context: unknown): asserts context is string {
  if (typeof context !== 'string') throw new Error('空间背景必须是文本')
  if (context.length > MAX_SPACE_CONTEXT_LENGTH)
    throw new Error(`空间背景不能超过 ${MAX_SPACE_CONTEXT_LENGTH.toLocaleString('en-US')} 个字符`)
}

function normalizeAgentInput(input: CreateAgentInput): CreateAgentInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('智能体数据无效')
  if (
    typeof input.name !== 'string' ||
    typeof input.role !== 'string' ||
    typeof input.persona !== 'string'
  ) {
    throw new Error('智能体数据无效')
  }
  if (typeof input.provider !== 'string' || typeof input.model !== 'string')
    throw new Error('模型配置无效')
  validateFieldLength(input.name, '智能体名称', 200)
  validateFieldLength(input.role, '角色定位', 2000)
  validateFieldLength(input.persona, '身份设定', 100_000)
  validateFieldLength(input.provider, '模型服务商', 100)
  validateFieldLength(input.model, '模型 ID', 100)
  validateStringList(input.skills, '技能')
  validateStringList(input.tools, '工具')
  const normalized = {
    name: input.name.trim(),
    role: input.role.trim(),
    persona: input.persona.trim(),
    provider: input.provider.trim(),
    model: input.model.trim(),
    skills: [...input.skills],
    tools: [...input.tools],
    reasoningEffort: normalizeReasoningEffort(input.reasoningEffort),
  }
  if (!normalized.name || !normalized.persona) throw new Error('名称和身份设定不能为空')
  if (!normalized.provider || !normalized.model) throw new Error('模型配置无效')
  return normalized
}

function normalizeReasoningEffort(value: string | undefined): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('思考强度无效')
  validateFieldLength(value, '思考强度', 40)
  const effort = value.trim()
  if (!effort) return undefined
  if (!/^[a-z]{1,20}$/.test(effort)) throw new Error('思考强度无效')
  return effort
}

function normalizeSpaceInput(input: CreateSpaceInput): CreateSpaceInput {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    typeof input.name !== 'string' ||
    typeof input.description !== 'string' ||
    typeof input.context !== 'string'
  ) {
    throw new Error('协作空间数据无效')
  }
  validateSpaceContext(input.context)
  validateFieldLength(input.name, '空间名称', 100)
  validateFieldLength(input.description, '空间简介', 10_000)
  validateStringList(input.memberIds, '空间成员', 256)
  const normalized = {
    name: input.name.trim(),
    description: input.description.trim(),
    context: input.context.trim(),
    memberIds: [...input.memberIds],
  }
  if (!normalized.name) throw new Error('空间名称不能为空')
  if (new Set(normalized.memberIds).size !== normalized.memberIds.length)
    throw new Error('成员不能重复')
  return normalized
}

const starterSkillUpgrades = {
  'starter-v2-product-manager': {
    previous: ['需求分析', '任务拆解'],
    current: [
      createSkillReference('mindmesh-builtin-user-story-writer-v1', '用户故事'),
      createSkillReference('mindmesh-builtin-project-planner-v1', '项目规划'),
    ],
  },
  'starter-v2-project-coordinator': {
    previous: ['项目计划', '任务拆解'],
    current: [createSkillReference('mindmesh-builtin-project-planner-v1', '项目规划')],
  },
  'starter-v2-study-coach': {
    previous: ['学习计划', '知识梳理'],
    current: [createSkillReference('mindmesh-builtin-study-plan-builder-v1', '学习计划')],
  },
  'starter-v2-english-tutor': {
    previous: ['语言学习', '写作反馈'],
    current: [createSkillReference('mindmesh-builtin-language-tutor-v1', '语言辅导')],
  },
  'starter-v2-fitness-coach': {
    previous: ['训练计划'],
    current: [createSkillReference('mindmesh-builtin-workout-planner-v1', '训练计划')],
  },
  'starter-v2-meal-planner': {
    previous: ['餐单规划', '清单整理'],
    current: [createSkillReference('mindmesh-builtin-meal-plan-builder-v1', '餐单规划')],
  },
  'starter-v2-travel-planner': {
    previous: ['行程规划', '清单整理'],
    current: [createSkillReference('mindmesh-builtin-trip-planner-v1', '旅行规划')],
  },
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
  capabilityHash: string
  agent: Agent
  lastConsumedMessageSequence: number
}

export class MindMeshDatabase {
  private readonly db: DatabaseSync

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    try {
      this.migrateVersioned(path)
      this.seed()
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  private migrateVersioned(path: string): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const row = this.db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined
    const version = Number(row?.value ?? 0)
    if (!Number.isInteger(version) || version < 0 || version > SCHEMA_VERSION)
      throw new Error('Unsupported database schema version')
    if (version === SCHEMA_VERSION) return
    // VACUUM INTO captures a consistent SQLite snapshot, including WAL, before migration.
    const backup = `${path}.before-schema-${version}.sqlite`
    if (path !== ':memory:' && !existsSync(backup)) this.db.prepare('VACUUM INTO ?').run(backup)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (version < 1) this.migrate()
      if (version < 2) {
        this.db.exec(`CREATE TABLE installed_plugins (
        package_name TEXT PRIMARY KEY, resolved_version TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), config_json TEXT NOT NULL,
        compatibility TEXT NOT NULL DEFAULT 'sdk-compatible', source TEXT NOT NULL DEFAULT 'npm',
        installed_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`)
        const meta = this.db.prepare('INSERT OR REPLACE INTO app_meta(key, value) VALUES (?, ?)')
        meta.run('runtime_schema_version', '2')
        meta.run('plugin_set_generation', '0')
      }
      if (version < 3)
        this.db.exec(`CREATE TABLE agent_sources (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
        source TEXT NOT NULL, source_id TEXT NOT NULL, revision TEXT NOT NULL,
        repository TEXT NOT NULL, content TEXT NOT NULL, license TEXT NOT NULL, license_text TEXT NOT NULL,
        UNIQUE(source, source_id)
      )`)
      if (version < 4)
        this.db.exec(`CREATE TABLE space_sources (
        space_id TEXT PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE,
        source TEXT NOT NULL, source_id TEXT NOT NULL, revision TEXT NOT NULL, manifest TEXT NOT NULL,
        UNIQUE(source, source_id)
      )`)
      if (version < 5) this.migrateToConversations()
      if (version < 6) this.createExecutionTables()
      if (version < 7) this.migrateRuntimeSessionKeys()
      if (version < 8) this.addRunUsageColumns()
      if (version < 9) this.backfillDefaultConversations()
      this.db
        .prepare('INSERT OR REPLACE INTO app_meta(key, value) VALUES (?, ?)')
        .run('schema_version', String(SCHEMA_VERSION))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  readPluginSet(): PluginSetSnapshot {
    const ownsTransaction = !this.db.isTransaction
    if (ownsTransaction) this.db.exec('BEGIN')
    try {
      const snapshot = this.readPluginSetRows()
      if (ownsTransaction) this.db.exec('COMMIT')
      return snapshot
    } catch (error) {
      if (ownsTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }

  private readPluginSetRows(): PluginSetSnapshot {
    const plugins = (
      this.db.prepare('SELECT * FROM installed_plugins ORDER BY package_name').all() as Array<
        Record<string, string | number>
      >
    ).map((row) => ({
      packageName: String(row.package_name),
      version: String(row.resolved_version),
      enabled: Boolean(row.enabled),
      config: JSON.parse(String(row.config_json)),
      installedAt: String(row.installed_at),
      updatedAt: String(row.updated_at),
    }))
    const meta = this.db.prepare('SELECT value FROM app_meta WHERE key = ?')
    const generation = Number((meta.get('plugin_set_generation') as { value: string }).value)
    const artifact = meta.get('plugin_set_artifact') as { value: string } | undefined
    return {
      generation,
      revision: pluginSetRevision(plugins),
      plugins,
      artifact: artifact ? JSON.parse(artifact.value) : null,
    }
  }

  commitPluginSet(
    expectedGeneration: number,
    plugins: InstalledPlugin[],
    artifact: PluginArtifact
  ): PluginSetSnapshot {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (this.readPluginSet().generation !== expectedGeneration)
        throw new Error('Plugin set changed during validation')
      this.db.exec('DELETE FROM installed_plugins')
      const insert = this.db.prepare(
        'INSERT INTO installed_plugins(package_name, resolved_version, enabled, config_json, installed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      for (const plugin of plugins)
        insert.run(
          plugin.packageName,
          plugin.version,
          Number(plugin.enabled),
          JSON.stringify(plugin.config),
          plugin.installedAt,
          plugin.updatedAt
        )
      const meta = this.db.prepare('INSERT OR REPLACE INTO app_meta(key, value) VALUES (?, ?)')
      meta.run('plugin_set_generation', String(expectedGeneration + 1))
      meta.run('plugin_set_artifact', JSON.stringify(artifact))
      const committed = this.readPluginSetRows()
      this.db.exec('COMMIT')
      return committed
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
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
        attachments TEXT NOT NULL DEFAULT '[]',
        stopped INTEGER NOT NULL DEFAULT 0,
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
    const columns = this.db.prepare('PRAGMA table_info(runtime_sessions)').all() as Array<{
      name: string
    }>
    if (!columns.some((column) => column.name === 'agentSnapshot')) {
      this.db.exec('ALTER TABLE runtime_sessions ADD COLUMN agentSnapshot TEXT')
    }
    if (!columns.some((column) => column.name === 'lastConsumedMessageSequence')) {
      this.db.exec(
        'ALTER TABLE runtime_sessions ADD COLUMN lastConsumedMessageSequence INTEGER NOT NULL DEFAULT 0'
      )
    }
    const messageColumns = this.db.prepare('PRAGMA table_info(messages)').all() as Array<{
      name: string
    }>
    if (!messageColumns.some((column) => column.name === 'reasoning')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN reasoning TEXT')
    }
    if (!messageColumns.some((column) => column.name === 'attachments')) {
      this.db.exec("ALTER TABLE messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'")
    }
    if (!messageColumns.some((column) => column.name === 'stopped')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN stopped INTEGER NOT NULL DEFAULT 0')
    }
    const agentColumns = this.db.prepare('PRAGMA table_info(agents)').all() as Array<{
      name: string
    }>
    if (!agentColumns.some((column) => column.name === 'reasoningEffort')) {
      this.db.exec('ALTER TABLE agents ADD COLUMN reasoningEffort TEXT')
    }
  }

  /**
   * v5: introduce conversations as the unit that owns messages, runs and usage.
   *
   * The messages table is rebuilt rather than ALTERed because its uniqueness rule
   * changes: `sequence` is only meaningful *within* a conversation, so the index
   * must move from (scope, scopeId, sequence) to (conversationId, sequence).
   * Rebuilding once here avoids a second table rewrite in a later phase.
   *
   * Runs inside the caller's BEGIN IMMEDIATE transaction, so a failure anywhere
   * leaves both the table and schema_version untouched.
   */
  private migrateToConversations(): void {
    this.db.exec(`CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK(scope IN ('private', 'space')),
      scopeId TEXT NOT NULL,
      title TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      archivedAt TEXT
    )`)
    this.db.exec(
      'CREATE INDEX conversations_scope ON conversations(scope, scopeId, updatedAt DESC)'
    )

    // One default conversation per existing agent and per existing space, so no
    // history is orphaned. Ids are derived from the scope key to stay stable and
    // collision-free across repeated runs.
    const insertConversation = this.db.prepare(
      `INSERT OR IGNORE INTO conversations (id, scope, scopeId, title, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    const stamp = new Date().toISOString()
    const agents = this.db.prepare('SELECT id, name FROM agents').all() as Array<{
      id: string
      name: string
    }>
    for (const agent of agents) {
      insertConversation.run(`private:${agent.id}`, 'private', agent.id, agent.name, stamp, stamp)
    }
    const spaces = this.db.prepare('SELECT id, name FROM spaces').all() as Array<{
      id: string
      name: string
    }>
    for (const space of spaces) {
      insertConversation.run(`space:${space.id}`, 'space', space.id, space.name, stamp, stamp)
    }
    // A conversation must exist before messages can reference it. Older databases
    // could hold messages for an agent or space that has since been deleted, so the
    // leftovers get a conversation titled from their id rather than failing the
    // migration on the foreign key.
    const backfill = this.db.prepare(
      `INSERT OR IGNORE INTO conversations (id, scope, scopeId, title, createdAt, updatedAt)
       SELECT ? || m.scopeId, ?, m.scopeId, m.scopeId, ?, ?
         FROM messages m
        WHERE m.scope = ? AND m.scopeId <> ''
        GROUP BY m.scopeId`
    )
    backfill.run('private:', 'private', stamp, stamp, 'private')
    backfill.run('space:', 'space', stamp, stamp, 'space')

    this.db.exec(`CREATE TABLE messages_v2 (
      id TEXT PRIMARY KEY,
      conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      authorType TEXT NOT NULL CHECK(authorType IN ('user', 'agent', 'system')),
      authorId TEXT,
      authorName TEXT NOT NULL,
      content TEXT NOT NULL,
      reasoning TEXT,
      attachments TEXT NOT NULL DEFAULT '[]',
      stopped INTEGER NOT NULL DEFAULT 0,
      sequence INTEGER NOT NULL,
      createdAt TEXT NOT NULL
    )`)
    // scope/scopeId are dropped: they are now reachable via conversations.
    this.db.exec(`INSERT INTO messages_v2 (
        id, conversationId, authorType, authorId, authorName, content,
        reasoning, attachments, stopped, sequence, createdAt
      )
      SELECT m.id,
        CASE WHEN m.scope = 'space' THEN 'space:' || m.scopeId ELSE 'private:' || m.scopeId END,
        m.authorType, m.authorId, m.authorName, m.content,
        m.reasoning, m.attachments, m.stopped, m.sequence, m.createdAt
      FROM messages m`)
    this.db.exec('DROP TABLE messages')
    this.db.exec('ALTER TABLE messages_v2 RENAME TO messages')
    this.db.exec(`CREATE UNIQUE INDEX messages_conversation_sequence
      ON messages(conversationId, sequence)`)
  }

  /**
   * v6: execution history.
   *
   * An Execution is one full attempt at a user request. In a Space it fans out to
   * several Runs (one per participating agent), all sharing `triggerMessageId`.
   * That indirection is what makes Regenerate countable: `COUNT(*) over runs` would
   * return the agent count, not the number of attempts.
   *
   * Token/cost columns are populated in a later phase; the spike only proved usage
   * is per-request and must be summed, so nothing is written here yet.
   *
   * workflowSnapshot holds the Space execution order captured at start time, so a
   * later edit to the Space cannot change how an in-flight execution is explained.
   */
  private createExecutionTables(): void {
    this.db.exec(`CREATE TABLE executions (
      id TEXT PRIMARY KEY,
      conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      triggerMessageId TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN (
        'running', 'completed', 'completed_with_errors', 'stopped', 'error', 'interrupted'
      )),
      workflowSnapshot TEXT,
      generationIndex INTEGER NOT NULL DEFAULT 1,
      regeneratedFromExecutionId TEXT,
      startedAt TEXT NOT NULL,
      endedAt TEXT,
      inputTokens INTEGER,
      outputTokens INTEGER,
      cacheReadTokens INTEGER,
      cacheWriteTokens INTEGER,
      costMicros INTEGER,
      currency TEXT
    )`)
    this.db.exec(`CREATE INDEX executions_conversation
      ON executions(conversationId, startedAt DESC)`)
    this.db.exec(`CREATE INDEX executions_trigger
      ON executions(triggerMessageId, generationIndex)`)

    this.db.exec(`CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      executionId TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
      conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      triggerMessageId TEXT NOT NULL,
      responseMessageId TEXT,
      agentId TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      permission TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN (
        'running', 'completed', 'stopped', 'error', 'interrupted'
      )),
      startedAt TEXT NOT NULL,
      firstOutputAt TEXT,
      endedAt TEXT,
      agentSnapshot TEXT,
      ${RUN_USAGE_COLUMNS.map(([column, type]) => `${column} ${type}`).join(',\n      ')}
    )`)
    this.db.exec('CREATE INDEX runs_execution ON runs(executionId, startedAt)')
    this.db.exec('CREATE INDEX runs_conversation ON runs(conversationId, startedAt DESC)')

    this.db.exec(`CREATE TABLE tool_calls (
      id TEXT PRIMARY KEY,
      runId TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      toolName TEXT NOT NULL,
      displayName TEXT,
      inputPreview TEXT,
      outputPreview TEXT,
      errorPreview TEXT,
      status TEXT NOT NULL CHECK(status IN ('running', 'ok', 'error', 'aborted')),
      startedAt TEXT NOT NULL,
      endedAt TEXT,
      elapsedMs INTEGER
    )`)
    this.db.exec('CREATE UNIQUE INDEX tool_calls_run_sequence ON tool_calls(runId, sequence)')
  }

  /**
   * Re-key runtime sessions so a harness session belongs to a conversation rather
   * than to an agent.
   *
   * Previously `private:<agentId>` and `space:<spaceId>:<agentId>` were the keys.
   * With conversations, keying on the agent alone would let a second conversation
   * silently reuse the first conversation's harness session: the UI would look like
   * a fresh chat while the model still remembered everything. Rows are re-keyed
   * rather than dropped so an upgrade does not force every agent to start over.
   */
  private migrateRuntimeSessionKeys(): void {
    const rows = this.db.prepare('SELECT contextKey FROM runtime_sessions').all() as Array<{
      contextKey: string
    }>
    const update = this.db.prepare(
      'UPDATE runtime_sessions SET contextKey = ? WHERE contextKey = ?'
    )
    for (const { contextKey } of rows) {
      const next = conversationRuntimeKey(contextKey)
      if (next && next !== contextKey) update.run(next, contextKey)
    }
  }

  /**
   * v8: authoritative per-run token usage.
   *
   * `executions` already carries token columns but they are a summary, and the spike
   * proved `assistant/message.usage` is per-request rather than cumulative. Without
   * the same columns on `runs` the per-agent numbers could never be written, and an
   * execution total could not be recomputed if the summary were ever wrong.
   *
   * ALTER TABLE ADD COLUMN is used instead of a table rebuild: the table is small,
   * the columns are nullable, and existing rows predate usage reporting so they
   * have no correct value to preserve.
   */
  private addRunUsageColumns(): void {
    const existing = new Set(
      (this.db.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    for (const [column, type] of RUN_USAGE_COLUMNS) {
      if (existing.has(column)) continue
      // db.exec cannot bind parameters, and node:sqlite cannot prepare DDL with
      // placeholders, so the identifiers come from the closed literal set above.
      this.db.exec(`ALTER TABLE runs ADD COLUMN ${column} ${type}`)
    }
  }

  private backfillDefaultConversations(): void {
    const owners = this.db
      .prepare(`
      SELECT 'private' AS scope, id, name FROM agents
      UNION ALL
      SELECT 'space' AS scope, id, name FROM spaces
    `)
      .all() as Array<{ scope: Message['scope']; id: string; name: string }>
    for (const owner of owners) {
      this.ensureConversation(
        this.conversationIdFor(owner.scope, owner.id),
        owner.scope,
        owner.id,
        owner.name
      )
    }
  }

  private seed(): void {
    const seeded = Boolean(this.db.prepare("SELECT value FROM app_meta WHERE key = 'seeded'").get())
    let seedMode = (
      this.db.prepare("SELECT value FROM app_meta WHERE key = 'starterSeedMode'").get() as
        | { value: string }
        | undefined
    )?.value
    if (!seeded && !seedMode) {
      const count = this.db.prepare('SELECT COUNT(*) AS count FROM agents').get() as {
        count: number
      }
      const spaces = this.db.prepare('SELECT COUNT(*) AS count FROM spaces').get() as {
        count: number
      }
      seedMode = count.count === 0 && spaces.count === 0 ? 'fresh' : 'upgrade'
      this.db
        .prepare("INSERT INTO app_meta (key, value) VALUES ('starterSeedMode', ?)")
        .run(seedMode)
    }
    this.seedStarterExamples(!seeded && seedMode === 'fresh')
    this.upgradeStarterSkills()
    this.upgradeStarterSkillReferences()
    if (!seeded) this.db.prepare("INSERT INTO app_meta (key, value) VALUES ('seeded', '1')").run()
    this.db.prepare("DELETE FROM app_meta WHERE key = 'starterSeedMode'").run()
  }

  private seedStarterExamples(includeLegacyExamples: boolean): void {
    if (this.db.prepare("SELECT value FROM app_meta WHERE key = 'starterExamplesV2'").get()) return
    const base = { provider: 'deepseek-official' as const, model: 'deepseek-flash' }
    if (includeLegacyExamples) {
      const researcher = this.ensureStarterAgent('starter-v1-researcher', {
        ...base,
        name: 'Researcher',
        role: '研究分析专家',
        persona: '你是一名严谨的研究分析专家。优先使用事实与证据，输出结构化结论。',
        skills: ['研究分析', '报告撰写'],
        tools: ['网页搜索', '文件'],
      })
      const developer = this.ensureStarterAgent('starter-v1-developer', {
        ...base,
        name: 'Developer',
        role: '软件工程师',
        persona: '你是一名务实的软件工程师。先澄清约束，再给出可验证的实现。',
        skills: ['代码审查'],
        tools: ['文件', 'Shell'],
      })
      this.ensureStarterSpace('starter-v1-ai-product-research', {
        name: 'AI Product Research',
        description: '讨论和研究 Multi-Agent 产品设计。',
        context: '当前目标：完成 MindMesh MVP。优先验证 Agent 创建、私聊和 Space 协作。',
        memberIds: [researcher.id, developer.id],
      })
    }
    const productManager = this.ensureStarterAgent('starter-v2-product-manager', {
      ...base,
      name: 'Product Manager',
      role: '产品经理',
      persona: '你负责澄清用户问题、范围和优先级。将讨论收敛为明确决策、验收标准和下一步。',
      skills: [...starterSkillUpgrades['starter-v2-product-manager'].current],
      tools: ['文件'],
    })
    const projectCoordinator = this.ensureStarterAgent('starter-v2-project-coordinator', {
      ...base,
      name: 'Project Coordinator',
      role: '项目协调员',
      persona: '你负责把目标拆成里程碑、任务和负责人，识别依赖与风险，并用简洁的进度清单推动执行。',
      skills: [...starterSkillUpgrades['starter-v2-project-coordinator'].current],
      tools: ['文件'],
    })
    const studyCoach = this.ensureStarterAgent('starter-v2-study-coach', {
      ...base,
      name: 'Study Coach',
      role: '学习教练',
      persona:
        '你会根据学习目标、截止时间和每日可用时间制定计划，用主动回忆、间隔复习和小测验跟踪进度。',
      skills: [...starterSkillUpgrades['starter-v2-study-coach'].current],
      tools: ['文件'],
    })
    const englishTutor = this.ensureStarterAgent('starter-v2-english-tutor', {
      ...base,
      name: 'English Tutor',
      role: '英语教练',
      persona:
        '你帮助用户练习实用英语。先给出自然表达，再简明解释错误，并提供可立即完成的对话或写作练习。',
      skills: [...starterSkillUpgrades['starter-v2-english-tutor'].current],
      tools: [],
    })
    const fitnessCoach = this.ensureStarterAgent('starter-v2-fitness-coach', {
      ...base,
      name: 'Fitness Coach',
      role: '健身教练',
      persona:
        '你根据时间、场地、设备和运动经验制定安全、可持续的训练计划，并给出热身、进阶和恢复建议。',
      skills: [...starterSkillUpgrades['starter-v2-fitness-coach'].current],
      tools: [],
    })
    const mealPlanner = this.ensureStarterAgent('starter-v2-meal-planner', {
      ...base,
      name: 'Meal Planner',
      role: '饮食规划师',
      persona: '你结合预算、口味、烹饪时间和忌口安排易执行的餐单，同时整理采购清单和备餐顺序。',
      skills: [...starterSkillUpgrades['starter-v2-meal-planner'].current],
      tools: ['文件'],
    })
    const travelPlanner = this.ensureStarterAgent('starter-v2-travel-planner', {
      ...base,
      name: 'Travel Planner',
      role: '旅行规划师',
      persona:
        '你根据出发地、日期、预算和兴趣制定节奏合理的行程，优先核对交通、营业时间和预订条件。',
      skills: [...starterSkillUpgrades['starter-v2-travel-planner'].current],
      tools: ['网页搜索', '文件'],
    })

    this.ensureStarterSpace('starter-v2-product-delivery', {
      name: 'Product Delivery Squad',
      description: '从需求澄清到项目推进的工作协作组。',
      context:
        '请提供目标、用户、截止时间和已知限制。Product Manager 收敛范围与验收标准，Project Coordinator 拆解里程碑、依赖和负责人。',
      memberIds: [productManager.id, projectCoordinator.id],
    })
    this.ensureStarterSpace('starter-v2-study-growth', {
      name: 'Study Growth Circle',
      description: '制定学习计划、讲解难点并进行语言练习。',
      context:
        '请先说明学习目标、当前水平、截止时间和每周可用时间。Study Coach 负责计划和检查点，English Tutor 负责英语练习。',
      memberIds: [studyCoach.id, englishTutor.id],
    })
    this.ensureStarterSpace('starter-v2-healthy-living', {
      name: 'Healthy Living Plan',
      description: '把运动和日常饮食整合成可执行的生活计划。',
      context:
        '请说明作息、运动基础、饮食偏好、忌口和预算。Fitness Coach 安排训练，Meal Planner 安排饮食与采购清单。',
      memberIds: [fitnessCoach.id, mealPlanner.id],
    })
    this.ensureStarterSpace('starter-v2-weekend-trip', {
      name: 'Weekend Trip Crew',
      description: '用有限时间和预算规划一次轻松的短途旅行。',
      context:
        '请提供出发地、日期、人数、预算和兴趣。Travel Planner 负责行程与交通，Meal Planner 补充用餐建议和预算。',
      memberIds: [travelPlanner.id, mealPlanner.id],
    })
    this.db.prepare("INSERT INTO app_meta (key, value) VALUES ('starterExamplesV2', '1')").run()
  }

  private upgradeStarterSkills(): void {
    if (this.db.prepare("SELECT value FROM app_meta WHERE key = 'starterSkillsV3'").get()) return
    for (const [id, skills] of Object.entries(starterSkillUpgrades)) {
      const agent = this.getAgent(id)
      if (
        !agent ||
        JSON.stringify(skills.previous) === JSON.stringify(skills.current) ||
        JSON.stringify(agent.skills) !== JSON.stringify(skills.previous)
      )
        continue
      this.db
        .prepare('UPDATE agents SET skills = ? WHERE id = ?')
        .run(JSON.stringify(skills.current), id)
      this.db
        .prepare('DELETE FROM runtime_sessions WHERE contextKey LIKE ?')
        .run(agentRuntimeKeyPattern(id))
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
      this.db
        .prepare('DELETE FROM runtime_sessions WHERE contextKey LIKE ?')
        .run(agentRuntimeKeyPattern(id))
    }
    this.db.prepare("INSERT INTO app_meta (key, value) VALUES ('starterSkillRefsV4', '1')").run()
  }

  private ensureStarterAgent(id: string, input: CreateAgentInput): Agent {
    const existing = this.getAgent(id)
    if (existing) return existing
    const names = new Set(this.listAgents().map((agent) => agent.name))
    let name = input.name
    for (let suffix = 1; names.has(name); suffix += 1)
      name = `${input.name} (示例${suffix > 1 ? ` ${suffix}` : ''})`
    return this.createAgent({ ...input, name }, id)
  }

  private ensureStarterSpace(id: string, input: CreateSpaceInput): Space {
    const existing = this.getSpace(id)
    if (existing) return existing
    const names = new Set(this.listSpaces().map((space) => space.name))
    let name = input.name
    for (let suffix = 1; names.has(name); suffix += 1)
      name = `${input.name} (示例${suffix > 1 ? ` ${suffix}` : ''})`
    return this.createSpace({ ...input, name }, id)
  }

  listAgents(): Agent[] {
    const rows = this.db
      .prepare('SELECT * FROM agents ORDER BY createdAt ASC')
      .all() as unknown as AgentRow[]
    return rows.map((row) => this.mapAgentRow(row))
  }

  getAgent(id: string): Agent | undefined {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined
    return row ? this.mapAgentRow(row) : undefined
  }

  private mapAgentRow(row: AgentRow): Agent {
    const { skills, tools, reasoningEffort, ...agent } = row
    return {
      ...agent,
      skills: JSON.parse(skills),
      tools: JSON.parse(tools),
      reasoningEffort: reasoningEffort ?? undefined,
      ...this.agentSourceFields(row.id),
    }
  }

  private agentSourceFields(id: string): { source?: AgentSource } {
    const row = this.db
      .prepare(`SELECT source, source_id AS sourceId, revision, repository, content,
      license, license_text AS licenseText FROM agent_sources WHERE agent_id = ?`)
      .get(id) as AgentSource | undefined
    return row ? { source: row } : {}
  }

  findAgentBySource(source: string, sourceId: string): Agent | undefined {
    const row = this.db
      .prepare('SELECT agent_id AS id FROM agent_sources WHERE source = ? AND source_id = ?')
      .get(source, sourceId) as { id: string } | undefined
    return row ? this.getAgent(row.id) : undefined
  }

  installAgencyAgent(template: AgencyTemplate): Agent {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const installed = this.installAgencyAgentRows(template)
      this.db.exec('COMMIT')
      return installed
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private installAgencyAgentRows(template: AgencyTemplate): Agent {
    const provenance = template.provenance
    const existing = this.findAgentBySource(provenance.source, provenance.sourceId)
    if (existing) {
      return existing
    }
    const names = new Set(this.listAgents().map((agent) => agent.name))
    let name = template.name
    for (let suffix = 2; names.has(name); suffix += 1) name = `${template.name} (${suffix})`
    const agent = this.createAgent({
      name,
      role: template.description,
      persona: template.persona,
      ...DEFAULT_AGENT_MODEL,
      skills: [],
      tools: [],
    })
    this.db
      .prepare(`INSERT INTO agent_sources(agent_id, source, source_id, revision, repository, content, license, license_text)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        agent.id,
        provenance.source,
        provenance.sourceId,
        provenance.revision,
        provenance.repository,
        provenance.content,
        provenance.license,
        provenance.licenseText
      )
    const installed = this.getAgent(agent.id)!
    return installed
  }

  createAgent(input: CreateAgentInput, id: string = randomUUID()): Agent {
    const normalized = this.validateAgentInput(input)
    const agent: Agent = { ...normalized, id, createdAt: new Date().toISOString() }
    this.db
      .prepare(`
      INSERT INTO agents (id, name, role, persona, provider, model, skills, tools, reasoningEffort, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        agent.id,
        agent.name,
        agent.role,
        agent.persona,
        agent.provider,
        agent.model,
        JSON.stringify(agent.skills),
        JSON.stringify(agent.tools),
        agent.reasoningEffort ?? null,
        agent.createdAt
      )
    // The default conversation is created up front rather than on first message:
    // deleteAgent relies on enumerating an agent's conversations, and a lazy row
    // would leave that loop empty and strand the agent's runtime sessions.
    this.ensureConversation(
      this.conversationIdFor('private', agent.id),
      'private',
      agent.id,
      agent.name
    )
    return agent
  }

  updateAgent(id: string, input: CreateAgentInput): Agent {
    validateRecordId(id)
    const existing = this.getAgent(id)
    if (!existing) throw new Error('智能体不存在')
    const normalized = this.validateAgentInput(input, id)
    const agent: Agent = {
      ...existing,
      ...normalized,
    }
    this.db
      .prepare(`
      UPDATE agents SET name = ?, role = ?, persona = ?, provider = ?, model = ?, skills = ?, tools = ?, reasoningEffort = ?
      WHERE id = ?
    `)
      .run(
        agent.name,
        agent.role,
        agent.persona,
        agent.provider,
        agent.model,
        JSON.stringify(agent.skills),
        JSON.stringify(agent.tools),
        agent.reasoningEffort ?? null,
        id
      )
    // See updateSpace: the default conversation is titled after its owner.
    this.db
      .prepare('UPDATE conversations SET title = ? WHERE id = ?')
      .run(agent.name, this.conversationIdFor('private', id))
    return agent
  }

  private validateAgentInput(input: CreateAgentInput, excludeId = ''): CreateAgentInput {
    const normalized = normalizeAgentInput(input)
    const duplicate = this.db
      .prepare('SELECT 1 FROM agents WHERE name = ? AND id <> ?')
      .get(normalized.name, excludeId)
    if (duplicate) throw new Error(`已存在名为「${normalized.name}」的智能体，请换一个名称`)
    return normalized
  }

  removeAgent(id: string): void {
    validateRecordId(id)
    this.db.exec('BEGIN')
    try {
      // Mirror of removeSpace: an agent's private conversations and their history
      // must not outlive the agent, and Phase 2 gives each agent several.
      const conversations = this.db
        .prepare('SELECT id FROM conversations WHERE scope = ? AND scopeId = ?')
        .all('private', id) as Array<{ id: string }>
      const deleteConversation = this.db.prepare('DELETE FROM conversations WHERE id = ?')
      const deleteSessions = this.db.prepare('DELETE FROM runtime_sessions WHERE contextKey LIKE ?')
      for (const conversation of conversations) {
        deleteSessions.run(conversationRuntimeKeyPattern(conversation.id))
        deleteConversation.run(conversation.id)
      }
      // Catches sessions whose conversation row is already gone, e.g. an agent
      // imported from a template whose conversations were pruned.
      this.db
        .prepare('DELETE FROM runtime_sessions WHERE contextKey LIKE ?')
        .run(agentRuntimeKeyPattern(id))
      this.db.prepare('DELETE FROM agents WHERE id = ?').run(id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  listSpaces(): Space[] {
    const rows = this.db
      .prepare('SELECT * FROM spaces ORDER BY createdAt ASC')
      .all() as unknown as SpaceRow[]
    const members = this.db.prepare(
      'SELECT agentId FROM space_members WHERE spaceId = ? ORDER BY position ASC'
    )
    return rows.map((row) => ({
      ...row,
      ...this.spaceSourceFields(row.id),
      memberIds: (members.all(row.id) as unknown as Array<{ agentId: string }>).map(
        (item) => item.agentId
      ),
    }))
  }

  getSpace(id: string): Space | undefined {
    const row = this.db.prepare('SELECT * FROM spaces WHERE id = ?').get(id) as unknown as
      | SpaceRow
      | undefined
    if (!row) return undefined
    const members = this.db
      .prepare('SELECT agentId FROM space_members WHERE spaceId = ? ORDER BY position ASC')
      .all(id) as unknown as Array<{ agentId: string }>
    return { ...row, ...this.spaceSourceFields(id), memberIds: members.map((item) => item.agentId) }
  }

  private spaceSourceFields(id: string): Pick<Space, 'source'> {
    const source = this.db
      .prepare(`SELECT source, source_id AS sourceId, revision, manifest
      FROM space_sources WHERE space_id = ?`)
      .get(id) as Space['source']
    return source ? { source } : {}
  }

  findSpaceBySource(source: string, sourceId: string): Space | undefined {
    const row = this.db
      .prepare('SELECT space_id AS id FROM space_sources WHERE source = ? AND source_id = ?')
      .get(source, sourceId) as { id: string } | undefined
    return row ? this.getSpace(row.id) : undefined
  }

  installTeam(team: ResolvedTeam): Space {
    if (
      !team.templates.length ||
      team.templates.length > 100 ||
      team.members.length !== team.templates.length ||
      new Set(team.members).size !== team.members.length ||
      team.templates.some(
        (template, index) =>
          template.provenance.source !== 'agency' ||
          template.provenance.sourceId !== team.members[index]
      )
    )
      throw new Error('团队成员无效')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.findSpaceBySource('mindmesh-curated', team.sourceId)
      if (existing) {
        this.db.exec('COMMIT')
        return existing
      }
      const memberIds = team.templates.map((template) => this.installAgencyAgentRows(template).id)
      const names = new Set(this.listSpaces().map((space) => space.name))
      let name = team.name
      for (let suffix = 2; names.has(name); suffix += 1) name = `${team.name} (${suffix})`
      const space: Space = {
        ...normalizeSpaceInput({
          name,
          description: team.description,
          context: team.context,
          memberIds,
        }),
        id: randomUUID(),
        createdAt: new Date().toISOString(),
      }
      this.insertSpaceRows(space)
      const { templates, ...manifest } = team
      this.db
        .prepare(`INSERT INTO space_sources(space_id, source, source_id, revision, manifest)
        VALUES (?, ?, ?, ?, ?)`)
        .run(
          space.id,
          'mindmesh-curated',
          team.sourceId,
          team.revision,
          JSON.stringify({
            ...manifest,
            members: memberIds.map((id) => {
              const provenance = this.getAgent(id)!.source!
              return {
                source: provenance.source,
                sourceId: provenance.sourceId,
                revision: provenance.revision,
              }
            }),
          })
        )
      const installed = this.getSpace(space.id)!
      this.db.exec('COMMIT')
      return installed
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getUserProfile(): UserProfile {
    return (
      (this.db.prepare('SELECT name, avatar FROM user_profile WHERE id = 1').get() as
        | UserProfile
        | undefined) ?? { name: '你', avatar: null }
    )
  }

  getWorkspacePath(): string | undefined {
    return (
      this.db.prepare("SELECT value FROM app_meta WHERE key = 'workspacePath'").get() as
        | { value: string }
        | undefined
    )?.value
  }

  changeWorkspace(path: string): void {
    this.db.exec('BEGIN')
    try {
      this.db
        .prepare(
          "INSERT INTO app_meta (key, value) VALUES ('workspacePath', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        )
        .run(path)
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
    if (
      avatar !== null &&
      (typeof avatar !== 'string' ||
        avatar.length > 1_500_000 ||
        !/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(avatar))
    ) {
      throw new Error('请选择不超过 1 MB 的 PNG、JPEG、WebP 或 GIF 图片')
    }
    this.db
      .prepare(`INSERT INTO user_profile (id, name, avatar) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, avatar = excluded.avatar`)
      .run(name, avatar)
    return { name, avatar }
  }

  updateSpaceContext(id: string, context: string): Space {
    validateSpaceContext(context)
    validateRecordId(id)
    const result = this.db.prepare('UPDATE spaces SET context = ? WHERE id = ?').run(context, id)
    if (result.changes === 0) throw new Error('协作空间不存在')
    return this.getSpace(id)!
  }

  createSpace(input: CreateSpaceInput, id: string = randomUUID()): Space {
    const space: Space = { ...normalizeSpaceInput(input), id, createdAt: new Date().toISOString() }
    this.db.exec('BEGIN')
    try {
      this.insertSpaceRows(space)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return space
  }

  private insertSpaceRows(space: Space): void {
    this.db
      .prepare(
        'INSERT INTO spaces (id, name, description, context, createdAt) VALUES (?, ?, ?, ?, ?)'
      )
      .run(space.id, space.name, space.description, space.context, space.createdAt)
    const addMember = this.db.prepare(
      'INSERT INTO space_members (spaceId, agentId, position) VALUES (?, ?, ?)'
    )
    space.memberIds.forEach((agentId, index) => addMember.run(space.id, agentId, index))
    // Both direct creation and Team installation must own a default conversation.
    this.ensureConversation(
      this.conversationIdFor('space', space.id),
      'space',
      space.id,
      space.name
    )
  }

  updateSpace(id: string, input: CreateSpaceInput): Space {
    validateRecordId(id)
    if (!this.getSpace(id)) throw new Error('协作空间不存在')
    const normalized = normalizeSpaceInput(input)
    this.db.exec('BEGIN')
    try {
      this.db
        .prepare('UPDATE spaces SET name = ?, description = ?, context = ? WHERE id = ?')
        .run(normalized.name, normalized.description, normalized.context, id)
      this.db.prepare('DELETE FROM space_members WHERE spaceId = ?').run(id)
      const addMember = this.db.prepare(
        'INSERT INTO space_members (spaceId, agentId, position) VALUES (?, ?, ?)'
      )
      normalized.memberIds.forEach((agentId, index) => addMember.run(id, agentId, index))
      // Keep the default conversation's title in step with the space name; Phase 2
      // lists conversations by title, so a stale name would surface in the UI.
      this.db
        .prepare('UPDATE conversations SET title = ? WHERE id = ?')
        .run(normalized.name, this.conversationIdFor('space', id))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.getSpace(id)!
  }

  /**
   * Deletes a space and every conversation inside it.
   *
   * Returns the deleted conversation ids so the caller can release the matching
   * harness leases — those are keyed by conversation and cannot be re-derived from
   * the space id once several conversations exist.
   */
  removeSpace(id: string): string[] {
    validateRecordId(id)
    if (!this.getSpace(id)) throw new Error('协作空间不存在')
    this.db.exec('BEGIN')
    try {
      // Every conversation in the space goes, not just the default one. Phase 2
      // lets a space hold several conversations, and each owns its messages,
      // executions, runs and tool calls; deleting only `space:<id>` would strand a
      // second conversation's whole history after the space itself was gone.
      const conversations = this.db
        .prepare('SELECT id FROM conversations WHERE scope = ? AND scopeId = ?')
        .all('space', id) as Array<{ id: string }>
      const deleteConversation = this.db.prepare('DELETE FROM conversations WHERE id = ?')
      const deleteSessions = this.db.prepare('DELETE FROM runtime_sessions WHERE contextKey LIKE ?')
      for (const conversation of conversations) {
        deleteSessions.run(conversationRuntimeKeyPattern(conversation.id))
        deleteConversation.run(conversation.id)
      }
      this.db.prepare('DELETE FROM space_members WHERE spaceId = ?').run(id)
      this.db.prepare('DELETE FROM spaces WHERE id = ?').run(id)
      this.db.exec('COMMIT')
      return conversations.map((conversation) => conversation.id)
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Resolve the conversation that owns a private agent's or a space's messages.
   *
   * The default conversation was created with a scope-derived id during migration,
   * so the mapping is deterministic and needs no extra lookup table. Until Phase 2
   * lands the UI there is exactly one conversation per scope; afterwards callers
   * must pass an explicit conversation id instead of resolving the default.
   */
  conversationIdFor(scope: Message['scope'], scopeId: string): string {
    return `${scope}:${scopeId}`
  }

  /**
   * Messages are stored per conversation; callers still speak in scope/scopeId.
   * Joining conversations keeps `Message` a stable shape for the renderer and IPC
   * while the storage layer moves to conversation-scoped sequences.
   */
  private hydrateMessageRow(row: Record<string, unknown>): Message {
    return this.hydrateMessage({
      ...row,
      scope: row.conversationScope,
      scopeId: row.conversationScopeId,
    })
  }

  private listMessageRows(where: string, ...params: Array<string | number>): Message[] {
    return this.db
      .prepare(`
      SELECT m.*, c.scope AS conversationScope, c.scopeId AS conversationScopeId
      FROM messages m JOIN conversations c ON c.id = m.conversationId
      ${where}
    `)
      .all(...params)
      .map((row) => this.hydrateMessageRow(row as Record<string, unknown>))
  }

  /** Attach each reply message's persisted tool calls for the audit trail. */
  private attachToolCalls(messages: Message[]): Message[] {
    return messages.map((message) =>
      message.authorType !== 'user'
        ? { ...message, toolCalls: this.listToolCallsForResponse(message.id) }
        : message
    )
  }

  /**
   * History reads are conversation-scoped, matching the storage layout and the
   * consumption cursor in {@link lastAgentMessageSequence}.
   *
   * Querying by scope/scopeId looked equivalent while there was one conversation
   * per scope, but it silently concatenates every conversation in a scope — so a
   * second conversation would render the first one's history and the Space
   * consumption cursor would skip messages it had never seen. Callers that only
   * know a scope must resolve a conversation id first.
   */
  listMessages(conversationId: string): Message[] {
    return this.attachToolCalls(
      this.listMessageRows('WHERE m.conversationId = ? ORDER BY m.sequence ASC', conversationId)
    )
  }

  listMessagesSince(conversationId: string, sequence: number): Message[] {
    return this.attachToolCalls(
      this.listMessageRows(
        'WHERE m.conversationId = ? AND m.sequence > ? ORDER BY m.sequence ASC',
        conversationId,
        sequence
      )
    )
  }

  /**
   * The space consumption cursor: how far this agent has already been fed.
   *
   * Sequences are per conversation, so this must be scoped to the same conversation
   * the runtime session belongs to — otherwise a second conversation in the same
   * space would start from the first one's cursor and silently skip messages.
   */
  lastAgentMessageSequence(conversationId: string, agentId: string): number {
    const row = this.db
      .prepare(`
      SELECT COALESCE(MAX(sequence), 0) AS sequence
      FROM messages WHERE conversationId = ? AND authorId = ?
    `)
      .get(conversationId, agentId) as { sequence: number }
    return row.sequence
  }

  getOrCreateRuntimeSession(
    contextKey: string,
    agent: Agent,
    sessionId: string,
    capabilityHash: string,
    initialSequence = 0
  ): RuntimeSession {
    const row = this.db
      .prepare(`
      SELECT harnessSessionId, capabilityHash, agentSnapshot, lastConsumedMessageSequence
      FROM runtime_sessions WHERE contextKey = ?
    `)
      .get(contextKey) as RuntimeSessionRow | undefined
    if (row) {
      const snapshot = row.agentSnapshot ? (JSON.parse(row.agentSnapshot) as Agent) : agent
      const snapshotHash = row.agentSnapshot ? getAgentCapabilityHash(snapshot) : capabilityHash
      if (!row.agentSnapshot || getAgentCapabilityBaseHash(row.capabilityHash) !== snapshotHash) {
        this.db
          .prepare(`UPDATE runtime_sessions
          SET harnessSessionId = ?, provider = ?, model = ?, capabilityHash = ?, agentSnapshot = ?, updatedAt = ?
          WHERE contextKey = ?`)
          .run(
            sessionId,
            snapshot.provider,
            snapshot.model,
            snapshotHash,
            JSON.stringify(snapshot),
            new Date().toISOString(),
            contextKey
          )
        return {
          harnessSessionId: sessionId,
          capabilityHash: snapshotHash,
          agent: snapshot,
          lastConsumedMessageSequence: row.lastConsumedMessageSequence,
        }
      }
      return {
        harnessSessionId: row.harnessSessionId,
        capabilityHash: row.capabilityHash,
        agent: snapshot,
        lastConsumedMessageSequence: row.lastConsumedMessageSequence,
      }
    }
    this.db
      .prepare(`
      INSERT INTO runtime_sessions
        (contextKey, harnessSessionId, provider, model, capabilityHash, agentSnapshot,
         lastConsumedMessageSequence, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        contextKey,
        sessionId,
        agent.provider,
        agent.model,
        capabilityHash,
        JSON.stringify(agent),
        initialSequence,
        new Date().toISOString()
      )
    return {
      harnessSessionId: sessionId,
      capabilityHash,
      agent,
      lastConsumedMessageSequence: initialSequence,
    }
  }

  restartRuntimeSession(
    contextKey: string,
    agent: Agent,
    sessionId: string,
    capabilityHash: string,
    initialSequence = 0
  ): RuntimeSession {
    this.db.prepare('DELETE FROM runtime_sessions WHERE contextKey = ?').run(contextKey)
    return this.getOrCreateRuntimeSession(
      contextKey,
      agent,
      sessionId,
      capabilityHash,
      initialSequence
    )
  }

  saveRuntimeSessionProgress(
    contextKey: string,
    sessionId: string,
    sequence: number,
    expected?: RuntimeSession
  ): void {
    this.db
      .prepare(`
      UPDATE runtime_sessions SET harnessSessionId = ?, lastConsumedMessageSequence = ?, updatedAt = ?
      WHERE contextKey = ? AND (? IS NULL OR (capabilityHash = ? AND harnessSessionId = ?))
    `)
      .run(
        sessionId,
        sequence,
        new Date().toISOString(),
        contextKey,
        expected?.capabilityHash ?? null,
        expected?.capabilityHash ?? null,
        expected?.harnessSessionId ?? null
      )
  }

  referencedCapabilityHashes(): string[] {
    return (
      this.db.prepare('SELECT DISTINCT capabilityHash FROM runtime_sessions').all() as Array<{
        capabilityHash: string
      }>
    ).map((row) => row.capabilityHash)
  }

  addMessage(input: Omit<Message, 'id' | 'sequence' | 'createdAt'>): Message {
    const conversationId = this.conversationIdFor(input.scope, input.scopeId)
    this.ensureConversation(conversationId, input.scope, input.scopeId)
    const next = this.db
      .prepare(
        'SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM messages WHERE conversationId = ?'
      )
      .get(conversationId) as { sequence: number }
    const message: Message = {
      ...input,
      reasoning: input.reasoning ?? null,
      attachments: input.attachments ?? [],
      stopped: input.stopped ?? false,
      id: randomUUID(),
      sequence: next.sequence,
      createdAt: new Date().toISOString(),
    }
    this.db
      .prepare(`
      INSERT INTO messages (id, conversationId, authorType, authorId, authorName, content, reasoning, attachments, stopped, sequence, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        message.id,
        conversationId,
        message.authorType,
        message.authorId ?? null,
        message.authorName,
        message.content,
        message.reasoning ?? null,
        JSON.stringify(message.attachments),
        message.stopped ? 1 : 0,
        message.sequence,
        message.createdAt
      )
    return message
  }

  /**
   * Guarantee a conversation exists before a message references it. A private or
   * space scope can gain messages after its default conversation was archived or
   * removed, and the message insert must not fail on the foreign key.
   */
  /**
   * Insert the scope's default conversation if it does not exist yet.
   *
   * `addMessage` also calls this, but creating it at entity-creation time keeps the
   * invariant "every agent and space owns exactly one default conversation", which is
   * what the delete paths enumerate. A lazily created row would make a brand-new
   * agent or space look like it had none.
   */
  private ensureConversation(
    conversationId: string,
    scope: Message['scope'],
    scopeId: string,
    title?: string
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO conversations (id, scope, scopeId, title, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        conversationId,
        scope,
        scopeId,
        title || scopeId,
        new Date().toISOString(),
        new Date().toISOString()
      )
  }

  private hydrateMessage(row: unknown): Message {
    const stored = row as Omit<Message, 'attachments' | 'stopped'> & {
      attachments?: string
      stopped?: number | boolean
    }
    let attachments: ChatImageAttachment[] = []
    try {
      const parsed: unknown = stored.attachments ? JSON.parse(stored.attachments) : []
      if (Array.isArray(parsed)) attachments = parsed.filter(isStoredImageAttachment)
    } catch {
      /* Preserve readable messages even if an attachment payload is corrupt. */
    }
    return { ...stored, attachments, stopped: Boolean(stored.stopped) }
  }

  close(): void {
    this.db.close()
  }

  // ── Execution history (§4.3–4.5) ─────────────────────────────────────────

  /**
   * Persist the start of an execution. The id is minted by the caller and reused
   * across every run, so the renderer's `executionId` matches the stored row.
   */
  createExecution(input: {
    id: string
    conversationId: string
    triggerMessageId: string
    workflowSnapshot?: string
  }): void {
    this.db
      .prepare(`
      INSERT INTO executions (id, conversationId, triggerMessageId, status, workflowSnapshot, startedAt)
      VALUES (?, ?, ?, 'running', ?, ?)
    `)
      .run(
        input.id,
        input.conversationId,
        input.triggerMessageId,
        input.workflowSnapshot ?? null,
        new Date().toISOString()
      )
  }

  /**
   * Persist the start of a run. `id` is the request id that already identifies
   * the run on every runtime event, so the event stream and the stored row share
   * one identity.
   */
  createRun(input: {
    id: string
    executionId: string
    conversationId: string
    triggerMessageId: string
    agentId: string
    provider: string
    model: string
    permission: string
    agentSnapshot?: string
  }): void {
    this.db
      .prepare(`
      INSERT INTO runs (id, executionId, conversationId, triggerMessageId, agentId, provider, model, permission, status, startedAt, agentSnapshot)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
    `)
      .run(
        input.id,
        input.executionId,
        input.conversationId,
        input.triggerMessageId,
        input.agentId,
        input.provider,
        input.model,
        input.permission,
        new Date().toISOString(),
        input.agentSnapshot ?? null
      )
  }

  /** Mark the first body output of a run, once. */
  markRunFirstOutput(id: string): void {
    this.db
      .prepare('UPDATE runs SET firstOutputAt = COALESCE(firstOutputAt, ?) WHERE id = ?')
      .run(new Date().toISOString(), id)
  }

  /** Close a run with its terminal state and, on success, the reply message id. */
  finishRun(id: string, status: RunStatus, responseMessageId?: string): void {
    this.db
      .prepare('UPDATE runs SET status = ?, responseMessageId = ?, endedAt = ? WHERE id = ?')
      .run(status, responseMessageId ?? null, new Date().toISOString(), id)
  }

  /** Accumulate the per-request usage onto the run's authoritative totals. */
  accumulateRunUsage(
    id: string,
    usage: {
      inputTokens?: number
      outputTokens?: number
      cacheReadTokens?: number
      cacheWriteTokens?: number
    }
  ): void {
    this.db
      .prepare(`
      UPDATE runs SET
        inputTokens = COALESCE(inputTokens, 0) + ?,
        outputTokens = COALESCE(outputTokens, 0) + ?,
        cacheReadTokens = COALESCE(cacheReadTokens, 0) + ?,
        cacheWriteTokens = COALESCE(cacheWriteTokens, 0) + ?
      WHERE id = ?
    `)
      .run(
        usage.inputTokens ?? 0,
        usage.outputTokens ?? 0,
        usage.cacheReadTokens ?? 0,
        usage.cacheWriteTokens ?? 0,
        id
      )
  }

  /** Derive the execution's state from its persisted runs, never from loop exit. */
  finishExecution(id: string): void {
    const states = (
      this.db.prepare('SELECT status FROM runs WHERE executionId = ?').all(id) as Array<{
        status: RunStatus
      }>
    ).map((row) => row.status)
    // Shutdown may leave a run in flight. Startup recovery will interrupt it.
    if (states.includes('running')) return
    const status: ExecutionStatus = states.includes('stopped')
      ? 'stopped'
      : states.includes('interrupted')
        ? 'interrupted'
        : states.includes('error') || !states.length
          ? states.includes('completed')
            ? 'completed_with_errors'
            : 'error'
          : 'completed'
    this.db
      .prepare('UPDATE executions SET status = ?, endedAt = ? WHERE id = ?')
      .run(status, new Date().toISOString(), id)
  }

  /** Persist the start of a tool call, returning its per-run sequence. */
  addToolCall(input: {
    id: string
    runId: string
    toolName: string
    displayName?: string
  }): number {
    const next = this.db
      .prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM tool_calls WHERE runId = ?')
      .get(input.runId) as { sequence: number }
    this.db
      .prepare(`
      INSERT INTO tool_calls (id, runId, sequence, toolName, displayName, status, startedAt)
      VALUES (?, ?, ?, ?, ?, 'running', ?)
    `)
      .run(
        input.id,
        input.runId,
        next.sequence,
        input.toolName,
        input.displayName ?? null,
        new Date().toISOString()
      )
    return next.sequence
  }

  /** Close a tool call with its terminal state and bounded previews. */
  finishToolCall(input: {
    id: string
    status: ToolCallStatus
    outputPreview?: string
    errorPreview?: string
  }): void {
    this.db
      .prepare(`
      UPDATE tool_calls SET
        status = ?,
        outputPreview = ?,
        errorPreview = ?,
        endedAt = ?,
        elapsedMs = CAST((julianday(?) - julianday(startedAt)) * 86400000 AS INTEGER)
      WHERE id = ?
    `)
      .run(
        input.status,
        input.outputPreview ?? null,
        input.errorPreview ?? null,
        new Date().toISOString(),
        new Date().toISOString(),
        input.id
      )
  }

  /**
   * Startup recovery: a crash leaves runs and executions stuck in `running`.
   * Runs become `interrupted`; their stranded running tool calls become
   * `aborted`; and executions with no live run become `interrupted`.
   */
  markInterruptedRecovery(): void {
    const now = new Date().toISOString()
    this.db
      .prepare("UPDATE runs SET status = 'interrupted', endedAt = ? WHERE status = 'running'")
      .run(now)
    this.db
      .prepare("UPDATE tool_calls SET status = 'aborted', endedAt = ? WHERE status = 'running'")
      .run(now)
    this.db
      .prepare(
        `UPDATE executions SET status = 'interrupted', endedAt = ?
         WHERE status = 'running'
           AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.executionId = executions.id AND runs.status = 'running')`
      )
      .run(now)
  }

  /**
   * The audit trail for one reply message: its run's tool calls, in order.
   * A reply is linked to a run by `runs.responseMessageId`.
   */
  listToolCallsForResponse(responseMessageId: string): ToolCallRecord[] {
    return this.db
      .prepare(`
      SELECT tc.id, tc.toolName, tc.displayName, tc.status, tc.outputPreview, tc.errorPreview
      FROM tool_calls tc JOIN runs r ON r.id = tc.runId
      WHERE r.responseMessageId = ?
      ORDER BY tc.sequence ASC
    `)
      .all(responseMessageId)
      .map((row) => {
        const stored = row as Record<string, unknown>
        return {
          id: String(stored.id),
          toolName: String(stored.toolName),
          displayName: String(stored.displayName ?? stored.toolName),
          status: stored.status as ToolCallStatus,
          output: String(stored.errorPreview ?? stored.outputPreview ?? ''),
          isError: stored.status === 'error',
        }
      })
  }
}

function isStoredImageAttachment(value: unknown): value is ChatImageAttachment {
  if (!value || typeof value !== 'object') return false
  const attachment = value as Record<string, unknown>
  return (
    attachment.type === 'image' &&
    typeof attachment.name === 'string' &&
    ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(attachment.mediaType)) &&
    typeof attachment.data === 'string' &&
    typeof attachment.bytes === 'number'
  )
}
