import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { expect, test } from 'vitest'
import { pluginHomeDigest } from '../src/main/plugins/plugin-runtime'

test('reusing a Home detects aliases redirected to another installed version', () => {
  const home = mkdtempSync(join(tmpdir(), 'mindmesh-plugin-integrity-'))
  const profile = join(home, 'profiles', 'sdk'), modules = join(profile, 'node_modules')
  try {
    for (const version of ['one', 'two']) {
      const directory = join(modules, '.pnpm', version)
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'index.cjs'), `module.exports = '${version}'`)
    }
    for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml']) writeFileSync(join(profile, name), 'sealed')
    const alias = join(modules, 'plugin')
    symlinkSync(join(modules, '.pnpm', 'one'), alias, 'junction')
    const original = pluginHomeDigest(home)
    writeFileSync(join(home, 'session'), 'runtime state is outside composition')
    expect(pluginHomeDigest(home)).toBe(original)
    unlinkSync(alias)
    symlinkSync(join(modules, '.pnpm', 'two'), alias, 'junction')
    expect(pluginHomeDigest(home)).not.toBe(original)
  } finally {
    if (!resolve(home).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe integrity cleanup')
    rmSync(home, { recursive: true, force: true })
  }
})
