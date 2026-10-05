import { mockProviderSettings } from './service-mocks'
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  realpathSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { expect, test, vi } from 'vitest'
import { startPluginFixtureRegistry } from '../scripts/plugin-fixture-registry.mjs'
import { startPluginModelFixture } from '../scripts/plugin-model-fixture.mjs'
import { MindMeshDatabase, runtimeContextKey } from '../src/main/database'
import { PluginSetManager } from '../src/main/plugins/plugin-set'
import { PluginManager, PluginStaging } from '../src/main/plugins/plugin-manager'
import { DeepSeekHarnessAdapter } from '../src/main/harness-adapter'
import { RuntimeHomeMaterializer } from '../src/main/runtime-home-materializer'
import { MindMeshServices } from '../src/main/services'

test('full materializes the validated lockfile; core physically contains no third-party plugin', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mindmesh-plugin-runtime-'))
  const registry = await startPluginFixtureRegistry(root)
  const model = await startPluginModelFixture()
  const db = new MindMeshDatabase(join(root, 'data', 'db.sqlite'))
  // Exercise canonicalization when the OS/user exposes a directory alias (e.g. RUNNER~1).
  symlinkSync(
    join(root, 'data'),
    join(root, 'alias'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  const dataDirectory = join(root, 'alias')
  const set = new PluginSetManager(db)
  const manager = new PluginManager(set, new PluginStaging(dataDirectory, undefined, registry.url))
  const provider = {
    id: 'custom' as const,
    name: 'Fixture',
    apiKey: 'fixture-key',
    baseUrl: model.url,
    model: 'fixture-model',
  }
  const settings = mockProviderSettings({
    getProvider: () => provider,
    configuredProviders: () => [provider],
  })
  let adapter = new DeepSeekHarnessAdapter(root, dataDirectory, settings, set)
  const agent = {
    id: 'a',
    name: 'A',
    role: '',
    persona: 'Test',
    provider: 'custom',
    model: 'fixture-model',
    skills: [],
    tools: ['Shell'],
    createdAt: '',
  }
  try {
    const chatBefore = adapter.prepareRun(agent, 'chat').identity.key
    await manager.change({
      kind: 'install',
      packageName: 'mindmesh-fixture-plugin',
      version: '1.0.0',
    })
    expect(adapter.prepareRun(agent, 'chat').identity.key).toBe(chatBefore)
    const materializer = new RuntimeHomeMaterializer(dataDirectory)
    for (const permission of ['chat', 'workspace'] as const) {
      const request = adapter.prepareRun(agent, permission)
      expect(request.plugins).toBeUndefined()
      const home = await materializer.ensure(request)
      expect(home.dshHome.startsWith(join(realpathSync(dataDirectory), 'runtime-v2') + sep)).toBe(
        true
      )
      expect(
        existsSync(join(home.dshHome, 'profiles', 'sdk', 'node_modules', 'mindmesh-fixture-plugin'))
      ).toBe(false)
      expect(readFileSync(home.capabilityPatch, 'utf8')).toMatch(
        /id: tool-(?:pwsh|bash)\n  disabled: true/
      )
    }
    const full = adapter.prepareRun(agent, 'full')
    const cancelled = adapter.prepareRun({ ...agent, persona: 'cancelled preparation' }, 'full')
    const preparing = adapter.run(agent, 'cancel before ready', undefined, undefined, [], cancelled)
    const rejected = expect(preparing).rejects.toMatchObject({ kind: 'materialization' })
    await vi.waitFor(() =>
      expect(
        adapter.runtimeDiagnostics().find((entry) => entry.key === cancelled.identity.key)?.state
      ).toBe('preparing')
    )
    expect(await adapter.stop(agent)).toBe(true)
    await rejected
    expect(
      existsSync(join(root, 'data', 'runtime-v2', cancelled.identity.key, 'metadata.json'))
    ).toBe(false)
    const home = await materializer.ensure(full)
    expect(
      JSON.parse(
        readFileSync(
          join(
            home.dshHome,
            'profiles',
            'sdk',
            'node_modules',
            'mindmesh-fixture-plugin',
            'package.json'
          ),
          'utf8'
        )
      ).version
    ).toBe('1.0.0')
    expect((await materializer.ensure(full)).created).toBe(false)
    expect(readFileSync(join(home.dshHome, 'profiles', 'sdk', 'pnpm-lock.yaml'), 'utf8')).toBe(
      readFileSync(join(full.plugins!.artifact!.directory, 'pnpm-lock.yaml'), 'utf8')
    )
    const first = await adapter.run(agent, 'call the fixture tool', undefined, undefined, [], full)
    expect(first.text).toContain('fixture:1.0.0')
    expect(existsSync(join(root, 'tool-called-1.0.0'))).toBe(true)
    expect(readFileSync(join(home.dshHome, 'metadata.json'), 'utf8')).not.toContain('fixture-key')
    const services = new MindMeshServices(db, adapter, settings, () => undefined)
    const member = services.createAgent(agent)
    await services.sendPrivate(member.id, 'private remembered', [], { permission: 'full' })
    const space = services.createSpace({
      name: 'Plugins',
      description: '',
      context: '',
      memberIds: [member.id],
    })
    await services.sendSpace(space.id, `@${member.name} space remembered`, [], {
      permission: 'full',
    })
    const held = model.holdNext()
    const old = services.sendPrivate(member.id, 'old version request', [], { permission: 'full' })
    const resume = await held
    let newSession: string | undefined
    try {
      await manager.change({
        kind: 'update',
        packageName: 'mindmesh-fixture-plugin',
        version: '1.0.1',
      })
      expect(
        adapter.runtimeDiagnostics().find((entry) => entry.key === full.identity.key)
      ).toMatchObject({ stale: true, activeLeaseCount: 1 })
      const updated = adapter.prepareRun(agent, 'full')
      expect(updated.identity.key).not.toBe(full.identity.key)
      expect(
        (await adapter.run(agent, 'new version request', undefined, undefined, [], updated)).text
      ).toContain('fixture:1.0.1')
      const start = model.requests.length
      await services.sendPrivate(member.id, 'new private request', [], { permission: 'full' })
      newSession = db.getOrCreateRuntimeSession(
        runtimeContextKey(`private:${member.id}`, member.id),
        member,
        'unused',
        updated.identity.capabilityHash
      ).harnessSessionId
      await services.sendSpace(space.id, `@${member.name} new space request`, [], {
        permission: 'full',
      })
      const recovered = JSON.stringify(model.requests.slice(start))
      expect(recovered).toContain('private remembered')
      expect(recovered).toContain('space remembered')
    } finally {
      resume()
    }
    expect((await old).at(-1)?.content).toContain('fixture:1.0.0')
    expect(
      db.getOrCreateRuntimeSession(
        runtimeContextKey(`private:${member.id}`, member.id),
        member,
        'unused',
        adapter.capabilityHash(member, 'full')
      ).harnessSessionId
    ).toBe(newSession)
    expect(adapter.runtimeDiagnostics().some((entry) => entry.key === full.identity.key)).toBe(
      false
    )
    await adapter.shutdownAll()
    adapter = new DeepSeekHarnessAdapter(
      root,
      join(root, 'data'),
      settings,
      new PluginSetManager(db)
    )
    expect(
      (
        await adapter.run(
          agent,
          'restart request',
          undefined,
          undefined,
          [],
          adapter.prepareRun(agent, 'full')
        )
      ).text
    ).toContain('fixture:1.0.1')
    await adapter.shutdownAll()
    const intact = adapter.prepareRun(agent, 'full')
    const intactHome = join(root, 'data', 'runtime-v2', intact.identity.key)
    writeFileSync(
      join(intactHome, 'profiles', 'sdk', 'node_modules', 'mindmesh-fixture-plugin', 'index.cjs'),
      'corrupt plugin code'
    )
    writeFileSync(join(intactHome, 'session-marker'), 'must not be copied')
    expect((await materializer.ensure(intact)).created).toBe(true)
    expect(existsSync(join(intactHome, 'session-marker'))).toBe(false)
    // Corrupt a sealed recipe: full must fail without altering desired state; both core modes still run.
    await adapter.shutdownAll()
    adapter = new DeepSeekHarnessAdapter(root, join(root, 'data'), settings, set)
    const before = set.snapshot()
    const artifactFile = join(before.artifact!.directory, 'package.json')
    const saved = readFileSync(artifactFile, 'utf8')
    writeFileSync(artifactFile, 'corrupt')
    const broken = adapter.prepareRun({ ...agent, persona: 'new home' }, 'full')
    await expect(
      adapter.run(agent, 'broken', undefined, undefined, [], broken)
    ).rejects.toMatchObject({ kind: 'materialization' })
    expect(
      JSON.parse(
        readFileSync(
          join(root, 'data', 'runtime-v2', broken.identity.key, 'materialization-failure.json'),
          'utf8'
        )
      ).kind
    ).toBe('materialization')
    expect(set.snapshot()).toEqual(before)
    for (const permission of ['chat', 'workspace'] as const) {
      const core = adapter.prepareRun(agent, permission)
      expect(
        (await adapter.run(agent, 'core still works', undefined, undefined, [], core)).text
      ).toBe('core-without-plugin')
      const coreHome = join(root, 'data', 'runtime-v2', core.identity.key)
      expect(
        existsSync(join(coreHome, 'profiles', 'sdk', 'node_modules', 'mindmesh-fixture-plugin'))
      ).toBe(false)
      expect((await materializer.ensure(core)).created).toBe(false)
    }
    writeFileSync(artifactFile, saved)
    expect((await adapter.run(agent, 'retry', undefined, undefined, [], broken)).text).toContain(
      'fixture:1.0.1'
    )
    await manager.change({ kind: 'remove', packageName: 'mindmesh-fixture-plugin' })
    const removed = adapter.prepareRun(agent, 'full')
    expect(removed.plugins).toBeUndefined()
    expect((await adapter.run(agent, 'removed', undefined, undefined, [], removed)).text).toBe(
      'core-without-plugin'
    )
  } finally {
    await adapter.shutdownAll()
    db.close()
    await registry.close()
    await model.close()

    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) {
      // biome-ignore lint/correctness/noUnsafeFinally: Refuse recursive cleanup outside the verified temporary directory, even after an earlier failure.
      throw new Error('Unsafe fixture cleanup')
    }
    rmSync(root, { recursive: true, force: true })
  }
}, 240_000)
