import { downgradeToSchema2, mockHarness, mockProviderSettings } from './service-mocks'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { c as createTar } from 'tar'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AgencyProvider,
  installAgencyAgent,
  parseAgencyTemplate,
} from '../src/main/agency-provider'
import { MarketplaceCatalogService } from '../src/main/marketplace'
import { MindMeshDatabase } from '../src/main/database'
import { MindMeshServices } from '../src/main/services'

const revision = 'a'.repeat(40)
const license = 'MIT License\nCopyright fixture contributors\nPermission fixture notice'
const content =
  '---\nname: Writer\ndescription: Writes carefully\ntools: [Shell]\nmodel: remote-choice\n---\n# Writer\nUse the fixture persona marker.'
const sourceId = 'engineering/engineering-writer.md'
const roots: string[] = []
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'mindmesh-agency-test-'))
  roots.push(path)
  return path
}
afterEach(() => {
  vi.unstubAllGlobals()
  for (const path of roots.splice(0)) {
    if (!resolve(path).startsWith(resolve(tmpdir()) + sep))
      throw new Error('Unexpected fixture path')
    rmSync(path, { recursive: true, force: true })
  }
})

async function fixture(path: string, templateContent = content): Promise<ReturnType<typeof vi.fn>> {
  const rootName = `agency-agents-${revision}`
  const root = join(path, rootName)
  mkdirSync(join(root, 'engineering'), { recursive: true })
  mkdirSync(join(root, 'scripts'))
  writeFileSync(join(root, sourceId), templateContent)
  writeFileSync(
    join(root, 'engineering', 'engineering-reviewer.md'),
    content.replace('Writer', 'Reviewer')
  )
  writeFileSync(join(root, 'scripts', 'malicious.md'), content)
  writeFileSync(join(root, 'LICENSE'), license)
  const archive = join(path, 'archive.tar.gz')
  await createTar({ cwd: path, file: archive, gzip: true }, [rootName])
  const fetchMock = vi.fn(async (url: string) =>
    url.includes('/commits/main')
      ? new Response(revision)
      : new Response(new Uint8Array(readFileSync(archive)))
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('Agency pinned content and installs', () => {
  it('accepts maximum-size Agency names and descriptions including a name collision suffix', () => {
    const db = new MindMeshDatabase(':memory:')
    try {
      const name = 'x'.repeat(160),
        description = 'y'.repeat(2000)
      const template = parseAgencyTemplate(
        sourceId,
        `---\nname: ${name}\ndescription: ${description}\n---\nPersona`,
        revision,
        license
      )!
      db.createAgent({ ...db.listAgents()[0], name })
      expect(db.installAgencyAgent(template)).toMatchObject({
        name: `${name} (2)`,
        role: description,
      })
    } finally {
      db.close()
    }
  })

  it('retains an installation failure cause without exposing it in the user message', async () => {
    const path = directory()
    const agency = new AgencyProvider(path),
      catalog = new MarketplaceCatalogService(path, [agency])
    const db = new MindMeshDatabase(':memory:')
    try {
      const failure = await installAgencyAgent(null, revision, agency, catalog, db).catch(
        (error: unknown) => error
      )
      expect(failure).toMatchObject({
        message: '安装智能体失败，请刷新目录后重试。',
        cause: expect.any(Error),
      })
    } finally {
      db.close()
    }
  })

  it('bounds the SHA response before parsing or downloading', async () => {
    const path = directory()
    const fetchMock = vi.fn(async () => new Response('a'.repeat(81)))
    vi.stubGlobal('fetch', fetchMock)
    await expect(new AgencyProvider(path).load()).rejects.toThrow('响应过大')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('rejects oversized archive content as a controlled failure without publishing a snapshot', async () => {
    const path = directory()
    await fixture(path, content + 'x'.repeat(65_536))
    await expect(new AgencyProvider(path).load()).rejects.toThrow(/文件无效或过大/)
    expect(existsSync(join(path, 'marketplace-cache', 'agency', `${revision}.json`))).toBe(false)
  })

  it('pins one commit for the entire archive, retains licensed content, and installs offline after restart', async () => {
    const path = directory()
    const fetchMock = await fixture(path)
    const agency = new AgencyProvider(path)
    const service = new MarketplaceCatalogService(path, [agency])
    const catalog = await service.list('agents')
    expect(catalog.state).toBe('fresh')
    expect(catalog.items).toHaveLength(2)
    expect(
      catalog.items.every((item) => item.revision === revision && item.license === 'MIT')
    ).toBe(true)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.github.com/repos/msitarzewski/agency-agents/commits/main',
      `https://codeload.github.com/msitarzewski/agency-agents/tar.gz/${revision}`,
    ])
    fetchMock.mockRejectedValue(new Error('offline secret'))
    const restartedAgency = new AgencyProvider(path)
    const restartedService = new MarketplaceCatalogService(
      path,
      [restartedAgency],
      () => Date.now() + 16 * 60_000
    )
    const stale = await restartedService.list('agents')
    expect(stale).toMatchObject({ state: 'stale', items: catalog.items })
    const db = new MindMeshDatabase(join(path, 'db.sqlite'))
    try {
      const item = stale.items.find((item) => item.sourceId === sourceId)!
      const agent = await installAgencyAgent(
        item.key,
        item.revision,
        restartedAgency,
        restartedService,
        db
      )
      expect(agent).toMatchObject({
        provider: 'deepseek-official',
        model: 'deepseek-flash',
        tools: [],
        skills: [],
        persona: '# Writer\nUse the fixture persona marker.',
        source: { content, licenseText: license, revision, sourceId },
      })
      await expect(
        installAgencyAgent(item.key, 'b'.repeat(40), restartedAgency, restartedService, db)
      ).resolves.toMatchObject({ id: agent.id })
      await expect(
        installAgencyAgent(
          '["plugins","agency","bad"]',
          revision,
          restartedAgency,
          restartedService,
          db
        )
      ).rejects.toThrow('安装智能体失败')
    } finally {
      db.close()
    }
  })

  it('deduplicates by source, preserves edits, resolves name collisions and persists through restart', () => {
    const path = directory()
    const file = join(path, 'db.sqlite')
    let db = new MindMeshDatabase(file)
    const template = parseAgencyTemplate(sourceId, content, revision, license)!
    const manual = db.createAgent({
      name: 'Writer',
      role: 'manual',
      persona: 'manual persona',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      skills: [],
      tools: ['Shell'],
    })
    const installed = db.installAgencyAgent(template)
    expect(installed.name).toBe('Writer (2)')
    const editedInput = {
      ...installed,
      name: 'Edited Writer',
      persona: 'user edit',
      tools: [],
      source: { ...installed.source!, sourceId: 'forged' },
    }
    expect(db.updateAgent(installed.id, editedInput).source?.sourceId).toBe(sourceId)
    expect(db.installAgencyAgent({ ...template, persona: 'upstream new persona' })).toMatchObject({
      id: installed.id,
      persona: 'user edit',
      name: 'Edited Writer',
    })
    db.close()
    db = new MindMeshDatabase(file)
    try {
      expect(db.findAgentBySource('agency', sourceId)).toMatchObject({
        id: installed.id,
        persona: 'user edit',
        source: { content, licenseText: license },
      })
      expect(db.getAgent(manual.id)).toMatchObject({ persona: 'manual persona', tools: ['Shell'] })
      const other = db.installAgencyAgent(
        parseAgencyTemplate('engineering/engineering-other.md', content, revision, license)!
      )
      expect(other.name).toBe('Writer (2)')
      expect(other.id).not.toBe(installed.id)
      db.removeAgent(installed.id)
      expect(db.findAgentBySource('agency', sourceId)).toBeUndefined()
      expect(db.installAgencyAgent(template).id).not.toBe(installed.id)
    } finally {
      db.close()
    }
  })

  it('migrates schema 2 with a backup, preserves plugin state, and rolls back a failed source write', () => {
    const path = directory()
    const file = join(path, 'db.sqlite')
    const initial = new MindMeshDatabase(file)
    const oldAgent = initial.listAgents()[0]
    initial.close()
    const raw = new DatabaseSync(file)
    raw.exec('DROP TABLE agent_sources')
    raw.exec('DROP TABLE space_sources')
    downgradeToSchema2(raw)
    raw.prepare("UPDATE app_meta SET value = '2' WHERE key = 'schema_version'").run()
    raw.prepare("UPDATE app_meta SET value = '7' WHERE key = 'plugin_set_generation'").run()
    raw.close()
    const migrated = new MindMeshDatabase(file)
    try {
      expect(migrated.getAgent(oldAgent.id)).toEqual(oldAgent)
      expect(migrated.readPluginSet().generation).toBe(7)
      const before = migrated.listAgents().length
      const template = parseAgencyTemplate(sourceId, content, revision, license)!
      expect(() =>
        migrated.installAgencyAgent({
          ...template,
          provenance: { ...template.provenance, licenseText: null as never },
        })
      ).toThrow()
      expect(migrated.listAgents()).toHaveLength(before)
      expect(migrated.findAgentBySource('agency', sourceId)).toBeUndefined()
    } finally {
      migrated.close()
    }
    expect(existsSync(`${file}.before-schema-2.sqlite`)).toBe(true)
    const backup = new DatabaseSync(`${file}.before-schema-2.sqlite`, { readOnly: true })
    expect(backup.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get()).toEqual(
      { value: '2' }
    )
    expect(
      backup.prepare("SELECT name FROM sqlite_master WHERE name = 'agent_sources'").get()
    ).toBeUndefined()
    backup.close()
    const reopened = new MindMeshDatabase(file)
    reopened.close()
  })

  it('uses the installed persona through the normal private chat path', async () => {
    const db = new MindMeshDatabase(':memory:')
    try {
      const agent = db.installAgencyAgent(
        parseAgencyTemplate(sourceId, content, revision, license)!
      )
      const run = vi.fn(async (..._args: unknown[]) => ({
        text: 'Template reply',
        sessionId: 'installed-session',
      }))
      const services = new MindMeshServices(
        db,
        mockHarness({ run }),
        mockProviderSettings(),
        () => undefined
      )
      const messages = await services.sendPrivate(agent.id, 'Write a sentence')
      expect(run.mock.calls[0][0]).toMatchObject({
        id: agent.id,
        persona: agent.persona,
        tools: [],
      })
      expect(messages.at(-1)).toMatchObject({ authorId: agent.id, content: 'Template reply' })
    } finally {
      db.close()
    }
  })

  it('rejects unsafe content and malformed metadata without deriving capabilities from frontmatter', () => {
    expect(parseAgencyTemplate('../outside.md', content, revision, license)).toBeUndefined()
    expect(() => parseAgencyTemplate(sourceId, content, '../bad', license)).toThrow()
    expect(() => parseAgencyTemplate(sourceId, content, revision, 'unknown license')).toThrow()
    expect(() =>
      parseAgencyTemplate(sourceId, content + 'x'.repeat(65_536), revision, license)
    ).toThrow()
    expect(parseAgencyTemplate(sourceId, content, revision, license)).not.toHaveProperty('tools')
  })
})
