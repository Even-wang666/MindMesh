import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { getDshRuntimeInfo } from '../src/main/dsh-runtime'
import { prepareAgentCapabilities, toolCatalog } from '../src/main/capabilities'
import type { Agent } from '../src/shared/contracts'
// @ts-expect-error The standalone Node verification script is intentionally JavaScript.
import * as runtimeDependencies from '../scripts/runtime-dependencies.mjs'

const { inspectRuntimeDependencies, resolvePackageManifest } = runtimeDependencies

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'mindmesh-dsh-upgrade-'))
}
function cleanup(directory: string): void {
  if (!resolve(directory).startsWith(resolve(tmpdir()) + sep))
    throw new Error('Unexpected test directory')
  rmSync(directory, { recursive: true, force: true })
}
function manifest(directory: string, value: Record<string, unknown>): string {
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'package.json')
  writeFileSync(path, JSON.stringify(value))
  return path
}

describe('DSH upgrade gates', () => {
  it('reads the installed version and bin from the actual runtime package', () => {
    const expected = JSON.parse(
      readFileSync(
        join(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
        'utf8'
      )
    )
    expect(getDshRuntimeInfo().version).toBe(expected.version)
    expect(readFileSync(getDshRuntimeInfo().dshBin, 'utf8')).toContain('node')
  })

  it('uses the bundled runtime version instead of the development dependency', () => {
    const directory = temporaryDirectory()
    try {
      const runtime = join(directory, 'app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh')
      manifest(runtime, { name: '@deepseek-ai/dsh', version: '9.8.7' })
      expect(getDshRuntimeInfo(directory)).toEqual({
        version: '9.8.7',
        dshBin: join(runtime, 'lib', 'bin.js'),
      })
      manifest(runtime, { name: 'wrong-package', version: '9.8.7' })
      expect(() => getDshRuntimeInfo(directory)).toThrow('manifest')
      rmSync(join(runtime, 'package.json'))
      expect(() => getDshRuntimeInfo(directory)).toThrow()
    } finally {
      cleanup(directory)
    }
  })

  it('resolves exports-restricted packages without treating nested manifests as packages', () => {
    const directory = temporaryDirectory()
    try {
      const entry = manifest(directory, { name: 'fixture', version: '1.0.0' })
      const dependency = join(directory, 'node_modules', 'import-only')
      manifest(dependency, {
        name: 'import-only',
        version: '1.0.0',
        exports: { import: './dist/index.js' },
      })
      manifest(join(dependency, 'dist'), { type: 'module' })
      expect(resolvePackageManifest('import-only', entry)).toBe(join(dependency, 'package.json'))
    } finally {
      cleanup(directory)
    }
  })

  it('fails required missing and incompatible peers while recording missing optional peers', () => {
    const directory = temporaryDirectory()
    try {
      const entry = manifest(directory, {
        name: 'fixture',
        version: '1.0.0',
        dependencies: { missing: '^1.0.0', peer: '^3.0.0' },
        peerDependencies: { peer: '^2.0.0', optional: '^1.0.0' },
        peerDependenciesMeta: { optional: { optional: true } },
      })
      manifest(join(directory, 'node_modules', 'peer'), { name: 'peer', version: '1.0.0' })
      const graph = inspectRuntimeDependencies([entry])
      expect(graph.errors).toHaveLength(3)
      expect(graph.errors.join('\n')).toContain('installed 1.0.0')
      expect(graph.optionalMissing).toEqual(['fixture@1.0.0 -> optional@^1.0.0'])
    } finally {
      cleanup(directory)
    }
  })

  it('never resolves a missing packaged dependency from outside the distribution', () => {
    const directory = temporaryDirectory()
    try {
      manifest(join(directory, 'node_modules', 'outside'), { name: 'outside', version: '1.0.0' })
      const packaged = join(directory, 'release', 'node_modules')
      mkdirSync(packaged, { recursive: true })
      const entry = join(packaged, '__check__.cjs')
      expect(resolvePackageManifest('outside', entry)).toBeDefined()
      expect(resolvePackageManifest('outside', entry, packaged)).toBeUndefined()
    } finally {
      cleanup(directory)
    }
  })

  it('requires optional native payloads that are installed on the packaging platform', () => {
    const directory = temporaryDirectory()
    try {
      const local = manifest(directory, {
        name: 'fixture',
        version: '1.0.0',
        optionalDependencies: { native: '1.0.0' },
      })
      manifest(join(directory, 'node_modules', 'native'), { name: 'native', version: '1.0.0' })
      const installed = inspectRuntimeDependencies([local])
      const packaged = join(directory, 'release', 'node_modules')
      const entry = manifest(join(packaged, 'fixture'), {
        name: 'fixture',
        version: '1.0.0',
        optionalDependencies: { native: '1.0.0' },
      })
      expect(inspectRuntimeDependencies([entry], packaged).errors).toEqual([])
      expect(
        inspectRuntimeDependencies([entry], packaged, installed.installedOptional).errors
      ).toEqual(['fixture@1.0.0 -> native@1.0.0'])
      manifest(join(packaged, 'native'), { name: 'native', version: '1.0.0' })
      expect(
        inspectRuntimeDependencies([entry], packaged, installed.installedOptional).errors
      ).toEqual([])
    } finally {
      cleanup(directory)
    }
  })

  it.each(['chat', 'workspace', 'full'] as const)(
    'composes the real SDK profile with the %s tool ceiling',
    (permission) => {
      const directory = temporaryDirectory()
      try {
        const tools =
          permission === 'chat'
            ? []
            : toolCatalog
                .map((tool) => tool.name)
                .filter((name) => permission === 'full' || name !== 'Shell')
        // Browser is inserted through MCP; its actual startup is covered by the separate browser smoke.
        const agent: Agent = {
          id: 'gate',
          name: 'Gate',
          role: '',
          persona: '',
          provider: 'deepseek-official',
          model: 'deepseek-v4-flash',
          skills: [],
          tools: tools.filter((tool) => tool !== '浏览器'),
          createdAt: '',
        }
        const home = join(directory, 'home')
        const patch = prepareAgentCapabilities(agent, directory, home)
        const output = execFileSync(
          process.execPath,
          [getDshRuntimeInfo().dshBin, '--profile', 'sdk', '--patch', patch, '--dump-config'],
          {
            env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DSH_HOME: home },
            encoding: 'utf8',
            timeout: 30_000,
          }
        )
        const rows = parse(output, {
          customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
        }) as Array<{ id: string; disabled?: boolean | string }>
        const enabled = rows
          .filter((row) => row.id.startsWith('tool-') && row.disabled !== true)
          .map((row) => row.id)
        // tool-result-pruner is a compaction service, not a model-callable tool.
        const active = enabled.filter((id) => id !== 'tool-result-pruner')
        expect(rows.find((row) => row.id === 'tool-plugin-manager')?.disabled).toBe(true)
        expect(rows.find((row) => row.id === 'tool-ralph')?.disabled).toBe(true)
        if (permission === 'chat') expect(active).toEqual([])
        else {
          expect(active).toContain('tool-fs')
          expect(active).toContain('tool-web')
          expect(active).toContain('tool-subagent')
          expect(active.includes('tool-pwsh')).toBe(
            permission === 'full' && process.platform === 'win32'
          )
          expect(active.includes('tool-bash')).toBe(
            permission === 'full' && process.platform !== 'win32'
          )
        }
      } finally {
        cleanup(directory)
      }
    },
    30_000
  )
})
