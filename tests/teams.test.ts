import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { downgradeToSchema2 } from './service-mocks'
import { AgencyProvider, parseAgencyTemplate } from '../src/main/agency-provider'
import { MindMeshDatabase } from '../src/main/database'
import { MarketplaceCatalogService } from '../src/main/marketplace'
import { curatedTeams, installTeam, teamProvider, teamRevision } from '../src/main/team-provider'
import { marketplaceKey } from '../src/shared/marketplace'

const roots: string[] = []
const sha = 'a'.repeat(40)
const license = 'MIT License\nFixture license notice'
const team = curatedTeams[0]
const revision = teamRevision(team)
const key = marketplaceKey({ kind: 'teams', source: 'mindmesh-curated', sourceId: team.sourceId })
const templates = team.members.map(
  (id, index) =>
    parseAgencyTemplate(
      id,
      `---\nname: Member ${index}\ndescription: Fixture member\n---\nPersona ${index}`,
      sha,
      license
    )!
)
const resolved = { ...team, revision, templates }
function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'mindmesh-team-test-'))
  roots.push(path)
  return path
}
function fixture(path: string) {
  const agency = new AgencyProvider(path)
  const files = Object.fromEntries(
    templates.map(({ provenance }) => [provenance.sourceId, provenance.content])
  )
  const dir = join(path, 'marketplace-cache', 'agency')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${sha}.json`),
    JSON.stringify({ revision: sha, files: { ...files, LICENSE: license } })
  )
  const load = vi.spyOn(agency, 'load').mockResolvedValue(
    templates.map((template) => ({
      sourceId: template.provenance.sourceId,
      name: template.name,
      revision: sha,
    }))
  )
  return { agency, load, catalog: new MarketplaceCatalogService(path, [agency, teamProvider]) }
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const path of roots.splice(0)) {
    if (!resolve(path).startsWith(resolve(tmpdir()) + sep))
      throw new Error('Unexpected fixture path')
    rmSync(path, { recursive: true, force: true })
  }
})

describe('curated Team installation', () => {
  it('publishes local manifests, resolves pinned references and installs once even under concurrent calls', async () => {
    const path = root(),
      { agency, catalog } = fixture(path)
    const db = new MindMeshDatabase(':memory:')
    try {
      expect((await catalog.list('teams')).items).toHaveLength(curatedTeams.length)
      const before = db.listAgents().length
      const installs = await Promise.all([
        installTeam(key, revision, agency, catalog, db),
        installTeam(key, revision, agency, catalog, db),
      ])
      expect(installs[0]).toEqual(installs[1])
      const raw = (db as unknown as { db: DatabaseSync }).db
      expect(
        raw
          .prepare('SELECT title FROM conversations WHERE id = ?')
          .get(db.conversationIdFor('space', installs[0].id))
      ).toEqual({ title: installs[0].name })
      expect(db.listAgents()).toHaveLength(before + 3)
      expect(installs[0].memberIds.map((id) => db.getAgent(id))).toEqual(
        templates.map((template) =>
          expect.objectContaining({
            persona: template.persona,
            source: template.provenance,
            tools: [],
            skills: [],
            provider: 'deepseek-official',
            model: 'deepseek-flash',
          })
        )
      )
      expect(JSON.parse(installs[0].source!.manifest).members).toEqual(
        team.members.map((sourceId) => ({ source: 'agency', sourceId, revision: sha }))
      )
      await expect(
        installTeam('["agents","mindmesh-curated","web-delivery"]', revision, agency, catalog, db)
      ).rejects.toThrow('安装团队失败')
      await expect(installTeam(key, 'b'.repeat(64), agency, catalog, db)).rejects.toThrow(
        '安装团队失败'
      )
    } finally {
      db.close()
    }
  })

  it('rolls back every new Agent on an Nth create failure while retaining pre-existing edits', () => {
    const db = new MindMeshDatabase(':memory:')
    try {
      const first = db.installAgencyAgent(templates[0])
      const edited = db.updateAgent(first.id, { ...first, persona: 'User edit', tools: ['Shell'] })
      const beforeAgents = db.listAgents(),
        beforeSpaces = db.listSpaces()
      const create = db.createAgent.bind(db)
      let count = 0
      vi.spyOn(db, 'createAgent').mockImplementation((input, id) => {
        if (++count === 2) throw new Error('Nth create failure')
        return create(input, id)
      })
      expect(() => db.installTeam(resolved)).toThrow('Nth create failure')
      expect(db.listAgents()).toEqual(beforeAgents)
      expect(db.listSpaces()).toEqual(beforeSpaces)
      expect(db.getAgent(first.id)).toEqual(edited)
      expect(db.findAgentBySource('agency', team.members[1])).toBeUndefined()
      expect(db.findSpaceBySource('mindmesh-curated', team.sourceId)).toBeUndefined()
      vi.restoreAllMocks()
      expect(db.installTeam(resolved).memberIds[0]).toBe(first.id)
    } finally {
      db.close()
    }
  })

  it('rolls back Space, members and Agents when the final source write fails', () => {
    const path = root(),
      file = join(path, 'db.sqlite')
    const db = new MindMeshDatabase(file)
    const raw = new DatabaseSync(file)
    raw.exec(
      "CREATE TRIGGER fail_team_source BEFORE INSERT ON space_sources BEGIN SELECT RAISE(ABORT, 'source failure'); END"
    )
    try {
      const beforeAgents = db.listAgents(),
        beforeSpaces = db.listSpaces()
      expect(() => db.installTeam(resolved)).toThrow('source failure')
      expect(db.listAgents()).toEqual(beforeAgents)
      expect(db.listSpaces()).toEqual(beforeSpaces)
      expect(raw.prepare('SELECT COUNT(*) AS n FROM space_sources').get()).toEqual({ n: 0 })
      expect(
        raw
          .prepare(
            'SELECT COUNT(*) AS n FROM space_members WHERE spaceId NOT IN (SELECT id FROM spaces)'
          )
          .get()
      ).toEqual({ n: 0 })
      raw.exec('DROP TRIGGER fail_team_source')
      expect(db.installTeam(resolved).memberIds).toHaveLength(3)
    } finally {
      raw.close()
      db.close()
    }
  })

  it('rejects missing or corrupt templates before changing the database', async () => {
    const path = root(),
      { agency, catalog, load } = fixture(path)
    const db = new MindMeshDatabase(':memory:')
    try {
      const beforeAgents = db.listAgents(),
        beforeSpaces = db.listSpaces()
      load.mockResolvedValue([{ sourceId: team.members[0], name: 'one', revision: sha }])
      await expect(installTeam(key, revision, agency, catalog, db)).rejects.toThrow('安装团队失败')
      expect(db.listAgents()).toEqual(beforeAgents)
      expect(db.listSpaces()).toEqual(beforeSpaces)
      load.mockResolvedValue(
        templates.map((template) => ({
          sourceId: template.provenance.sourceId,
          name: template.name,
          revision: sha,
        }))
      )
      await catalog.list('agents', true)
      writeFileSync(join(path, 'marketplace-cache', 'agency', `${sha}.json`), '{}')
      await expect(installTeam(key, revision, agency, catalog, db)).rejects.toThrow('安装团队失败')
      expect(db.listAgents()).toEqual(beforeAgents)
      expect(db.listSpaces()).toEqual(beforeSpaces)
    } finally {
      db.close()
    }
  })

  it('preserves source, edits and member order across restart and cleans only the Space mapping on deletion', async () => {
    const path = root(),
      file = join(path, 'db.sqlite')
    let db = new MindMeshDatabase(file)
    const manual = db.createSpace({ name: team.name, description: '', context: '', memberIds: [] })
    const first = db.installAgencyAgent({
      ...templates[0],
      provenance: { ...templates[0].provenance, revision: 'b'.repeat(40) },
    })
    db.updateAgent(first.id, { ...first, name: 'Edited', persona: 'User edit' })
    const installed = db.installTeam(resolved)
    expect(JSON.parse(installed.source!.manifest).members[0].revision).toBe('b'.repeat(40))
    expect(installed.name).toBe(`${team.name} (2)`)
    expect(installed.memberIds[0]).toBe(first.id)
    const edited = db.updateSpace(installed.id, {
      ...installed,
      name: 'My team',
      context: 'User context',
      memberIds: [...installed.memberIds].reverse(),
    })
    db.close()
    db = new MindMeshDatabase(file)
    try {
      const offlineAgency = new AgencyProvider(path)
      const load = vi.spyOn(offlineAgency, 'load').mockRejectedValue(new Error('offline'))
      const catalog = new MarketplaceCatalogService(path, [offlineAgency, teamProvider])
      expect(db.findSpaceBySource('mindmesh-curated', team.sourceId)).toEqual(edited)
      expect(db.listSpaces().find((space) => space.id === installed.id)).toEqual(edited)
      expect(await installTeam(key, revision, offlineAgency, catalog, db)).toEqual(edited)
      expect(load).not.toHaveBeenCalled()
      expect(db.getAgent(first.id)?.persona).toBe('User edit')
      db.removeSpace(installed.id)
      expect(db.findSpaceBySource('mindmesh-curated', team.sourceId)).toBeUndefined()
      expect(db.getSpace(manual.id)).toEqual(manual)
      expect(installed.memberIds.every((id) => db.getAgent(id))).toBe(true)
      const reinstalled = db.installTeam(resolved)
      expect(reinstalled.id).not.toBe(installed.id)
      expect(reinstalled.memberIds).toEqual(installed.memberIds)
    } finally {
      db.close()
    }
  })

  it('migrates schema 3 with an original backup and preserves Agent provenance and plugin generation', () => {
    const path = root(),
      file = join(path, 'db.sqlite')
    const initial = new MindMeshDatabase(file)
    const agent = initial.installAgencyAgent(templates[0])
    const spaces = initial.listSpaces()
    initial.close()
    const raw = new DatabaseSync(file)
    raw.exec('DROP TABLE space_sources')
    downgradeToSchema2(raw)
    raw.prepare("UPDATE app_meta SET value = '3' WHERE key = 'schema_version'").run()
    raw.prepare("UPDATE app_meta SET value = '7' WHERE key = 'plugin_set_generation'").run()
    raw.close()
    let db = new MindMeshDatabase(file)
    expect(db.getAgent(agent.id)).toEqual(agent)
    expect(db.listSpaces()).toEqual(spaces)
    expect(db.readPluginSet().generation).toBe(7)
    db.close()
    expect(existsSync(`${file}.before-schema-3.sqlite`)).toBe(true)
    const backup = new DatabaseSync(`${file}.before-schema-3.sqlite`, { readOnly: true })
    expect(backup.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get()).toEqual(
      { value: '3' }
    )
    expect(
      backup.prepare("SELECT name FROM sqlite_master WHERE name = 'space_sources'").get()
    ).toBeUndefined()
    backup.close()
    const backupBytes = readFileSync(`${file}.before-schema-3.sqlite`)
    db = new MindMeshDatabase(file)
    db.close()
    expect(readFileSync(`${file}.before-schema-3.sqlite`)).toEqual(backupBytes)
  })
})
