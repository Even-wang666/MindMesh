import type { DatabaseSync } from 'node:sqlite'
import { vi } from 'vitest'
import type { MindMeshServices } from '../src/main/services'
import type { ModelProviderSettings } from '../src/main/model-provider-settings'
import { getAgentCapabilityHash } from '../src/main/agent-capability'

type Harness = ConstructorParameters<typeof MindMeshServices>[1]
type ProviderSettings = Pick<
  ModelProviderSettings,
  'getProvider' | 'configuredProviders' | 'statuses' | 'save' | 'remove'
>

export function mockProviderSettings(overrides: Partial<ProviderSettings> = {}): ProviderSettings {
  return {
    getProvider: () => undefined,
    configuredProviders: () => [],
    statuses: () => [],
    save: () => [],
    remove: () => [],
    ...overrides,
  }
}

export function mockHarness(overrides: Partial<Harness> = {}): Harness {
  return {
    run: vi.fn(async () => {
      throw new Error('Unexpected Harness run')
    }),
    stop: vi.fn(async () => false),
    prepareRun: (agent, permission) => {
      // Chat-flow fixtures isolate session bookkeeping from filesystem/SDK preparation.
      const hash = getAgentCapabilityHash(agent)
      return {
        agent,
        workspace: '',
        providers: [],
        skillIds: [],
        dshBin: '',
        identity: {
          key: hash,
          capabilityHash: hash,
          schemaVersion: 2,
          dshVersion: 'test',
          flavor: 'core',
          permission,
          workspaceIdentity: '',
          skillRevision: '',
        },
      }
    },
    status: vi.fn(() => ({ state: 'ready' as const, label: '', detail: '' })),
    forgetAgent: vi.fn(async () => undefined),
    forgetSpace: vi.fn(async () => undefined),
    workspacePath: '',
    setWorkspace: vi.fn(),
    invalidateWorkspace: vi.fn(async () => undefined),
    invalidateProvider: vi.fn(async () => undefined),
    cleanupUnusedHomes: vi.fn(),
    shutdownAll: vi.fn(async () => undefined),
    ...overrides,
  }
}

/**
 * Rewind a current database to the pre-conversation schema.
 *
 * Migration tests used to only rewind `schema_version`, which left the newer
 * tables in place — a state no real installation can ever be in. This reverses the
 * actual Phase 1 schema change so the migration runs against a faithful shape:
 * conversations removed, messages restored to (scope, scopeId, sequence), and the
 * execution tables dropped along with their rows.
 */
export function downgradeToSchema2(db: DatabaseSync): void {
  db.exec('DROP TABLE IF EXISTS tool_calls')
  db.exec('DROP TABLE IF EXISTS runs')
  db.exec('DROP TABLE IF EXISTS executions')
  db.exec('DROP INDEX IF EXISTS tool_calls_run_sequence')
  db.exec('DROP INDEX IF EXISTS messages_conversation_sequence')
  db.exec(`CREATE TABLE messages_pre_v5 (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    scopeId TEXT NOT NULL,
    authorType TEXT NOT NULL,
    authorId TEXT,
    authorName TEXT NOT NULL,
    content TEXT NOT NULL,
    reasoning TEXT,
    attachments TEXT NOT NULL DEFAULT '[]',
    stopped INTEGER NOT NULL DEFAULT 0,
    sequence INTEGER NOT NULL,
    createdAt TEXT NOT NULL
  )`)
  db.exec(`INSERT INTO messages_pre_v5
    (id, scope, scopeId, authorType, authorId, authorName, content, reasoning,
     attachments, stopped, sequence, createdAt)
    SELECT m.id, c.scope, c.scopeId, m.authorType, m.authorId, m.authorName, m.content,
           m.reasoning, m.attachments, m.stopped, m.sequence, m.createdAt
      FROM messages m JOIN conversations c ON c.id = m.conversationId`)
  db.exec('DROP TABLE messages')
  db.exec('ALTER TABLE messages_pre_v5 RENAME TO messages')
  db.exec('CREATE UNIQUE INDEX messages_scope_sequence ON messages(scope, scopeId, sequence)')
  db.exec('DROP TABLE conversations')
  db.exec('DELETE FROM runtime_sessions')
}
