import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Agent } from '../shared/contracts'
import { parseSkillReference } from '../shared/skill-reference'
import { defaultSkills } from './default-skills'

export const toolCatalog = [
  { id: 'web', name: '网页搜索', description: '检索公开网页资料。' },
  { id: 'files', name: '文件', description: '读取文件，并在设置中选择的工作目录内写入。' },
  { id: 'shell', name: 'Shell', description: '在本机执行受控命令。' },
  { id: 'browser', name: '浏览器', description: '打开网页、点击、填表、截图并抓取内容（Playwright）。' },
  { id: 'todo', name: '待办清单', description: '规划并跟踪多步任务。' },
  { id: 'goal', name: '目标管理', description: '在当前会话中维护长任务目标。' },
  { id: 'jobs', name: '后台任务', description: '在当前会话中查看和控制后台任务。' },
]

type SkillItem = { id: string; name: string; description: string; path: string }

export function listSkillCatalog(dataDirectory: string): SkillItem[] {
  const root = join(dataDirectory, 'skills')
  mkdirSync(root, { recursive: true })
  for (const skill of defaultSkills) {
    const directory = join(root, skill.id)
    const path = join(directory, 'SKILL.md')
    if (existsSync(path)) continue
    mkdirSync(directory, { recursive: true })
    const attribution = skill.source ? `license: MIT\nsource: ${skill.source}\n` : ''
    writeFileSync(path, `---\nname: ${skill.name}\ndescription: ${skill.description}\n${attribution}---\n\n${skill.body}\n`)
  }
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => {
    const path = join(root, entry.name, 'SKILL.md')
    if (!existsSync(path)) return []
    const source = readFileSync(path, 'utf8')
    if (source.length > 65_536) return []
    const header = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1]
    const name = /^name:\s*(.+)$/m.exec(header ?? '')?.[1]?.trim()
    const description = /^description:\s*(.+)$/m.exec(header ?? '')?.[1]?.trim()
    return name && description ? [{ id: entry.name, name, description, path }] : []
  })
}

export function prepareAgentCapabilities(agent: Agent, dataDirectory: string, dshHome: string): string {
  const catalog = listSkillCatalog(dataDirectory)
  const selected = agent.skills.map((value) => {
    const reference = parseSkillReference(value)
    const legacyMatches = reference ? [] : catalog.filter((item) => item.name === value)
    if (legacyMatches.length > 1) throw new Error(`技能「${value}」有多个版本，请编辑智能体并重新选择`)
    const skill = reference ? catalog.find((item) => item.id === reference.id) : legacyMatches[0]
    if (!skill) throw new Error(`技能「${reference?.name ?? value}」未安装`)
    return skill
  })
  const selectedRoot = join(dshHome, 'selected-skills')
  mkdirSync(selectedRoot, { recursive: true })
  for (const skill of selected) writeFileSync(join(selectedRoot, `${skill.id}.md`), readFileSync(skill.path))

  const unknownTools = agent.tools.filter((name) => !toolCatalog.some((item) => item.name === name))
  if (unknownTools.length) throw new Error(`工具「${unknownTools[0]}」不可用`)
  const tools = new Set(agent.tools)
  const disabled = (id: string, value: boolean) => `- id: ${id}\n  disabled: ${value}\n`
  const patch = [
    '- id: skill-filesystem',
    '  config:',
    '    includeDefaultRoots: false',
    '    customSkillDirs:',
    `      - ${JSON.stringify(selectedRoot)}`,
    '    watch: false',
    disabled('tool-skill', selected.length === 0),
    disabled('tool-fs', !tools.has('文件')),
    disabled('tool-fs-search', !tools.has('文件')),
    disabled('tool-bash', process.platform === 'win32' || !tools.has('Shell')),
    disabled('tool-pwsh', process.platform !== 'win32' || !tools.has('Shell')),
    disabled('tool-web', !tools.has('网页搜索')),
    disabled('tool-todo', !tools.has('待办清单')),
    disabled('tool-goal', !tools.has('目标管理')),
    disabled('tool-jobs', !tools.has('后台任务')),
    ...['tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent',
      'tool-subagent-fork', 'tool-workflow'].map((id) => disabled(id, true)),
  ]
  if (tools.has('浏览器')) patch.push(buildPlaywrightMcpInsert())
  const patchPath = join(dshHome, 'capabilities.cordis.patch.yml')
  writeFileSync(patchPath, patch.join('\n'))
  return patchPath
}

function buildPlaywrightMcpInsert(): string {
  const cli = playwrightCliPath()
  if (!cli) throw new Error('浏览器工具未安装，请重新安装 MindMesh')
  if (!playwrightBrowserAvailable()) throw new Error(process.platform === 'win32'
    ? '未检测到可用的 Microsoft Edge 浏览器'
    : '当前平台尚未配置 Playwright Chromium 浏览器')
  const args = [cli, '--headless', ...(process.platform === 'win32' ? ['--browser', 'msedge'] : [])]
  return [
    '- insert:',
    '    - id: mindmesh-browser',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        transport: stdio',
    '        serverName: browser',
    '        command: !!js process.execPath',
    `        args: [${args.map((value) => JSON.stringify(value)).join(', ')}]`,
    '        cwd: !!js process.cwd()',
    '        toolCallTimeoutMs: 120000',
    '        failOnStartupError: true',
  ].join('\n')
}

export function playwrightCliPath(): string {
  const packaged = Boolean(process.resourcesPath
    && !(process as NodeJS.Process & { defaultApp?: boolean }).defaultApp)
  const path = packaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@playwright', 'mcp', 'cli.js')
    : join(process.cwd(), 'node_modules', '@playwright', 'mcp', 'cli.js')
  return existsSync(path) ? path : ''
}

export function playwrightBrowserAvailable(): boolean {
  if (!playwrightCliPath()) return false
  if (process.platform !== 'win32') return false
  return [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA]
    .filter((root): root is string => Boolean(root))
    .some((root) => existsSync(join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')))
}
