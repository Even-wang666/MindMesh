import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { c as createTar } from 'tar'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import type { Agent } from '../src/shared/contracts'
import { createSkillReference } from '../src/shared/skill-reference'
import { prepareAgentCapabilities } from '../src/main/capabilities'
import {
  installSkillBundle,
  installSkillFromGitHub,
  listSkillCatalog,
  seedBundledSkills,
} from '../src/main/skills'

const agent: Agent = {
  id: 'researcher',
  name: 'Researcher',
  role: '',
  persona: '研究员',
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  skills: ['研究分析'],
  tools: ['文件'],
  createdAt: '',
}

describe('Harness capability binding', () => {
  it('seeds versioned built-ins, parses YAML, and reports invalid bundles', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-capabilities-'))
    const bundled = mkdtempSync(join(tmpdir(), 'mindmesh-bundled-skills-'))
    try {
      writeFileSync(
        join(bundled, 'manifest.json'),
        JSON.stringify({ version: 1, skills: ['research'] })
      )
      const builtIn = join(bundled, 'research')
      mkdirSync(builtIn, { recursive: true })
      writeFileSync(
        join(builtIn, 'SKILL.md'),
        [
          '---',
          'name: research',
          'description: >',
          '  第一行',
          '  第二行',
          'metadata:',
          '  mindmesh.displayName: 研究分析',
          '---',
          '',
          '执行研究。',
          '',
        ].join('\n')
      )
      seedBundledSkills(bundled, directory)
      expect(readFileSync(join(directory, 'skills', 'research', 'SKILL.md'), 'utf8')).toContain(
        'name: research'
      )

      const custom = join(directory, 'skills', 'custom')
      mkdirSync(custom, { recursive: true })
      writeFileSync(
        join(custom, 'SKILL.md'),
        '---\nname: custom\ndescription: "一项本地技能"\nmetadata:\n  mindmesh.displayName: 自定义技能\n---\n\n执行自定义步骤。\n'
      )
      const invalid = join(directory, 'skills', 'invalid')
      mkdirSync(invalid, { recursive: true })
      writeFileSync(join(invalid, 'SKILL.md'), '---\nname: 中文名\ndescription: 无效技能\n---\n')

      const catalog = listSkillCatalog(directory)
      expect(catalog.find((item) => item.id === 'research')).toMatchObject({
        name: '研究分析',
        description: '第一行 第二行\n',
        status: '已安装',
        available: true,
      })
      expect(catalog.find((item) => item.id === 'custom')).toMatchObject({
        name: '自定义技能',
        description: '一项本地技能',
        status: '已安装',
        available: true,
      })
      expect(catalog.find((item) => item.id === 'invalid')).toMatchObject({
        status: '不可用',
        available: false,
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
      rmSync(bundled, { recursive: true, force: true })
    }
  })

  it('copies complete selected bundles into an isolated launch patch', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-capabilities-bundle-'))
    try {
      const research = join(directory, 'skills', 'research')
      mkdirSync(research, { recursive: true })
      writeFileSync(
        join(research, 'SKILL.md'),
        '---\nname: research\ndescription: 研究资料\nmetadata:\n  mindmesh.displayName: 研究分析\n---\n\n执行研究。\n'
      )
      writeFileSync(join(research, 'REFERENCE.md'), '完整 bundle 资源')
      const home = join(directory, 'harness', 'one')
      const path = prepareAgentCapabilities(agent, directory, home)
      const patch = readFileSync(path, 'utf8')
      expect(patch).toContain('includeDefaultRoots: false')
      expect(patch).toMatch(/id: tool-fs\n  disabled: false/)
      expect(patch).toMatch(/id: tool-web\n  disabled: true/)
      expect(patch).toMatch(/id: tool-pwsh\n  disabled: true/)
      expect(patch).toMatch(/id: tool-todo\n  disabled: true/)
      expect(patch).toMatch(/id: tool-goal\n  disabled: true/)
      expect(patch).toMatch(/id: tool-jobs\n  disabled: true/)
      expect(patch).toMatch(/id: tool-subagent\n  disabled: true/)
      expect(patch).toMatch(/id: tool-workflow\n  disabled: true/)
      expect(patch).not.toContain('mindmesh-browser')
      expect(readFileSync(join(home, 'selected-skills', 'research', 'SKILL.md'), 'utf8')).toContain(
        'name: research'
      )
      expect(readFileSync(join(home, 'selected-skills', 'research', 'REFERENCE.md'), 'utf8')).toBe(
        '完整 bundle 资源'
      )
      prepareAgentCapabilities({ ...agent, skills: [] }, directory, home)
      expect(existsSync(join(home, 'selected-skills', 'research'))).toBe(false)
      expect(() =>
        prepareAgentCapabilities({ ...agent, skills: ['未安装技能'] }, directory, home)
      ).toThrow('未安装')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('enables subagent tools only when explicitly selected', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-capabilities-subagent-'))
    try {
      const path = prepareAgentCapabilities(
        { ...agent, skills: [], tools: ['子代理'] },
        directory,
        join(directory, 'harness')
      )
      const patch = readFileSync(path, 'utf8')
      for (const id of [
        'tool-subagent-control',
        'tool-subagent-list-agents',
        'tool-subagent',
        'tool-subagent-fork',
        'tool-workflow',
      ]) {
        expect(patch).toMatch(new RegExp(`id: ${id}\\n  disabled: false`))
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('parses all repository Agent Skills samples without changing them', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-skill-samples-'))
    try {
      cpSync(join(process.cwd(), '.codex', 'skills'), join(directory, 'skills'), {
        recursive: true,
      })
      const catalog = listSkillCatalog(directory)
      expect(catalog).toHaveLength(31)
      expect(catalog.every((item) => item.available)).toBe(true)
      expect(catalog.find((item) => item.id === 'ponytail')?.description).toContain(
        'Forces the laziest solution'
      )
      expect(catalog.find((item) => item.id === 'ponytail')?.manifest?.argumentHint).toBe(
        '[lite|full|ultra]'
      )
      expect(catalog.filter((item) => item.status === '仅手动调用')).toHaveLength(14)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('ships ten valid built-in skill bundles', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-builtins-'))
    try {
      seedBundledSkills(join(process.cwd(), 'resources', 'skills'), directory)
      const catalog = listSkillCatalog(directory)
      expect(catalog).toHaveLength(10)
      expect(catalog.every((item) => item.available)).toBe(true)
      expect(
        catalog.find((item) => item.id === 'mindmesh-builtin-workout-planner-v1')
      ).toMatchObject({
        name: '训练计划',
        source: 'MindMesh 内置',
        integrity: 'verified',
        license: 'MIT',
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('installs and upgrades a complete local bundle with a trusted receipt', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-install-target-'))
    const sourceRoot = mkdtempSync(join(tmpdir(), 'mindmesh-install-source-'))
    const source = join(sourceRoot, 'sample')
    try {
      mkdirSync(source)
      writeFileSync(
        join(source, 'SKILL.md'),
        '---\nname: sample\ndescription: Sample skill\nlicense: See LICENSE.txt\n---\n\nfirst\n'
      )
      writeFileSync(join(source, 'template.txt'), 'template')
      expect(installSkillBundle(source, directory)).toMatchObject({
        id: 'sample',
        available: true,
        source: '本地导入：sample',
        integrity: 'verified',
        licenseSpdx: false,
      })
      const installed = join(directory, 'skills', 'sample')
      expect(readFileSync(join(installed, 'template.txt'), 'utf8')).toBe('template')
      expect(
        JSON.parse(readFileSync(join(installed, '.mindmesh-install.json'), 'utf8'))
      ).toMatchObject({
        source: { kind: 'local', path: source },
      })

      writeFileSync(
        join(source, 'SKILL.md'),
        '---\nname: sample\ndescription: Updated skill\nlicense: AGPL-3.0-only\n---\n\nsecond\n'
      )
      installSkillBundle(source, directory)
      expect(listSkillCatalog(directory).find((item) => item.id === 'sample')).toMatchObject({
        description: 'Updated skill',
        licenseSpdx: true,
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
      rmSync(sourceRoot, { recursive: true, force: true })
    }
  })

  it('installs a GitHub skill directory at a resolved commit with trusted provenance', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-github-target-'))
    const archiveSource = mkdtempSync(join(tmpdir(), 'mindmesh-github-archive-'))
    const commit = 'a'.repeat(40)
    try {
      const skill = join(archiveSource, `skills-${commit}`, 'catalog', 'sample')
      mkdirSync(skill, { recursive: true })
      writeFileSync(
        join(skill, 'SKILL.md'),
        '---\nname: sample\ndescription: GitHub sample\nlicense: MIT\n---\n'
      )
      writeFileSync(join(skill, 'REFERENCE.md'), 'downloaded resource')
      const archivePath = join(archiveSource, 'repository.tar.gz')
      createTar({ cwd: archiveSource, file: archivePath, gzip: true, sync: true }, [
        `skills-${commit}`,
      ])
      const archive = readFileSync(archivePath)
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input)
        if (url.startsWith('https://api.github.com/')) {
          return new Response(JSON.stringify({ sha: commit }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response(archive, {
          status: 200,
          headers: { 'content-length': String(archive.length) },
        })
      })
      const progress: Array<{ phase: string; receivedBytes?: number; totalBytes?: number }> = []

      const installed = await installSkillFromGitHub(
        'https://github.com/acme/skills/tree/main/catalog/sample',
        directory,
        (event) => progress.push(event)
      )

      expect(installed).toMatchObject({
        id: 'sample',
        source: `GitHub：acme/skills@${commit.slice(0, 7)}`,
        integrity: 'verified',
        license: 'MIT',
        licenseSpdx: true,
      })
      expect(readFileSync(join(directory, 'skills', 'sample', 'REFERENCE.md'), 'utf8')).toBe(
        'downloaded resource'
      )
      expect(
        JSON.parse(
          readFileSync(join(directory, 'skills', 'sample', '.mindmesh-install.json'), 'utf8')
        )
      ).toMatchObject({
        source: {
          kind: 'github',
          repository: 'acme/skills',
          commit,
          path: 'catalog/sample',
          url: 'https://github.com/acme/skills/tree/main/catalog/sample',
        },
        license: { declared: 'MIT', spdx: 'MIT' },
      })
      expect(
        progress
          .map((event) => event.phase)
          .filter((phase, index, phases) => phase !== phases[index - 1])
      ).toEqual(['resolving', 'downloading', 'extracting', 'installing', 'done'])
      expect(progress.filter((event) => event.phase === 'downloading').at(-1)).toMatchObject({
        receivedBytes: archive.length,
        totalBytes: archive.length,
      })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.restoreAllMocks()
      rmSync(directory, { recursive: true, force: true })
      rmSync(archiveSource, { recursive: true, force: true })
    }
  })

  it('rejects non-GitHub and non-directory GitHub URLs before downloading', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-github-invalid-'))
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    try {
      await expect(
        installSkillFromGitHub('https://example.com/acme/skills', directory)
      ).rejects.toThrow('GitHub')
      await expect(
        installSkillFromGitHub('https://github.com/acme/skills/blob/main/SKILL.md', directory)
      ).rejects.toThrow('目录')
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('resolves a GitHub branch containing slashes before locating the skill directory', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-github-branch-target-'))
    const archiveSource = mkdtempSync(join(tmpdir(), 'mindmesh-github-branch-archive-'))
    const commit = 'c'.repeat(40)
    try {
      const skill = join(archiveSource, `skills-${commit}`, 'catalog', 'sample')
      mkdirSync(skill, { recursive: true })
      writeFileSync(join(skill, 'SKILL.md'), '---\nname: sample\ndescription: Slash branch\n---\n')
      const archivePath = join(archiveSource, 'repository.tar.gz')
      createTar({ cwd: archiveSource, file: archivePath, gzip: true, sync: true }, [
        `skills-${commit}`,
      ])
      const archive = readFileSync(archivePath)
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input)
        if (url.endsWith('/commits/feature')) return new Response('', { status: 404 })
        if (url.endsWith('/commits/feature%2Ffoo'))
          return new Response(JSON.stringify({ sha: commit }), { status: 200 })
        return new Response(archive, { status: 200 })
      })

      await installSkillFromGitHub(
        'https://github.com/acme/skills/tree/feature/foo/catalog/sample',
        directory
      )

      expect(
        JSON.parse(
          readFileSync(join(directory, 'skills', 'sample', '.mindmesh-install.json'), 'utf8')
        )
      ).toMatchObject({ source: { commit, path: 'catalog/sample' } })
    } finally {
      vi.restoreAllMocks()
      rmSync(directory, { recursive: true, force: true })
      rmSync(archiveSource, { recursive: true, force: true })
    }
  })

  it('rejects an oversized GitHub archive before extraction', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-github-large-'))
    const commit = 'b'.repeat(40)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).startsWith('https://api.github.com/')) {
        return new Response(JSON.stringify({ sha: commit }), { status: 200 })
      }
      return new Response('', {
        status: 200,
        headers: { 'content-length': String(32 * 1024 * 1024 + 1) },
      })
    })
    try {
      await expect(
        installSkillFromGitHub('https://github.com/acme/skills/tree/main/sample', directory)
      ).rejects.toThrow('32 MiB')
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.restoreAllMocks()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects legacy invocation keys and oversized bundles with diagnostics', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-invalid-skills-'))
    try {
      const legacy = join(directory, 'skills', 'legacy')
      mkdirSync(legacy, { recursive: true })
      writeFileSync(
        join(legacy, 'SKILL.md'),
        '---\nname: legacy\ndescription: Legacy\ndisableModelInvocation: true\n---\n'
      )
      const huge = join(directory, 'skills', 'huge')
      mkdirSync(huge, { recursive: true })
      writeFileSync(join(huge, 'SKILL.md'), '---\nname: huge\ndescription: Huge\n---\n')
      for (let index = 0; index < 512; index += 1) writeFileSync(join(huge, `${index}.txt`), '')

      const catalog = listSkillCatalog(directory)
      expect(catalog.find((item) => item.id === 'legacy')).toMatchObject({
        available: false,
        diagnostic: expect.stringContaining('disableModelInvocation'),
      })
      expect(catalog.find((item) => item.id === 'huge')).toMatchObject({
        available: false,
        diagnostic: expect.stringContaining('512 个文件'),
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not overwrite unowned installs or a new built-in name collision', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-owned-skills-'))
    const sourceRoot = mkdtempSync(join(tmpdir(), 'mindmesh-owned-source-'))
    const bundled = mkdtempSync(join(tmpdir(), 'mindmesh-owned-bundled-'))
    try {
      const source = join(sourceRoot, 'sample')
      mkdirSync(source)
      writeFileSync(join(source, 'SKILL.md'), '---\nname: sample\ndescription: First\n---\n')
      installSkillBundle(source, directory)
      writeFileSync(join(directory, 'skills', 'sample', '.mindmesh-install.json'), '{broken')
      writeFileSync(join(source, 'SKILL.md'), '---\nname: sample\ndescription: Second\n---\n')
      expect(() => installSkillBundle(source, directory)).toThrow('来源不明')
      expect(listSkillCatalog(directory).find((item) => item.id === 'sample')?.description).toBe(
        'First'
      )

      const original = join(bundled, 'original')
      mkdirSync(original)
      writeFileSync(join(original, 'SKILL.md'), '---\nname: original\ndescription: Original\n---\n')
      writeFileSync(
        join(bundled, 'manifest.json'),
        JSON.stringify({ version: 1, skills: ['original'] })
      )
      const existingOriginal = join(directory, 'skills', 'original')
      mkdirSync(existingOriginal)
      writeFileSync(
        join(existingOriginal, 'SKILL.md'),
        '---\nname: original\ndescription: User original\n---\n'
      )
      seedBundledSkills(bundled, directory)
      expect(listSkillCatalog(directory).find((item) => item.id === 'original')?.description).toBe(
        'User original'
      )
      const collision = join(directory, 'skills', 'new-name')
      mkdirSync(collision)
      writeFileSync(
        join(collision, 'SKILL.md'),
        '---\nname: new-name\ndescription: User owned\n---\n'
      )
      const newBuiltIn = join(bundled, 'new-name')
      mkdirSync(newBuiltIn)
      writeFileSync(
        join(newBuiltIn, 'SKILL.md'),
        '---\nname: new-name\ndescription: Bundled\n---\n'
      )
      writeFileSync(
        join(bundled, 'manifest.json'),
        JSON.stringify({ version: 2, skills: ['original', 'new-name'] })
      )

      seedBundledSkills(bundled, directory)
      expect(listSkillCatalog(directory).find((item) => item.id === 'new-name')?.description).toBe(
        'User owned'
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
      rmSync(sourceRoot, { recursive: true, force: true })
      rmSync(bundled, { recursive: true, force: true })
    }
  })

  it('migrates only the exact legacy code-generated built-in without a receipt', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-legacy-seed-'))
    try {
      const legacy = join(directory, 'skills', 'research')
      mkdirSync(legacy, { recursive: true })
      writeFileSync(
        join(legacy, 'SKILL.md'),
        [
          '---',
          'name: 研究分析',
          'description: 整理资料、比较证据并形成结构化结论。',
          '---',
          '',
          'old',
          '',
        ].join('\n')
      )

      seedBundledSkills(join(process.cwd(), 'resources', 'skills'), directory)

      expect(readFileSync(join(legacy, 'SKILL.md'), 'utf8')).toContain('name: research')
      expect(listSkillCatalog(directory).find((item) => item.id === 'research')).toMatchObject({
        source: 'MindMesh 内置',
        integrity: 'verified',
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('inserts Playwright MCP and enables the selected session tools', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-capabilities-browser-'))
    try {
      const home = join(directory, 'harness', 'browser')
      const path = prepareAgentCapabilities(
        {
          ...agent,
          skills: [],
          tools: ['浏览器', '待办清单', '目标管理', '后台任务'],
        },
        directory,
        home
      )
      const patch = readFileSync(path, 'utf8')
      expect(patch).toMatch(/id: tool-todo\n  disabled: false/)
      expect(patch).toMatch(/id: tool-goal\n  disabled: false/)
      expect(patch).toMatch(/id: tool-jobs\n  disabled: false/)
      expect(patch).toContain('- insert:')
      expect(patch).toContain('id: mindmesh-browser')
      expect(patch).toContain("name: '@deepseek-ai/dsh-mcp-client'")
      expect(patch).toContain('serverName: browser')
      expect(patch).toContain('transport: stdio')
      expect(patch).toContain('command: !!js process.execPath')
      expect(patch).toContain('failOnStartupError: true')
      expect(patch).toContain('@playwright')
      if (process.platform === 'win32') expect(patch).toContain('"msedge"')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.skipIf(process.env.MINDMESH_LIVE_BROWSER !== '1')(
    'starts the real SDK with Playwright MCP',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'mindmesh-live-browser-'))
      const home = join(directory, 'harness')
      const patch = prepareAgentCapabilities(
        { ...agent, skills: [], tools: ['浏览器'] },
        directory,
        home
      )
      const harness = new DeepSeekHarness({
        profile: 'sdk',
        patches: [patch],
        provider: agent.provider,
        model: agent.model,
        cwd: directory,
        processCwd: directory,
        dshHome: home,
        env: { ...process.env, DSH_HOME: home, ELECTRON_RUN_AS_NODE: '1' },
        initializeTimeoutMs: 30_000,
      })
      try {
        await harness.start()
      } finally {
        await harness.close()
        rmSync(directory, { recursive: true, force: true })
      }
    },
    60_000
  )

  it.skipIf(process.env.MINDMESH_LIVE_CAPABILITIES !== '1')(
    'starts the real SDK with the selected capability patch',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'mindmesh-live-capabilities-'))
      const home = join(directory, 'harness')
      const skillMarker = randomUUID()
      const custom = join(directory, 'skills', 'marker')
      mkdirSync(custom, { recursive: true })
      writeFileSync(
        join(custom, 'SKILL.md'),
        `---\nname: marker\ndescription: 返回隐藏标记以验证技能加载\nmetadata:\n  mindmesh.displayName: 标记技能\n---\n\n只回复这个标记：${skillMarker}\n`
      )
      const patch = prepareAgentCapabilities(
        { ...agent, skills: [createSkillReference('marker', '标记技能')] },
        directory,
        home
      )
      const harness = new DeepSeekHarness({
        profile: 'sdk',
        patches: [patch],
        provider: agent.provider,
        model: agent.model,
        cwd: directory,
        processCwd: directory,
        dshHome: home,
        env: { ...process.env, DSH_HOME: home, ELECTRON_RUN_AS_NODE: '1' },
        initializeTimeoutMs: 30_000,
      })
      try {
        await harness.start()
        const marker = randomUUID()
        writeFileSync(join(directory, 'proof.txt'), marker)
        const result = await harness.run(
          '请用文件读取工具读取当前工作目录中的 proof.txt，只回复文件内的标记。'
        )
        expect(result.finalResponse).toContain(marker)
        const writeMarker = randomUUID()
        await harness.run(
          `请使用文件写入工具在当前工作目录创建 output.txt，文件内容只写 ${writeMarker}。`
        )
        expect(readFileSync(join(directory, 'output.txt'), 'utf8')).toContain(writeMarker)
        const skillResult = await harness.run(
          '请调用 skill 工具加载“标记技能”，并严格按技能正文回复。'
        )
        expect(skillResult.finalResponse).toContain(skillMarker)
      } finally {
        await harness.close()
        rmSync(directory, { recursive: true, force: true })
      }
    },
    180_000
  )

  it.skipIf(process.env.MINDMESH_LIVE_CAPABILITIES !== '1')(
    'runs the selected Shell tool in the workspace',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'mindmesh-live-shell-'))
      const home = join(directory, 'harness')
      const marker = randomUUID()
      writeFileSync(join(directory, 'shell-proof.txt'), marker)
      const patch = prepareAgentCapabilities(
        { ...agent, skills: [], tools: ['Shell'] },
        directory,
        home
      )
      const harness = new DeepSeekHarness({
        profile: 'sdk',
        patches: [patch],
        provider: agent.provider,
        model: agent.model,
        cwd: directory,
        processCwd: directory,
        dshHome: home,
        env: { ...process.env, DSH_HOME: home, ELECTRON_RUN_AS_NODE: '1' },
        initializeTimeoutMs: 30_000,
      })
      try {
        const result = await harness.run(
          '请用 PowerShell 工具执行 Get-Content shell-proof.txt，然后只回复文件中的标记。'
        )
        expect(result.finalResponse).toContain(marker)
      } finally {
        await harness.close()
        rmSync(directory, { recursive: true, force: true })
      }
    },
    180_000
  )
})
