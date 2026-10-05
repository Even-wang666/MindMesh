import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { create } from 'tar'
import { expect, test, vi } from 'vitest'
import { MindMeshDatabase } from '../src/main/database'
import { MarketplaceCatalogService } from '../src/main/marketplace'
import { PluginSetManager } from '../src/main/plugins/plugin-set'
import { PluginManager, PluginStaging } from '../src/main/plugins/plugin-manager'
import { PluginMarketplaceService } from '../src/main/plugins/plugin-marketplace'
import { pluginSourceArchive } from '../src/main/plugins/plugin-sources'

test('GitHub source at exact commit installs only after real SDK boot; rejected imports leave the old set untouched', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mindmesh-plugin-github-'))
  const db = new MindMeshDatabase(join(root, 'db.sqlite'))
  const data = join(root, 'data')
  const manager = new PluginManager(
    new PluginSetManager(db),
    new PluginStaging(data, undefined, undefined, {
      directory: join(root, 'package-cache'),
      offline: false,
    })
  )
  const catalog = new MarketplaceCatalogService(data)
  const service = new PluginMarketplaceService(data, catalog, manager)
  let commit = 'a'.repeat(40),
    mode = 'valid'
  const fetchMock = vi.fn(async (input: string) => {
    if (input === 'https://api.github.com/repos/acme/plugin')
      return new Response(JSON.stringify({ default_branch: 'main' }))
    if (input.startsWith('https://api.github.com/repos/acme/plugin/commits/'))
      return new Response(JSON.stringify({ sha: commit }))
    if (input.startsWith('https://codeload.github.com/acme/plugin/tar.gz/')) {
      const source = join(root, `source-${commit}`)
      mkdirSync(source, { recursive: true })
      writeFileSync(
        join(source, 'package.json'),
        JSON.stringify({
          name: 'github-test-plugin',
          version: '1.0.0',
          main: 'index.cjs',
          dsh: { bundle: { patch: './cordis.patch.yml' } },
          ...(mode === 'peer' ? { peerDependencies: { '@deepseek-ai/dsh': '0.1.5' } } : {}),
        })
      )
      writeFileSync(
        join(source, 'cordis.patch.yml'),
        '- insert:\n    - id: github-test\n      name: github-test-plugin\n'
      )
      writeFileSync(
        join(source, 'index.cjs'),
        mode === 'boot'
          ? "exports.apply=()=>{throw new Error('github startup failure')}"
          : 'exports.apply=()=>{}'
      )
      const archive = join(root, `archive-${commit}.tgz`)
      await create({ file: archive, gzip: true, cwd: source, prefix: 'repo' }, ['.'])
      return new Response(readFileSync(archive))
    }
    throw new Error(`Unexpected request: ${input}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  const request = () => ({ requestId: randomUUID(), url: 'https://github.com/acme/plugin' })
  try {
    const result = await service.importGitHub(request())
    expect(result.phase, result.diagnostics).toBe('succeeded')
    expect(result.message).toContain('验证通过，安装完成')
    let installed = manager.snapshot()
    expect(installed.plugins[0].version).toBe(`1.0.0+github.${commit}`)
    expect(
      pluginSourceArchive(data, 'github-test-plugin', installed.plugins[0].version)
    ).toBeTruthy()
    await manager.change({ kind: 'disable', packageName: 'github-test-plugin' })
    installed = manager.snapshot()
    commit = 'b'.repeat(40)
    mode = 'peer'
    const mismatch = await service.importGitHub(request())
    expect(mismatch.phase).toBe('failed')
    expect(mismatch.message).toContain('@deepseek-ai/dsh 要求 0.1.5，当前 0.2.0-rc.2')
    expect(manager.snapshot()).toEqual(installed)
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, options: { signal: AbortSignal }) =>
          new Promise((_done, reject) => {
            options.signal.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            })
          })
      )
    )
    const cancelledRequest = request()
    const pending = service.importGitHub(cancelledRequest)
    expect(() => service.importGitHub(request())).toThrow('正在进行')
    expect(service.cancel(cancelledRequest.requestId)).toBe(true)
    expect((await pending).phase).toBe('cancelled')
    expect(manager.snapshot()).toEqual(installed)
    vi.stubGlobal('fetch', fetchMock)
    commit = 'c'.repeat(40)
    mode = 'boot'
    expect((await service.importGitHub(request())).phase).toBe('failed')
    expect(manager.snapshot()).toEqual(installed)
    expect(
      (await service.importGitHub({ ...request(), url: 'http://127.0.0.1/repo' })).message
    ).toContain('公开的 GitHub HTTPS')
    expect(manager.snapshot()).toEqual(installed)
  } finally {
    await service.shutdown()
    db.close()
    vi.unstubAllGlobals()
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)
