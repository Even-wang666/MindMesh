import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startPluginFixtureRegistry } from '../scripts/plugin-fixture-registry.mjs'
import { expect, test } from 'vitest'
import { MindMeshDatabase } from '../src/main/database'
import { PluginSetManager } from '../src/main/plugins/plugin-set'
import { PluginManager, PluginStaging } from '../src/main/plugins/plugin-manager'

test('real exact install, full-set boot, disable/enable/update/remove and rejection preserve desired state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mindmesh-staging-'))
  const registry = await startPluginFixtureRegistry(root)
  const db = new MindMeshDatabase(join(root, 'db.sqlite'))
  try {
    const manager = new PluginManager(new PluginSetManager(db), new PluginStaging(join(root, 'data'), undefined, registry.url))
    const installed = await manager.change({ kind: 'install', packageName: 'mindmesh-fixture-plugin', version: '1.0.0' })
    expect(installed.generation).toBe(1)
    expect(readFileSync(join(installed.artifact!.directory, 'pnpm-lock.yaml'), 'utf8')).toContain('1.0.0')
    for (const version of ['2.0.0', '3.0.0', '4.0.0', '5.0.0', '6.0.0', '7.0.0']) {
      await expect(manager.change({ kind: 'update', packageName: 'mindmesh-fixture-plugin', version })).rejects.toThrow(/polluted|compatibility|build script|SDK|exited|conflict/)
      expect(manager.snapshot()).toEqual(installed)
    }
    expect(existsSync(join(root, 'script-ran'))).toBe(false)
    await expect(manager.change({ kind: 'install', packageName: 'mindmesh-fixture-conflict', version: '1.0.0' })).rejects.toThrow(/conflict|compatibility|exited/)
    expect(manager.snapshot()).toEqual(installed)
    const activeAbort = new AbortController()
    const active = manager.change({ kind: 'update', packageName: 'mindmesh-fixture-plugin', version: '1.0.1' }, activeAbort.signal)
    setTimeout(() => activeAbort.abort(), 100)
    await expect(active).rejects.toThrow(/cancelled|aborted/)
    expect(manager.snapshot()).toEqual(installed)
    const abort = new AbortController(); abort.abort()
    await expect(manager.change({ kind: 'disable', packageName: 'mindmesh-fixture-plugin' }, abort.signal)).rejects.toThrow()
    expect(manager.snapshot()).toEqual(installed)
    const dependent = await manager.change({ kind: 'install', packageName: 'mindmesh-fixture-peer', version: '1.0.0' })
    for (const kind of ['remove', 'disable'] as const) {
      await expect(manager.change({ kind, packageName: 'mindmesh-fixture-plugin' })).rejects.toThrow(/peer conflict/)
      expect(manager.snapshot()).toEqual(dependent)
    }
    await manager.change({ kind: 'remove', packageName: 'mindmesh-fixture-peer' })
    const [disabled, enabled] = await Promise.all([
      manager.change({ kind: 'disable', packageName: 'mindmesh-fixture-plugin' }),
      manager.change({ kind: 'enable', packageName: 'mindmesh-fixture-plugin' }),
    ])
    expect(disabled.plugins[0].enabled).toBe(false)
    expect(enabled.plugins[0].enabled).toBe(true)
    expect(enabled.generation).toBe(disabled.generation + 1)
    expect((await manager.change({ kind: 'update', packageName: 'mindmesh-fixture-plugin', version: '1.0.1' })).plugins[0].version).toBe('1.0.1')
    expect((await manager.change({ kind: 'remove', packageName: 'mindmesh-fixture-plugin' })).plugins).toEqual([])
  } finally {
    db.close(); await registry.close()
    const checked = join(tmpdir(), root.slice(tmpdir().length)).replaceAll('\\', '/')
    if (!checked.includes('/mindmesh-staging-')) throw new Error('Unexpected fixture path')
    rmSync(root, { recursive: true, force: true })
  }
}, 240_000)
