import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import type { Agent } from '../src/shared/contracts'
import { createSkillReference } from '../src/shared/skill-reference'
import { listSkillCatalog, prepareAgentCapabilities } from '../src/main/capabilities'

const agent: Agent = {
  id: 'researcher', name: 'Researcher', role: '', persona: '研究员',
  provider: 'deepseek-official', model: 'deepseek-v4-flash',
  skills: ['研究分析'], tools: ['文件'], createdAt: '',
}

describe('Harness capability binding', () => {
  it('discovers installed skill files and writes an isolated launch patch', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-capabilities-'))
    try {
      const custom = join(directory, 'skills', 'custom')
      mkdirSync(custom, { recursive: true })
      writeFileSync(join(custom, 'SKILL.md'), '---\nname: 自定义技能\ndescription: 一项本地技能\n---\n\n执行自定义步骤。\n')
      const upstream = join(directory, 'skills', 'workout-planner')
      mkdirSync(upstream, { recursive: true })
      writeFileSync(join(upstream, 'SKILL.md'), '---\nname: 训练计划\ndescription: Existing same-name install\n---\n\n不要使用这个同名技能。\n')
      const catalog = listSkillCatalog(directory)
      expect(catalog.map((item) => item.name)).toEqual(expect.arrayContaining([
        '自定义技能', '项目规划', '用户故事', '学习计划', '语言辅导', '训练计划', '餐单规划', '旅行规划',
      ]))
      expect(readFileSync(catalog.find((item) => item.id === 'mindmesh-builtin-workout-planner-v1')!.path, 'utf8'))
        .toContain('github.com/JayRHa/AgentSkills')
      expect(catalog.filter((item) => item.name === '训练计划')).toHaveLength(2)
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
      expect(patch).not.toContain('mindmesh-browser')
      expect(readFileSync(join(home, 'selected-skills', 'research.md'), 'utf8')).toContain('研究分析')
      prepareAgentCapabilities({ ...agent, skills: [
        createSkillReference('mindmesh-builtin-workout-planner-v1', '训练计划'),
      ] }, directory, home)
      expect(readFileSync(join(home, 'selected-skills', 'mindmesh-builtin-workout-planner-v1.md'), 'utf8')).toContain('渐进规则')
      expect(() => prepareAgentCapabilities({ ...agent, skills: ['训练计划'] }, directory, home))
        .toThrow('有多个版本')
      expect(() => prepareAgentCapabilities({ ...agent, skills: ['未安装技能'] }, directory, home)).toThrow('未安装')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('inserts Playwright MCP and enables the selected session tools', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-capabilities-browser-'))
    try {
      const home = join(directory, 'harness', 'browser')
      const path = prepareAgentCapabilities({
        ...agent, skills: [], tools: ['浏览器', '待办清单', '目标管理', '后台任务'],
      }, directory, home)
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

  it.skipIf(process.env.MINDMESH_LIVE_BROWSER !== '1')('starts the real SDK with Playwright MCP', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-live-browser-'))
    const home = join(directory, 'harness')
    const patch = prepareAgentCapabilities({ ...agent, skills: [], tools: ['浏览器'] }, directory, home)
    const harness = new DeepSeekHarness({
      profile: 'sdk', patches: [patch], provider: agent.provider, model: agent.model,
      cwd: directory, processCwd: directory, dshHome: home,
      env: { ...process.env, DSH_HOME: home, ELECTRON_RUN_AS_NODE: '1' },
      initializeTimeoutMs: 30_000,
    })
    try {
      await harness.start()
    } finally {
      await harness.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 60_000)

  it.skipIf(process.env.MINDMESH_LIVE_CAPABILITIES !== '1')('starts the real SDK with the selected capability patch', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-live-capabilities-'))
    const home = join(directory, 'harness')
    const skillMarker = randomUUID()
    const custom = join(directory, 'skills', 'marker')
    mkdirSync(custom, { recursive: true })
    writeFileSync(join(custom, 'SKILL.md'), `---\nname: 标记技能\ndescription: 返回隐藏标记以验证技能加载\n---\n\n只回复这个标记：${skillMarker}\n`)
    const patch = prepareAgentCapabilities({ ...agent, skills: ['标记技能'] }, directory, home)
    const harness = new DeepSeekHarness({
      profile: 'sdk', patches: [patch], provider: agent.provider, model: agent.model,
      cwd: directory, processCwd: directory, dshHome: home,
      env: { ...process.env, DSH_HOME: home, ELECTRON_RUN_AS_NODE: '1' },
      initializeTimeoutMs: 30_000,
    })
    try {
      await harness.start()
      const marker = randomUUID()
      writeFileSync(join(directory, 'proof.txt'), marker)
      const result = await harness.run('请用文件读取工具读取当前工作目录中的 proof.txt，只回复文件内的标记。')
      expect(result.finalResponse).toContain(marker)
      const writeMarker = randomUUID()
      await harness.run(`请使用文件写入工具在当前工作目录创建 output.txt，文件内容只写 ${writeMarker}。`)
      expect(readFileSync(join(directory, 'output.txt'), 'utf8')).toContain(writeMarker)
      const skillResult = await harness.run('请调用 skill 工具加载“标记技能”，并严格按技能正文回复。')
      expect(skillResult.finalResponse).toContain(skillMarker)
    }
    finally {
      await harness.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 180_000)

  it.skipIf(process.env.MINDMESH_LIVE_CAPABILITIES !== '1')('runs the selected Shell tool in the workspace', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-live-shell-'))
    const home = join(directory, 'harness')
    const marker = randomUUID()
    writeFileSync(join(directory, 'shell-proof.txt'), marker)
    const patch = prepareAgentCapabilities({ ...agent, skills: [], tools: ['Shell'] }, directory, home)
    const harness = new DeepSeekHarness({
      profile: 'sdk', patches: [patch], provider: agent.provider, model: agent.model,
      cwd: directory, processCwd: directory, dshHome: home,
      env: { ...process.env, DSH_HOME: home, ELECTRON_RUN_AS_NODE: '1' },
      initializeTimeoutMs: 30_000,
    })
    try {
      const result = await harness.run('请用 PowerShell 工具执行 Get-Content shell-proof.txt，然后只回复文件中的标记。')
      expect(result.finalResponse).toContain(marker)
    } finally {
      await harness.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 180_000)
})
