import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { MindMeshDatabase } from '../src/main/database'
import { PluginSetManager, pluginSetRevision } from '../src/main/plugins/plugin-set'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('desired set persists across startup; revision ignores timestamps and rejects stale commits', () => {
  const root = mkdtempSync(join(tmpdir(), 'mindmesh-plugins-'))
  roots.push(root)
  const file = join(root, 'db.sqlite')
  const db = new MindMeshDatabase(file)
  const set = new PluginSetManager(db)
  const plugin = {
    packageName: 'test-plugin',
    version: '1.0.0',
    enabled: true,
    config: {},
    installedAt: 'today',
    updatedAt: 'today',
  }
  const initial = set.snapshot()
  const revision = pluginSetRevision([plugin])
  expect(revision).toBe(pluginSetRevision([{ ...plugin, updatedAt: 'tomorrow' }]))
  set.commit(initial.generation, [plugin], {
    revision,
    directory: join(root, revision),
    digest: 'a'.repeat(64),
  })
  expect(() =>
    set.commit(initial.generation, [], {
      revision: pluginSetRevision([]),
      directory: root,
      digest: 'b'.repeat(64),
    })
  ).toThrow(/changed/)
  db.close()
  const restarted = new MindMeshDatabase(file)
  expect(new PluginSetManager(restarted).snapshot()).toMatchObject({
    generation: 1,
    revision,
    plugins: [plugin],
  })
  restarted.close()
})

test('legacy data migrates transactionally, backup captures original schema, future versions fail closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'mindmesh-plugins-'))
  roots.push(root)
  const file = join(root, 'legacy.sqlite')
  const legacy = new DatabaseSync(file)
  legacy.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, role TEXT NOT NULL, persona TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, skills TEXT NOT NULL DEFAULT '[]', tools TEXT NOT NULL DEFAULT '[]', createdAt TEXT NOT NULL);
    INSERT INTO agents VALUES ('legacy', 'Existing agent', 'role', 'persona', 'deepseek-official', 'deepseek-v4-flash', '[]', '[]', 'yesterday');`)
  legacy.close()
  const upgraded = new MindMeshDatabase(file)
  expect(upgraded.listAgents().find((agent) => agent.id === 'legacy')?.persona).toBe('persona')
  expect(new PluginSetManager(upgraded).snapshot().generation).toBe(0)
  upgraded.close()
  const backup = `${file}.before-schema-0.sqlite`
  expect(existsSync(backup)).toBe(true)
  const previous = new DatabaseSync(backup, { readOnly: true })
  expect(
    previous.prepare("SELECT name FROM sqlite_master WHERE name = 'installed_plugins'").get()
  ).toBeUndefined()
  previous.close()
  const future = new DatabaseSync(file)
  future.prepare("UPDATE app_meta SET value = '999' WHERE key = 'schema_version'").run()
  future.close()
  expect(() => new MindMeshDatabase(file)).toThrow('Unsupported database schema version')
})
