import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { getDshRuntimeInfo } from '../src/main/dsh-runtime'
import { getRuntimeIdentity, type RuntimeRequest } from '../src/main/runtime-revision'
import { DshCliRunner } from '../src/main/plugins/dsh-cli-runner'
import { materializePlugins } from '../src/main/plugins/plugin-runtime'

test('rejects malformed sealed capability YAML before running package installation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mindmesh-plugin-yaml-'))
  const artifactDirectory = join(root, 'plugin-artifacts', 'fixture')
  mkdirSync(artifactDirectory, { recursive: true })
  const runtime = getDshRuntimeInfo()
  const run = vi.spyOn(DshCliRunner.prototype, 'run').mockRejectedValue(new Error('CLI sentinel'))
  const cases = [
    'null',
    '[]',
    '- id: skill-filesystem',
    '- config: {}',
    '- id: skill-filesystem\n  config:\n    customSkillDirs: [42]',
    '- id: skill-filesystem\n  config:\n    customSkillDirs: [relative/skills]',
    '- id: skill-filesystem\n  config:\n    customSkillDirs: [',
  ]
  try {
    for (const patch of [
      ...cases,
      '- id: skill-filesystem\n  config:\n    customSkillDirs: ["<STAGING_HOME>/selected-skills"]',
    ]) {
      const files = {
        'dump-config.yml': '[]',
        'capabilities.patch.yml': patch,
        'package.json': '{}',
        'pnpm-lock.yaml': 'fixture',
        'pnpm-workspace.yaml': 'fixture',
        'cordis.patch.yml': '[]',
        'composition.json': JSON.stringify({
          revision: 'fixture',
          runtimeVersion: runtime.version,
          pnpmVersion: '11.7.0',
          registry: 'http://127.0.0.1:65534/',
          enabled: [],
        }),
      }
      for (const [name, content] of Object.entries(files))
        writeFileSync(join(artifactDirectory, name), content)
      const request: RuntimeRequest = {
        agent: {
          id: 'fixture',
          name: 'Fixture',
          persona: '',
          role: '',
          provider: 'custom',
          model: 'fixture',
          skills: [],
          tools: [],
          createdAt: '',
        },
        workspace: root,
        providers: [],
        skillIds: [],
        dshBin: runtime.dshBin,
        identity: getRuntimeIdentity({
          baseHash: 'fixture',
          workspace: root,
          permission: 'full',
          providerRevision: 'fixture',
          skillRevision: '',
          dshVersion: runtime.version,
        }),
        plugins: {
          revision: 'fixture',
          desiredRevision: 'fixture',
          packages: [],
          artifact: {
            revision: 'fixture',
            directory: artifactDirectory,
            digest: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
          },
        },
      }
      run.mockClear()
      await expect(materializePlugins(root, join(root, 'home'), request)).rejects.toThrow(
        cases.includes(patch) ? '重新验证插件' : 'CLI sentinel'
      )
      expect(run).toHaveBeenCalledTimes(cases.includes(patch) ? 0 : 1)
    }
  } finally {
    run.mockRestore()
    rmSync(root, { recursive: true, force: true })
  }
})
